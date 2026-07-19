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

## Measured Performance

A checksum-sealed Potion/LanceDB run on Satori published 488 files and 10,830 chunks in 34.46 seconds on CPU. The later representative delta run measured 154.543 ms warm-search p95, 185.662 ms zero-change synchronization p95, and 789–865 ms p95 for one-file add/edit/delete operations.

On 30 frozen positive retrieval tasks, Potion placed the required owner in the top five on 23 tasks versus Voyage on 25. Potion's observed median search latency was 94.64 ms versus 1,009.46 ms for Voyage in that paired run, but the provider latency observations were descriptive and Potion showed weaker Java and configuration/runtime retrieval.

<!-- TOOLS_START -->

## Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Create, synchronize, inspect, repair, reindex, or clear a repository index. Use status and repair guidance instead of guessing whether an index is ready. |
| `search_codebase` | Run freshness-aware hybrid search and return symbol-owned evidence. Start here for behavior, ownership, configuration, or path discovery. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. |
| `call_graph` | Inspect advisory callers, callees, imports, and exports when supported. Verify inbound leads before blast-radius changes. |
| `file_outline` | List the indexed symbols and spans in one file. Use it to choose an exact owner before reading implementation. |
| `read_file` | Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods. |
| `list_codebases` | List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one. |

<!-- TOOLS_END -->

## Runtime Boundaries

- The server does not edit repository source.
- `read_file` is not a general host-filesystem reader.
- Inbound call-graph evidence is advisory and should be verified before blast-radius edits.
- Provider, model, dimensions, projection, and vector backend are persisted compatibility identities; changing them requires a reindex.
- Multiple incompatible live Satori runtimes are blocked from mutating the same publication.
- Offline neural reranking is not shipped today. The candidate boundary permits a future complete-set local scorer to fail back atomically to exact + BM25 + single-vector ordering.

## Development

```bash
pnpm --filter @zokizuan/satori-mcp build
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-mcp docs:check
```

Node.js 22.13 or newer is required. Satori is MIT licensed.
