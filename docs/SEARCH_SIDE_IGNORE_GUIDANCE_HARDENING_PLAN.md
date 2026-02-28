# Search + Manage Operator Safety Evolution Plan

## Implementation Status (2026-02-28)
Shipped in `packages/mcp`:

1. Track A baseline completed:
   - deterministic root `.gitignore`-aware suppression of redundant `hints.noiseMitigation.suggestedIgnorePatterns`
   - deterministic next-step messaging variants
   - matcher cache invalidation by `mtimeMs + size` + forced reload cadence
2. Track B baseline completed:
   - `manage_index` response envelope SSOT (`status/reason/warnings/hints/preflight/humanText`)
   - explicit `allowUnnecessaryReindex` override for `action:"reindex"`
   - preflight outcomes (`reindex_required`, `reindex_unnecessary_ignore_only`, `unknown`, `probe_failed`)
   - warning-code registry SSOT and envelope propagation

This document remains as the design/decision record, including historical no-drift constraints and staged evolution notes.

## Summary
This plan now has two deliberate tracks:

1. Track A (P1, no-drift): improve `search_codebase` noise mitigation guidance with deterministic `.gitignore`-aware filtering.
2. Track B (P1.5/P2, contract evolution): move operator-critical branching from text guidance into machine-checkable `manage_index` envelopes and preflight outcomes.

Track A is low risk and can ship immediately. Track B is the long-term safety path.

## Codebase Verification (Current Reality)
Verification against current implementation:

1. `manage_index` is envelope-native today (JSON envelope serialized in `content[0].text`).
   - Schema/routes: `packages/mcp/src/tools/manage_index.ts`
   - Handler outputs: `packages/mcp/src/core/handlers.ts` (`handleIndexCodebase`, `handleReindexCodebase`, `handleSyncCodebase`, `handleGetIndexingStatus`, `handleClearIndex`)
2. `handleReindexCodebase` currently delegates to create with hard force (`force: true`), so override semantics must not reuse existing `force` meaning.
3. CLI already supports structured envelope parsing when present (`parseStructuredEnvelope`), but `manage_index` polling still relies partly on text inference.
   - `packages/mcp/src/cli/format.ts`
   - `packages/mcp/src/cli/index.ts`
4. Bridge already preserves structured envelope text blocks and classifies valid tool payloads as non-retryable, so envelope migration is compatible.
   - `examples/pi-extension/satori-bridge/index.ts`
   - `examples/pi-extension/satori-bridge/recovery.ts`
5. Tests now assert envelope behavior for `manage_index` in core flows; legacy text assumptions were migrated.
   - `packages/mcp/src/core/handlers.manage_index_blocking.test.ts`
   - `packages/mcp/src/core/handlers.status.test.ts`
   - `packages/mcp/src/tools/registry.test.ts`

## Constraint Update (Contract Evolution Allowed)
Contract drift is now allowed when it materially improves operator safety and deterministic convergence. This unlocks a broader follow-up track beyond the P1 no-drift slice.

### Expanded Track (P1.5/P2, Sequenced)
1. Introduce `manage_index` response envelope SSOT.
   - Add `ManageIndexResponseEnvelope` with stable fields:
     - `status`, `reason`, `warnings`, `hints`, `message`, `humanText`
   - Keep machine-checkable status/reason aligned with existing non-ok conventions (`indexing`, `requires_reindex`, `not_indexed`).
   - Add stable warning-code registry (single source of truth in code + docs) in `packages/mcp/src/core/warnings.ts`.
   - Initial proposed registry:
     - statuses: `ok | not_ready | not_indexed | requires_reindex | blocked | error`
     - reasons: `indexing | not_indexed | requires_reindex | unnecessary_reindex_ignore_only | preflight_unknown`
     - warning codes: `REINDEX_UNNECESSARY_IGNORE_ONLY`, `REINDEX_PREFLIGHT_UNKNOWN`, `IGNORE_POLICY_PROBE_FAILED`
2. Add `reindex` preflight outcomes and explicit override.
   - Preflight outcomes:
     - `reindex_required`
     - `reindex_unnecessary_ignore_only`
     - `unknown`
     - `probe_failed`
   - Default behavior:
     - block `reindex_unnecessary_ignore_only` unless explicit override is provided
     - allow `unknown` and `probe_failed` with deterministic warnings (`REINDEX_PREFLIGHT_UNKNOWN` / `IGNORE_POLICY_PROBE_FAILED`)
   - Probe-failure semantics:
     - `probe_failed` is a preflight outcome only (not a response `reason`)
     - diagnostics are carried via warning code + `hints.preflight.probeFailed=true`
   - Add dedicated override input for `action:"reindex"` only (do not overload existing `force`).
3. Upgrade CLI/bridge to consume `manage_index` envelope deterministically.
   - Update polling/error mapping to prefer envelope status/reason over text heuristics.
   - Exit code mapping:
     - envelope `status !== "ok"` => tool error exit code `1` (including `blocked`)
     - CLI usage/schema failures remain exit code `2`
   - Keep backward compatibility parser for legacy text while migration rolls out.
   - Side-effect safety:
     - `blocked` and `preflight_unknown` envelope responses are valid tool outcomes and must never be retried as protocol failures.
   - Add explicit sunset step: remove legacy text heuristics after versioned migration window and envelope adoption tests pass.
4. Expand `search_codebase` noise hints (contract-aware phase).
   - Add structured fields (bounded/sorted):
     - `alreadyIgnoredByGitignore`
     - `newSatoriIgnoreOnly`
     - `confidence`
   - Preserve deterministic ordering/caps and no raw exception strings.
5. Expand ignore-source awareness safely.
   - Phase 1: effective ignore policy (no hard source attribution claims).
   - Phase 2: source attribution only if deterministic and verifiable.
6. Migration/docs/versioning.
   - Update tool schemas/spec/docs/changelog together.
   - Version bump + migration notes for clients that currently assume text-first `manage_index`.
   - Add compatibility tests for old/new parsing paths.

## Public API / Contract Impact
### Track A (P1, no-drift)
1. `manage_index` remains text-first and unchanged.
2. `search_codebase` envelope shape remains unchanged.
3. `hints.noiseMitigation` fields remain unchanged:
   - `reason`
   - `topK`
   - `ratios`
   - `recommendedScope`
   - `suggestedIgnorePatterns`
   - `debounceMs`
   - `nextStep`
4. Behavioral refinement only:
   - `suggestedIgnorePatterns` may be reduced or empty when observed noisy files are already ignored by root `.gitignore`.
   - `nextStep` wording is updated to explain redundancy outcomes.

### Track B (P1.5/P2, intentional contract evolution)
1. `manage_index` transitions to structured envelope responses (with human-readable text retained as `humanText`).
2. `manage_index` input schema adds explicit reindex override field scoped to `action:"reindex"`.
3. `search_codebase` `hints.noiseMitigation` may gain new structured fields (deterministically ordered and bounded).
4. CLI/bridge/client parsing is upgraded to consume new structured signals first.
5. Warning codes are sourced from a shared registry module (`packages/mcp/src/core/warnings.ts`).

## Implementation Plan
1. Add root `.gitignore` matcher cache in handlers.
   - File: `packages/mcp/src/core/handlers.ts`
   - Add a private cache on `ToolHandlers`, similar style to `changedFilesCache`:
     - key: canonical root identity:
       - reuse existing canonicalization SSOT helper already used in handlers (`canonicalizeCodebasePath`)
       - do not introduce a third root canonicalization implementation
     - value: `{ state: "ready" | "absent" | "error", mtimeMs: number | null, size: number | null, matcher: ignore.Matcher | null, checksSinceReload: number }`
   - Cache policy:
     - compute root `.gitignore` path (`<codebaseRoot>/.gitignore`)
     - if missing: cache `state="absent"` and return baseline behavior (no filtering)
     - if present: store `mtimeMs=Math.trunc(stat.mtimeMs)` and `size=stat.size`
     - reload matcher only when `mtimeMs` or `size` changes
     - add deterministic paranoia fallback for coarse timestamp filesystems:
       - force matcher reload every fixed N checks (default `N=25`) even when `mtimeMs + size` are unchanged
     - `checksSinceReload` is per-root and monotonic:
       - increments only when noise-mitigation filtering attempts to read/use this cache entry (not on every search request)
       - resets to `0` on successful reload
       - continues incrementing in `absent`/`error` states so retry cadence still progresses
     - on read/parse failure: cache `state="error"` and return baseline behavior (no filtering)
     - recovery rule: `state="absent"` and `state="error"` are not terminal; both are retried on fixed cadence (same N-check policy)
     - testability rule: expose reload interval via internal constant with test override (no runtime env tuning required for this phase)
2. Implement deterministic path-grounded redundancy filtering.
   - File: `packages/mcp/src/core/handlers.ts`
   - Add helper functions:
     - normalize relative path for ignore checks (`\` -> `/`, strip leading `/`, reject empty/`..`)
     - check if a relative path is ignored by cached root `.gitignore` matcher
     - compute filtered suggestions from `SEARCH_NOISE_HINT_PATTERNS` based on observed top-K noisy files
   - Filtering rule:
     - observed file set comes from the same ordered top-K list used for noise-ratio calculation and `nextStep` decision (no alternate source/order)
     - consider only observed top-K files classified as non-runtime (`tests|fixtures|docs|generated`) using the existing classifier SSOT (`classifyNoiseCategory`)
     - use one normalization SSOT for all matcher checks (no dual path representations)
     - evaluate suggestion coverage with the same ignore engine semantics:
       - `ignore().add(pattern).ignores(relPath)`
     - keep a pattern iff it matches at least one observed noisy file not ignored by root `.gitignore`
     - preserve original constant order from `packages/mcp/src/core/search-constants.ts`
3. Update `buildNoiseMitigationHint` behavior without shape changes.
   - File: `packages/mcp/src/core/handlers.ts`
   - Change signature:
     - from `buildNoiseMitigationHint(filesInOrder: string[])`
     - to `buildNoiseMitigationHint(codebaseRoot: string, filesInOrder: string[])`
   - Keep all existing ratio/top-K logic.
   - Replace static `suggestedIgnorePatterns` assignment with filtered list.
   - Keep deterministic fallback:
     - if cache state is `absent` or `error`, use current unfiltered default suggestions
     - empty `suggestedIgnorePatterns` from redundancy filtering is valid only when cache state is `ready` and filtering actually runs
4. Update `nextStep` messaging for clarity.
   - File: `packages/mcp/src/core/handlers.ts`
   - Deterministic short message template with fixed sentence order:
     - always first sentence: `Use scope="runtime" to reduce noise.`
     - always last sentence: `Reindex is only required when you see requires_reindex (fingerprint mismatch).`
   - Two deterministic message variants between those two fixed lines:
     - `suggestedIgnorePatterns.length > 0`:
       - `If you edit ignores, add only patterns not already ignored by root .gitignore (root-only check), then run manage_index sync.`
     - `suggestedIgnorePatterns.length === 0`:
       - emit “already covered by root .gitignore” language only when:
         - matcher state is `ready`, and
         - at least one observed noisy file was validated as ignored by that matcher
         - validated noisy files are valid relative keys under the same `effectiveRoot` being searched (`no absolute`, `no ..`)
       - `Top noisy files appear already covered by root .gitignore (root-only check); .satoriignore changes may be unnecessary.`
       - `If you changed ignores, run manage_index sync for immediate convergence.`
       - no alternate “already covered” phrasing is allowed
5. Wire call sites.
   - File: `packages/mcp/src/core/handlers.ts`
   - Update both invocations:
     - raw mode hint generation
     - grouped mode hint generation
   - Pass `effectiveRoot` (indexed root used for search) into `buildNoiseMitigationHint`.
6. Tests (TDD-first).
   - File: `packages/mcp/src/core/handlers.scope.test.ts`
   - Add tests:
     1. All redundant: root `.gitignore` covers observed noisy files -> `suggestedIgnorePatterns` is empty; `nextStep` contains “already covered by root `.gitignore`”.
     2. Partially redundant: some noisy files covered, some not -> suggestions include only needed patterns, in original order.
     3. Fallback when root matcher is absent: no root `.gitignore` -> current baseline suggestions remain unchanged.
     4. Fallback when root matcher errors: unreadable/invalid root `.gitignore` -> current baseline suggestions remain unchanged.
     5. Cache invalidation by `mtimeMs + size`: same handler instance, change `.gitignore`, force mtime bump, rerun search -> suggestions update.
     6. Periodic forced reload catches coarse timestamp misses: keep `mtimeMs + size` effectively stable across edits, cross N checks, verify matcher refresh updates suggestions.
     7. Message determinism: both `nextStep` variants include sync-not-reindex guidance and the fingerprint-only reindex rule.
     8. Confidence gating: “already covered by root .gitignore” is never emitted when matcher state is `absent` or `error`.
     9. Interval override determinism: test override sets forced-reload interval to low value (e.g., 2) and validates cadence behavior.
     10. Effective-root safety: “already covered by root .gitignore” is not emitted for noisy files outside the searched `effectiveRoot`.
   - Keep existing deterministic noise-hint tests passing, updating only expectations that legitimately change due to filtering logic.
7. Docs and changelog.
   - Update behavior spec:
     - `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
     - clarify redundancy filtering is root `.gitignore`-aware and path-observed; suggestions may be empty
     - explicitly note v1 limitation: root `.gitignore` only (not nested/global excludes)
     - clarify fallback behavior for `absent/error` matcher states
     - clarify guidance text: ignore-only changes use `sync`; reindex only for `requires_reindex`
   - Update operator-facing docs:
     - `README.md` and/or CLI docs section
     - add one deterministic sentence: “Ignore-only edits should use `sync`, not `reindex`.”
   - Add changelog entry:
     - `CHANGELOG.md`

## Track B Implementation Plan (Contract Evolution)
1. Add typed `manage_index` envelope.
   - Files:
     - `packages/mcp/src/core/search-types.ts` or dedicated `manage-types.ts`
     - `packages/mcp/src/core/handlers.ts`
     - `packages/mcp/src/core/warnings.ts`
   - Return envelope JSON from all `manage_index` actions.
2. Add preflight + override for `reindex`.
   - Files:
     - `packages/mcp/src/tools/manage_index.ts` (schema)
     - `packages/mcp/src/core/handlers.ts` (decision logic)
   - Add deterministic warning codes and `hints.sync` / `hints.overrideReindex`.
3. Upgrade CLI status inference to envelope-first.
   - Files:
     - `packages/mcp/src/cli/format.ts`
     - `packages/mcp/src/cli/index.ts`
   - Ensure poll termination and exit codes use structured statuses for both old/new outputs.
4. Upgrade bridge recovery/assertions to recognize new non-ok manage envelopes.
   - Files:
     - `examples/pi-extension/satori-bridge/index.ts`
     - `examples/pi-extension/satori-bridge/recovery.ts`
5. Add compatibility and migration tests.
   - Keep legacy text-path tests while adding envelope-path tests, then remove legacy assumptions deliberately.
   - Include explicit legacy-parser removal checklist and final cleanup PR item.
   - Explicit sunset scope:
     - remove/update CLI polling tests that rely on text heuristics once envelope-first parsing is authoritative.
6. Update authoritative behavior spec + changelog + migration notes in same patch.

## Acceptance Criteria
### Track A
1. No changes to `manage_index` schema or output contract.
2. No additions to `SearchNoiseMitigationHint` type fields.
3. `search_codebase` still returns deterministic hint shape; only content of `suggestedIgnorePatterns`/`nextStep` is refined.
4. Redundant `.satoriignore` recommendations are suppressed only when confidently covered by root `.gitignore`.
5. If confidence is low (`state=absent|error` for root `.gitignore` matcher), behavior falls back to existing suggestions.
6. Cache behavior is deterministic across equivalent roots, invalidates on `mtimeMs` or `size` change, and performs fixed-interval forced reload (`N=25`).
7. `nextStep` deterministically communicates:
   - ignore-only change -> `sync`, not `reindex`
   - `reindex` is only required when `requires_reindex` is returned (fingerprint mismatch)
8. “Already covered by root .gitignore” messaging appears only under validated `ready` matcher conditions.
9. New and existing scope/noise tests pass.

### Track B
1. `manage_index` emits stable envelope statuses/reasons/warnings across all actions.
2. `reindex` unnecessary-ignore-only attempts are blocked by default unless explicit override is present.
3. Preflight outcomes are deterministic:
   - `reindex_required` and `reindex_unnecessary_ignore_only` are authoritative
   - `unknown` and `probe_failed` are warn-only, non-blocking paths
4. CLI poll/exit behavior remains deterministic for both old and new response formats during migration.
5. Bridge treats valid non-ok envelopes as tool outcomes (non-retryable), not protocol failures.
6. Legacy text heuristics are removed after migration window with explicit cleanup tests.
7. Warning codes are emitted from the shared registry module (`packages/mcp/src/core/warnings.ts`) only.
8. Spec, schemas, docs, tests, and changelog are updated in the same versioned patch.
9. Tests assert that emitted warning codes are members of the shared warning registry.
10. Docs list warning codes sourced from the shared registry.

## Assumptions / Defaults
1. Scope is intentionally limited to root `.gitignore` for this phase.
2. Track A keeps `manage_index` unchanged; Track B intentionally evolves `manage_index`.
3. Envelope and warning-code additions are allowed only in Track B with explicit migration coverage.
4. Determinism and contract stability take precedence over aggressive inference.
5. Root-only limitation is explicitly documented in spec and reflected in `nextStep` messaging.
6. Fixed reload interval defaults to `25` checks unless explicitly tuned in implementation constants.
7. Test suites may lower the forced-reload interval via test-only override to keep cadence tests deterministic and fast.
