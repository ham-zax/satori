# Satori

Agent-safe code retrieval for developers who use MCP coding agents on real repos.

Satori indexes a repository, keeps the index fresh, and gives agents a fixed six-tool MCP surface for finding code, opening exact spans, checking callers/callees, and reading bounded evidence before an edit. It is read-only from MCP: source edits stay in your editor or agent host.

## What You Get

- Find behavior by intent, not just filenames or exact tokens.
- Keep search focused on runtime code before pulling in docs or tests.
- Open exact files, line ranges, and symbols instead of dumping broad context.
- Trace nearby callers/callees when sidecar data is ready.
- Get explicit `requires_reindex`, stale-state, and noise guidance instead of silent bad context.
- Install the MCP server and first-party workflow skill with one command.
- Avoid resident MCP startup through `npx`; clients launch an installer-owned Node launcher.

## Packages

| Package | Purpose |
|---|---|
| `@zokizuan/satori-core` | Indexing, AST chunking, embeddings, Milvus/Zilliz storage, retrieval, incremental sync |
| `@zokizuan/satori-mcp` | MCP server with the six agent-facing tools and lifecycle gates |
| `@zokizuan/satori-cli` | Installer, doctor command, and shell access to MCP tools |

## Quick Start

Install managed MCP config for all supported clients:

```bash
npx -y @zokizuan/satori-cli@0.4.0 install --client all
npx -y @zokizuan/satori-cli@0.4.0 doctor
```

Supported installers: `codex`, `claude`, `opencode`, and `all`.

The installer writes Satori-managed config and copies the first-party workflow skill:

- `satori`

It also installs the MCP server once under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and points client config at that launcher with Node. Resident MCP startup should not perform package-manager resolution.

Treat `~/.satori/` paths as installer-owned. Do not hand-write `npx @zokizuan/satori-mcp` into resident MCP config unless you are intentionally accepting package-manager startup latency.

Restart the MCP client after changing config.

## Index a Repo

Once provider env is configured and your MCP client has restarted:

```text
manage_index action="create" path="/absolute/path/to/repo"
list_codebases
```

Then search and navigate with the six-tool workflow:

```text
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

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

## Search Defaults

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

## Release Commands

Current release versions:

- `@zokizuan/satori-core@1.6.0`
- `@zokizuan/satori-mcp@4.11.0`
- `@zokizuan/satori-cli@0.4.0`

Preflight before publishing:

```bash
pnpm install --frozen-lockfile
pnpm run versions:check
pnpm build
pnpm -C packages/mcp docs:check
pnpm -C packages/mcp manifest:check
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
pnpm run release:smoke:mcp
pnpm run release:smoke:cli
```

Recommended public release path:

```bash
git tag v0.5.0
git push origin v0.5.0
```

The GitHub Actions release uses npm provenance and requires the `NPM_TOKEN` secret. Use the manual fallback only when you intentionally want to publish from a local authenticated shell without CI provenance:

```bash
pnpm run release:login
pnpm run release:all
pnpm run release:verify
```

## Release Proof

The tag release workflow runs generated-doc checks, manifest checks, MCP tarball smoke tests, and CLI tarball smoke tests before publishing. The CLI installer tests also smoke `install --client all` against Codex, Claude, and OpenCode config in a temp home, asserting that resident client config launches the installer-owned Node launcher without `npx`, runtime cache paths, or custom startup timeout fields.

Release publishes use npm provenance from GitHub Actions. After publish, inspect registry integrity metadata with:

```bash
npm view @zokizuan/satori-core@<version> dist.integrity dist.shasum
npm view @zokizuan/satori-mcp@<version> dist.integrity dist.shasum
npm view @zokizuan/satori-cli@<version> dist.integrity dist.shasum
```

## More Docs

- [Architecture](./ARCHITECTURE.md)
- [End-to-end behavior spec](./docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md)
- [Features and use cases](./docs/SATORI_FEATURES_AND_USE_CASES.md)
- [MCP package README](./packages/mcp/README.md)

## License

MIT (c) Hamza (@ham-zax)
