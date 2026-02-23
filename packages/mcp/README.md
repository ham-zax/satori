# @zokizuan/satori-mcp

MCP server for Satori — agent-safe semantic code search and indexing.

## Features

- Capability-driven execution via `CapabilityResolver`
- Unified `search_codebase` flow with optional reranker override:
  - `useReranker=true`: force rerank (errors if capability missing)
  - `useReranker=false`: disable rerank
  - `useReranker` omitted: auto behavior by capability/profile
- Snapshot v3 safety with index fingerprints and strict `requires_reindex` access gates
- Deterministic train-in-the-error responses for incompatible or legacy index states
- Query-time exclusion support with `.gitignore`-style matching
- Structured search telemetry logs (`[TELEMETRY]` JSON to `stderr`)
- Zod-first tool schemas converted to MCP JSON Schema for `ListTools`
- Auto-generated tool docs from live tool schemas
- `read_file` line-range retrieval with default large-file truncation guard
- Optional proactive sync watcher mode (debounced filesystem events)
- Index-time AST scope breadcrumbs (TS/JS/Python) rendered in search output as `🧬 Scope`
- Fingerprint schema `dense_v2`/`hybrid_v2` with strict reindex gate for legacy `*_v1` indexes

## Architecture

```
[MCP Client]
    -> [index.ts bootstrap + ListTools/CallTool]
    -> [tool registry]
    -> [manage_index | search_codebase | read_file | list_codebases]
    -> [ToolContext DI]
       -> [CapabilityResolver]
       -> [SnapshotManager v3 + access gate]
       -> [Context / Vector store / Embedding / Reranker adapters]
```

Tool surface is hard-broken to 4 tools. This reduces agent tool-selection ambiguity compared to larger, overlapping tool sets.

## read_file Behavior

- Supports optional `start_line` and `end_line` (1-based, inclusive)
- When no range is provided and file length exceeds `READ_FILE_MAX_LINES` (default `1000`), output is truncated and includes a continuation hint with `path` and next `start_line`

## Proactive Sync

- Enabled by default. Set `MCP_ENABLE_WATCHER=false` to disable
- Debounce window via `MCP_WATCH_DEBOUNCE_MS` (default `5000`)
- Watch events reuse the same incremental sync pipeline (`reindexByChange`)
- Safety gates:
  - Watch-triggered sync only runs for `indexed`/`sync_completed` codebases
  - Events are dropped for `indexing`, `indexfailed`, and `requires_reindex`
  - Ignored/hidden paths are excluded (`node_modules`, `.git`, build artifacts, dotfiles)
- On shutdown (`SIGINT`/`SIGTERM`), watchers are explicitly closed

<!-- TOOLS_START -->

## Tool Reference

### `manage_index`

Manage index lifecycle operations (create/sync/status/clear) for a codebase path.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum("create", "sync", "status", "clear") | yes |  | Required operation to run. |
| `path` | string | yes |  | ABSOLUTE path to the target codebase. |
| `force` | boolean | no |  | Only for action='create'. Force rebuild from scratch. |
| `splitter` | enum("ast", "langchain") | no |  | Only for action='create'. Code splitter strategy. |
| `customExtensions` | array\<string\> | no |  | Only for action='create'. Additional file extensions to include. |
| `ignorePatterns` | array\<string\> | no |  | Only for action='create'. Additional ignore patterns to apply. |

### `search_codebase`

Unified semantic search tool. Supports optional reranking and query-time excludes. Reranker is available. If useReranker is omitted, reranking is enabled automatically for fast/standard profiles.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to an indexed codebase or subdirectory. |
| `query` | string | yes |  | Natural-language query. |
| `limit` | integer | no | `50` | Maximum results to return. |
| `extensionFilter` | array\<string\> | no | `[]` | Optional file-extension filter (e.g. ['.ts','.py']). |
| `useIgnoreFiles` | boolean | no | `true` | Apply repo ignore files at search-time. |
| `excludePatterns` | array\<string\> | no | `[]` | Optional query-time exclude patterns. |
| `returnRaw` | boolean | no | `false` | Return machine-readable JSON results. |
| `showScores` | boolean | no | `false` | Include similarity scores in formatted output. |
| `useReranker` | boolean | no |  | Optional override: true=force rerank, false=disable rerank, omitted=resolver default. |

### `read_file`

Read file content from the local filesystem, with optional 1-based inclusive line ranges and safe truncation.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes |  | ABSOLUTE path to the file. |
| `start_line` | integer | no |  | Optional start line (1-based, inclusive). |
| `end_line` | integer | no |  | Optional end line (1-based, inclusive). |

### `list_codebases`

List tracked codebases and their indexing state.

No parameters.


<!-- TOOLS_END -->

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
