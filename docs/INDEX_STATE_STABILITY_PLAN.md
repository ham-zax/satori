# Index State Stability Plan

## Objective
Stop `indexed <-> not_indexed` flapping and make index status deterministic for operators and agents.

## Problem Summary
- Foreground tool handlers currently invoke cloud-state reconciliation.
- Reconciliation can remove local snapshot entries when cloud metadata is transient, partial, or temporarily unavailable.
- Result: the same codebase may appear indexed in one call and not indexed in the next call.

## Chosen Direction
Safe Simplify (selected): foreground paths must not perform destructive cloud-derived snapshot mutations.

## Core Invariants
1. Foreground reads must not delete tracked codebases from snapshot state.
2. Cloud state may confirm/repair, but never delete local state during foreground reads.
3. `already indexed` is valid only when searchable snapshot state and valid completion proof both exist.
4. Existing fingerprint and indexing gates remain authoritative (`requires_reindex`, `not_ready`).
5. Side effects occur only on explicit lifecycle actions (`manage_index create|reindex|sync|clear`), never from passive reads.
6. Cloud collection existence is never considered completion proof; only marker-doc validation is.
7. Foreground read stability includes `list_codebases`; it must remain read-only and membership-stable under transient cloud errors.

## Scope
- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/*.test.ts`
- `packages/mcp/src/tools/list_codebases.ts`
- `packages/mcp/src/tools/list_codebases.test.ts`
- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

## Terminology
- Canonical root normalization: codebase identity normalization (`realpath` when available + normalized + trailing separator trimmed).
- `normalizeRelPath`: relative file-key normalization for manifests/diffs (slash normalization + reject escaping segments like `..`).
- These are distinct operations and must not be conflated.

## Implementation Plan

### 1) Enforce non-mutating foreground behavior
Remove implicit destructive reconcile calls from:
- `handleIndexCodebase`
- `handleSearchCode`
- `handleFileOutline`
- `handleCallGraph`
- treat `list_codebases` as foreground read: no destructive reconcile/prune path is allowed directly or indirectly

### 2) Introduce one shared completion-proof validator
Add a helper used by all relevant handlers:
- `validateCompletionProof(effectiveRoot): { outcome: "valid" | "stale_local" | "fingerprint_mismatch" | "probe_failed"; reason?: "missing_marker_doc" | "invalid_marker_kind" | "path_mismatch" | "invalid_payload" | "fingerprint_mismatch" | "probe_failed" }`

Validation semantics (single source of truth):
- marker exists
- marker kind/version is valid
- marker `codebasePath` matches canonical root (Policy A): normalize with canonicalization (`realpath` when available + normalized + trailing separator trimmed) before comparing
- marker payload is structurally valid
- marker fingerprint must strictly equal runtime fingerprint tuple: `embeddingProvider + embeddingModel + embeddingDimension + vectorStoreProvider + schemaVersion`
- marker writer rule: marker-doc must store `codebasePath` as canonical root (same Policy A) at write time

Decision for proof stability:
- Use Option A (non-authoritative probe failure): marker probe backend failures map to `outcome:"probe_failed"` and must not downgrade foreground responses to `not_indexed` by themselves.
- Classification boundary:
  - `missing_marker_doc` applies only when marker query completes successfully and returns no valid marker document.
  - `probe_failed` applies only when marker probe cannot be completed (timeout/transport/auth/backend-unavailable/response-parse failure).

### 3) Tighten "already indexed" semantics for create flow only
In `handleIndexCodebase`:
- If user explicitly requested `create` (or `reindex`), stale local searchable state is treated as `not_indexed` and create proceeds.
- If proof is valid, keep existing "already indexed" early-return behavior.
- For create/reindex early-return, only `outcome:"valid"` qualifies as already indexed.
- `outcome:"probe_failed"` is treated as proof-unavailable (not valid proof) and create/reindex proceeds.
- Emit deterministic text:
  - "Local snapshot claims indexed, but completion proof is missing/invalid; treating as not_indexed for create."

Important constraint:
- No automatic reindex side effects in `status`, `search`, `file_outline`, or `call_graph`.

### 4) Add stale-local handling in foreground read paths
In `handleSearchCode`, `handleFileOutline`, and `handleCallGraph`:
- If completion proof outcome is `stale_local`:
  - return deterministic `status:"not_indexed", reason:"not_indexed"` envelope with explicit stale-local message
  - include `manage_index` create hint for the effective root
  - include structured stale hint payload:
    - `hints.staleLocal.completionProof=<reason>`
    - `hints.staleLocal.recommendedAction={tool:"manage_index",args:{action:"create",path:"<root>"}}`
- If completion proof outcome is `fingerprint_mismatch`:
  - return `status:"requires_reindex", reason:"requires_reindex"` with reindex hint (not `not_indexed`)
- If completion proof outcome is `probe_failed`:
  - do not downgrade to `not_indexed` based on probe failure alone
  - non-authoritative rule: never upgrades state and never downgrades an otherwise-OK local indexed state
  - if local snapshot indicates indexed/sync_completed and other gates pass, return normal existing success/status path with diagnostic hint
  - if local snapshot indicates not indexed, return `not_indexed` as usual
  - attach diagnostic hint (debug/metadata only), e.g. `hints.debugProofCheck={ok:false,reason:"probe_failed"}`

### 5) Add stale-local diagnostics in status
In `handleGetIndexingStatus`:
- If status is searchable and proof outcome is `stale_local`:
  - return explicit warning text describing stale local snapshot and recovery action
  - keep compatibility diagnostics in output
- If proof outcome is `fingerprint_mismatch`:
  - surface `requires_reindex` guidance
- If proof outcome is `probe_failed`:
  - do not reclassify as `not_indexed`; surface probe diagnostic note only

### 6) Split cloud reconcile responsibilities
Replace current single reconcile behavior with clear roles:
- `reconcileFromCloudNonDestructive()`:
  - may confirm or add/repair local metadata only when cloud proof is strong
  - strong proof is defined as marker-doc validation passing (same validator contract as local checks)
  - must be read-only for roots currently in `indexing`
  - never removes local snapshot entries
- `pruneFromCloud()`:
  - maintenance-only, explicit path
  - never called from foreground tool handlers

If prune is not exposed now, keep it internal and unused.

### 7) Define deterministic gate precedence
Apply this order consistently in foreground handlers:
1. `requires_reindex` (fingerprint gate)
2. `not_ready` with `reason=indexing` (indexing lock)
3. `not_indexed` (includes stale-local-without-proof)

Stale-local contract:
- stale-local remains `status:"not_indexed", reason:"not_indexed"` (no new reason enum)
- stale-local differentiation is carried in `message` + `hints.staleLocal`

### 8) Align documentation
Update behavior spec so it does not claim foreground handlers mutate snapshot state via cloud prune.

## Test Plan

### A) Foreground handlers do not call cloud reconcile
- Add/adjust tests in:
  - `handlers.scope.test.ts`
  - `handlers.file_outline.test.ts`
  - `handlers.call_graph.test.ts`
- Assert reconcile spy/stub call count remains `0` during foreground requests.

### B) Create flow repairs stale searchable snapshot state
- Add/adjust tests to ensure:
  - snapshot searchable + missing proof does not return `already indexed`
  - create proceeds and emits stale-repair note

### C) Status reports stale searchable state clearly
- Add/adjust status test to verify warning text and explicit recovery guidance.

### D) List stability guard
- Add regression coverage in `list_codebases.test.ts` for stability expectations.
- Add repeated `list_codebases` calls under transient cloud-list/query failures and assert membership does not drop.

### E) Adversarial transient-cloud scenario
- Add regression where cloud list/query temporarily fails or returns empty.
- Starting state: local snapshot searchable + valid proof.
- Assert foreground `search/status/list_codebases` remains stable and does not delete snapshot membership.

### F) Stale-local does not mutate and does not trigger transport retries
- Add regression ensuring stale-local foreground responses:
  - keep deterministic JSON envelope (`status:"not_indexed", reason:"not_indexed"`)
  - do not mutate snapshot membership
  - are treated as tool-level non-protocol responses (no protocol retry behavior)
  - bridge/CLI retry classifiers must treat any valid JSON CallTool response (including non-ok envelopes) as non-retryable

### G) Probe-failure stability and mismatch mapping
- Add regression where marker probe intermittently fails:
  - searchable roots must not flip to `not_indexed` solely from probe failure.
- Add regression that `fingerprint_mismatch` maps to `requires_reindex` (not `not_indexed`).
- Add regression that successful marker probe with empty result maps to `stale_local` (`missing_marker_doc`), not `probe_failed`.

## Acceptance Criteria
1. Repeated `create -> status -> search -> list_codebases` cannot flap a repo to `not_indexed` unless a real local transition occurs.
2. `already indexed` is never returned when completion proof is missing/invalid.
3. Foreground handlers do not perform destructive cloud-prune reconciliation.
4. Stale local searchable state is surfaced with deterministic recovery instructions.
5. Transient cloud failures cannot cause immediate local state deletion during foreground operations.
6. Stale-local responses preserve existing reason contract (`reason:"not_indexed"`) and never trigger protocol-failure retry paths.
7. Marker probe transient failure does not cause response-level downgrade flapping to `not_indexed`.
8. Fingerprint mismatch always resolves to `requires_reindex`.

## Non-Goals
- No tool-surface expansion.
- No new status enum variants.
- No destructive `clear` behavior changes.

## Execution TODOs (Do Not Skip)

### Phase 0: Baseline and Guardrails
- [ ] Capture current behavior in failing tests before edits.
- [ ] Add explicit TODO IDs in test names/comments for traceability (`ISS-INDEX-STABILITY-*`).

### Phase 1: Shared Proof Validator
- [ ] Add `validateCompletionProof` helper in `handlers.ts`.
- [ ] Route all relevant handler checks through this helper.
- [ ] Add unit coverage for all validator failure reasons.
- [ ] Implement explicit `probe_failed` non-authoritative handling.

### Phase 2: Foreground Non-Mutation
- [ ] Remove foreground calls that trigger destructive cloud reconcile logic.
- [ ] Add tests asserting reconcile path is not invoked from foreground handlers.
- [ ] Verify no snapshot deletion on transient cloud failure simulation.
- [ ] Include `list_codebases` read-stability verification under transient cloud failures.

### Phase 3: Create Flow Semantics
- [ ] Update `handleIndexCodebase` early-return condition to require valid proof.
- [ ] Add stale-local create messaging.
- [ ] Add tests for searchable-without-proof -> create proceeds.

### Phase 4: Read/Status Stale-Local Behavior
- [ ] Implement stale-local `not_indexed` responses for search/file_outline/call_graph.
- [ ] Implement stale-local warning in `manage_index status`.
- [ ] Add structured `hints.staleLocal` payload.
- [ ] Map `fingerprint_mismatch` to `requires_reindex` responses.
- [ ] Ensure `probe_failed` does not downgrade classification to `not_indexed`.

### Phase 5: Reconcile Split
- [ ] Split reconcile API into non-destructive reconcile vs prune-only path.
- [ ] Enforce "strong proof = marker-doc validation" in non-destructive reconcile.
- [ ] Ensure prune path is maintenance-only and not wired to foreground handlers.

### Phase 6: Docs and Final Verification
- [ ] Update `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`.
- [ ] Run full MCP test suite.
- [ ] Validate manual scenario: repeated status/search/list after transient cloud failure stays stable.

## TDD Cycles (Per Phase)

### Cycle 1: Proof Validator (Red -> Green -> Refactor)
- Red: add tests for `missing_marker_doc`, `invalid_marker_kind`, `path_mismatch`, `fingerprint_mismatch`, `invalid_payload`, `probe_failed`.
- Green: implement helper and pass tests with minimal changes.
- Refactor: remove duplicated proof-check codepaths.

### Cycle 2: Foreground Non-Mutation
- Red: tests fail if reconcile/prune is called in search/file_outline/call_graph/status flows.
- Green: remove calls and satisfy tests.
- Refactor: centralize non-mutating foreground guard utility.

### Cycle 3: Create Flow and Stale-Local Semantics
- Red: tests assert stale searchable entry no longer returns "already indexed".
- Green: implement create behavior and deterministic messaging.
- Refactor: align response builders to avoid string drift.

### Cycle 4: Cloud Transient Adversarial
- Red: simulated cloud empty/error should currently flap; assert failure.
- Green: ensure snapshot remains stable and responses deterministic.
- Refactor: isolate cloud adapters and add clear mutation boundaries.

### Cycle 4b: Proof Probe Stability
- Red: intermittent marker probe failure causes classification flip.
- Green: keep stable classification; attach probe-failure diagnostic only.
- Refactor: keep probe-failure handling centralized in validator mapping.

### Cycle 5: Contract/Docs Lock
- Red: contract anchor assertions fail against stale doc language (avoid brittle full-string assertions).
- Green: update docs and add regression checks.
- Refactor: ensure all references use the same precedence and stale-local wording.

## Drift Controls
1. No merge unless all new tests pass and at least one adversarial transient-cloud test is present.
2. Any future handler that mutates snapshot state must be lifecycle-scoped and documented.
3. Any change to `validateCompletionProof` reasons requires simultaneous update to:
   - handler stale-local messaging
   - tests
   - docs
4. PR checklist must confirm:
   - foreground handlers are non-destructive
   - stale-local remains `reason:"not_indexed"`
   - no new status enum introduced
   - cloud existence was not used as completion proof
   - bridge/CLI classifiers keep valid JSON non-ok envelopes non-retryable
   - `fingerprint_mismatch -> requires_reindex` mapping preserved
   - probe failure cannot independently downgrade to `not_indexed`
