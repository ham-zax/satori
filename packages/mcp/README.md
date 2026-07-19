# @zokizuan/satori-mcp

The MCP server for [Satori](https://github.com/ham-zax/satori): freshness-aware hybrid code search, symbol navigation, advisory call graphs, bounded source reads, and index lifecycle management.

Most users should install Satori through `@zokizuan/satori-cli`. The installer writes a stable local launcher and configures supported MCP clients; this package does not manage client configuration by itself.

## Install

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime offline
npx -y @zokizuan/satori-cli@latest doctor
```

The local Potion runtime currently supports Linux x64, including Windows through WSL2. Connected Voyage and explicit local Ollama configurations are also available. See the [main README](https://github.com/ham-zax/satori#quick-start) for runtime choices.

Direct package execution is intended for inspection and custom harnesses:

```bash
npx -y @zokizuan/satori-mcp@latest --help
```

Do not use `npx` as the resident MCP command when the CLI installer supports your client; package resolution can exceed normal MCP startup timeouts.

## Workflow

```text
manage_index action="create" path="/absolute/path/to/repo"
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

Public paths are absolute. Search is freshness-aware; exact reads are limited to indexed searchable roots. Follow `recommendedNextAction` when returned, and reindex before retrying a request that reports `requires_reindex`.

<!-- TOOLS_START -->

## Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Create, synchronize, inspect, repair, reindex, or clear a repository index. |
| `search_codebase` | Run freshness-aware hybrid search and return symbol-owned evidence. |
| `continue_search` | Continue a frozen result set without rerunning retrieval. |
| `call_graph` | Inspect advisory callers, callees, imports, and exports when supported. |
| `file_outline` | List the symbols in one indexed file. |
| `read_file` | Read a bounded source span or one exact indexed symbol. |
| `list_codebases` | List known indexed repositories and their readiness state. |

<!-- TOOLS_END -->

## Runtime Boundaries

- The server does not edit repository source.
- `read_file` is not a general host-filesystem reader.
- Inbound call-graph evidence is advisory and should be verified before blast-radius edits.
- Provider, model, dimensions, projection, and vector backend are persisted compatibility identities; changing them requires a reindex.
- Multiple incompatible live Satori runtimes are blocked from mutating the same publication.

## Development

```bash
pnpm --filter @zokizuan/satori-mcp build
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-mcp docs:check
```

Node.js 22.13 or newer is required. Satori is MIT licensed.
