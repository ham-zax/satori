# Satori Features, Use Cases, and Differentiators

This document inventories what Satori does, where it is useful, and what it does differently from generic code search or broad agent tool bundles.

It is intentionally product-facing but implementation-aware. The authoritative behavior contract remains `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`; this file explains the feature surface and user value in one place.

## One-Line Positioning

Satori is an agent-safe semantic code retrieval system that indexes real repositories, keeps indexes fresh, and gives coding agents a small deterministic MCP surface for finding, navigating, and reading code without flooding the context window.

## What Satori Is

Satori has three runtime packages:

- `@zokizuan/satori-core`: the indexing and retrieval engine.
- `@zokizuan/satori-mcp`: the MCP server and six-tool agent interface.
- `@zokizuan/satori-cli`: the installer and shell client for direct workflows.

The core promise is not "more tools." The promise is higher signal per tool call:

- intent-level search instead of filename guessing,
- exact file and line evidence instead of vague summaries,
- freshness gates instead of stale answers,
- deterministic navigation instead of ad-hoc follow-up searches,
- a constrained tool surface agents can reliably learn.

## What Satori Is Not

Satori deliberately avoids several tempting expansions:

- It is not a general agent framework.
- It is not a UI-heavy code browser.
- It is not a static docs generator.
- It is not a replacement for grep, tests, typecheck, or human review.
- It is not a write-capable MCP server.
- It does not expose arbitrary shell or filesystem mutation tools.
- It does not try to solve every language equally at the symbol-graph layer.

The product boundary is narrow by design: index, search, navigate, read, and manage index lifecycle.

## Major Capabilities

### 1. Six-Tool MCP Surface

Satori exposes exactly six MCP tools:

- `list_codebases`
- `manage_index`
- `search_codebase`
- `file_outline`
- `call_graph`
- `read_file`

This is a feature, not a limitation. Agents get a small stable interface:

- one tool to see tracked roots,
- one tool for lifecycle operations,
- one tool for semantic discovery,
- one tool for symbol outlines,
- one tool for graph traversal,
- one tool for bounded reads.

Why it matters:

- Less tool-routing ambiguity.
- Easier system prompts and skills.
- Lower chance of accidental destructive operations.
- More predictable automation across Codex, Claude, Cursor, Windsurf, PI, and other MCP clients.

### 2. Runtime-First Semantic Search

`search_codebase` defaults to implementation-oriented runtime discovery:

- `scope=runtime`
- `resultMode=grouped`
- `groupBy=symbol`
- `rankingMode=auto_changed_first`

This fits the most common agent need: find the production behavior first, while still allowing tests to surface when the query asks for test/spec/coverage evidence.

For exact identifier-style lookups, `search_codebase` can use a current compatible symbol registry before vector search. A unique exact registry hit returns a grouped symbol result without semantic search, tracked lexical scanning, or rerank. Missing, unavailable, or ambiguous registry state falls back without guessing.

Supported scopes:

- `runtime`: includes source/runtime code, top-level `scripts/**`, and test evidence; tests are demoted unless test intent is explicit.
- `docs`: includes docs/tests only.
- `mixed`: includes everything.

Index profiles are separate from search scopes. `default` indexes a safe-broad set of source, docs/text, config, scripts, infra/query files, and known extensionless files. `minimal` indexes source plus docs/text. `all-text` adds unknown UTF-8 text files under the size limit. Search still starts at `scope=runtime`, so indexing docs/config does not make docs beat implementation results by default.

Use cases:

- "Where is auth token refresh handled?"
- "Find the retry/backoff policy."
- "Show the database write path for deletion."
- "Where is this error generated?"
- "Which module owns index freshness?"

### 3. Natural-Language Intent Queries

Satori is optimized for intent-level questions rather than exact symbol names. The intended workflow is semantic discovery first, then deterministic proof through exact symbols, spans, call graph context, or navigation fallbacks.

Examples:

- `where is auth refresh handled`
- `trace request validation from route to service`
- `where are retries, backoff, and timeout policies defined`
- `find database write path for user deletion`
- `how does stale index recovery work`

What is better than grep:

- The query can describe behavior, not just tokens.
- Results can surface files that do not contain the exact words.
- Grouping reduces repeated chunks from the same symbol/file.
- The response includes line ranges and structural scope.

### 4. Dense + BM25 Hybrid Search

Satori supports dense vector retrieval plus BM25 sparse keyword search.

The merge is rank-based through Reciprocal Rank Fusion (RRF), which avoids fragile score calibration between vector similarity and keyword matching.

Why it matters:

- Dense search catches conceptual matches.
- BM25 preserves exact-token strength for symbols, error names, config keys, and domain words.
- RRF makes mixed retrieval stable without tuning score scales.

Use cases:

- Find a concept when naming differs across modules.
- Find exact constants and error strings while still ranking semantic context.
- Search unfamiliar codebases without knowing filenames.

### 5. Optional VoyageAI Reranking

When available, Satori can rerank top candidates with VoyageAI.

Important behavior:

- Rerank is capability-driven.
- Search does not expose a public `useReranker` knob.
- Docs scope skips reranking by policy.
- Reranker failure degrades safely with warnings instead of failing the whole search.

Why it matters:

- Agents get better top-hit precision when the backend supports it.
- Slow/local configurations are not forced through expensive reranking.
- The public search API stays simpler.

### 6. AST-Aware Chunking

Satori uses tree-sitter where supported to split code around meaningful code structure rather than arbitrary text windows.

AST splitter support currently covers:

- TypeScript: `.ts`, `.tsx`
- JavaScript: `.js`, `.jsx`, `.mjs`, `.cjs`
- Python: `.py`
- Java: `.java`
- C/C++: `.c`, `.cpp`, `.h`, `.hpp`
- Go: `.go`
- Rust: `.rs`
- C#: `.cs`
- Scala: `.scala`

Fallback file types are handled by the in-package recursive splitter.

Why it matters:

- Function/class boundaries are less likely to be cut in half.
- Search results are more edit-ready.
- Indexed chunks can carry structural breadcrumbs.

### 7. Scope Breadcrumbs in Results

For languages with supported symbol metadata, indexed chunks include breadcrumbs such as:

```text
class UserService > method refreshToken
```

Why it matters:

- Agents can understand where a chunk lives before reading a larger span.
- Similar snippets from different scopes are easier to distinguish.
- The result itself carries enough structure to choose the next navigation call.

### 8. Supported Language Model

Satori separates language capabilities instead of pretending every language has identical support.

Current capability split:

- Full AST/symbol/call graph/file outline support: TypeScript, JavaScript, Python.
- Symbol-only navigation support: Go, Rust. These languages have golden symbol fixtures, `file_outline`, and `read_file(open_symbol)` evidence, but no `call_graph` support.
- AST splitting only: Java, C/C++, C#, Scala.
- Fallback text indexing: PHP, Ruby, Swift, Kotlin, Objective-C, Jupyter notebooks, Markdown.

Why it matters:

- Agents receive honest capability states.
- Unsupported call graph or outline cases can return navigation fallback rather than fabricated graph output.
- Runtime search remains useful even where graph navigation is unavailable.

### 9. Deterministic Search Operators

`search_codebase` supports prefix-block operators:

- `lang:`
- `path:`
- `-path:`
- `must:`
- `exclude:`

Behavior is deterministic:

- quoted values are tokenized consistently,
- escaped prefixes can be used as literals,
- `path:` and `-path:` use gitignore-style matching,
- filtering order is fixed.
- exact `path:` filters constrain exact-registry lookup to symbols from the requested file before any broader fallback.

Use cases:

- Find Python runtime code only.
- Search inside one package.
- Exclude generated or fixture paths.
- Require an exact term while keeping semantic search.
- Remove noisy repeated concepts from the candidate set.

### 10. Grouped Results

Search can return grouped results by symbol or file.

Why it matters:

- Agents get fewer near-duplicate chunks.
- Results cover more distinct implementation areas.
- Search output becomes easier to scan.

Group diversity is deterministic:

- fixed caps,
- stable tie-breaks,
- one bounded relaxed pass when underfilled,
- fallback hashed group IDs when symbol identity is unavailable.

### 11. Raw Result Mode

`resultMode=raw` returns chunk-level hits instead of grouped results.

Use cases:

- Debug retrieval quality.
- Inspect exact chunk ranking.
- Compare semantic versus grouped behavior.
- Build custom clients that want raw retrieval primitives.

### 12. Changed-Files Ranking

`rankingMode=auto_changed_first` boosts files changed in the current git working tree when safe to do so.

Why it matters:

- During active coding, the agent is more likely to find the code currently being edited.
- Large dirty trees are threshold-gated to avoid expensive or noisy behavior.
- The boost is deterministic and cache-backed.

### 13. Debug Search Payloads

`debug=true` enables explainability payloads for ranking/filtering investigation.

Use cases:

- Diagnose why a result did or did not appear.
- Inspect filter/operator behavior.
- Tune ignore patterns.
- Verify rerank or grouping decisions.

### 14. Noise Mitigation Hints

Satori can detect when top visible results are dominated by noisy categories such as tests, fixtures, coverage, or generated output.

When the threshold is crossed, it emits a `hints.noiseMitigation` payload with suggested ignore patterns.

Why it matters:

- Agents can recover from noisy indexes without guessing.
- Suggestions account for root `.gitignore` where possible, avoiding redundant advice.
- The normal remediation path is `.satoriignore` plus `manage_index(action="sync")`, not full reindex.

### 15. File Outline

`file_outline` returns sidecar-backed symbols for one file.

Modes:

- `outline`: list symbols in a file or line window.
- `exact`: resolve one symbol by exact symbol id or exact label.

Statuses include:

- `ok`
- `not_found`
- `requires_reindex`
- `unsupported`
- `ambiguous`

Use cases:

- Inspect a large file before reading it.
- Lock exact symbol spans before editing.
- Resolve overloaded or repeated names deterministically.
- Get direct call graph jump handles.

### 16. Call Graph Traversal

`call_graph` traverses callers, callees, or both from a `symbolRef`.

Current query support follows language capability:

- TypeScript
- JavaScript
- Python

Behavior:

- bounded depth,
- bounded edge count,
- deterministic node/edge/note sorting,
- optional `testReferences` static references from test-like files to returned symbols,
- status mapping for unsupported/not-ready/not-found cases.

`testReferences` are useful investigation hints, but they do not prove runtime coverage, assertion coverage, or that a test executed a path.

Use cases:

- Understand blast radius before changing a function.
- Trace request flows.
- Find direct callers before editing behavior.
- Inspect whether a utility is shared or local.
- Follow call chains without broad grep.

### 17. Navigation Fallback

When call graph is unavailable, grouped search results can expose `navigationFallback`.

The fallback is executable:

- a `readSpan` for `read_file`,
- optional `fileOutlineWindow` when outline-capable.

Why it matters:

- Agents do not have to invent line ranges.
- Unsupported graph cases still move forward deterministically.
- Search results directly encode the next best navigation action.

### 18. Safe File Reads

`read_file` supports:

- plain text output,
- 1-based inclusive line ranges,
- safe truncation when reading large files,
- continuation hints,
- annotated mode with outline metadata,
- deterministic `open_symbol` resolution.

Why it matters:

- Agents can read only the code they need.
- Large files do not flood context by default.
- Symbol opening avoids guessing spans from search snippets.
- Annotated mode lets clients combine content plus outline state.

### 19. Read-Only Agent Surface

The MCP server does not expose write tools.

Why it matters:

- Search/navigation can be safely enabled in clients that should not mutate source.
- Index lifecycle is explicit and separated from code editing.
- Agents still use the host editor or normal filesystem tools for writes.

### 20. Index Lifecycle Management

`manage_index` supports:

- `create`: create a codebase index.
- `reindex`: rebuild when compatibility gates require it.
- `sync`: converge changed files and ignore-rule updates.
- `status`: inspect readiness.
- `clear`: destructive removal, explicit only.

Use cases:

- First-time indexing.
- Repair an index after model/schema changes.
- Sync after file edits.
- Recover from stale local state.
- Remove an index intentionally.

### 21. Fingerprint Safety Gates

Every index stores a runtime fingerprint:

- embedding provider,
- embedding model,
- embedding dimension,
- vector store provider,
- schema version.

If runtime and stored fingerprint differ, Satori blocks searchable access with `requires_reindex`.

Why it matters:

- Prevents mixing embeddings from incompatible models/dimensions.
- Prevents stale dense/hybrid schema assumptions.
- Turns subtle retrieval corruption into an explicit operator action.

### 22. Completion Proof Validation

Satori validates local ready state with marker documents in the vector backend.

Why it matters:

- A local snapshot alone is not treated as enough proof when the remote collection cannot prove completion.
- `list_codebases` and status paths can distinguish ready, failed, missing marker, stale local, and indeterminate probe states.
- Indeterminate remote state preserves local state rather than deleting it blindly.

### 23. Timeout-Safe Remote Delete Handling

Milvus/Zilliz collection deletion is verified after `dropCollection`.

Behavior:

- If delete times out but follow-up probe proves the collection is absent, local cleanup may proceed.
- If delete/probe state remains indeterminate, local ready state is preserved.
- Force reindex cleanup aborts before removing local metadata when remote deletion is not verified.
- Remote delete diagnostics are explicit and retryable/operator-actionable.

Why it matters:

- Backend timeouts do not half-clear a usable local index.
- Operators can retry safely.
- Cloud collection state and local snapshot state are kept less surprising.

### 24. Clear Tombstones

Satori records clear tombstones to persist explicit clear intent and the cleared collection identity across snapshot save/load.

Recent hardening scopes tombstones to collection identity rather than path alone.

Why it matters:

- An intentional clear does not silently reappear as ready local state.
- A later legitimate re-index of the same path by another session can still repair local state if it uses a new collection identity.

### 25. Snapshot Manager v3

The MCP runtime tracks codebase state in a local snapshot.

State categories include:

- indexing,
- indexed,
- indexfailed,
- sync_completed,
- requires_reindex.

Snapshot behavior includes:

- v1/v2 migration,
- fingerprint storage,
- indexing progress,
- failed state,
- sync deltas,
- clear tombstones,
- call graph sidecar metadata,
- ignore-rule versions,
- completion proof metadata.

Why it matters:

- Agents can reason about lifecycle state.
- The system can recover across MCP restarts.
- Status output is not just "exists or not."

### 26. Incremental Merkle Sync

Satori stores file state as a Merkle-style snapshot and diffs current files against previous state.

Sync tracks:

- added files,
- removed files,
- modified files.

Why it matters:

- Small edits do not require re-embedding the whole repository.
- Large repositories become cheaper to keep fresh.
- Indexing cost scales with change size rather than repo size after initial index.

### 27. Stat-First, Hash-On-Change File Tracking

The synchronizer can avoid hashing every file every time.

Why it matters:

- Common sync checks are faster.
- Hashing is still available when metadata indicates change or full verification is due.
- Freshness does not rely only on timestamps forever.

### 28. Partial-Scan Preservation

Core sync avoids treating unreadable or unscanned areas as removals.

Why it matters:

- Permission errors or transient filesystem issues do not cause mass false deletion.
- Sync can be conservative under incomplete reads.

### 29. Ignore Rule System

Ignore rules are additive across multiple layers:

- built-in defaults,
- constructor overrides,
- environment custom values,
- repo-root `.gitignore`,
- repo-root `.satoriignore`.

v1 intentionally loads root ignore files only. Nested `.gitignore` files and global
`~/.satori/.satoriignore` files are not part of the ignore-control contract.

Default ignored areas include:

- dependency directories,
- build output,
- coverage,
- VCS directories,
- editor files,
- caches,
- logs,
- temp files,
- env/local files,
- minified/bundled artifacts.

Why it matters:

- Indexes are cleaner by default.
- Projects can tune noise without changing code.
- Sensitive local/env files are excluded by default.

### 30. No-Reindex Ignore Reconciliation

Changing `.gitignore` or `.satoriignore` does not require a full reindex in the normal case.

Behavior:

- newly ignored paths are removed from indexed results,
- newly unignored paths are picked up by incremental sync,
- control-file signatures are checked on search freshness paths,
- manual `sync` can force immediate convergence.

Why it matters:

- Noise cleanup is cheap.
- Agents can recommend ignore changes without turning them into expensive rebuilds.

### 31. Sync-On-Read Freshness for Search

`search_codebase` runs freshness checks before returning results.

Other navigation tools do not run sync-on-read by design.

Why it matters:

- Search is the discovery entrypoint most sensitive to stale code.
- Navigation tools remain sidecar/local operations with predictable cost.
- The system balances freshness with latency.

### 32. Session-Scoped Watchers

When enabled, watcher mode registers codebases touched in the current session.

Behavior:

- startup does not watch every indexed root,
- successful search/navigation/read/index flows can mark roots as touched,
- events are debounced,
- status gates prevent syncing failed/indexing/reindex-required roots,
- shutdown closes watchers.

Why it matters:

- Lower startup overhead.
- Freshness focuses on active work.
- Watchers do not mutate unavailable or blocked states.

### 33. Background Periodic Sync

The MCP runtime can run periodic background sync with non-overlapping scheduling.

Why it matters:

- Long-running MCP sessions can converge over time.
- Recursive overlap is avoided.
- Freshness is not limited to manual calls.

### 34. Subdirectory Effective Root Resolution

Search can accept a subdirectory path inside an indexed parent.

Behavior:

- Satori resolves the indexed parent as the effective root.
- Response path preserves the user's requested path.
- Navigation fallback stays runnable from the resolved root.

Use cases:

- Search only within `packages/mcp` while the repo root is indexed.
- Work from a subproject path without remembering the indexed root.

### 35. Capability-Aware Defaults

CapabilityResolver derives behavior from provider/runtime configuration.

Profiles:

- fast: VoyageAI/OpenAI cloud providers,
- standard: other cloud providers such as Gemini,
- slow: local Ollama.

Search limits:

- fast default/max: 50/50,
- standard default/max: 25/30,
- slow default/max: 10/15.

Reranking:

- enabled only when a reranker key exists and profile is not slow.

Why it matters:

- Local setups stay responsive.
- Cloud setups use larger result budgets.
- Users do not have to configure every tuning knob manually.

### 36. Multiple Embedding Providers

Supported providers:

- OpenAI
- VoyageAI
- Gemini
- Ollama

Default models:

- OpenAI: `text-embedding-3-small`
- VoyageAI: `voyage-4-large`
- Gemini: `gemini-embedding-001`
- Ollama: `nomic-embed-text`

Why it matters:

- Users can choose quality, cost, locality, and operational control.
- Local-first workflows are possible with Ollama.
- Cloud free-tier workflows are possible with VoyageAI/Zilliz.

### 37. Configurable Embedding Dimensions

VoyageAI output dimension can be set through `EMBEDDING_OUTPUT_DIMENSION`.

Accepted values:

- `256`
- `512`
- `1024`
- `2048`

Default:

- `1024` for VoyageAI.

Why it matters:

- Users can trade retrieval quality, storage footprint, and cost.
- Fingerprint gates prevent incompatible dimension reuse.

### 38. Dense and Hybrid Schema Versions

The runtime fingerprint tracks schema version:

- `dense_v3`
- `hybrid_v3`

`HYBRID_MODE=true` selects hybrid mode by default.

Why it matters:

- Dense-only and hybrid indexes are not accidentally mixed.
- Migration boundaries are explicit.

### 39. Milvus and Zilliz Backends

Satori targets Milvus-compatible vector storage:

- local Milvus,
- Zilliz Cloud,
- gRPC adapter,
- REST adapter.

Why it matters:

- Users can start in the cloud and move local.
- The same conceptual index lifecycle applies across backend variants.

### 40. Zilliz Collection Limit Awareness

Satori uses one collection per indexed codebase.

This matters on free-tier Zilliz, where collection count can be limited.

Use cases:

- Diagnose create failures due collection limits.
- Intentionally clear old roots.
- Keep indexed roots focused.

### 41. Collection Naming by Codebase Path

Collections are derived from codebase path hashes:

- dense: `code_chunks_<md5(path)[0..8]>`
- hybrid: `hybrid_code_chunks_<md5(path)[0..8]>`

Why it matters:

- Collection names are deterministic.
- Different roots avoid collisions.
- Operator diagnostics can map collection names back to codebase paths through snapshot metadata.

### 42. CLI Installer

`@zokizuan/satori-cli` installs and uninstalls managed Satori config for supported clients:

- Codex,
- Claude,
- OpenCode,
- all supported clients.

Why it matters:

- Users do not need to hand-edit MCP config.
- Uninstall removes only Satori-managed config.
- `--dry-run` is available for inspection.

### 43. Managed Config Ownership

Installer logic distinguishes Satori-managed entries from unmanaged user entries.

Why it matters:

- It avoids overwriting hand-written config.
- It avoids deleting unrelated user config.
- It supports safer upgrade/uninstall flows.

### 44. Packaged First-Party Skill

Satori ships one first-party agent skill:

- `satori`

Why it matters:

- The recommended workflow is installed alongside the server.
- The skill does not add new MCP tools.
- Agents learn when to search, navigate, and remediate index state from one workflow entrypoint.

### 45. Direct Shell Tool Invocation

The CLI can run MCP tools directly:

```bash
satori-cli tools list
satori-cli tool call search_codebase --args-json '{"path":"/abs/repo","query":"auth"}'
satori-cli search_codebase --path /abs/repo --query auth
```

Why it matters:

- Users can debug Satori without a full MCP client.
- CI/smoke tests can invoke the same tool surface.
- Scripts can call Satori through JSON-only stdout.

### 46. CLI Output Contract

The CLI separates machine and human streams:

- `stdout`: JSON only.
- `stderr`: diagnostics and summaries.
- exit `0`: success.
- exit `1`: tool-level error or non-ok structured status.

Why it matters:

- Shell automation can parse output reliably.
- Diagnostics do not corrupt JSON.

### 47. MCP Stdio Safety

The MCP server protects JSON-RPC over stdio by redirecting console output away from stdout.

Why it matters:

- Package startup logs do not corrupt MCP protocol messages.
- CLI modes can guard accidental stdout writes.
- Protocol failures become easier to isolate.

### 48. Zod Tool Schemas

Tool inputs are defined with Zod and converted to MCP JSON Schema.

Why it matters:

- Runtime validation and advertised schema stay aligned.
- Generated docs can be built from live schemas.
- CLI wrapper flags can be derived from schema subsets.

### 49. Generated Tool Docs

MCP README tool reference is generated from live tool schemas.

Why it matters:

- Public docs are less likely to drift.
- Release checks can verify generated docs.

### 50. Server Manifest

`server.json` records package name, version, installer bootstrap command, managed-runtime behavior, and supported client config paths.

Why it matters:

- Package metadata can be consumed by installers/catalogs.
- Version freshness checks can cover public examples and manifests.

### 51. Version Freshness Guard

The repository has a `versions:check` script wired into the main `check` and release path.

Why it matters:

- README/config examples are less likely to advertise stale package versions.
- Release prep catches docs drift before publish.

### 52. Release Ordering

Release scripts publish in dependency order:

1. core,
2. MCP,
3. CLI.

Why it matters:

- The MCP package depends on the core package.
- The CLI package depends on the MCP package.
- Smoke failures caused by unpublished dependency versions are expected before publish but resolved by ordered release.

### 53. PI Bridge Example

The repo includes an example PI extension bridge.

Behavior:

- registers the same six tools,
- delegates to `satori-cli tool call`,
- supports env/config overrides,
- includes health check command `/satori-mcp`,
- forwards cancellation to child processes,
- can retry protocol guard failures once with stdout guard disabled.

Why it matters:

- Satori can be exposed to PI without inventing a second tool implementation.
- The bridge stays a thin proxy over the CLI.

### 54. Structured Search Telemetry

`search_codebase` emits structured telemetry to stderr.

Fields include:

- event/tool/profile,
- query length,
- requested limit,
- results before and after filters,
- excluded-by-ignore count,
- reranker used,
- latency.

Why it matters:

- Search behavior can be diagnosed without parsing user-facing prose.
- Operators can spot noisy filters, slow calls, and reranker usage.

### 55. Train-in-the-Error Responses

Satori returns operator guidance in structured envelopes and human text.

Examples:

- reindex hints when fingerprint gates fail,
- sync recommendation for ignore-only reindex preflight,
- retry guidance for backend timeouts,
- noise mitigation hints for cluttered search results.

Why it matters:

- Agents can recover from known states.
- Users see the next action instead of raw failure only.

### 56. Reindex Preflight Guardrails

`manage_index(action="reindex")` can block unnecessary reindex for ignore-only changes.

Preferred remediation:

- run `manage_index(action="sync")`.

Override:

- `allowUnnecessaryReindex=true` when a rebuild is explicitly intended.

Why it matters:

- Expensive rebuilds are avoided when sync can converge.
- The user can still force the operation intentionally.

### 57. Clear Is Explicitly Destructive

`manage_index(action="clear")` exists, but the recommended agent policy is to never call it unless the user explicitly requests a destructive wipe/reset.

Why it matters:

- Accidental index deletion is avoided.
- Lifecycle operations remain operator-controlled.

### 58. Public Package Boundary

Satori can be consumed as:

- a core library,
- an MCP server,
- a shell CLI,
- a PI bridge example.

Why it matters:

- Integrators can choose the lowest-level interface they need.
- Agents normally use MCP.
- Developers and automation can use CLI/core directly.

### 59. Snapshot Lock and Merge Hardening

Satori's local snapshot is a shared state file, so the SnapshotManager includes hardening around locking, merging, corruption, and stale state.

Important behavior:

- lock waits are bounded,
- CPU-spin fallback behavior was removed,
- stale locks check owner PID liveness,
- stale-lock break attempts use the same bounded wait/abort path as normal lock retries,
- lock retries fail gracefully when the wait path is unavailable,
- corrupt snapshots are preserved with `.corrupt-<pid>-<timestamp>-<suffix>.json` names,
- malformed persisted snapshots fall back to local-only merge behavior,
- malformed entries can be skipped without dropping the whole usable snapshot,
- load/save migration persists only when the semantic representation changes.

Merge precedence is deterministic:

- `indexing` wins over failed/reindex/ready states,
- `indexfailed` and `requires_reindex` win over ready states,
- `indexed` and `sync_completed` are lower-priority ready states,
- stale high-progress indexing records do not override fresh indexing state.

Why it matters:

- Concurrent or restarted MCP sessions are less likely to corrupt local state.
- Snapshot recovery is conservative and debuggable.
- Bad persisted data does not automatically erase good runtime state.

### 60. Metadata Setter Guardrails

Snapshot metadata setters are constrained so they cannot mutate derived state-driving fields by accident.

Guarded fields include:

- `status`,
- `indexingPercentage`,
- `indexedFiles`.

Why it matters:

- Cosmetic or metadata-only updates cannot secretly change lifecycle state.
- Dirty state is still tracked and persisted on the next successful save.

### 61. Per-Codebase Indexing Lock Semantics

Satori treats indexing as a per-codebase lifecycle, not a global vague "busy" flag.

The indexing-lock contract includes:

- stable non-ok reason codes such as `indexing`, `requires_reindex`, and `not_indexed`,
- a single completion source of truth through marker documents,
- deterministic status polling for long-running create/reindex actions,
- blocked actions while a root is actively indexing.

Why it matters:

- Agents get machine-readable reasons instead of ambiguous failure text.
- Long indexing runs can be polled instead of abandoned.
- Multiple roots can be reasoned about independently.

### 62. Long-Running Create/Reindex Polling

The shell CLI and bridge paths account for `manage_index create|reindex` being long-running operations.

Behavior includes:

- minimum polling timeout floors for create/reindex,
- initial call result is evaluated before polling begins,
- immediate errors or non-ok envelopes are not masked by polling,
- deterministic JSON tool-error payloads are emitted on call timeout instead of empty stdout.

Why it matters:

- Indexing large repositories does not look like a broken CLI just because it takes time.
- Automation can distinguish timeout, non-ok lifecycle state, and successful completion.

### 63. CLI Run Modes

Satori distinguishes MCP server mode from CLI one-shot mode.

In CLI mode:

- startup background sync loop is disabled,
- watcher startup is disabled,
- startup reconciliation is disabled in the long-running sense,
- one-shot interrupted-index recovery can run before the first tool request,
- on-demand tool execution semantics remain intact.

Why it matters:

- A short-lived shell command does not leave background loops running.
- CLI output stays deterministic and bounded.
- Startup recovery can still make obvious stale states safer.

### 64. Source-Mode and Symlink-Friendly CLI Launch

The CLI supports source-mode server entry resolution when built `dist` files are unavailable.

Behavior includes:

- resolving `index.ts` with a `tsx` import fallback,
- supporting linked/symlinked package-manager installs,
- keeping wrapper execution usable in local development.

Why it matters:

- Contributors can use the CLI before publishing/building every artifact.
- Local package-link workflows are less brittle.

### 65. Wrapper Argument Parsing

The CLI supports both raw JSON tool calls and schema-backed wrapper flags.

Argument modes include:

- `--args-json '{"path":"/abs/repo","query":"auth"}'`,
- `--args-file ./args.json`,
- `--args-json @-`,
- direct wrapper mode such as `satori-cli search_codebase --path /abs/repo --query auth`.

Important behavior:

- global flags must appear before the command token,
- tool-level `--debug` is preserved in wrapper mode,
- unsupported schema shapes fall back deterministically to raw JSON guidance,
- boolean wrapper flags follow explicit parsing rules.

Why it matters:

- Human shell use and machine JSON use both work.
- Debug flags do not get swallowed by the wrong parser.

### 66. PI Bridge Robust Parsing and Recovery

The PI bridge is a thin adapter over `satori-cli`, but it has its own reliability behavior.

Bridge parsing:

- first parses full stdout as JSON,
- falls back to the last non-empty stdout line when stdout is noisy,
- returns combined diagnostics when both parsing attempts fail,
- preserves structured envelope JSON text blocks from truncation,
- keeps plain text truncation separate from structured envelope preservation.

Bridge recovery:

- transport/protocol failures can trigger a one-time retry with stdout guard disabled,
- tool-level non-ok envelopes do not trigger auto-retry,
- cancellation is forwarded to the child process through `AbortSignal`,
- health check clamps startup/call timeouts to short values.

Why it matters:

- PI integration remains a proxy, not a second implementation.
- Structured `status` and `hints` payloads are not corrupted by display normalization.
- Protocol recovery does not hide real tool-level errors.

### 67. Parallel Search Pass Degradation

`search_codebase` can run internal search passes concurrently.

Behavior includes:

- multiple passes run through `Promise.allSettled`,
- deterministic fusion order is preserved,
- partial pass failures emit warnings,
- full pass failure returns a structured tool error,
- telemetry reports pass counts and success/failure counts.
- exact-registry-eligible misses or ambiguities skip the expanded semantic pass and continue with the primary semantic pass plus bounded lexical recovery.

Why it matters:

- Search can degrade gracefully when one retrieval pass fails.
- The user and agent can see when results are usable but degraded.
- Parallelism improves latency without losing deterministic output order.

### 68. Search Fault-Injection and Warning Discipline

Satori has deterministic test-only fault injection for semantic search pass failures.

Covered cases include:

- primary pass failure,
- expanded pass failure,
- both passes failing,
- partial failure warnings,
- full failure structured error path,
- non-test-mode guard behavior.

Why it matters:

- Warning behavior is intentionally tested instead of incidental.
- The runtime can distinguish degraded search from failed search.

### 69. Call Graph Diagnostic Notes

Call graph sidecars record structured diagnostic notes instead of fabricating certainty.

Note types include:

- `missing_symbol_metadata`,
- `dynamic_edge`,
- `unresolved_edge`.

Hardening includes:

- declaration lines are not parsed as self-loop call sites,
- definition detection handles `function`, `class`, `def`, and method signatures case-insensitively,
- missing metadata skips node/edge emission instead of inventing symbol IDs,
- notes are sorted deterministically.

Why it matters:

- Agents can tell the difference between a real edge and an unresolved/dynamic relationship.
- Non-recursive functions do not get false recursive edges from declarations.

### 70. Staleness Buckets in Search Results

Grouped search results carry freshness metadata.

Staleness buckets:

- Fresh: `<= 30m`
- Aging: `<= 24h`
- Stale: `> 24h`

Grouped result metadata can include:

- stable `groupId`,
- nullable `symbolId`,
- nullable `symbolLabel`,
- `collapsedChunkCount`,
- aggregated `indexedAtMax`,
- `stalenessBucket`,
- discriminated `callGraphHint` with validation timestamps for supported graph handles.

Why it matters:

- Agents can prefer fresher evidence.
- Grouped results reveal how much content was collapsed.
- Search output is more than a list of snippets.

### 71. Compatibility Diagnostics

When a tool returns `requires_reindex`, Satori can include compatibility diagnostics.

Diagnostics include:

- runtime fingerprint,
- indexed fingerprint,
- reindex reason,
- remediation hint.

Surfaced in:

- `search_codebase`,
- `call_graph`,
- `manage_index status`.

Why it matters:

- Operators can see exactly why an index is blocked.
- Migration/release changes become explainable.

### 72. CI and Release Safety Gates

The repository includes several release and CI safety checks.

Examples:

- root `versions:check`,
- generated MCP docs check,
- generated `server.json` manifest check,
- `core_sync_gate` for core sync invariants on Ubuntu/Node 20,
- MCP package version bump guard for package-relevant MCP source changes,
- release workflow verification of `server.json`.

Why it matters:

- Public docs, manifests, and package versions are less likely to drift.
- Core sync determinism has a dedicated gate.
- Release mistakes fail before publish.

### 73. Landing and Documentation Surfaces

Satori keeps multiple documentation surfaces aligned:

- root `README.md`,
- `ARCHITECTURE.md`,
- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`,
- package READMEs,
- generated MCP tool docs,
- `server.json`,
- landing pages under `satori-landing/`,
- planning docs under `docs/`.

Why it matters:

- The project has both operator docs and behavior-contract docs.
- Public-facing product copy and implementation contracts can evolve together.

### 74. Public Surface Pruning

Several older public knobs were removed to keep the agent contract smaller.

Removed or simplified:

- embedded call-graph flags inside `search_codebase`,
- synthetic/fabricated symbol IDs,
- regex fallback symbol extraction for invented identities,
- legacy search parameters such as `extensionFilter`, `excludePatterns`, and ignore toggles,
- public `search_codebase.useReranker`,
- public `manage_index.splitter`.

Why it matters:

- Graph traversal lives in `call_graph`.
- Reranking is policy-driven.
- Indexing is AST-first without user-selectable splitter drift.
- Agents have fewer ways to create inconsistent behavior.

## Primary Use Cases

### Use Case: Agent Onboarding to a New Codebase

Goal: give an agent enough context to answer architectural questions without dumping the repository into context.

Workflow:

1. `list_codebases`
2. `manage_index(action="create")` if missing
3. `search_codebase(query="how does X work")`
4. `file_outline` for top candidate files
5. `read_file` on exact spans

Why Satori is better:

- The first query can be conceptual.
- Results are line-bounded.
- Navigation is deterministic.

### Use Case: Bug Triage

Goal: find where a runtime behavior or error originates.

Workflow:

1. Search for the behavior or error.
2. Use grouped results to identify likely owner symbols.
3. Use call graph to inspect callers/callees.
4. Read exact spans.

Why Satori is better:

- Hybrid retrieval can find both exact error strings and semantically related handlers.
- Call graph reduces blind grep.
- `read_file` avoids loading huge files.

### Use Case: Safe Refactoring Prep

Goal: understand affected call sites before editing a function.

Workflow:

1. Search for the symbol or behavior.
2. Use `file_outline` to lock the symbol.
3. Use `call_graph(direction="callers")`.
4. Read direct callers.

Why Satori is better:

- The graph starts from stable `symbolRef` data.
- Traversal is bounded and sorted.
- Unsupported graph cases return explicit status instead of fake certainty.

### Use Case: Reducing Test/Fixture Noise

Goal: keep search focused on production code.

Workflow:

1. Search with `scope=runtime`.
2. Inspect noise mitigation hints.
3. Add `.satoriignore` patterns.
4. Run `manage_index(action="sync")`.

Why Satori is better:

- Noise cleanup does not normally require reindex.
- Hints are deterministic and category-based.
- Existing `.gitignore` is considered.

### Use Case: Working in a Monorepo

Goal: search one package while the repo root is indexed.

Workflow:

1. Pass the subdirectory path to `search_codebase`.
2. Follow returned navigation fallback or file paths.

Why Satori is better:

- Effective root resolution keeps index identity stable.
- User-requested path remains visible.
- Navigation fallback is built to be executable.

### Use Case: Keeping Long MCP Sessions Fresh

Goal: avoid stale retrieval during active coding.

Mechanisms:

- sync-on-read for search,
- session-scoped watchers,
- debounce,
- periodic sync,
- manual `sync` for immediate convergence.

Why Satori is better:

- Search checks freshness before returning results.
- Watchers focus on touched roots rather than every known root.
- Blocked states are respected.

### Use Case: Local-First Development

Goal: avoid cloud embedding spend.

Setup:

- `EMBEDDING_PROVIDER=Ollama`
- local Milvus,
- local embedding model such as `nomic-embed-text`.

Tradeoffs:

- lower/no API spend,
- slower profile,
- smaller default result limits,
- no default cloud reranker.

### Use Case: Cloud Quality Start

Goal: quickly get strong retrieval quality.

Setup:

- `EMBEDDING_PROVIDER=VoyageAI`
- `EMBEDDING_MODEL=voyage-4-large`
- `EMBEDDING_OUTPUT_DIMENSION=1024`
- Zilliz/Milvus backend,
- optional Voyage reranker.

Tradeoffs:

- better first-hit quality,
- cloud dependency,
- provider/API cost,
- collection count limits may matter on free tiers.

### Use Case: MCP Client Installation

Goal: configure Satori in Codex, Claude, or OpenCode without manual config editing.

Workflow:

```bash
npx -y @zokizuan/satori-cli@0.4.4 install --client all
npx -y @zokizuan/satori-cli@0.4.4 install --client all --profile minimal
```

Why Satori is better:

- Managed entries are owned and removable.
- First-party skills are copied with the config.
- Installed package versions are resolved once and launched through the installer-owned stable launcher.
- Optional repo-local `satori.toml` lets users choose `default`, `minimal`, or `all-text` indexing without changing MCP tool parameters.

### Use Case: CLI Automation

Goal: run Satori outside an MCP client.

Workflow:

```bash
satori-cli tools list
satori-cli tool call list_codebases --args-json '{}'
```

Why Satori is better:

- The CLI uses the same server/tool surface.
- JSON stdout is script-friendly.
- Exit codes map to tool success/error.

### Use Case: Public Release Readiness

Goal: publish package versions with matching docs/config examples.

Workflow:

1. `pnpm run check`
2. `pnpm run build`
3. docs/manifest checks
4. package smoke checks
5. ordered release scripts

Why Satori is better:

- Version freshness is checked before release.
- Generated tool docs and server manifest reduce drift.
- Installer smoke tests prove `install --client all` writes launcher-backed config for Codex, Claude, and OpenCode.
- Release smoke tests prove packed MCP and CLI tarballs start before publish.
- npm provenance links published packages back to the GitHub Actions release run.
- Publish order follows dependency graph.

### Use Case: Backend Timeout Recovery

Goal: avoid corrupting local state when Zilliz/Milvus operations timeout.

Behavior:

- create validation errors are classified as backend timeouts when appropriate,
- remote delete is verified,
- indeterminate remote state preserves local state,
- local mutation happens after remote state is known enough.

Why Satori is better:

- Failed cloud operations do not silently look like invalid repos.
- Operators receive retryable guidance.
- Half-cleared states are less likely.

## Cloud Index and Reindex Lifecycle Deep Dive

This section describes the operational behavior behind cloud collection checks, intelligent deletion, reindex decisions, and recovery. These details are important because Satori keeps two kinds of state:

- remote vector database state in Milvus/Zilliz collections,
- local state in `~/.satori` snapshots, Merkle sync files, sidecar metadata, and clear tombstones.

The core design rule is conservative: remote operations must be verified before local ready state is removed, and steady-state runtime readiness is proven from local snapshot state plus completion proof, not by opportunistic cloud-side snapshot repair.

### Cloud Collection Discovery

Explicit lifecycle operations such as create, clear, and force-reindex may ask the active vector store for collections.

The reconcile logic only considers Satori code collections:

- `code_chunks_*`
- `hybrid_code_chunks_*`

All other collections are skipped.

For each candidate collection, Satori queries a small sample row and reads the stored metadata. The important metadata field is:

- `metadata.codebasePath`

That field links a remote collection back to the original indexed repository path.

Why this matters:

- Non-Satori collections in the same Milvus/Zilliz instance are left alone.
- Collection identity can still be resolved during destructive lifecycle operations.
- Foreground handlers do not treat cloud collection existence as readiness proof.

### Completion Marker Documents

Satori writes and reads a completion marker document in the collection.

The marker identifies a finished index run with fields like:

- `kind=satori_index_completion_v1`
- `codebasePath`
- fingerprint
- `indexedFiles`
- `totalChunks`
- `completedAt`
- `runId`

The marker is checked through `getIndexCompletionMarker()` and validated by shared completion-proof logic.

Proof outcomes include:

- `valid`
- `stale_local`
- `fingerprint_mismatch`
- `probe_failed`

Important invalid/stale reasons include:

- missing marker document,
- malformed marker shape,
- codebase path mismatch,
- fingerprint mismatch,
- backend probe failure.

Why this matters:

- A collection existing in cloud is not enough.
- Local ready state requires remote completion proof.
- A collection from a different model, dimension, vector schema, or path does not silently become ready.

### Fingerprint-Aware Cloud Repair

Completion proof is checked against the runtime fingerprint.

The fingerprint includes:

- embedding provider,
- embedding model,
- embedding dimension,
- vector store provider,
- dense/hybrid schema version.

If the marker fingerprint does not match runtime configuration, Satori does not repair local ready state from that collection.

Why this matters:

- A stale collection created with an old embedding model is blocked.
- A dense index is not treated as a hybrid index.
- Model/dimension drift becomes `requires_reindex` instead of corrupt retrieval.

### Clear Tombstones

When a codebase is intentionally cleared, Satori records a clear tombstone.

The tombstone records:

- codebase path,
- cleared timestamp,
- collection name.

Steady-state foreground handlers do not repair snapshot state from cloud collections. Tombstones persist clear intent and collection identity so explicit maintenance flows do not accidentally blur a user-requested clear with later collection activity.

The important hardening is collection scoping:

- a tombstone records exactly which collection identity was cleared,
- a later legitimate re-index of the same path is treated as a fresh explicit indexing event instead of passive background repair.

Why this matters:

- A user-requested clear is not silently re-advertised as ready.
- A future valid remote re-index is still possible through explicit create/reindex flows.

### Local Status from Cloud State

Cloud checks can influence local status in these ways:

- valid cloud marker plus missing local ready entry can repair local snapshot to ready,
- missing marker makes a local ready claim stale,
- probe failure is non-authoritative and should preserve local state,
- fingerprint mismatch blocks use and leads to reindex guidance,
- collection absence can prove deletion only when explicitly checked in delete flows.

What Satori avoids:

- deleting local state because cloud list returned empty,
- treating any Satori-looking collection as complete,
- accepting marker documents for the wrong path,
- accepting marker documents for the wrong runtime fingerprint.

### Intelligent Clear

`manage_index(action="clear")` is destructive, but it is staged carefully.

The clear flow is:

1. Validate the path is absolute, exists, and is a directory.
2. Recover stale indexing state when possible.
3. Confirm the path is indexed, indexing, or requires reindex.
4. Refuse clear while the path is actively indexing.
5. Call `Context.clearIndex()`.
6. `Context.clearIndex()` resolves the active collection name.
7. It checks whether the collection exists.
8. If the collection exists, it calls verified remote delete.
9. Only after remote delete is verified absent does it delete local Merkle/synchronizer/ignore state.
10. The MCP handler removes local snapshot metadata.
11. The MCP handler records a collection-scoped clear tombstone.
12. The handler saves the snapshot and unregisters watchers.

Remote delete pending behavior:

- If remote deletion is not verified, the handler returns `reason="remote_delete_pending"`.
- Local snapshot state is not changed.
- The response includes retry hints.

Why this matters:

- Clear does not half-delete local state when cloud deletion is uncertain.
- Retrying clear remains safe.
- Tombstones prevent the just-cleared collection from being repaired back into local ready state.

### Verified Remote Deletion

Remote deletion uses `deleteCollectionWithVerification()`.

The algorithm is:

1. Call `hasCollection(collectionName)`.
2. If absent, return verified absent with zero drop attempts.
3. If present, attempt `dropCollection(collectionName)`.
4. Probe again with `hasCollection(collectionName)`.
5. If absent, return verified absent.
6. If still present, retry with backoff.
7. After the attempt budget is exhausted, throw `RemoteCollectionDeletePendingError`.

Defaults:

- maximum attempts: 5,
- initial backoff: 100ms,
- multiplier: 2.

Diagnostic behavior:

- per-attempt `lastError` is reset,
- if `dropCollection()` succeeds but the collection still exists, diagnostics say that,
- if probe/drop times out, the timeout becomes the last error,
- if both drop and probe are indeterminate, Satori preserves local state.

Why this matters:

- Milvus/Zilliz delete operations can be eventually consistent or timeout.
- A timeout is not automatically success.
- A successful drop call is not trusted until `hasCollection()` proves absence.

### Indeterminate Remote State Rule

If remote state cannot be determined, Satori preserves local state.

Examples:

- `dropCollection()` times out,
- follow-up `hasCollection()` also times out,
- collection list fails during cleanup preparation,
- completion marker probe fails.

The rule:

- indeterminate remote state is not proof of absence,
- indeterminate remote state is not proof of readiness,
- local ready state should not be removed based only on an inconclusive backend response.

Why this matters:

- Backend/network instability does not turn into local metadata corruption.
- Operators can retry once the backend is healthy.

### Force Reindex Cleanup

`create` with force/rebuild behavior can need to remove old collection variants before rebuilding.

Force cleanup is more aggressive than normal clear because it looks for all collection variants for the codebase hash.

The flow is:

1. Resolve the active collection name for the path.
2. Extract the path hash suffix.
3. Build candidate names:
   - `code_chunks_<hash>`
   - `hybrid_code_chunks_<hash>`
   - the resolved active collection name
4. List cloud collections when possible.
5. Add matching Satori code collections ending in the same hash.
6. Try verified deletion for each candidate.
7. Accumulate any drop errors.
8. If any deletion failed, throw before local state changes.
9. If all deletions are verified or already absent, clear local Merkle/snapshot state.
10. Return the dropped collection names.

Why this matters:

- Switching dense/hybrid mode or schema variants does not leave old same-root collections behind.
- Cleanup is all-or-fail before local mutation.
- Force reindex does not make the local state unrecoverable when remote delete fails.

### Why `clearIndex()` Can Run After Collection Deletion

Force cleanup may already delete the active collection before calling `Context.clearIndex()`.

That is safe because `Context.clearIndex()` first checks `hasCollection()`.

If the collection is already absent:

- it skips remote drop,
- still deletes the local Merkle snapshot,
- removes synchronizer state,
- removes ignore state for that collection.

Why this matters:

- Shared local cleanup logic can be reused after remote deletion.
- Already-absent collections are treated as a valid cleanup state.

### Reindex Decision Logic

Satori distinguishes several reasons a user may ask for reindex:

- required reindex due fingerprint/schema incompatibility,
- unknown state where reindex may be reasonable,
- unnecessary reindex when only ignore files changed,
- probe failure where Satori cannot confidently preflight.

The preflight logic checks:

1. Current local status.
2. Fingerprint access gate.
3. Working tree changed paths.
4. Whether changed paths are only `.gitignore` or `.satoriignore`.

Outcomes:

- `reindex_required`: proceed.
- `reindex_unnecessary_ignore_only`: block by default and recommend sync.
- `unknown`: warn but proceed.
- `probe_failed`: warn but proceed.

Override:

- `allowUnnecessaryReindex=true` permits an ignore-only reindex when explicitly intended.

Why this matters:

- Ignore-only changes normally need sync, not full rebuild.
- Required compatibility rebuilds are not blocked.
- Satori avoids expensive reindexing when a cheaper deterministic convergence path exists.

### Intelligent Sync vs Reindex

Satori treats sync and reindex as different operations.

Use `sync` for:

- normal file edits,
- ignore-rule changes,
- newly ignored paths,
- newly unignored paths,
- immediate freshness convergence.

Use `reindex` for:

- embedding provider/model changes,
- embedding dimension changes,
- dense/hybrid schema changes,
- missing or incompatible sidecar/fingerprint state,
- explicitly requested full rebuilds.

Why this matters:

- Most day-to-day changes avoid full embedding cost.
- Full rebuilds remain available when the index contract changed.

### Create Validation and Backend Timeouts

Create validates collection operations against the backend.

This can fail because the backend times out, especially with Zilliz/Milvus control-plane operations.

When classified as backend timeout:

- the repo path is not treated as invalid,
- local index state is not mutated,
- the response is retryable/operator-actionable,
- the user is told to check backend availability/network latency and retry.

Why this matters:

- Backend availability is separated from repository validity.
- A failed validation does not create a half-ready local snapshot.

### Collection Limit Handling

Satori uses one collection per indexed root.

On constrained Zilliz tiers, collection count can block creation.

The lifecycle tooling is designed to surface collection-limit guidance rather than hiding it behind generic failures.

Operationally:

- list indexed roots,
- clear intentionally unused roots,
- retry create,
- avoid clearing active roots unless explicitly intended.

### Watchers and Cloud/Local State

Watchers are local freshness helpers; they are not cloud reconciliation by themselves.

They:

- watch roots touched in the current session,
- debounce file events,
- drop events for blocked statuses,
- trigger sync/reconcile paths for eligible roots.

Cloud reconciliation:

- lists and probes remote collections,
- validates completion markers,
- repairs local snapshot entries only with proof.

Why this matters:

- Local file change tracking and cloud-state repair are separate responsibilities.
- Watcher events do not override fingerprint gates or clear tombstones.

### Operational Recovery Matrix

| Situation | Satori behavior | Recommended action |
|---|---|---|
| Local says ready but marker is missing | mark/report stale local | `manage_index(action="create")` or reindex as hinted |
| Runtime fingerprint differs | block access with `requires_reindex` | `manage_index(action="reindex")` |
| Only `.gitignore` / `.satoriignore` changed | block unnecessary reindex | `manage_index(action="sync")` |
| `dropCollection()` times out, probe says absent | proceed with local cleanup | no extra action |
| `dropCollection()` times out, probe also times out | preserve local state | retry clear/reindex later |
| Cloud has valid marker but local snapshot missing | remain `not_indexed` until explicit create/reindex | run `manage_index(action="create")` or `reindex` |
| Cloud collection matches clear tombstone | cleared intent remains persisted locally | create/reindex explicitly if wanted |
| Create validation times out | local state unchanged, retryable error | check backend/network and retry |
| Force cleanup cannot verify all drops | abort before local mutation | fix backend/delete issue and retry |

### Why This Is Better

Generic index lifecycle systems often treat local metadata and remote collections as the same thing.

Satori keeps them separate:

- remote collection existence,
- completion marker proof,
- fingerprint compatibility,
- local snapshot readiness,
- Merkle sync state,
- sidecar state,
- clear tombstones.

That separation is what makes the lifecycle safer:

- a cloud timeout does not delete local state,
- a stale local snapshot does not become trusted without proof,
- a clear action does not get silently undone,
- an ignore-only change does not trigger a wasteful full rebuild,
- a force reindex does not proceed after partial remote cleanup failure.

## What Satori Does Differently

### It Optimizes for Agent Workflows, Not Human Browsing

Most code search tools optimize for a person clicking through files.

Satori optimizes for an agent making tool calls:

- bounded JSON/text outputs,
- explicit next-step hints,
- deterministic status envelopes,
- small tool count,
- line-range reads,
- no write surface.

### It Treats Freshness as a First-Class Contract

Generic semantic indexes often become stale until manually rebuilt.

Satori adds:

- sync-on-read search,
- incremental Merkle sync,
- watcher mode,
- ignore-control signatures,
- fingerprint gates,
- state-machine statuses.

### It Separates Discovery from Navigation

Search answers "where might this be?"

Navigation answers "what exact symbol/span should I read?"

Satori keeps those separate:

- `search_codebase` for discovery,
- `file_outline` for symbol spans,
- `call_graph` for relationships,
- `read_file` for evidence.

### It Fails With Operator Guidance

Instead of raw errors only, Satori tries to return:

- `status`,
- `reason`,
- `warnings`,
- `hints`,
- deterministic `humanText`.

This makes failures usable by both humans and agents.

### It Avoids Public Knob Sprawl

Internally, Satori has ranking, rerank, diversity, freshness, and capability logic.

The public tool surface does not expose every internal toggle.

Why it matters:

- fewer bad combinations,
- less prompt complexity,
- simpler docs,
- more deterministic behavior.

### It Is Honest About Capability Gaps

Unsupported graph or outline cases do not pretend to work.

Instead, Satori returns:

- `unsupported`,
- `not_ready`,
- `requires_reindex`,
- `navigationFallback`,
- remediation hints.

### It Supports Both Free/Local and Cloud Paths

Users can choose:

- local Ollama + local Milvus,
- VoyageAI/OpenAI/Gemini + Zilliz/Milvus,
- dense or hybrid schema,
- optional reranker where supported.

This lets users optimize for cost, quality, privacy, or speed.

## Small Features That Matter

- `READ_FILE_MAX_LINES` prevents accidental huge file dumps.
- `MCP_WATCH_DEBOUNCE_MS` tunes watcher convergence.
- `MCP_ENABLE_WATCHER=false` disables watcher mode.
- `OPENAI_BASE_URL` and `GEMINI_BASE_URL` support custom endpoints.
- `OLLAMA_MODEL` takes priority for Ollama compatibility.
- `MILVUS_ADDRESS` can be explicit, while token-based resolution is supported.
- `VOYAGEAI_RERANKER_MODEL` supports `rerank-2.5`, `rerank-2.5-lite`, `rerank-2`, and `rerank-2-lite`.
- `customExtensions` and `ignorePatterns` can be passed during create.
- `zillizDropCollection` supports explicit Zilliz collection cleanup during create flows.
- `allowUnnecessaryReindex` overrides ignore-only reindex preflight when explicitly intended.
- `debug=true` exists for search explainability, not normal usage.
- `call_graph` accepts direction aliases and normalizes bidirectional traversal to `both`.
- `file_outline` has exact mode to avoid ambiguous symbol guesses.
- `read_file` annotated mode can return content plus outline metadata in one call.
- `list_codebases` uses stable bucket ordering and lexicographic path sorting.
- Search warnings are stable codes, not raw exception strings.
- Search telemetry goes to stderr, not stdout.
- Package docs can be regenerated from schemas.
- `server.json` records install metadata for supported clients.
- Release scripts include version freshness checks.

## Evidence Map

Primary evidence files:

- `README.md`: public positioning, architecture, quickstart, data flow, config, tool summary.
- `ARCHITECTURE.md`: package boundaries, runtime flow, state machine, sync behavior.
- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`: authoritative behavior contract.
- `packages/core/src/core/context.ts`: indexing, semantic search, collection naming, ignore loading.
- `packages/core/src/language/registry.ts`: language capability matrix.
- `packages/core/src/config/defaults.ts`: supported extensions and default ignore patterns.
- `packages/core/src/sync/synchronizer.ts`: Merkle sync and file diffing.
- `packages/core/src/vectordb/remote-delete.ts`: verified remote collection deletion.
- `packages/mcp/src/core/handlers.ts`: MCP tool behavior and lifecycle orchestration.
- `packages/mcp/src/core/snapshot.ts`: snapshot v3 state machine and local state.
- `packages/mcp/src/core/sync.ts`: freshness, watcher, and ignore reconciliation.
- `packages/mcp/src/core/call-graph.ts`: sidecar graph build/query.
- `packages/mcp/src/core/capabilities.ts`: runtime capability defaults.
- `packages/mcp/src/core/search-types.ts`: search envelopes, hints, navigation fallback.
- `packages/mcp/src/tools/*.ts`: six tool schemas and registry.
- `packages/mcp/src/config.ts`: environment configuration and runtime fingerprint.
- `packages/mcp/src/server/stdio-safety.ts`: MCP stdout/stderr protection.
- `packages/mcp/src/telemetry/search.ts`: search telemetry.
- `packages/cli/src/*.ts`: CLI installer, direct tool calls, schema-backed flags, output contract.
- `packages/mcp/assets/skills/satori/SKILL.md`: first-party Satori skill.
- `examples/pi-extension/satori-bridge`: PI bridge through CLI delegation.
- `server.json`: package install manifest.
- `scripts/check-version-freshness.mjs`: public version freshness guard.

## Practical Evaluation Checklist

Use this checklist to judge whether Satori is doing its job in a real workflow:

- Can an agent find the right implementation from an intent query?
- Are top results mostly runtime code when `scope=runtime`?
- Does the result include file paths, line ranges, and useful scope?
- Can the agent move from search to exact read without guessing spans?
- Does call graph work where the language supports it?
- Does unsupported graph behavior return useful fallback instead of pretending?
- Do file changes become visible without full reindex?
- Do ignore-rule changes converge through sync?
- Does fingerprint mismatch block unsafe search?
- Do backend failures produce retryable/operator-actionable messages?
- Can the CLI invoke the same tools as MCP?
- Are public docs and package versions in sync before release?

## Current Limitations and Honest Edges

- Full call graph and file outline support are strongest for TypeScript, JavaScript, and Python.
- Other AST-supported languages get better chunking but not full symbol graph behavior.
- Local Ollama setups are slower and use smaller default search budgets.
- Zilliz/Milvus backend timeouts can still block create/reindex until the backend is healthy.
- Search quality depends on embedding provider, model, dimensions, and ignore hygiene.
- Satori does not edit code; it gives context for the agent/editor to edit.
- Collection limits on free cloud tiers can require pruning old indexed roots.

## Bottom Line

Satori's advantage is not a single feature. It is the combination:

- semantic search,
- hybrid retrieval,
- AST-aware chunks,
- deterministic grouping,
- sidecar navigation,
- safe file reads,
- freshness and fingerprint gates,
- incremental sync,
- explicit lifecycle states,
- CLI/client install path,
- small MCP surface.

That combination makes it practical for coding agents to ask high-level questions, land on the right source lines, understand relationships, and keep working as the code changes without turning every task into a broad grep-and-read loop.
