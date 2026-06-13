# Satori

Agent-safe code retrieval for developers who use MCP coding agents on real repos.

Satori indexes a repo, keeps that index fresh, and gives agents a fixed six-tool surface for finding code, opening exact spans, checking callers/callees, and reading bounded evidence before an edit. It is read-only from MCP: source edits stay in your normal editor or agent host.

## Why Developers Use It

- Find behavior by intent, not just filenames or exact tokens.
- Keep search focused on runtime code before pulling in docs or tests.
- Open exact files, line ranges, and symbols instead of dumping broad context.
- Trace nearby callers/callees when sidecar data is ready.
- Get explicit `requires_reindex`, stale-state, and noise guidance instead of silent bad context.
- Install the MCP server and first-party workflow skills with one CLI command.

## Packages

| Package | Purpose |
|---|---|
| `@zokizuan/satori-core` | Indexing, AST chunking, embeddings, Milvus/Zilliz storage, retrieval, incremental sync |
| `@zokizuan/satori-mcp` | MCP server with the six agent-facing tools and lifecycle gates |
| `@zokizuan/satori-cli` | Installer, doctor command, and shell access to MCP tools |

## Quick Start

Install managed MCP config for your client:

```bash
npx -y @zokizuan/satori-cli@0.3.2 install --client codex
npx -y @zokizuan/satori-cli@0.3.2 install --client claude
npx -y @zokizuan/satori-cli@0.3.2 doctor
```

The installer writes Satori-managed config and copies the first-party skills:

- `satori-search`
- `satori-navigation`
- `satori-indexing`

It also installs the MCP server once under `~/.satori/mcp-runtime/` and writes client config that starts the cached server entry directly with Node. Resident MCP startup should not perform package-manager resolution.

Treat the cache path as installer-owned. Do not hand-write `npx @zokizuan/satori-mcp` into resident MCP config unless you are intentionally accepting package-manager startup latency.

Restart the MCP client after changing config.

## Runtime Setup

Satori needs an embedding provider and a Milvus-compatible vector store before indexing.

Cloud quality start:

```bash
EMBEDDING_PROVIDER=VoyageAI
EMBEDDING_MODEL=voyage-4-large
EMBEDDING_OUTPUT_DIMENSION=1024
VOYAGEAI_API_KEY=your-api-key
VOYAGEAI_RERANKER_MODEL=rerank-2.5
MILVUS_ADDRESS=your-milvus-endpoint
MILVUS_TOKEN=your-milvus-token
```

Local-first start:

```bash
EMBEDDING_PROVIDER=Ollama
EMBEDDING_MODEL=nomic-embed-text
OLLAMA_HOST=http://127.0.0.1:11434
MILVUS_ADDRESS=localhost:19530
```

Provider, model, dimension, vector store, and schema are part of the index fingerprint. If they change, Satori blocks search with `requires_reindex` until you rebuild the index.

## Agent Workflow

Use Satori as the investigation layer before edits:

```text
list_codebases
manage_index action="create" path="/absolute/path/to/repo"
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

Default search behavior is developer-oriented:

- `scope="runtime"` so docs/tests do not dominate first results.
- `resultMode="grouped"` and `groupBy="symbol"` to reduce duplicate chunks.
- `rankingMode="auto_changed_first"` to prefer active work when safe.
- `debug=false` unless you are inspecting ranking/filter behavior.

## Six MCP Tools

| Tool | Use it for |
|---|---|
| `list_codebases` | See indexed roots and their lifecycle buckets |
| `manage_index` | Create, sync, reindex, inspect status, or explicitly clear indexes |
| `search_codebase` | Runtime-first semantic search with operators, grouping, freshness, and navigation hints |
| `file_outline` | Read sidecar symbol outlines and resolve exact symbols without guessing |
| `call_graph` | Traverse bounded caller/callee context from a search-provided `symbolRef` |
| `read_file` | Read bounded files, ranges, annotations, or exact symbol spans |

## What Satori Is Not

- Not an agent framework.
- Not a source-code write server.
- Not a replacement for tests, typecheck, code review, or grep.
- Not a promise that static call graph hints prove runtime or assertion coverage.

Satori gives the agent better evidence. It does not remove engineering judgment.

## Repository Layout

```text
packages/core   indexing, retrieval, embeddings, vector store, sync
packages/mcp    MCP server, tool schemas, lifecycle gates, generated tool docs
packages/cli    managed installer, doctor, direct shell tool calls
docs/           behavior specs, feature inventory, architecture notes
satori-landing/ static website HTML source
```

## Development

```bash
pnpm install
pnpm build
pnpm run versions:check
pnpm -C packages/mcp docs:check
pnpm -C packages/mcp manifest:check
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
pnpm test:integration
```

## More Docs

- [Architecture](./ARCHITECTURE.md)
- [End-to-end behavior spec](./docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md)
- [Features and use cases](./docs/SATORI_FEATURES_AND_USE_CASES.md)
- [MCP package README](./packages/mcp/README.md)

## License

MIT (c) Hamza (@ham-zax)
