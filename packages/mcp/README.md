# @zokizuan/satori-mcp

MCP server for Satori — agent-safe semantic code search and indexing.

## Features

- Capability-driven execution via `CapabilityResolver`
- Runtime-first `search_codebase` with explicit `scope`, `resultMode`, `groupBy`, and optional `debug` traces
- Deterministic query-prefix operators in `search_codebase` (`lang:`, `path:`, `-path:`, `must:`, `exclude:`)
- Default grouped-result diversity and auto changed-files ranking (`rankingMode="auto_changed_first"`)
- First-class `call_graph` tool with deterministic node/edge sorting and TS/Python support
- Sidecar-backed `file_outline` tool for per-file symbol navigation and direct call_graph jump handles
- Snapshot v3 safety with index fingerprints and strict `requires_reindex` access gates
- Deterministic train-in-the-error responses for incompatible or legacy index states
- Query-time exclusion support with `.gitignore`-style matching
- Structured search telemetry logs (`[TELEMETRY]` JSON to `stderr`)
- Zod-first tool schemas converted to MCP JSON Schema for `ListTools`
- Auto-generated tool docs from live tool schemas
- `read_file` line-range retrieval with default large-file truncation guard and optional `mode="annotated"` metadata envelope
- Optional proactive sync watcher mode (debounced filesystem events)
- Index-time AST scope breadcrumbs (TS/JS/Python) rendered in search output as `🧬 Scope`
- Fingerprint schema `dense_v3`/`hybrid_v3` with hard gate for all pre-v3 indexes

## Architecture

```
[MCP Client]
    -> [index.ts bootstrap + ListTools/CallTool]
    -> [tool registry]
    -> [manage_index | search_codebase | call_graph | file_outline | read_file | list_codebases]
    -> [ToolContext DI]
       -> [CapabilityResolver]
       -> [SnapshotManager v3 + access gate]
       -> [Context / Vector store / Embedding / Reranker adapters]
```

Tool surface is hard-broken to 6 tools. This keeps routing explicit while exposing call-chain traversal and file-level navigation as first-class operations.

## read_file Behavior

- Supports optional `start_line` and `end_line` (1-based, inclusive)
- When no range is provided and file length exceeds `READ_FILE_MAX_LINES` (default `1000`), output is truncated and includes a continuation hint with `path` and next `start_line`
- Optional `mode="annotated"` returns content plus `outlineStatus`, `outline`, `hasMore`, and reindex hints when sidecar data is unavailable

## Proactive Sync

- Enabled by default. Set `MCP_ENABLE_WATCHER=false` to disable
- Debounce window via `MCP_WATCH_DEBOUNCE_MS` (default `5000`)
- Watch events reuse the same incremental sync pipeline (`reindexByChange`)
- Ignore control files (`.satoriignore`, root `.gitignore`) trigger no-reindex reconciliation:
  - delete indexed paths now ignored by active rules
  - incremental sync picks up newly unignored files
  - signature checks in `ensureFreshness` keep this working even when watcher events are missed
- Safety gates:
  - Watch-triggered sync only runs for `indexed`/`sync_completed` codebases
  - Events are dropped for `indexing`, `indexfailed`, and `requires_reindex`
  - Ignored/hidden paths are excluded (`node_modules`, `.git`, build artifacts, dotfiles)
- On shutdown (`SIGINT`/`SIGTERM`), watchers are explicitly closed

<!-- TOOLS_START -->

## Tool Reference

### `manage_index`

Manage index lifecycle operations (create/reindex/sync/status/clear) for a codebase path. Ignore-rule edits in repo-root .satoriignore/.gitignore reconcile automatically in the normal sync path. Use action="sync" for immediate convergence and action="reindex" for full rebuild recovery.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum("create", "reindex", "sync", "status", "clear") | yes |  | Required operation to run. |
| `path` | string | yes |  | ABSOLUTE path to the target codebase. |
| `force` | boolean | no |  | Only for action='create'. Force rebuild from scratch. |
| `customExtensions` | array<string> | no |  | Only for action='create'. Additional file extensions to include. |
| `ignorePatterns` | array<string> | no |  | Only for action='create'. Additional ignore patterns to apply. |
| `zillizDropCollection` | string | no |  | Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index. |

### `search_codebase`

Unified semantic search with runtime-first defaults (start with scope="runtime"), grouped/raw output modes, and deterministic ranking/freshness behavior. Operators are parsed from a query prefix block: lang:, path:, -path:, must:, exclude: (escape with \\ to keep literals). Use debug:true for explainability payloads, and rely on response hints for remediation (.satoriignore noise handling, navigation fallback, reindex guidance).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to an indexed codebase or subdirectory. |
| `query` | string | yes |  | Natural-language query. |
| `scope` | enum("runtime", "mixed", "docs") | no | `"runtime"` | Search scope policy. runtime excludes docs/tests, docs returns docs/tests only, mixed includes all. Docs scope skips reranker by policy in the current tool surface. |
| `resultMode` | enum("grouped", "raw") | no | `"grouped"` | Output mode. grouped returns merged search groups, raw returns chunk hits. |
| `groupBy` | enum("symbol", "file") | no | `"symbol"` | Grouping strategy in grouped mode. |
| `rankingMode` | enum("default", "auto_changed_first") | no | `"auto_changed_first"` | Ranking policy. auto_changed_first boosts files changed in the current git working tree when available. |
| `limit` | integer | no | `50` | Maximum groups (grouped mode) or chunks (raw mode). |
| `debug` | boolean | no | `false` | Optional debug payload toggle for score and fusion breakdowns. |

### `call_graph`

Traverse the prebuilt TS/JS/Python call graph sidecar for callers/callees/bidirectional symbol relationships.

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

### `read_file.open_symbol` Fields

`open_symbol` resolves symbols inside the same file passed in `read_file.path`.

- `symbolId` (string, optional): deterministic symbol id to resolve in `path`.
- `symbolLabel` (string, optional): exact symbol label to resolve in `path`.
- `start_line` (integer, optional): direct 1-based start line for span-based jump.
- `end_line` (integer, optional): direct 1-based end line (inclusive).

## MCP Config Examples

### JSON-style (Claude Desktop, Cursor)

```json
{
  "mcpServers": {
    "satori": {
      "command": "npx",
      "args": ["-y", "@zokizuan/satori-mcp@latest"],
      "timeout": 180000,
      "env": {
        "EMBEDDING_PROVIDER": "VoyageAI",
        "EMBEDDING_MODEL": "voyage-4-large",
        "EMBEDDING_OUTPUT_DIMENSION": "1024",
        "VOYAGEAI_API_KEY": "your-api-key",
        "VOYAGEAI_RERANKER_MODEL": "rerank-2.5",
        "MILVUS_ADDRESS": "your-milvus-endpoint",
        "MILVUS_TOKEN": "your-milvus-token"
      }
    }
  }
}
```

### TOML-style (Claude Code CLI)

```toml
[mcp_servers.satori]
command = "npx"
args = ["-y", "@zokizuan/satori-mcp@latest"]
startup_timeout_ms = 180000
env = { EMBEDDING_PROVIDER = "VoyageAI", EMBEDDING_MODEL = "voyage-4-large", EMBEDDING_OUTPUT_DIMENSION = "1024", VOYAGEAI_API_KEY = "your-api-key", VOYAGEAI_RERANKER_MODEL = "rerank-2.5", MILVUS_ADDRESS = "your-milvus-endpoint", MILVUS_TOKEN = "your-milvus-token" }
```

### Local development (when working on this repo)

```json
{
  "mcpServers": {
    "satori": {
      "command": "node",
      "args": ["/absolute/path/to/claude-context/packages/mcp/dist/index.js"],
      "timeout": 180000,
      "env": {
        "EMBEDDING_PROVIDER": "VoyageAI",
        "EMBEDDING_MODEL": "voyage-4-large",
        "EMBEDDING_OUTPUT_DIMENSION": "1024",
        "VOYAGEAI_API_KEY": "your-api-key",
        "VOYAGEAI_RERANKER_MODEL": "rerank-2.5",
        "MILVUS_ADDRESS": "your-milvus-endpoint",
        "MILVUS_TOKEN": "your-milvus-token"
      }
    }
  }
}
```

Never commit real API keys/tokens into repo config files.

## Run Locally

```bash
pnpm --filter @zokizuan/satori-mcp start
```

## Development

```bash
pnpm --filter @zokizuan/satori-mcp build
pnpm --filter @zokizuan/satori-mcp typecheck
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-mcp docs:check
```

`build` automatically runs docs generation from tool schemas.
