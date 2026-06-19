# Satori End-to-End Feature & Behavior Spec (Authoritative, Evidence-Backed)

Maintenance rule: this spec is hand-maintained and treated as a contract. Behavior changes must update this document and the proving tests in the same patch.

## Outline of Discovered Behaviors (Complete)
- Server boot lifecycle is split into a bootstrap entrypoint (`index.ts`) and server factory (`start-server.ts`), with run-mode gates for startup loops.
- Canonical architecture path: Core sync state + vector store + sidecar + MCP handlers + 6 MCP tools.
- North-star agent path: plain-English `search_codebase` discovery first, then `file_outline -> call_graph -> read_file(open_symbol)` for deterministic proof with `navigationFallback` when graph is unavailable.
- Exactly six MCP tools are exposed via registry: `list_codebases`, `manage_index`, `search_codebase`, `file_outline`, `call_graph`, `read_file`.
- `satori-cli` is a shell client of the same six MCP tools (tool reflection via `tools/list` and execution via `tools/call`) and does not add MCP tool surface.
- `satori-cli` also ships CLI-only `install` and `uninstall` commands for supported clients; these commands run before MCP session startup and do not widen the six-tool surface.
- Managed installs perform package resolution during setup, not resident MCP startup; generated client config must avoid `npx`/package-manager launch paths.
- Installer `--profile default|minimal|all-text` writes repo-local `satori.toml`; runtime reads `[index].profile` as index policy and treats `satori.toml` as a control file with `.gitignore` and `.satoriignore`.
- Index profile defaults are safe-broad but hard-deny secrets, lockfiles, generated output, dependencies, binaries, bundles, logs, database dumps, and snapshots before indexing.
- Language capability routing is explicit: `search` means text retrieval eligibility, `symbols`/legacy `symbolMetadata` means extracted symbol metadata, `owner` means extracted source-symbol ownership beyond synthesized file fallback, and `call_graph` uses relationship-backed navigation as the canonical path. Legacy `callGraphBuild`/`callGraphQuery` are no longer part of steady-state runtime navigation behavior.
- Symbol-owned retrieval contracts now distinguish stable-ish `symbolKey` from exact snapshot `symbolInstanceId`; core writes compatible symbol registry sidecars for completed full indexes, assigns `ownerSymbolKey`/`ownerSymbolInstanceId` to indexed chunks, and after incremental changes reuses changed-file symbol output plus the previous compatible registry to rewrite canonical navigation sidecars and SQLite without re-splitting unchanged files. If changed-file indexing stops early, navigation state is cleared instead of publishing a mixed generation.
- Completed full indexes also import an additive `navigation.sqlite` cache under the same navigation root as the JSON sidecars; JSON remains canonical, runtime navigation still serves JSON by default, the default shared runtime store can enable once-per-root SQLite parity warnings in live runtime with `SATORI_NAVIGATION_DUAL_READ=1`, and that same shared runtime store can exercise SQLite-backed reads with `SATORI_NAVIGATION_BACKEND=sqlite` only after proving parity with the canonical JSON symbol registry and relationship sidecars. If canonical JSON is missing or incompatible, SQLite is not allowed to become truth; if SQLite is missing, stale, incompatible, or parity-mismatched while JSON is compatible, runtime falls back to JSON with a warning.
- `manage_index` action router supports `create|reindex|sync|status|clear`; behavior is action-specific in handlers and responses are structured JSON envelopes.
- `search_codebase` defaults are runtime-first and grouped (`scope=runtime`, `resultMode=grouped`, `groupBy=symbol`, `rankingMode=auto_changed_first`).
- Search operator parsing is deterministic and prefix-block based with escape and quote handling.
- `path:` and `-path:` operators use gitignore-style pattern matching via `ignore` against normalized repo-relative paths.
- Scope filtering is strict: runtime includes source/runtime/script code and test evidence while excluding docs/generated/artifacts/landing/fixtures, docs includes docs/tests only, mixed includes all. Runtime ranking demotes tests unless the query explicitly asks for test/spec/coverage evidence.
- Search filtering precedence is deterministic: scope -> lang -> path include -> path exclude -> must -> exclude.
- Must-retry is bounded and deterministic; warning is emitted only when must constraints remain unsatisfied after retries.
- Group diversity is default-on and deterministic with fixed caps and one deterministic relaxed pass.
- Changed-files boost is git-aware with TTL cache and hard threshold gating for large dirty trees; search responses expose a compact freshness summary on every ok result.
- Owner-oriented ranking favors canonical core implementation paths over adapters/tool wrappers for implementation queries.
- Noise mitigation hint is deterministic, category-based, emitted only when noise ratio threshold is crossed in visible top-K, and root `.gitignore`-aware for redundant suggestion suppression.
- Rerank is policy-controlled (capability/profile + docs-scope skip), runs post-filter and pre-group, top-K bounded, deterministic rank-only boost, stable failure degradation.
- Candidate and group sorting both use explicit deterministic tie-break chains.
- Grouping supports `symbol` and `file`; symbol grouping prefers owner metadata when present, repairs missing owner identity from a compatible registry, and uses deterministic hashed fallback groups when symbol identity is unavailable.
- `callGraphHint` contains supported/unsupported reasoned state; supported groups expose compact `nextActions.callGraph` args plus allowed directions, unsupported groups expose executable `navigationFallback`, and search results include `recommendedNextAction`, capability confidence, and fallbacks so agents can choose the proof path without reconstructing spans.
- `file_outline` supports `resolveMode=outline|exact` with exact outcomes `ok|ambiguous|not_found`.
- `read_file` supports `plain|annotated`; annotated mode returns `outlineStatus`, `outline`, `hasMore`, warnings/hints; `open_symbol` resolves deterministically via `file_outline exact`.
- Reindex-compatibility gates propagate `requires_reindex` envelopes with deterministic `hints.reindex` across search/navigation tools.
- Freshness behavior: sync-on-read for `search_codebase` via `ensureFreshness`; other tools do not run sync-on-read.
- Subdirectory search requests resolve to an indexed parent `effectiveRoot` when needed; fallback navigation paths stay runnable from that resolved root while keeping returned `path` as requested input.
- Watchers are optional, debounced, status-gated, and session-scoped; ignore-control files trigger ignore reconciliation flow.
- Ignore reconciliation is self-healing: manifest-first deletion of newly ignored indexed paths, synchronizer reload, forced sync, version/signature update, coalescing.
- Non-watcher ignore convergence exists via control-file signature comparison in `ensureFreshness`.
- Background periodic sync runs on timer with non-overlapping recursive scheduling.
- Core sync trust contract: snapshot identity SSOT, canonical path parity, stat-first/hash-on-change, deterministic merkle root, partial-scan preservation semantics, deterministic save gating.
- Partial-scan semantics preserve prior entries on unreadable files/dirs and avoid false removals; unscanned prefixes are normalized/compressed segment-safely.
- Snapshot/diff path normalization is SSOT (`\ -> /`, duplicate separator collapse, `./` collapse, `..` rejection).
- Core sync has deterministic env tunables for hashing concurrency and full-hash interval.
- CI now has a dedicated core sync hardening gate (`core_sync_gate`) plus docs-check/build matrix.
- Recent evolution includes removal of user rerank knob and splitter knob, deterministic jump hardening, and sync identity hardening.

---

## A) System Overview
Architecture in words:
- Core sync (`packages/core`) tracks file state (stats, hashes, merkle root, partial-scan metadata).
- MCP runtime (`packages/mcp`) owns snapshot status, freshness gating, search orchestration, call graph sidecar lifecycle, and tool routing.
- Shell CLI runtime (`packages/mcp/src/cli`) is transport/client glue plus install/uninstall lifecycle commands; it must not duplicate MCP tool logic.
- Installer runtime cache paths are private implementation details; public setup remains the one-command CLI installer flow.
- Sidecar/index artifacts are consumed by `search_codebase`, `file_outline`, `call_graph`, `read_file`.
- Agent-visible entrypoints are only the six tools from `toolRegistry`.

North-star workflow:
- `search_codebase` finds candidate symbol/file groups.
- `file_outline` locks deterministic symbol spans in-file.
- `call_graph` traverses callers/callees for that symbol.
- `read_file(open_symbol)` opens deterministic symbol span for editing context.
- If call graph is unavailable for a group, `navigationFallback` provides executable `readSpan` and optional `fileOutlineWindow`.

Language capability contract:
- Capability names are exposed through `packages/core/src/language/registry.ts` and keep backward-compatible aliases for existing MCP callers.
- `search` is broad retrieval eligibility and does not imply extracted symbols, owner resolution, imports, outline, or call graph support.
- `owner` means chunks can resolve to extracted source symbols beyond the synthesized file owner. All indexed chunks may later receive a synthesized file owner when no extracted owner exists.
- Future language expansion uses capability tiers. A language cannot be treated as symbol-production-ready unless extractor fixtures, parser/extractor failure fallback tests, indexing owner-metadata tests, `file_outline` tests, and `read_file(open_symbol)` tests pass.
- Current capability tiers: TypeScript, JavaScript, and Python are the only production-ready `call_graph` languages; Go and Rust are `symbol_only`; broad catalog languages are routed/searchable or parser-declared/parser-covered without graph readiness unless separately fixture-proven.
- Parser or extractor failure must degrade to synthesized file-owner fallback, must not crash indexing, and must not attach stale extracted-symbol owner metadata.
- L1 symbol-only languages must not claim `callGraphBuild` or `callGraphQuery`, must not emit `nextActions.callGraph`, and must keep `call_graph` unsupported or not-ready even if relationship sidecars exist globally.
- Adding extensions to the capability matrix must not silently broaden the default indexing profile. Any profile expansion requires an explicit allowlist/profile test.
- Search-only artifact/container languages such as Vue, Svelte, Astro, CSS/SCSS, Dockerfile, Makefile, CMakeLists, and Justfile must not claim `symbols`, `owner`, `imports`, `fileOutline`, or `callGraph` until deterministic extractors exist.
- TypeScript module extensions `.mts` and `.cts` route as TypeScript; C/C++ variants `.cc`, `.cxx`, `.hh`, `.hxx`, `.ixx` route as C++; `.kts` routes as Kotlin.

Symbol identity contract:
- Files remain the source of truth. Symbol records are derived navigation contracts for compatible index snapshots.
- `symbolKey` is stable-ish across small edits but is not exact and is not expected to survive file moves/renames in v1.
- `symbolInstanceId` is exact snapshot identity derived from `symbolKey`, file hash, canonical span serialization, and extractor version.
- `symbolKey` lookup is candidate lookup; exact opens must disambiguate with `symbolInstanceId`, file hash, manifest compatibility, and exact file/label constraints.
- Relationship manifests must bind to the compatible symbol registry manifest hash before graph data can be trusted.
- Current implementation status: core exports contract types and runtime guards, writes symbol registry sidecars for completed full indexes, assigns owner metadata into retrieval documents, writes relationship manifests bound to the symbol registry manifest hash, writes conservative function/method-owned `CALLS v0` relationship edge shards plus TS/JS relative-module and Python relative-module `IMPORTS`/`EXPORTS v0` file-owner edge shards, reads relationship sidecars for registry-backed search/outline/navigation through `NavigationStore`, and mirrors compatible JSON navigation state into `navigation.sqlite` for additive parity-checked reads. `CALLS v0` is heuristic and name-based: unique same-file targets are high confidence, unique cross-file targets are low confidence, and ambiguous same-name targets are skipped until import/receiver-aware resolution exists. `IMPORTS`/`EXPORTS v0` only records resolvable relative module edges and unambiguous local export declarations; package imports, unresolved paths, ambiguous local exports, and multiline module syntax are skipped. For Python, top-level `def`/`class` declarations act as module-owner exports, which allows deterministic promotion of relative-import-backed low-confidence cross-file calls. `call_graph` resolves exact symbols through the registry and traverses compatible relationship sidecars for conservative `CALLS v0` edges, filtering unsupported low-confidence edges by default and promoting low-confidence cross-file calls only when deterministic import/export-supported evidence points to the target symbol. When suppressed Python caller/callee records still carry a concrete site, MCP can synthesize bounded source-backed dynamic recovery only if source-span repair validates the owning function body, the recorded site remains inside that repaired span, and direct-call verification resolves to the exact suppressed target symbol; successful recovery is surfaced as `SOURCE_BACKED_DYNAMIC_CALLEES:<n>` or `SOURCE_BACKED_DYNAMIC_CALLERS:<n>`. Remaining suppressed candidates are surfaced in structured notes with the candidate site location. When the default shared runtime store is created with `SATORI_NAVIGATION_BACKEND=sqlite`, runtime navigation can explicitly serve from SQLite only if canonical JSON registry and relationship metadata prove parity; JSON remains the canonical default and fallback path, and SQLite remains cache/validation/experimental serving only.

Behavior contract:
- Trigger: MCP server starts and tools are invoked.
- Effect: Requests route through `ToolHandlers`, enforcing indexing/fingerprint/sync/sidecar gates before returning envelopes.
- Observability: JSON envelopes (`status`, `hints`, `warnings`, `freshnessDecision`, `freshnessSummary`), search telemetry `response_bytes`, and deterministic debug payload when `debug:true`.
- Determinism: Explicit sort/tie-break chains, stable warning ordering, fixed caps/thresholds/constants.
- Performance impact: incremental sync, coalescing, bounded retries, bounded rerank top-K, cached git-status, watcher debounce.

**Evidence:**
- [index.ts](/home/hamza/repo/satori/packages/mcp/src/index.ts) (bootstrap entrypoint with run-mode and stdio-safety wiring).
- [start-server.ts](/home/hamza/repo/satori/packages/mcp/src/server/start-server.ts) (`ContextMcpServer`, `start`, `setupTools`, run-mode startup lifecycle).
- [stdio-safety.ts](/home/hamza/repo/satori/packages/mcp/src/server/stdio-safety.ts) (console-to-stderr and cli-mode stdout guard).
- [cli/index.ts](/home/hamza/repo/satori/packages/mcp/src/cli/index.ts) (`tools list`, `tool call`, wrapper path, envelope-aware exit mapping).
- [registry.ts](/home/hamza/repo/satori/packages/mcp/src/tools/registry.ts) (6-tool surface).
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (`handleSearchCode`, `handleFileOutline`, `handleCallGraph`).
- [search-types.ts](/home/hamza/repo/satori/packages/mcp/src/core/search-types.ts) (envelopes/contracts).

---

## B) Tool Surface (6 tools)

### 1) `list_codebases`
Purpose: Show tracked codebases grouped by state.

Inputs/defaults: strict empty object.

Outputs:
- Plain text sections: Ready, Indexing, Requires Reindex, Failed.
- Not JSON envelope.

Warnings/hints:
- None emitted as structured fields.

Determinism:
- Grouping by status is deterministic.
- Bucket order is fixed (`Ready`, `Indexing`, `Requires Reindex`, `Failed`) and paths are sorted lexicographically within each bucket.

Common recipes:
1. Inventory current tracked roots before any operation.
2. Discover candidate root for `read_file open_symbol` remediation.

Behavior:
- Trigger: call `list_codebases`.
- Effect: reads snapshot manager state and formats status text.
- Observability: text output sections and paths.
- Determinism: fixed section order + lexicographically sorted paths inside each section.
- Performance: O(number of tracked codebases); no sync, no search.

### 2) `manage_index`
Purpose: lifecycle operations (`create`, `reindex`, `sync`, `status`, `clear`).

Inputs/defaults:
- Required: `action`, `path`.
- Optional: `force`, `allowUnnecessaryReindex`, `customExtensions`, `ignorePatterns`, `zillizDropCollection`.
- No per-action schema branching in zod; handler enforces behavior.

Outputs:
- JSON envelope (serialized in `content[0].text`) for each action:
  - `tool`, `version`, `action`, `path`
  - `status` (`ok|not_ready|not_indexed|requires_reindex|blocked|error`)
  - `reason` (when applicable)
  - `message`, `humanText`
  - optional `warnings`, `hints`, `preflight`
- `humanText` remains deterministic operator-facing guidance; structured fields are authoritative for client branching.

Warnings/hints:
- Reindex guidance text when blocked by fingerprint mismatch.
- Zilliz collection-limit guidance with explicit next action.
- Vector backend failures return structured `status=error`, `reason=vector_backend_unavailable`, stable diagnostic code, and remediation in `hints.backend`.
- `create` path resolves and can return "already indexed" guidance.
- `reindex` preflight can emit deterministic warnings (`REINDEX_UNNECESSARY_IGNORE_ONLY`, `REINDEX_PREFLIGHT_UNKNOWN`, `IGNORE_POLICY_PROBE_FAILED`).
- Runtime-owner conflicts return `status=blocked`, `reason=runtime_owner_conflict`, and `hints.runtimeOwners` / `hints.nextStep`. This blocks `create`, `reindex`, `sync`, and `clear` when another live Satori MCP runtime has a different runtime fingerprint, Satori package version, or normalized config identity.

Determinism:
- Action dispatch deterministic switch.
- Fingerprint gate deterministic via snapshot/runtime fingerprint comparison.
- Index mutations are gated by the runtime owner registry at `~/.satori/runtime/owners.json`; owner records are written with a lock and atomic rename, dead/stale owners are pruned, and live PID validation uses process identity evidence rather than PID alone.
- Reindex preflight outcomes are deterministic and bounded:
  - `reindex_required`
  - `reindex_unnecessary_ignore_only` (blocked unless `allowUnnecessaryReindex=true`)
  - `unknown` (warn-only, proceeds)
  - `probe_failed` (warn-only, proceeds)

Common recipes:
1. First-time index: `manage_index {action:"create", path}`.
2. Recovery: `manage_index {action:"reindex", path}` when blocked.
3. Immediate ignore convergence: `manage_index {action:"sync", path}`.

Behavior:
- Trigger: action call.
- Effect: runs mapped handler with validations/gates.
- Observability: structured manage envelope with stable statuses/reasons/warnings + human guidance text.
- Determinism: fixed action routing and gate checks.
- Performance: `create/reindex` background indexing; `sync` incremental; `status` read-mostly (but can mutate on fingerprint gate).

Operational rule:
- After changing `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, embedding dimension, `HYBRID_MODE`, vector backend settings, or Satori runtime version, restart all Satori MCP clients before index mutation. MCP tools do not terminate processes; cleanup is operator-owned outside the MCP tool surface.

### 3) `search_codebase`
Purpose: unified semantic retrieval with deterministic filtering/grouping/ranking/freshness.

Inputs/defaults:
- Required: `path`, `query`.
- Defaults: `scope=runtime`, `resultMode=grouped`, `groupBy=symbol`, `rankingMode=auto_changed_first`, `limit=capability default`, `debug=false`.

Outputs:
- JSON envelope: `status`, `path`, `query`, `scope`, `groupBy`, `resultMode`, `limit`, `freshnessDecision`, `freshnessSummary`, `results`, optional structured `warnings`, top-level `recommendedNextAction`, and `hints`.
- Grouped results include legacy `span`, explicit `previewSpan` and optional authoritative `symbolSpan`, plus `capabilities`, optional result-level `recommendedNextAction`, optional `fallbacks`, executable `nextActions`, and `navigationFallback` only when a deterministic preview-span fallback is intentionally allowed.
- `nextActions.openSymbol` is gated by exact symbol navigation readiness; `nextActions.callGraph` is gated separately by relationship-sidecar readiness. Search may expose `openSymbol` without exposing `callGraph`.
- If exact symbol navigation is not ready because symbol registry readiness is missing or incompatible, search suppresses preview-span action leaks: no `navigationFallback.readSpan`, no preview-span `read_file` fallback entries, and no recommended action derived from those preview spans.
- Status variants: `ok`, `not_indexed`, `requires_reindex`, `not_ready`.
- Failed index snapshots return `status:"not_indexed"` with `reason:"index_failed"`, `indexingFailure` diagnostics, and `manage_index {action:"create"}` hints. This restarts a failed partial attempt; it is not a fingerprint `reindex` requirement.

Warnings/hints:
- Search warnings are structured objects with `code`, `severity`, `blocksUse`, `message`, and optional `action`; known codes include `FILTER_MUST_UNSATISFIED`, `SEARCH_PASS_FAILED:*`, `RERANKER_FAILED`, `SEARCH_DIRTY_WORKTREE_NOT_SYNCED`, and `SEARCH_CHANGED_FILES_BOOST_SKIPPED`.
- `hints.navigation`, `hints.noiseMitigation`, `hints.debugSummary`, `hints.debugSearch`, `hints.reindex`, result `fallbacks`, and `navigationFallback`.
- Backend failures return structured `not_ready` envelopes with `reason=vector_backend_unavailable`, stable diagnostic codes such as `ZILLIZ_CLUSTER_STOPPED`, and remediation in `hints.backend`.

Determinism:
- deterministic operator parse, filter order, tie-breaks, warning sort, grouping logic, diversity selection.

Common recipes:
1. Runtime triage: `scope=runtime, resultMode=grouped, groupBy=symbol`.
2. Noise remediation: apply `.satoriignore`, wait debounce, rerun search.
3. Debug ranking: `debug:true`, inspect `hints.debugSummary` first, then drill into `hints.debugSearch` if needed.

Behavior:
- Trigger: search call.
- Effect: sync-on-read + multi-pass retrieval + deterministic post-processing.
- Effect detail: `search_codebase` remains the only sync-on-read exception in the MCP read surface. It resolves the candidate tracked root, runs freshness, reruns tracked-root readiness, and fails closed if readiness degraded before final result emission.
- Effect detail: when semantic retrieval under-delivers, exact identifiers, exact path filters, and quoted literal phrases may trigger a bounded tracked-file lexical recovery pass before final ranking/grouping.
- Observability: envelope + debug hints.
- Determinism: explicit comparator chains and bounded loops.
- Performance: bounded candidates, TTL cache, rerank top-K, coalesced freshness.

### 4) `file_outline`
Purpose: deterministic symbol outline and exact symbol resolver from the compatible symbol registry.

Inputs/defaults:
- Required: `path`, `file`.
- Defaults: `limitSymbols=500`, `resolveMode=outline`.
- Exact mode requires `symbolIdExact` or `symbolLabelExact`.

Outputs:
- JSON envelope: `status`, `path`, `file`, `outline|null`, `hasMore`, optional `message`, `warnings`, `hints`, and `indexingFailure` when the tracked root is in `indexfailed`.
- Status variants: `ok|not_found|requires_reindex|unsupported|ambiguous`.
- Failed index snapshots return `status:"not_indexed"` with `reason:"index_failed"` and `manage_index {action:"create"}` hints rather than hiding the failed-state cause behind generic `not_indexed`.

Warnings/hints:
- `OUTLINE_MISSING_SYMBOL_METADATA:<count>`.
- `OUTLINE_CALL_GRAPH_UNAVAILABLE:<reason>` when registry-backed outline succeeds but graph traversal is not available for returned symbols.
- `OUTLINE_SYMBOL_REGISTRY_WARNINGS:<count>` when the compatible registry loaded with non-fatal duplicate/candidate warnings.
- `OUTLINE_SYNTHESIZED_FILE_SYMBOL` when only a synthesized file owner is returned.
- Reindex hint payload on sidecar incompatibility.

Determinism:
- Symbol ordering deterministic by span->label->id.
- Exact mode ambiguous candidates sorted deterministically.

Common recipes:
1. Pre-read symbol map before targeted edits.
2. Exact jump resolution using `resolveMode="exact"`.

Behavior:
- Trigger: outline call.
- Effect: validates root/file/fingerprint/completion proof, loads the compatible symbol registry first, and returns deterministic registry symbols when present.
- Registry-backed outline uses `symbolInstanceId` as each outline symbol's `symbolId`. Supported graph hints use relationship-backed `symbolInstanceId` navigation.
- If the relationship sidecar is missing or incompatible with the loaded symbol registry manifest, registry-backed outline remains usable but graph hints degrade deterministically to unsupported/reindex guidance rather than reviving legacy graph hints.
- Observability: `status`, `outline`, `warnings`, `hasMore`.
- Determinism: explicit sort and exact-mode status semantics.
- Performance: sidecar lookup only; no sync-on-read.

### 5) `call_graph`
Purpose: relationship-backed caller/callee traversal from symbolRef.

Inputs/defaults:
- Required: `path`, `symbolRef`.
- Defaults: `direction=both`, `depth=1`, `limit=20`.
- Alias normalization: `bidirectional -> both`.

Outputs:
- JSON envelope with `status` plus graph payload.
- Status variants via handler mapping: `ok|not_found|unsupported|not_ready|requires_reindex|not_indexed`.
- Failed index snapshots return `status:"not_indexed"`, `reason:"index_failed"`, `supported:false`, `indexingFailure`, empty graph arrays, and `manage_index {action:"create"}` hints.
- Malformed direct handler calls fail as a normal JSON envelope with `status:"not_found"`, `reason:"invalid_symbol_ref"`, and empty `nodes`/`edges`/`notes`; normal MCP tool execution rejects malformed `symbolRef` at schema validation before dispatch.
- `sidecar.nodeCount` and `sidecar.edgeCount` report the node/edge counts returned in that traversal response. They are not whole-sidecar totals for the indexed codebase.
- `testReferences` are static call-graph references from test-like files to returned symbols. They are investigation hints only; they do not prove runtime coverage, assertion coverage, or that a test executed a path.

Warnings/hints:
- Missing sidecar: reindex hint.
- Missing symbol: advisory hint.
- Validated Python source-backed recovery keeps the suppressed low-confidence note and adds `SOURCE_BACKED_DYNAMIC_CALLEES:<n>` or `SOURCE_BACKED_DYNAMIC_CALLERS:<n>` only for exact target-validated recovery.

Determinism:
- node/edge/note sorting deterministic.
- traversal bounded by depth/limit.

Common recipes:
1. Start from search `callGraphHint.symbolRef`.
2. Use `direction=both, depth=1` then increase depth if needed.

Behavior:
- Trigger: call graph query.
- Effect: gate checks then relationship-backed sidecar traversal.
- Observability: status + nodes/edges/notes + hints.
- Determinism: fixed traversal/sort rules.
- Performance: query-side traversal only; no sync-on-read.

### 6) `read_file`
Purpose: file content retrieval with optional deterministic symbol-open and annotated outline envelope.

Inputs/defaults:
- Required: `path`.
- Optional: `start_line`, `end_line`, `mode` (`plain` default), `open_symbol`.

Outputs:
- `plain`: text content (+ truncation continuation hint).
- `annotated`: JSON `{path, mode, content, outlineStatus, outline, hasMore, warnings?, hints?}`.

Warnings/hints:
- `open_symbol` unresolved root returns structured `requires_reindex` with `hints.nextSteps`.
- Annotated mode propagates outline warnings/hints.

Determinism:
- line clamping deterministic.
- `open_symbol` delegates exact resolver and does not guess on ambiguity.

Common recipes:
1. Read bounded span around result.
2. Open exact symbol by `symbolId` or `symbolLabel`.
3. Use annotated mode to inspect sidecar readiness for the same file.

Behavior:
- Trigger: read call.
- Effect: reads file text and optionally resolves symbol span.
- Observability: plain text or annotated JSON.
- Determinism: explicit range math and exact-resolution semantics.
- Performance: local file IO; outline lookup only in annotated/open_symbol flows.

**Evidence:**
- [list_codebases.ts](/home/hamza/repo/satori/packages/mcp/src/tools/list_codebases.ts) (`listCodebasesTool`).
- [manage_index.ts](/home/hamza/repo/satori/packages/mcp/src/tools/manage_index.ts) (`actionEnum`, execute switch).
- [search_codebase.ts](/home/hamza/repo/satori/packages/mcp/src/tools/search_codebase.ts) (schema defaults, description).
- [file_outline.ts](/home/hamza/repo/satori/packages/mcp/src/tools/file_outline.ts) (exact-mode validation).
- [call_graph.ts](/home/hamza/repo/satori/packages/mcp/src/tools/call_graph.ts) (direction alias normalization).
- [read_file.ts](/home/hamza/repo/satori/packages/mcp/src/tools/read_file.ts) (`open_symbol`, annotated mode).
- [registry.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/registry.test.ts) (default-schema and description assertions).

---

## C) Search Behavior Deep Dive (search_codebase)

1) Scope semantics (`runtime|mixed|docs`)
- Trigger: `scope` input.
- Effect: `runtime` includes source/runtime/script code and test evidence while excluding docs/generated/artifacts/landing/fixtures, `docs` includes docs/tests only, `mixed` includes all.
- Observability: returned files and `hints.debugSearch.filterSummary.removedByScope`.
- Determinism: strict category gate from `shouldIncludeCategoryInScope`.
- Performance: early scope filtering reduces downstream scoring/grouping volume.

2) Result modes and grouping
- Trigger: `resultMode` and `groupBy`.
- Effect: `raw` returns chunks; `grouped` returns collapsed groups by symbol/file. For `groupBy=symbol`, grouping prefers `ownerSymbolKey` plus `ownerSymbolInstanceId` when present, repairs missing owner identity from a compatible symbol registry by file/span containment, then falls back to deterministic file/proximity grouping.
- Observability: `resultMode`, `results.kind`, legacy `span`, additive `previewSpan`, optional authoritative `symbolSpan`, additive `symbolKey`, `symbolInstanceId`, `symbolKind`, `confidence`, `collapsedChunkCount`, `callGraphHint`, compact readiness-gated `nextActions`, `recommendedNextAction`, `capabilities`, `fallbacks`, symbol-bounded capped `preview`, and `debug.symbolAggregation.ownerSource` (`owner_metadata|registry_repair|fallback`) when `debug:true`.
- Determinism: group key construction, saturated support boost, and sorted representative selection.
- Performance: grouped mode reduces result payload/noise with capped previews and shared call-graph action args; raw mode preserves chunk detail.

3) Subdirectory `effectiveRoot` resolution
- Trigger: `search_codebase.path` points to a subdirectory that is inside an indexed parent root.
- Effect: search executes against the nearest indexed parent (`effectiveRoot`), but response `path` remains the original requested path.
- Observability: logs include auto-resolve message; `navigationFallback.context.codebaseRoot` and `readSpan.args.path` resolve against `effectiveRoot`.
- Determinism: parent selection uses longest-prefix parent match with deterministic sort.
- Performance: avoids forced reindex of subdirectories by reusing parent index.

4) Operator parsing rules
- Trigger: operator-like tokens in prefix block.
- Effect: parses `lang:`, `path:`, `-path:`, `must:`, `exclude:`; escaped `\` stays literal.
- Effect (path matching semantics): `path:` and `-path:` are matched with gitignore-style patterns via the `ignore` package against normalized repo-relative paths (not minimatch semantics).
- Observability: `hints.debugSearch.operatorSummary`.
- Determinism: prefix window length cap, tokenization, quote-unescape rules, fixed key set.
- Performance: deterministic prefix parser avoids full-query parsing cost.

5) Filtering pipeline and precedence
- Trigger: candidates produced by semantic passes.
- Effect: scope -> language -> include path -> exclude path -> must -> exclude token filtering.
- Observability: `hints.debugSearch.filterSummary`.
- Determinism: fixed order in candidate loop.
- Performance: hard filters prune early before rerank/group/diversity.

5a) Bounded tracked-file lexical recovery
- Trigger: exact path filters, identifier-style lookups, quoted literal phrases, or implementation/reference/writer-seeking queries.
- Effect: scan currently tracked indexable files under active ignore rules with hard file/byte/result caps, recover exact lexical evidence when vector retrieval misses it, and merge those hits into normal ranking/grouping with provenance `lexical_files`.
- Observability: `hints.debugSearch.passesUsed`, `hints.debugSearch.trackedLexical`, per-result `debug.provenance.retrievalPasses`, and `queryIntent.reasons` such as `quoted_literal_query`.
- Determinism: tracked path set is normalized/sorted, exact path filters sort first, and lexical candidates tie-break by exact-match flag -> score -> file -> line.
- Performance: bounded by hard caps; this is not an unbounded whole-repo grep fallback.

5b) Exact registry identifier fast path
- Trigger: grouped symbol searches with exact identifier-like queries, current compatible symbol registry, and no ambiguous exact owner.
- Effect: after freshness gates pass, exact symbol registry hits can return a symbol group before semantic/vector search, tracked lexical scan, or rerank. Ambiguous/missing registry matches fall back to the normal search path without guessing; exact-eligible fallback uses the primary semantic pass plus bounded lexical recovery, not the expanded semantic pass.
- Observability: `hints.debugSearch.exactRegistry`, `hints.debugSearch.phaseTimingsMs`, `hints.debugSearch.passesUsed`, and per-result `debug.provenance.retrievalPasses` include `exact_registry` on hits. Missing or incompatible registry state reports `exactRegistry.reason=registry_unavailable` when `debug:true`.
- Determinism: exact path filters inspect only that file's registry symbols; unscoped duplicate exact names are ambiguous and fall back.
- Performance: warm exact identifier lookup avoids vector search, tracked lexical scan, and rerank when the registry hit is unique.

6) Must retry
- Trigger: active `must:` constraints and insufficient results.
- Effect: bounded retries with `candidateLimit` expansion.
- Observability: `hints.debugSearch.mustRetry` and warning `FILTER_MUST_UNSATISFIED` only when final scored list is empty.
- Determinism: `maxAttempts=1+SEARCH_MUST_RETRY_ROUNDS`, multiplier, hard cap.
- Performance: bounded expansion prevents runaway fetch.

7) Diversity caps
- Trigger: grouped mode result post-sort.
- Effect: cap per file and per symbol; deterministic relaxed second pass if underfilled.
- Observability: `hints.debugSearch.diversitySummary`.
- Determinism: fixed caps and stable iteration order.
- Performance: small additional pass; improves top-K coverage quality without re-query.

8) Changed-files boost
- Trigger: `rankingMode=auto_changed_first`.
- Effect: tracked git-changed files get multiplicative boost when changed-file count is within threshold.
- Observability: `freshnessSummary.changedFileCount`, `freshnessSummary.gitDirtyFilesConsidered`, `freshnessSummary.changedFilesBoostApplied` (true only when at least one candidate was boosted), `freshnessSummary.changedFilesBoostSkippedForLargeChangeSet`, and `hints.debugSearch.changedFilesBoost` when `debug:true`.
- Warnings: structured `SEARCH_DIRTY_WORKTREE_NOT_SYNCED` when tracked dirty files are visible but freshness did not sync/reconcile, and structured `SEARCH_CHANGED_FILES_BOOST_SKIPPED` when the dirty set exceeds the boost threshold. Each warning carries an action string for the caller.
- Determinism: tracked-only porcelain parse, normalized paths, TTL-cached set, threshold disable path.
- Performance: one cached git status call per TTL window (5s), fallback to stale cache on git failure.

8a) Owner-vs-wrapper ranking
- Trigger: implementation/owner-oriented search where adapters/tool wrappers and core implementation files both match.
- Effect: canonical core/runtime owners receive stronger path-category weighting than adapters/wrappers; adapters remain searchable but are downweighted.
- Observability: `hints.debugSearch` result debug includes `pathCategory` and `pathMultiplier` when `debug:true`.
- Determinism: fixed `PathCategory` classifier and `SCOPE_PATH_MULTIPLIERS`.
- Performance: path-only scoring adjustment; no extra backend calls.

8b) Agent-fit ranking
- Trigger: runtime or mixed search result scoring.
- Effect: implementation-owner queries prefer implementation symbols/chunks and top-level `scripts/**` over tests, docs, interfaces/types, schema-only results, and anonymous callbacks. Test/spec/coverage queries keep tests eligible for top ranking.
- Observability: result debug includes `agentFitMultiplier` and `agentFitReason` when `debug:true`.
- Determinism: fixed query-intent regexes and fixed multipliers; no extra backend calls.
- Performance: metadata/content-prefix scoring adjustment only.

8c) Structural-anchor sibling demotion
- Trigger: mixed or semantic lexical scoring when the query contains high-signal structural anchors such as exact phase/path tokens.
- Effect: exact anchor hits still receive the existing pre-weight lexical boost, while sibling near misses that share the same prefix structure but differ on the terminal anchor segment (for example `phase6p` vs `phase6m`) receive a pre-weight lexical demotion. Neutral candidates that simply lack the sibling anchor are not penalized.
- Observability: `results[].debug.lexicalScore` reflects the pre-weight adjustment and should rank exact anchor hits above sibling near misses even when backend scores are otherwise parallel.
- Determinism: fixed anchor token splitting and sibling comparison rules; no fuzzy edit-distance matching.
- Performance: lexical-only adjustment; no extra backend calls.

9) Noise mitigation hint
- Trigger: top visible results exceed noise ratio threshold.
- Effect: emits deterministic mitigation payload (`ratios`, `recommendedScope`, patterns, debounce, nextStep) with root `.gitignore` redundancy suppression.
- Observability: `hints.noiseMitigation` with `version=1`.
- Determinism:
  - fixed category precedence `generated > fixture > landing > artifact > tests > docs > example > adapter > entrypoint > core > srcRuntime > neutral`, topK fixed cap; `scriptRuntime` is a runtime path category, not a noise bucket.
  - suggestion order remains stable (`SEARCH_NOISE_HINT_PATTERNS` order).
  - suppression is path-observed over top-K noisy files only.
  - fallback to baseline suggestions when root `.gitignore` matcher state is absent/error.
  - forced matcher reload cadence plus `mtimeMs+size` invalidation for coarse filesystems.
- Performance: lightweight classification on visible top-K only.

10) Reranking
- Trigger: policy enable + non-docs scope + reranker present + scored candidates.
- Effect: reranks top-K slice, converts rerank order to rank-only RRF boost, recomputes final score and resorts.
- Observability: `hints.debugSearch.rerank`; structured warnings include `RERANKER_FAILED` on degradation.
- Observability (precedence semantics): debug exposes `enabledByPolicy`, `capabilityPresent`, `rerankerPresent`, and final `enabled`.
- Determinism (precedence): rerank is attempted only when all are true: policy-enabled, capability present, reranker instance present, and scope is not docs. If policy is enabled but instance is missing, rerank is not attempted and no warning is emitted.
- Determinism: fixed K/weight/rankK constants, stable comparator after rerank.
- Performance: bounded call to reranker on at most 50 docs.

11) Final ordering tie-breakers
- Trigger: candidate/group score ties.
- Effect: stable chain by score desc then file asc, start line asc, symbol label asc, symbol id asc.
- Observability: repeated identical query on stable snapshot yields same ordering.
- Determinism: explicit comparator code for candidate, chunk-in-group, and final group sort.
- Performance: standard O(n log n) sorts with deterministic keys.

Recent vs legacy:
- Legacy `useReranker` input has been removed; rerank is policy-driven now.
- Legacy splitter control in `manage_index` removed from public schema.
- `manage_index` now returns structured envelopes (not text-only contract).
- `manage_index` reindex preflight guard rails added with explicit override knob (`allowUnnecessaryReindex`).
- Warning semantics for must constraints tightened to final unsatisfied only.

**Evidence:**
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (`parseSearchOperators`, `shouldIncludeCategoryInScope`, candidate filtering loop, must retry loop, rerank block, sorting comparators, `buildNoiseMitigationHint`, `applyGroupDiversity`).
- [search-constants.ts](/home/hamza/repo/satori/packages/mcp/src/core/search-constants.ts) (all caps/thresholds/weights/defaults).
- [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) (`docs scope`, `parses operators`, must warning tests, diversity tests, changed-files boost tests, rerank policy/failure tests, noise hint tests, deterministic fallback/navigation tests).
- [search.eval.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/search.eval.test.ts) (deterministic matrix invariants).
- [CHANGELOG.md](/home/hamza/repo/satori/CHANGELOG.md) (`Sole-User Retrieval Precision Upgrades`, `Neural Reranker Integration`, `MCP Surface Simplification`).

---

## D) Navigation + Symbol Semantics

1) `callGraphHint` semantics
- Trigger: grouped search result construction.
- Effect: returns `{supported:true,symbolRef,validated:true,validatedAt,sidecarBuiltAt}` when graph readiness is established through a compatible relationship sidecar bound to the loaded symbol registry manifest hash. On symbol-owned flows, `symbolRef.symbolId` carries the owner `symbolInstanceId`. Otherwise returns `{supported:false,reason}`.
- Observability: `results[].callGraphHint`.
- Determinism: supported symbolRef uses deterministic registry file/span metadata on symbol-owned flows; unsupported search hint reasons are limited to `missing_symbol`, `unsupported_language`, `missing_symbol_registry`, `missing_relationship_sidecar`, `incompatible_symbol_registry`, `incompatible_relationship_sidecar`, and `stale_symbol_ref`. The direct `call_graph` handler keeps the public `invalid_symbol_ref` reason for malformed direct handler input, but emits it inside the normal call-graph envelope. Legacy low-level sidecar diagnostics may still use `missing_sidecar`, but current public handlers normalize unavailable navigation state to the precise registry/relationship reasons above.
- Performance: no graph query until explicit `call_graph` call.

2) `navigationFallback`
- Trigger: `callGraphHint.supported === false`.
- Effect: emits executable fallback plan derived from `previewSpan` (`readSpan` always; `fileOutlineWindow` when sidecar-ready and extension supports outline). `symbolSpan` remains authoritative owner metadata for exact navigation when available.
- Observability: `results[].navigationFallback`.
- Determinism: executable fallback args are derived deterministically from representative chunk/effective root; preview-span fallback and owner-symbol span remain distinct fields in grouped results.
- Performance: no extra backend calls; payload-only guidance.

3) `file_outline` exact resolution
- Trigger: `resolveMode="exact"` with `symbolIdExact` or `symbolLabelExact`.
- Effect: `ok` for single match, `ambiguous` for multiple, `not_found` for none.
- Observability: envelope `status`, `outline.symbols`, `message`, `hasMore`.
- Determinism: exact matches explicitly sorted before truncation.
- Performance: sidecar in-memory filter/sort on one file.

4) `read_file open_symbol`
- Trigger: `open_symbol` in read request.
- Effect: direct span open when `start_line` provided; else exact symbol resolve via `file_outline`; ambiguous/not_found become explicit error payload.
- Observability: error JSON with `status`, `message`, optional `matches`/`warnings`/`hints`.
- Determinism: does not guess symbol on ambiguity.
- Performance: single extra resolver call only when needed.

5) Annotated read mode
- Trigger: `mode="annotated"`.
- Effect: returns content plus outline metadata (`outlineStatus`, `outline`, `hasMore`, optional hints/warnings).
- Observability: JSON annotated envelope.
- Determinism: stable status coercion (`ok|requires_reindex|unsupported|ambiguous`).
- Performance: optional outline lookup; plain mode remains cheaper.

**Evidence:**
- [search-types.ts](/home/hamza/repo/satori/packages/mcp/src/core/search-types.ts) (`CallGraphHint`, `SearchNavigationFallback*`, file outline statuses).
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (`buildCallGraphHint`, `buildNavigationFallback`, `handleFileOutline`, exact mode logic).
- [read_file.ts](/home/hamza/repo/satori/packages/mcp/src/tools/read_file.ts) (`open_symbol` resolution and ambiguous/not_found handling).
- [handlers.file_outline.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.file_outline.test.ts) (exact `ok|ambiguous|not_found`).
- [tools/read_file.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/read_file.test.ts) (open_symbol next steps and annotated semantics).
- [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) (`navigationFallback` assertions incl. subdirectory root case).

---

## E) Indexing + Freshness + Ignore Semantics

1) `manage_index` action semantics
- Trigger: action dispatch.
- Effect: create/reindex start background indexing, sync runs incremental `reindexByChange`, status reports current state, clear removes index+snapshot state.
- Observability: action-specific textual responses and logs; indexing-blocked responses include `retryAfterMs=2000`, independent of watcher debounce.
- Determinism: absolute-path enforcement and status/fingerprint gates.
- Performance: create/reindex heavy background operation, sync incremental.
- Partial index behavior: when full indexing returns `limit_reached`, search may expose the partial vector state, but complete navigation sidecars are not published. `file_outline` and `call_graph` must fail closed with `requires_reindex` and reason `partial_index_navigation_unavailable` rather than treating the missing registry as an ordinary sidecar miss.

2) Sync-on-read (`ensureFreshness`)
- Trigger: `search_codebase` call.
- Effect: runs freshness gate with threshold `3 minutes`; may sync/coalesce/skip.
- Observability: `freshnessDecision` in search envelope (`synced|skipped_recent|coalesced|...`) plus `freshnessSummary` (`syncMode`, `lastSyncAt`, dirty-file count, and boost application/skip booleans).
- Determinism: fixed gate order and thresholds.
- Performance: avoids repeated sync with throttling/coalescing.
  Implementation nuance: only `search_codebase` calls `ensureFreshness`; `file_outline` and `call_graph` do not run sync-on-read freshness and do not run cloud-state snapshot reconciliation in foreground.

3) Ignore controls (repo-root `.satoriignore`, repo-root `.gitignore`)
- Trigger: control-file signature mismatch or watcher control-file event.
- Effect: ignore-rule reconcile path reloads matcher, deletes newly ignored indexed paths from manifest/vector index, then forced incremental sync for newly unignored content.
- Observability: reconcile decision modes and counts (`deletedFiles`, `newlyIgnoredFiles`, `addedFiles`, `ignoreRulesVersion`).
- Determinism: signature is a content hash of root ignore control files; manifest snapshot captured before synchronizer recreation.
- Performance: no full reindex; targeted delete + incremental sync.

4) Watcher vs non-watcher behavior
- Trigger: watcher-enabled mode vs on-demand sync path.
- Effect: watcher schedules debounced sync/reconcile only for codebases in the current session watch list; non-watcher still converges via signature check in `ensureFreshness`.
- Observability: watcher logs and `freshnessDecision`.
- Determinism: debounce window fixed by config/env; coalescing maps prevent duplicate concurrent runs.
- Performance: watcher reduces manual sync need; signature check keeps non-watcher convergence cheap.

5) Fingerprint/reindex gate
- Trigger: incompatible/missing/legacy fingerprint on access.
- Effect: status transitions/blocked responses with `requires_reindex` envelopes and explicit reindex hints.
- Observability: compatibility diagnostics (`runtimeFingerprint`, `indexedFingerprint`, source/reason/statusAtCheck`).
- Determinism: deterministic gate in snapshot manager + handler enforcement.
- Performance: avoids unsafe mixed-runtime read/search behavior.

Recent vs legacy:
- Legacy duplicate ignore-source loading in sync manager was removed; context now drives effective ignore rules.
- Ignore reconciliation now runs in normal path via signature check, not watcher-only.

**Evidence:**
- [manage_index.ts](/home/hamza/repo/satori/packages/mcp/src/tools/manage_index.ts) (action dispatch).
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (`handleIndexCodebase`, `handleReindexCodebase`, `handleSyncCodebase`, `handleGetIndexingStatus`, `handleClearIndex`, `enforceFingerprintGate`).
- [sync.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.ts) (`ensureFreshness`, `runIgnoreReconcile`, `reconcileIgnoreRulesChange`, watcher scheduling/coalescing).
- [snapshot.ts](/home/hamza/repo/satori/packages/mcp/src/core/snapshot.ts) (`ensureFingerprintCompatibilityOnAccess`, status transitions, ignore signature/version fields).
- [sync.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.test.ts) (reconcile ordering/coalescing/signature-before-throttle and failure fallback tests).
- [handlers.call_graph.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.call_graph.test.ts) and [handlers.file_outline.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.file_outline.test.ts) (requires_reindex envelopes).
- [handlers.index_state_stability.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.index_state_stability.test.ts) (stale-local/probe-failed/fingerprint-mismatch mappings and foreground non-mutation expectations).

---

## F) Core Sync (packages/core) — “Trust Contract”

1) Snapshot identity policy
- Trigger: synchronizer construction or snapshot delete.
- Effect: canonicalized codebase path (resolve + realpath fallback + trim) maps to one snapshot path.
- Observability: snapshot file path from `getSnapshotPathForCodebase`; parity tests across variants.
- Determinism: single SSOT helper chain.
- Performance: prevents duplicate snapshots/redundant scans.

2) Stat-first + hash-on-change
- Trigger: `checkForChanges`.
- Effect: reuses prior hash when signature unchanged; hashes bytes only for changed/new candidates.
- Observability: `hashedCount` diagnostics and integration tests.
- Determinism: signature compare and sorted traversal order.
- Performance: major IO/CPU reduction vs full rehash.

3) Deterministic merkle root
- Trigger: state rebuild after scan/effective-state merge.
- Effect: root computed from sorted `(relativePath, hash)` stream with fixed separators.
- Observability: snapshot `merkleRoot`.
- Determinism: sorted entries and fixed encoding.
- Performance: linear hash over keys/hashes only.

4) Partial-scan preservation
- Trigger: unreadable dir/file/stat/hash failures.
- Effect: preserve prior entries under unreadable file set and unscanned prefixes; do not mark false removals.
- Observability: `partialScan`, `unscannedDirPrefixes`, absence from `removed/modified`.
- Determinism: normalized/compressed prefixes and segment-safe matching (`prefix==path || path starts prefix + "/"`).
- Performance: continues progress without destructive churn.
  Tradeoff: true removals under unreadable prefixes can be delayed until readability is restored.

5) Normalization SSOT
- Trigger: path ingestion from scan/snapshot/diff.
- Effect: normalized keys (`\ -> /`, collapse `//`, trim `./`, reject `..`).
- Observability: persisted snapshot keys and diff outputs.
- Determinism: one normalizer used throughout.
- Performance: avoids duplicate-key churn and redundant diffs.

6) Save gating and counters
- Trigger: post-scan comparison.
- Effect: snapshot write only when diffs, hashes recomputed, metadata changed, or full-hash counter advanced.
- Observability: file changes + `hashedCount` + `fullHashRun`.
- Determinism: explicit gating predicate.
- Performance: avoids unnecessary writes while preventing rehash loops.

7) Optional paranoia mode
- Trigger: env `SATORI_SYNC_FULL_HASH_EVERY_N > 0`.
- Effect: periodic forced full-hash run.
- Observability: `fullHashRun=true` in result.
- Determinism: counter-based interval.
- Performance: controlled extra cost for integrity hardening.

**Evidence:**
- [synchronizer.ts](/home/hamza/repo/satori/packages/core/src/sync/synchronizer.ts) (`canonicalizeSnapshotIdentityPath`, `snapshotPathFromCanonicalPath`, `getSnapshotPathForCodebase`, `normalizeRelPath`, `scanDirectory`, `hashCandidatesWithConcurrency`, `buildEffectiveState`, `checkForChanges`, `deleteSnapshot`).
- [merkle.ts](/home/hamza/repo/satori/packages/core/src/sync/merkle.ts) (`computeMerkleRoot`).
- [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) (identity parity, touch settle, unreadable preservation, normalization, prefix compression, removal detection, binary hashing, restart detection).
- [CHANGELOG.md](/home/hamza/repo/satori/CHANGELOG.md) (`Core Sync Determinism and Hash-on-Change Refactor`, `P0 Sync Identity and Determinism Hardening`).

---

## G) Background vs Foreground Work (What happens “behind your back”)

1) Background periodic sync
- Trigger: server startup.
- Effect: timer starts after 5s, then sync loop every 3 minutes with non-overlapping recursive scheduling.
- Observability: sync logs and updated snapshot statuses.
- Determinism: fixed timer durations.
- Performance: amortized freshness maintenance without request-blocking.

2) Watcher registration and debounce
- Trigger: server startup with watcher enabled, then later successful index/search/navigation/read activity on searchable codebases.
- Effect: startup enables watcher mode but does not register all indexed roots; chokidar watchers register only for codebases in the current session watch list; events coalesce by debounce; ignore-control files route to ignore reconcile.
- Observability: `[SYNC-WATCH]` logs and reconcile decisions.
- Determinism: fixed debounce, status gating, coalesced edit counting.
- Performance: avoids stormed sync calls.

3) Sync-on-read
- Trigger: `search_codebase`.
- Effect: `ensureFreshness` gate may sync, coalesce, or skip.
- Observability: `freshnessDecision`.
- Determinism: threshold and gate ordering fixed.
- Performance: skips frequent redundant sync.

4) Call graph sidecar rebuilds
- Trigger: indexing completion, manual sync with supported delta, and sync lifecycle callback.
- Effect: rebuilds sidecar and updates snapshot sidecar metadata.
- Observability: `[CALL-GRAPH]` logs and sidecar info in snapshot.
- Determinism: rebuild only when delta policy returns true.
- Performance: avoids full rebuild on irrelevant changes.

5) Git changed-files cache
- Trigger: `search_codebase` with `rankingMode=auto_changed_first`.
- Effect: caches parsed changed-file set for TTL; stale cache reused on transient git failures.
- Observability: debug `changedFilesBoost` fields.
- Determinism: fixed parse normalization and TTL path.
- Performance: prevents repeated git status calls and ranking flaps.

6) Background indexing
- Trigger: `manage_index create/reindex`.
- Effect: async indexing with periodic snapshot progress saves.
- Observability: `[BACKGROUND-INDEX]` logs + status snapshots.
- Determinism: status state machine updates are explicit.
- Performance: decouples indexing from request latency.

7) Foreground compatibility gating that can mutate snapshot state
- Trigger: foreground calls that invoke fingerprint compatibility checks (for example status/search/call_graph/file_outline paths through handler gates).
- Effect: incompatible entries can transition to `requires_reindex`, and snapshot is persisted when gate changes state.
- Observability: `requires_reindex` responses and compatibility diagnostics fields.
- Determinism: runtime-vs-indexed fingerprint comparison and gate transitions are deterministic.
- Performance: cheap metadata check that avoids unsafe reads on incompatible indexes.

8) Cloud-state snapshot repair is not part of steady-state runtime
- Trigger: none in the current public runtime path.
- Effect: foreground handlers and maintenance handlers do not repair local ready state from cloud collection existence alone.
- Observability: absence of any foreground cloud-reconcile log or handler path; readiness remains gated by local snapshot state plus completion proof.
- Determinism: cloud collection existence is not completion proof, and explicit create/reindex remains the only recovery path when local ready state is missing or incompatible.
- Performance: no cloud reconcile overhead on foreground reads.

9) Snapshot persistence hardening (multi-process)
- Trigger: any snapshot save/load under concurrent processes.
- Effect:
  - lock acquisition uses stale-lock owner checks (PID metadata + liveness) before breaking stale locks;
  - lock wait never uses CPU-spin fallback;
  - local-vs-disk merge uses deterministic state-class precedence (`indexing` > `indexfailed|requires_reindex` > `indexed|sync_completed`) with indexing progress tie-break and stale-indexing age guard;
  - startup load writes only when semantic representation changed (migration or canonicalized-pruning difference);
  - corrupt snapshots are preserved to `.corrupt-<pid>-<timestamp>-*` before in-memory reset (rename under lock, copy fallback when lock unavailable).
- Observability: `[SNAPSHOT]` lock warnings, malformed-entry warnings, corrupt quarantine log lines.
- Determinism: canonical stable-serialization comparison for save-on-load gating; indexed list ordering is lexicographically stable.
- Performance: avoids unconditional startup writes and skips O(n) derived-state rebuild for metadata-only setters.

**Evidence:**
- [index.ts](/home/hamza/repo/satori/packages/mcp/src/index.ts) (`start`, background sync/watcher startup, lifecycle callback).
- [sync.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.ts) (`startBackgroundSync`, watcher methods, debounce scheduling).
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (`startBackgroundIndexing`, changed-files cache methods, search freshness call).
- [call-graph.ts](/home/hamza/repo/satori/packages/mcp/src/core/call-graph.ts) (`shouldRebuildForDelta`, `rebuildIfSupportedDelta`).
- [snapshot.ts](/home/hamza/repo/satori/packages/mcp/src/core/snapshot.ts) (lock + merge + load/save gating + quarantine behavior).
- [snapshot.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/snapshot.test.ts) (hardened invariants for lock safety, merge precedence, migration-save gating, metadata-setter behavior, and quarantine).

---

## H) Configuration & Tunables

Core MCP runtime:
- `MCP_ENABLE_WATCHER` default `true`.
- `MCP_WATCH_DEBOUNCE_MS` default `5000` (fallback to default on invalid value).
- Indexing-blocked manage responses use fixed `retryAfterMs=2000`; this is a polling hint, not a watcher debounce.
- `READ_FILE_MAX_LINES` default `1000`.
- `VOYAGEAI_RERANKER_MODEL` default `rerank-2.5`.
- `EMBEDDING_PROVIDER` default `VoyageAI`.
- `EMBEDDING_MODEL` provider-specific default.
- `HYBRID_MODE` controls runtime fingerprint schema version (`hybrid_v3` default if unset).

Search constants:
- `SEARCH_MAX_CANDIDATES=80`.
- `SEARCH_OPERATOR_PREFIX_MAX_CHARS=200`.
- `SEARCH_MUST_RETRY_ROUNDS=2`.
- `SEARCH_MUST_RETRY_MULTIPLIER=2`.
- `SEARCH_DIVERSITY_MAX_PER_FILE=2`, `SEARCH_DIVERSITY_MAX_PER_SYMBOL=1`, relaxed file cap `3`.
- `SEARCH_CHANGED_FILES_CACHE_TTL_MS=5000`.
- `SEARCH_CHANGED_FIRST_MULTIPLIER=1.10`.
- `SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES=50`.
- `SEARCH_RERANK_TOP_K=50`, `SEARCH_RERANK_RRF_K=10`, `SEARCH_RERANK_WEIGHT=1.0`.
- `SEARCH_RERANK_DOC_MAX_LINES=200`, `SEARCH_RERANK_DOC_MAX_CHARS=4000`.
- `SEARCH_NOISE_HINT_TOP_K=5`, `SEARCH_NOISE_HINT_THRESHOLD=0.60`.
- Staleness thresholds: fresh `30m`, aging `24h`.

Core synchronizer tunables:
- `SATORI_SYNC_HASH_CONCURRENCY` default `16` (clamped `1..64`).
- `SATORI_SYNC_FULL_HASH_EVERY_N` default `0` (disabled; clamped `0..1,000,000`).

Behavior contract:
- Trigger: env var/constant use at startup or per request.
- Effect: modifies debounce, limits, candidate caps, caching windows, rerank behavior, hash cadence.
- Observability: debug payload, logs, and returned hints.
- Determinism: constants and clamped parsing enforce stable behavior.
- Performance: these are the primary CPU/IO/latency control points.

**Evidence:**
- [config.ts](/home/hamza/repo/satori/packages/mcp/src/config.ts) (`DEFAULT_WATCH_DEBOUNCE_MS`, env parsing, defaults).
- [search-constants.ts](/home/hamza/repo/satori/packages/mcp/src/core/search-constants.ts) (all search tunables).
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (changed-files cache, rerank and retry usage).
- [synchronizer.ts](/home/hamza/repo/satori/packages/core/src/sync/synchronizer.ts) (sync env parsing/clamps).
- [README.md](/home/hamza/repo/satori/packages/mcp/README.md) (public docs for key runtime vars).

---

## I) Operational Runbook (Sole-user)

1) First-time setup
- Call `manage_index {action:"create", path:"/abs/repo"}`.
- Check `manage_index {action:"status", path:"/abs/repo"}` until indexed.
- Use `list_codebases` to verify tracked roots.
- If status returns reindex instruction, run `manage_index {action:"reindex", path:"/abs/repo"}`.

2) “Search returns noise”
- Use `search_codebase` with `scope:"runtime", resultMode:"grouped", groupBy:"symbol"`.
- If `hints.noiseMitigation` appears, edit repo-root `.satoriignore` with suggested patterns.
- Wait one debounce window (`hints.noiseMitigation.debounceMs`) or run `manage_index {action:"sync", path:"<same search path>"}`.
- Re-run `search_codebase`.

3) “requires_reindex”
- Any tool returning `status:"requires_reindex"` with `hints.reindex` should be remediated by `manage_index {action:"reindex", path:hints.reindex.args.path}`.
- Re-run original tool call after reindex.

4) “failed index”
- Any search/navigation tool returning `status:"not_indexed"` with `reason:"index_failed"` is preserving a failed lifecycle state from the snapshot. Inspect `indexingFailure`, then run `manage_index {action:"create", path:hints.create.args.path}` when you want to restart that failed partial attempt.
- Do not convert `reason:"index_failed"` into `reindex`; `reindex` is reserved for explicit `requires_reindex` compatibility gates.

5) “call graph not ready”
- If `call_graph` returns `not_ready`, `missing_symbol_registry`, `missing_relationship_sidecar`, `incompatible_symbol_registry`, or `incompatible_relationship_sidecar`, reindex.
- While waiting, use `search_codebase` `navigationFallback.readSpan` and optional `fileOutlineWindow` only when they are actually emitted.
- If search emits `openSymbol` without `callGraph`, read the exact symbol first and treat graph traversal as unavailable until readiness is repaired.

6) “partial scan detected” (core sync)
- Observe `partialScan=true` and `unscannedDirPrefixes` in core sync diagnostics.
- Restore permissions/access for unreadable files/dirs.
- Re-run sync/search; verify no false removals and eventual convergence.
- If persistent, inspect ignore patterns and filesystem permissions.

6) “collection limit reached”
- On create, if collection-limit guidance appears, explicitly choose a collection to drop.
- Retry with `manage_index {action:"create", path:"<target>", zillizDropCollection:"<chosen_collection>"}`.
- Current product behavior: handler returns guided text (often as `isError:true`) and expects operator decision. “ask user confirmation before delete” is an AGENTS/process policy, not a hard-coded MCP schema confirmation flag.

Behavior contract:
- Trigger: operational failure mode.
- Effect: deterministic remediation path with explicit tool calls.
- Observability: status/warnings/hints fields and action responses.
- Determinism: each failure mode has fixed next-step actions.
- Performance: prefers incremental sync/reconcile over reindex except incompatibility gates.

**Evidence:**
- [handlers.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.ts) (`buildReindexHint`, requires_reindex payload builders, `buildCollectionLimitMessage`, sync/create behavior).
- [search-types.ts](/home/hamza/repo/satori/packages/mcp/src/core/search-types.ts) (hints/warnings envelopes).
- [sync.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.ts) (ignore reconcile and watcher debounce behavior).
- [README.md](/home/hamza/repo/satori/packages/mcp/README.md) (public remediation docs).
- [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) (noise mitigation and fallback behavior assertions).

---

## J) Regression Matrix

| Feature | Proof Test (file + anchor) |
|---|---|
| Index profiles and safe-broad file policy | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `default profile tracks safe-broad...`, `minimal profile excludes config...`, `all-text profile tracks unknown UTF-8...` |
| Language router capability honesty | [registry.test.ts](/home/hamza/repo/satori/packages/core/src/language/registry.test.ts) extension, filename, alias, and search-only capability assertions |
| Symbol-owned retrieval contract types | [contracts.test.ts](/home/hamza/repo/satori/packages/core/src/symbols/contracts.test.ts) schema versions, manifest guards, canonical span serialization, relationship manifest validation |
| Owner metadata assignment and persistence | [registry.test.ts](/home/hamza/repo/satori/packages/core/src/symbols/registry.test.ts) owner resolver tightest span/fallback/tie-break tests; [context.test.ts](/home/hamza/repo/satori/packages/core/src/core/context.test.ts) vector document owner metadata assertions |
| Symbol-owned grouped search aggregation | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `grouped symbol mode collapses chunks by owner symbol key...`, `grouped symbol mode repairs legacy chunks from compatible symbol registry ownership`, `keeps same-label declaration groups separate...` |
| Installer `--profile` repo config | [install.test.ts](/home/hamza/repo/satori/packages/cli/src/install.test.ts) `install --profile writes repo config`, [install.test.ts](/home/hamza/repo/satori/packages/mcp/src/cli/install.test.ts) `install --profile writes repo config` |
| `satori.toml` freshness reconciliation | [sync.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.test.ts) `ensureFreshness treats satori.toml as an index-policy control file` |
| Search scope runtime/docs invariants + ordering determinism | [search.eval.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/search.eval.test.ts) `search eval matrix invariants hold...` |
| Operator parsing + escaping | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `parses operators from query prefix...` |
| Must warning semantics | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `emits FILTER_MUST_UNSATISFIED...`, `does not emit ... when must succeeds after retry` |
| Diversity default behavior | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `grouped diversity keeps multi-file coverage by default` |
| Changed-files freshness summary, boost threshold + cache fallback | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `applies changed-files boost...`, `exposes freshness summary...`, `skips boost when changed set exceeds threshold`, `reuses stale cache on git status failure` |
| Owner-vs-wrapper ranking | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `ranks canonical owners above tool wrappers...` |
| Rerank docs-scope policy skip | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `policy mode skips reranker for docs scope...` |
| Rerank degraded failure path debug code | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `degrades gracefully when reranker fails` |
| Missing reranker clamp behavior | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `rerank.enabled=false when reranker instance is missing` |
| Rerank can alter representative chunk before grouping | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `reranker can change grouped representative chunk selection...` |
| Noise mitigation hint deterministic payload | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `emits deterministic noiseMitigation hint...`, `omits ... runtime-dominant` |
| Fallback groupId + navigation fallback stability | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `grouped fallback emits stable hash groupId...` |
| Search navigation next-step hint | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `grouped output includes compact nextActions...` |
| Subdirectory query fallback context correctness | [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts) `subdirectory query builds navigationFallback from effectiveRoot...` |
| Backend diagnostics for stopped/unavailable vector backend | [setup-errors.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/setup-errors.test.ts), [search_codebase.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/search_codebase.test.ts), [manage_index.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/manage_index.test.ts) |
| `file_outline` exact mode statuses | [handlers.file_outline.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.file_outline.test.ts) `exact mode resolves unique`, `returns ambiguous`, `returns not_found` |
| `file_outline` requires_reindex/metadata warning | [handlers.file_outline.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.file_outline.test.ts) `returns requires_reindex...`, `OUTLINE_MISSING_SYMBOL_METADATA` |
| `call_graph` requires_reindex and status mapping | [handlers.call_graph.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.call_graph.test.ts) `requires_reindex envelope...`, `maps missing_symbol to not_found` |
| `call_graph` direction alias | [tools/call_graph.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/call_graph.test.ts) `normalizes direction bidirectional to both` |
| `list_codebases` deterministic bucket/path ordering | [tools/list_codebases.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/list_codebases.test.ts) `list_codebases output is deterministic with fixed bucket order and sorted paths` |
| `read_file` open_symbol remediation + annotated behavior | [tools/read_file.test.ts](/home/hamza/repo/satori/packages/mcp/src/tools/read_file.test.ts) open_symbol next-step tests and annotated mode assertions |
| Sync manager ignore reconcile ordering/coalescing | [sync.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.test.ts) manifest pre-reload deletion and coalescing tests |
| Signature-trigger reconcile before recent-skip gate | [sync.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.test.ts) signature mismatch vs skipped_recent regression test |
| Core snapshot identity parity + deleteSnapshot SSOT | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `snapshot identity parity... deleteSnapshot SSOT` |
| No-change no-work + touch settle | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `unchanged files do not rehash and touch-only changes settle` |
| True removals detected | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `true file removals are detected deterministically` |
| Restart delta detection | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `restart preserves snapshot baseline...` |
| Byte hashing correctness | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `binary files are hashed as bytes...` |
| Partial-scan unreadable file preservation | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `unreadable file hash-fail triggers partial scan...` |
| Partial-scan unreadable dir preservation | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `unreadable directory triggers partial scan...` |
| Path normalization SSOT | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `normalization SSOT applies... including backslashes` |
| Segment-safe prefix rule | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `segment-safe prefix handling does not preserve sibling directories` |
| Prefix compression determinism | [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs) `prefix normalization and compression are deterministic` |
| CI hard gate exists | [ci.yml](/home/hamza/repo/satori/.github/workflows/ci.yml) `core_sync_gate` job |

**Evidence:**
- [handlers.scope.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.scope.test.ts)
- [registry.test.ts](/home/hamza/repo/satori/packages/core/src/language/registry.test.ts)
- [contracts.test.ts](/home/hamza/repo/satori/packages/core/src/symbols/contracts.test.ts)
- [handlers.file_outline.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.file_outline.test.ts)
- [handlers.call_graph.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/handlers.call_graph.test.ts)
- [sync.test.ts](/home/hamza/repo/satori/packages/mcp/src/core/sync.test.ts)
- [synchronizer.integration.test.mjs](/home/hamza/repo/satori/tests/integration/synchronizer.integration.test.mjs)
- [ci.yml](/home/hamza/repo/satori/.github/workflows/ci.yml)

---

## Known Gaps / Unverified Claims
- UNVERIFIED: exact call-graph language support matrix as a frozen public contract.
  - Why: runtime support derives from `getSupportedExtensionsForCapability('callGraphQuery')` in core capability registry, not hardcoded in MCP.
  - Add test/doc anchor: assert extension set snapshot in `packages/mcp/src/core/call-graph.test.ts` and mirror in README table.
- UNVERIFIED: destructive `manage_index clear` requiring explicit user confirmation is policy-enforced in code.
  - Why: this is currently an operator/process rule, not an in-handler confirmation gate.
  - Add change: optional safety flag (`confirm:true`) in schema or host-side policy check test.
- UNVERIFIED: search result determinism across active filesystem/index mutation windows.
  - Why: deterministic ordering is proven for stable index/query, but background sync can legitimately change candidate pool between calls.
  - Add test: integration test that freezes sync and re-runs query N times on fixed snapshot, then repeats after controlled sync event.
