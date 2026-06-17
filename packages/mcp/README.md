# @zokizuan/satori-mcp

Read-only MCP server for Satori. It gives coding agents six deterministic tools for repo search, symbol navigation, call graph context, bounded file reads, and index lifecycle management.

## Install

Use the CLI installer for normal setup:

```bash
npx -y @zokizuan/satori-cli@0.4.4 install --client all
npx -y @zokizuan/satori-cli@0.4.4 doctor
```

The CLI installer supports `codex`, `claude`, `opencode`, and `all`. It creates the runtime cache, writes the stable launcher, and writes client config for you. Avoid using `npx` as the resident MCP server command; first-run package resolution can exceed normal MCP startup timeouts.

Use `--profile default|minimal|all-text` to write repo-local `satori.toml` during install:

```bash
npx -y @zokizuan/satori-cli@0.4.4 install --client all --profile minimal
```

Profiles control indexing breadth, not search scope. `default` is safe-broad, `minimal` indexes source plus docs/text, and `all-text` indexes additional UTF-8 text files under the size limit. `search_codebase` still defaults to `scope=runtime`.

For Codex, add `--install-guidance-hook` only when you want an installer-managed `SessionStart` reminder in `~/.codex/config.toml`. The hook prints guidance only; it does not run indexing, search, or provider-backed work.

Advanced direct execution is available through the package bin:

```bash
npx -y @zokizuan/satori-mcp@4.11.5 --help
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
- Index profiles still honor `.satoriignore`, `.gitignore`, and the hard denylist for secrets, lockfiles, generated output, dependencies, binaries, bundles, logs, and database dumps.
- `read_file` is bounded and can return continuation hints.
- `requires_reindex` means reindex first, then retry the original call.
- `manage_index action="clear"` is destructive and should be explicit.

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
EMBEDDING_MODEL = "voyage-4-large"
EMBEDDING_OUTPUT_DIMENSION = "1024"
VOYAGEAI_API_KEY = "pa-..."
VOYAGEAI_RERANKER_MODEL = "rerank-2.5"
MILVUS_ADDRESS = "https://your-zilliz-endpoint"
MILVUS_TOKEN = "your-zilliz-token"
```

Cloud-quality setup:

```bash
EMBEDDING_PROVIDER=VoyageAI
EMBEDDING_MODEL=voyage-4-large
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

Manage index lifecycle operations (create/reindex/sync/status/clear) for a codebase path. Ignore-rule edits in repo-root .satoriignore/.gitignore reconcile automatically in the normal sync path. Use action="sync" for immediate convergence and action="reindex" for full rebuild recovery (preflight may block unnecessary ignore-only reindex churn unless allowUnnecessaryReindex=true).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum("create", "reindex", "sync", "status", "clear") | yes |  | Required operation to run. |
| `path` | string | yes |  | ABSOLUTE path to the target codebase. |
| `force` | boolean | no |  | Only for action='create'. Force rebuild from scratch. |
| `allowUnnecessaryReindex` | boolean | no |  | Only for action='reindex'. Override preflight block when reindex is detected as unnecessary ignore-only churn. |
| `customExtensions` | array<string> | no |  | Only for action='create'. Additional file extensions to include. |
| `ignorePatterns` | array<string> | no |  | Only for action='create'. Additional ignore patterns to apply. |
| `zillizDropCollection` | string | no |  | Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index. |

### `search_codebase`

Unified semantic search with runtime-first defaults (start with scope="runtime"), grouped/raw output modes, and deterministic ranking/freshness behavior. Operators are parsed from a query prefix block: lang:, path:, -path:, must:, exclude: (escape with \\ to keep literals). Use debug:true for explainability payloads, and rely on response hints for remediation (.satoriignore noise handling, navigation fallback, reindex guidance).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to an indexed codebase or subdirectory. |
| `query` | string | yes |  | Natural-language query. |
| `scope` | enum("runtime", "mixed", "docs") | no | `"runtime"` | Search scope policy. runtime includes source/runtime code and tests while excluding docs/generated/artifacts/landing/fixtures; docs returns docs/tests only; mixed includes all. Docs scope skips reranker by policy in the current tool surface. |
| `resultMode` | enum("grouped", "raw") | no | `"grouped"` | Output mode. grouped returns merged search groups, raw returns chunk hits. |
| `groupBy` | enum("symbol", "file") | no | `"symbol"` | Grouping strategy in grouped mode. |
| `rankingMode` | enum("default", "auto_changed_first") | no | `"auto_changed_first"` | Ranking policy. auto_changed_first boosts files changed in the current git working tree when available. |
| `limit` | integer | no | `50` | Maximum groups (grouped mode) or chunks (raw mode). |
| `debug` | boolean | no | `false` | Optional debug payload toggle for score and fusion breakdowns. |

### `call_graph`

Traverse the prebuilt call graph sidecar for callers/callees/bidirectional symbol relationships (language support follows the core callGraphQuery capability set; currently TS/JS/Python). When present, testReferences are static call-graph references from test-like files to returned symbols; they are investigation hints and do not prove runtime coverage, assertion coverage, or that a test executed a path.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to the indexed codebase root (or subdirectory). |
| `symbolRef` | object | yes |  | Symbol reference from a grouped search result callGraphHint. |
| `direction` | enum("callers", "callees", "both") | no | `"both"` | Traversal direction from the starting symbol. |
| `depth` | integer | no | `1` | Traversal depth (max 3). |
| `limit` | integer | no | `20` | Maximum number of returned edges. |

### `file_outline`

Return a sidecar-backed symbol outline for one file, including call_graph jump handles.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to the indexed codebase root. |
| `file` | string | yes |  | Relative file path inside the codebase root. |
| `start_line` | integer | no |  | Optional start line filter (1-based, inclusive). |
| `end_line` | integer | no |  | Optional end line filter (1-based, inclusive). |
| `limitSymbols` | integer | no | `500` | Maximum number of returned symbols after line filtering. |
| `resolveMode` | enum("outline", "exact") | no | `"outline"` | Outline mode returns all symbols (windowed/limited). Exact mode resolves deterministic symbol matches in this file. |
| `symbolIdExact` | string | no |  | Used with resolveMode="exact": exact symbolId match in the target file. |
| `symbolLabelExact` | string | no |  | Used with resolveMode="exact": exact symbol label match in the target file. |

### `read_file`

Read file content from the local filesystem, with optional 1-based inclusive line ranges and safe truncation.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to the file. |
| `start_line` | integer | no |  | Optional start line (1-based, inclusive). |
| `end_line` | integer | no |  | Optional end line (1-based, inclusive). |
| `mode` | enum("plain", "annotated") | no | `"plain"` | Output mode. plain returns text only; annotated returns content plus sidecar-backed outline metadata. |
| `open_symbol` | object | no |  | Optional deterministic symbol jump request for this file path. Uses exact symbol resolution within `path` when symbolId/symbolLabel is provided. |

### `list_codebases`

List tracked codebases and their indexing state.

No parameters.


<!-- TOOLS_END -->

## Notes

- `open_symbol` resolves exact symbols inside the same file passed to `read_file.path`.
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
