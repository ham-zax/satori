# @zokizuan/satori-mcp

Read-only MCP server for Satori. It gives coding agents six deterministic tools for repo search, symbol navigation, call graph context, bounded file reads, and index lifecycle management.

## Install

Installer ownership is **`@zokizuan/satori-cli` only** (this package serves MCP tools; it does not install client configs). Use the CLI installer for normal setup:

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```

The CLI installer supports `codex`, `claude`, `opencode`, and `all`. It creates the runtime cache, writes the stable launcher, and writes client config for you. Avoid using `npx` as the resident MCP server command; first-run package resolution can exceed normal MCP startup timeouts.

Use `--profile default|minimal|all-text` to write repo-local `satori.toml` during install:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --profile minimal
```

Profiles control indexing breadth, not search scope. `default` is safe-broad, `minimal` indexes source plus docs/text, and `all-text` indexes additional UTF-8 text files under the size limit. `search_codebase` still defaults to `scope=runtime`.

The repo-local config shape is:

```toml
[index]
profile = "minimal"
```

`satori.toml` is repository index policy, not MCP client config and not provider config. Do not put API keys, model names, Milvus endpoints, or tokens in it. Provider settings belong in the MCP client's runtime environment.

Profile behavior:

- `default`: source, docs/text, config, scripts, infra/query files, and known extensionless files such as `Dockerfile`, `Makefile`, `Justfile`, `Taskfile`, `Procfile`, `Jenkinsfile`, and `.dockerignore`.
- `minimal`: source plus docs/text only.
- `all-text`: default plus unknown UTF-8 text files under the size limit. `SATORI_ALL_TEXT_MAX_BYTES` can override the text-file cap.

All profiles still honor `.gitignore`, `.satoriignore`, and the hard denylist for secrets, lockfiles, generated output, dependency folders, binaries, bundles, logs, database dumps, source maps, and snapshots. `satori.toml` is treated as an index-policy control file; search freshness and `manage_index action="sync"` can reconcile ordinary profile/ignore changes, while incompatible fingerprints still return `requires_reindex`.

Codex installs write two companion artifacts by default: the first-party `satori` skill under `~/.codex/skills` and a marked Satori guidance block in `~/.codex/AGENTS.md`. The AGENTS block tells Codex to use Satori for semantic ownership/context discovery first, then use exact navigation and reads for proof.

For Codex, add `--install-guidance-hook` only when you want an installer-managed `SessionStart` reminder in `~/.codex/config.toml`. The hook prints guidance only, suppresses duplicate startup prints for the same working directory, and does not run indexing, search, or provider-backed work.

Advanced direct execution is available through the package bin:

```bash
npx -y @zokizuan/satori-mcp@4.11.16 --help
```

Use direct package execution for inspection, smoke tests, or unsupported harnesses. For supported clients, prefer `satori-cli install` so startup does not depend on package-manager resolution.

## Agent Workflow

```text
list_codebases
manage_index action="create" path="/absolute/path/to/repo"
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

Important defaults:

- `search_codebase` starts with runtime code, grouped by symbol.
- `search_codebase` runs freshness checks before returning results.
- Grouped search is symbol-owned: chunks are supporting evidence for an owner symbol, not the final navigation unit.
- Exact symbol navigation uses `symbolInstanceId`. `symbolKey` is stable-ish candidate lookup only, not exact identity.
- Index profiles still honor `.satoriignore`, `.gitignore`, `satori.toml`, and the hard denylist for secrets, lockfiles, generated output, dependencies, binaries, bundles, logs, and database dumps.
- `read_file` is bounded and can return continuation hints.
- `requires_reindex` means reindex first, then retry the original call.
- `manage_index action="clear"` is destructive and should be explicit.
- After changing `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, embedding dimension, `HYBRID_MODE`, vector backend settings, or the Satori runtime version, restart **all** Satori MCP clients before running `manage_index create`, `reindex`, `sync`, or `clear`.
- Satori records live runtime owners in `~/.satori/runtime/owners.json` and blocks those index mutations with `status="blocked"` / `reason="runtime_owner_conflict"` if another live Satori MCP runtime has a different fingerprint, package version, or config identity.
- On `runtime_owner_conflict`, the manage envelope lists conflicting **pids**, **versions**, and conflict reasons, plus a concrete `hints.nextStep`. MCP tools never kill other processes. Stop the listed host clients (or only orphaned Satori MCP node PIDs), leave a single package version/config running, then retry. `manage_index status` and `list_codebases` also show a compact **Runtime owners** line (live pids/versions); multi-version means mutations may block. `satori-cli doctor` reports multi-version live owners.
- Grouped `search_codebase` results with supported call graph attach **`inboundRecovery`**: a ready-to-run `must:` search to verify callers before blast-radius edits (`callGraphCallers` stays advisory/low).

## Navigation Sidecars

Completed full indexes write a derived symbol registry and relationship sidecar. Files remain the source of truth; the registry is the deterministic navigation view for the indexed snapshot.

- The symbol registry stores candidate owner keys, exact symbol instances, file-owner fallback symbols, and outline records used by grouped search, `file_outline`, and exact reads.
- The relationship sidecar stores conservative `CALLS v0` edges plus TypeScript/JavaScript `IMPORTS`/`EXPORTS v0` edges with manifest compatibility gates.
- Runtime navigation still serves canonical JSON sidecars by default. When the default shared runtime store is created at process startup, `SATORI_NAVIGATION_BACKEND=sqlite` can opt that shared store into SQLite-backed reads only after SQLite proves parity with the canonical JSON symbol registry and relationship sidecars. If canonical JSON is missing or incompatible, SQLite is not served as truth; if SQLite is missing, stale, incompatible, or parity-mismatched while JSON is compatible, runtime falls back to JSON with a warning. When the default shared runtime store is created with `SATORI_NAVIGATION_DUAL_READ=1`, JSON remains the serving backend and the runtime emits once-per-root parity mismatch warnings without changing the served result.
- `CALLS v0` is heuristic/name-based. Same-file unique targets can be high confidence; cross-file name-only targets start low and are upgraded when IMPORTS/EXPORTS evidence supports them, or when the imported file has a unique same-name target (class methods without top-level EXPORTS). Generic names like `push`/`get` stay suppressed without EXPORTS. Ambiguous same-name targets are skipped.
- `IMPORTS`/`EXPORTS v0` records only resolvable relative module edges and unambiguous local export declarations. Package imports, unresolved paths, ambiguous exports, and multiline module syntax are skipped.
- `call_graph` uses compatible relationship sidecars as the canonical source for symbol-owned traversal.
- Successful incremental sync reuses changed-file symbol output, preserves unchanged registry state, and recomputes relationships against the merged registry without re-splitting unchanged files. If changed-file indexing stops early, navigation state is cleared instead of publishing a mixed generation.

## Runtime Requirements

Configure an embedding provider and Milvus-compatible backend before indexing. Supported embedding providers are OpenAI, VoyageAI, Gemini, and Ollama. Changing provider, model, dimension, vector store, or schema requires a reindex because those values are part of the index fingerprint.

MCP startup, `tools/list`, and installer operations are lazy with respect to provider credentials. Missing provider values become `MISSING_PROVIDER_CONFIG` only when a provider-backed tool call needs them.

Installer-managed client config starts the resident launcher. Runtime provider settings come from the MCP client's environment and are exposed in native client config:

- Codex writes active `env_vars` forwarding plus an optional commented `[mcp_servers.satori.env]` template in `~/.codex/config.toml`.
- Claude Code writes `mcpServers.satori.env` in `~/.claude.json` with `${VAR:-}` pass-through values.
- OpenCode writes `mcp.satori.environment` in `~/.config/opencode/opencode.json` with `{env:VAR}` pass-through values.

Users who want literal values in a client config can replace the generated pass-through value for that client. In Codex, uncomment or add this table outside the installer-managed launcher block so reinstalls keep edits:

```toml
[mcp_servers.satori.env]
EMBEDDING_PROVIDER = "VoyageAI"
EMBEDDING_MODEL = "voyage-code-3"
EMBEDDING_OUTPUT_DIMENSION = "1024"
VOYAGEAI_API_KEY = "pa-..."
VOYAGEAI_RERANKER_MODEL = "rerank-2.5"
MILVUS_ADDRESS = "https://your-zilliz-endpoint"
MILVUS_TOKEN = "your-zilliz-token"
```

Cloud-quality setup:

```bash
EMBEDDING_PROVIDER=VoyageAI
EMBEDDING_MODEL=voyage-code-3
EMBEDDING_OUTPUT_DIMENSION=1024
VOYAGEAI_API_KEY=your-api-key
VOYAGEAI_RERANKER_MODEL=rerank-2.5
MILVUS_ADDRESS=your-milvus-endpoint
MILVUS_TOKEN=your-milvus-token
```

The full generated tool reference below is kept in the npm README for MCP clients and package consumers.

<!-- TOOLS_START -->

## Tool Reference

### `manage_index`

Manage index lifecycle operations (create/reindex/sync/status/clear/repair) for a codebase path. repair rebuilds local readiness only when existing vector payload and trusted runtime fingerprint proof match; otherwise it refuses and asks for create/reindex. Ignore-rule edits in repo-root .satoriignore/.gitignore reconcile automatically in the normal sync path. Use action="sync" for immediate convergence and action="reindex" for full rebuild recovery (preflight may block unnecessary ignore-only reindex churn unless allowUnnecessaryReindex=true). create/reindex return the kickoff response immediately and do not poll to terminal state; use action="status" to observe progress.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum("create", "reindex", "sync", "status", "clear", "repair") | yes |  | Required operation to run. |
| `path` | string | yes |  | ABSOLUTE filesystem path to the target codebase (relative paths are rejected). |
| `force` | boolean | no |  | Only for action='create'. Force rebuild from scratch. |
| `allowUnnecessaryReindex` | boolean | no |  | Only for action='reindex'. Override preflight block when reindex is detected as unnecessary ignore-only churn. |
| `customExtensions` | array<string> | no |  | Only for action='create'. Additional file extensions to include. |
| `ignorePatterns` | array<string> | no |  | Only for action='create'. Additional ignore patterns to apply. |
| `zillizDropCollection` | string | no |  | Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index. |

### `search_codebase`

Unified semantic search with runtime-first defaults (start with scope="runtime"), grouped/raw output modes, and deterministic ranking/freshness behavior. Operators are parsed from a query prefix block: lang:, path:, -path:, must:, exclude: (escape with \\ to keep literals). For high-precision queries such as exact identifiers, quoted literal phrases, and strict path filters, search_codebase can use an exact registry fast path or add a bounded tracked-file lexical recovery pass when semantic retrieval under-delivers. Grouped results expose legacy span plus explicit previewSpan/symbolSpan metadata, structured warnings, recommendedNextAction, per-result capabilities/fallbacks, executable nextActions/navigationFallbacks, and remediation hints such as .satoriignore noise handling. Use debug:true for explainability payloads, including debugSummary, exactRegistry, phaseTimingsMs, trackedLexical, and ranking provenance.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE filesystem path to an indexed codebase or subdirectory (relative paths are rejected). |
| `query` | string | yes |  | Natural-language query. |
| `scope` | enum("runtime", "mixed", "docs") | no | `"runtime"` | Search scope policy. runtime includes source/runtime code and tests while excluding docs/generated/artifacts/landing/fixtures; docs returns documentation paths only (not tests); mixed includes all. Docs scope skips reranker by policy in the current tool surface. |
| `resultMode` | enum("grouped", "raw") | no | `"grouped"` | Output mode. grouped returns merged search groups, raw returns chunk hits. |
| `groupBy` | enum("symbol", "file") | no | `"symbol"` | Grouping strategy in grouped mode. |
| `rankingMode` | enum("default", "auto_changed_first") | no | `"auto_changed_first"` | Ranking policy. auto_changed_first boosts files changed in the current git working tree when available. |
| `limit` | integer | no | `50` | Maximum groups (grouped mode) or chunks (raw mode). |
| `debug` | boolean | no | `false` | Optional debug payload toggle for score and fusion breakdowns. |

### `call_graph`

Traverse registry-resolved caller/callee relationships for indexed TS/JS/Python code. Relationship-backed CALLS v0 is heuristic and name-based (not a compiler-grade call graph): unique same-file name matches are high confidence; cross-file edges stay low unless IMPORTS/EXPORTS evidence upgrades them. Traversal is bounded (depth/limit) and incomplete by design—empty or short edge lists are not proof of “no callers.” Output is advisory navigation context, not authoritative blast-radius proof; confirm impact with search_codebase, read_file, tests, and references before editing. In successful traversal responses, sidecar.nodeCount and sidecar.edgeCount report counts returned in that response, not whole-sidecar totals.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE filesystem path to the indexed codebase root or subdirectory (relative paths are rejected). |
| `symbolRef` | object | yes |  | Symbol reference from a grouped search result callGraphHint. |
| `direction` | enum("callers", "callees", "both") | no | `"both"` | Traversal direction from the starting symbol. |
| `depth` | integer | no | `1` | Traversal depth (max 3). |
| `limit` | integer | no | `20` | Maximum number of returned edges. |

### `file_outline`

Return a sidecar-backed symbol outline for one file, including call_graph jump handles.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE filesystem path to the indexed codebase root (relative paths are rejected). |
| `file` | string | yes |  | Repo-relative file path inside the codebase root (not absolute; resolved only against that root). |
| `start_line` | integer | no |  | Optional start line filter (1-based, inclusive). |
| `end_line` | integer | no |  | Optional end line filter (1-based, inclusive). |
| `limitSymbols` | integer | no | `500` | Maximum number of returned symbols after line filtering. |
| `resolveMode` | enum("outline", "exact") | no | `"outline"` | Outline mode returns all symbols (windowed/limited). Exact mode resolves deterministic symbol matches in this file. |
| `symbolIdExact` | string | no |  | Used with resolveMode="exact": exact symbol identifier match in the target file. On symbol-owned flows, pass the symbol's symbolInstanceId. |
| `symbolLabelExact` | string | no |  | Used with resolveMode="exact": exact symbol label match in the target file. |

### `read_file`

Read file content under an indexed/searchable Satori codebase root only (not a general host filesystem reader). Requires an absolute path whose canonical real path is inside a tracked root with status indexed or sync_completed. Supports optional 1-based inclusive line ranges and safe truncation.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to the file. |
| `start_line` | integer | no |  | Optional start line (1-based, inclusive). |
| `end_line` | integer | no |  | Optional end line (1-based, inclusive). |
| `mode` | enum("plain", "annotated") | no | `"plain"` | Output mode. plain returns text only; annotated returns content plus sidecar-backed outline metadata. |
| `open_symbol` | object | no |  | Optional deterministic symbol jump request for this file path. Uses exact symbol resolution within `path` when symbolId/symbolLabel is provided, and only uses direct span opens when no symbol identity fields are supplied. On symbol-owned flows, symbolId should carry the symbolInstanceId. |

### `list_codebases`

List tracked codebases and their indexing state.

No parameters.


<!-- TOOLS_END -->

## Notes

- `open_symbol` resolves exact symbols inside the same file passed to `read_file.path`. On symbol-owned flows, `symbolId`/`symbolIdExact` should carry `symbolInstanceId`.
- `MILVUS_TOKEN` is optional auth; local unauthenticated Milvus only needs `MILVUS_ADDRESS`.
- MCP startup does not require provider credentials or a live Milvus backend. Provider-backed calls report `MISSING_PROVIDER_CONFIG` when setup is incomplete.
- `MISSING_PROVIDER_CONFIG` is an active setup failure only when it appears as a tool response `code` or `reason`.

## Local Development

```bash
pnpm --filter @zokizuan/satori-mcp start
pnpm --filter @zokizuan/satori-mcp build
pnpm --filter @zokizuan/satori-mcp typecheck
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-mcp docs:check
```

`build` regenerates the tool reference from live tool schemas.
