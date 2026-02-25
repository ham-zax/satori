# Satori

**Semantic code search for AI agents: runtime-first retrieval, call-graph traversal, incremental sync, and strict safety gates.**

<p align="left">
  <img src="https://img.shields.io/badge/Built%20by-Hamza-blueviolet" alt="Built by Hamza">
  <img src="https://img.shields.io/badge/Architecture-Agent--Safe-brightgreen" alt="Agent Safe">
  <img src="https://img.shields.io/badge/VectorDB-Milvus-blue" alt="Milvus">
  <img src="https://img.shields.io/badge/Protocol-MCP-orange" alt="MCP">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT">
</p>

Satori (悟り, "sudden insight") is built around one idea: give coding agents high-signal code context without dumping noisy chunks into the context window.

Satori is my personal project and an active experimentation space for agent-safe retrieval. I use it to test ideas quickly, keep what works in real MCP workflows, and cut anything that adds noise.

Because of that focus, the repo is intentionally trimmed to the runtime engine. No UI extensions, no eval sidecars, just the core parts that index, search, and safely sync.

Two runtime packages:
- `@zokizuan/satori-core` — indexing, AST chunking, embeddings, vector storage, incremental sync
- `@zokizuan/satori-mcp` — MCP server with agent-safe tools

## Why Try Satori

If you only test one thing, test this:
- Ask your agent a high-level question (`"where is auth refresh handled?"`) and see if it lands on the right files and lines quickly.

What users usually notice first:
- Better first-hit relevance for cross-module questions
- Less duplicate/noisy context returned to the model
- Faster path from search result to safe code edit (`search_codebase` -> `read_file`)
- Simple, constrained MCP surface (6 tools) with predictable behavior

---

## Why I Built This

I started this to solve problems I kept hitting while running agents on real codebases:

1. **Stale context (no reliable real-time sync).** Agents answered from old code after files changed.
2. **Duplicate and redundant retrieval.** Results often repeated the same logic in slightly different chunks, wasting context window space.
3. **Low-signal chunks.** Naive splitting broke important boundaries, so agents missed key details and needed extra search turns.
4. **Weak intent-to-code discovery.** Agents relying on filename guesses or keyword grep often missed the real implementation path across modules.

Satori is my attempt to improve retrieval accuracy and finding quality, make workflows faster, and cut token/indexing costs with fingerprint safety, AST-aware chunking, and incremental sync.

In practice, the agent flow is simple: ask `search_codebase` with intent-level queries (for example, "where is auth token refresh handled"), inspect the top scoped results, then use `read_file` on exact line ranges to reason and edit safely.

It is open-source (MIT) and free to use. Your only runtime cost is the infrastructure you choose (embedding provider and vector store), and local-first setups are supported.

## Start for Free

You can run Satori with little to no cost:

1. **Cloud free-tier path (easy start).**
Use Milvus/Zilliz Cloud free tier + VoyageAI starter free tier/credits for embeddings.
On Zilliz free tier (Milvus), Satori can index up to 5 codebases (one collection per codebase).
2. **Fully local path (no API spend).**
Use local Milvus + Ollama embeddings.

Suggested setup for most users:
- Start with `VoyageAI + Zilliz` to get good quality quickly.
- Move to local `Ollama` when you want zero API-key usage.

Example provider switch:

```bash
# Cloud path
EMBEDDING_PROVIDER=VoyageAI

# Local path
EMBEDDING_PROVIDER=Ollama
```

Free-tier availability and limits can change, so check current provider pricing pages before production use.

---

## Architecture

```
  MCP Client (Claude, Cursor, Windsurf, etc.)
       |
       | JSON-RPC over stdio
       v
  +------------------------------------------------------------------+
  |  MCP Server  (@zokizuan/satori-mcp)                              |
  |                                                                   |
  |  6 Tools:                                                         |
  |    manage_index | search_codebase | call_graph | file_outline | read_file | list_codebases |
  |                                                                   |
  |  CapabilityResolver     SnapshotManager v3     SyncManager        |
  |  (fast|standard|slow)   (fingerprint gate)     (3-min loop +      |
  |                                                 fs watcher)       |
  +------------------------------+------------------------------------+
                                 |
                                 v
  +------------------------------------------------------------------+
  |  Core Engine  (@zokizuan/satori-core)                             |
  |                                                                   |
  |  Context Orchestrator                                             |
  |    +-> Splitter: AstCodeSplitter (tree-sitter) + LangChain        |
  |    +-> Embeddings: OpenAI | VoyageAI | Gemini | Ollama            |
  |    +-> VectorDB: Milvus gRPC | Milvus REST adapters               |
  |    +-> Sync: FileSynchronizer (Merkle DAG)                        |
  +---------------------------+-------------------+-------------------+
                              |                   |
                              v                   v
                      Milvus / Zilliz        ~/.satori/
                      (vector storage)       (local state)
```

> Full architecture docs with state machine, data lineage, and sync flows: [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Key Design Decisions

**Hybrid Search with Reranking**
Dense vector similarity + BM25 keyword matching, merged with Reciprocal Rank Fusion (RRF). Because RRF is rank-based, you avoid fragile score calibration between dense and sparse systems. VoyageAI reranking is available when you need higher precision.

**AST-Aware Code Chunking**
Tree-sitter splits code at function/class boundaries instead of arbitrary character windows. Each chunk includes structural breadcrumbs (`class UserService > method authenticate`) as metadata. Supported grammars: TypeScript, JavaScript, Python, Java, Go, C++, Rust, C#, and Scala. Unsupported languages fall back to LangChain splitting.

**Incremental Merkle Sync**
File-level SHA-256 hashing + Merkle DAG diffing means only changed files are re-embedded. If 3 files change in a 10,000-file repo, only 3 files are processed. Background polling runs every 3 minutes, with an optional chokidar watcher for near-real-time updates.

**Fingerprint Safety Gates**
Every index stores `{ provider, model, dimension, vectorStore, schemaVersion }`. On each search/sync call, runtime fingerprint is checked against stored fingerprint. If they differ, state flips to `requires_reindex` and queries are blocked. Errors include deterministic recovery steps ("train in the error").

**6-Tool Hard-Break API**
The MCP surface is intentionally constrained to 6 tools. Smaller surface area keeps routing predictable while preserving first-class graph traversal and file-level symbol navigation. `manage_index` uses a single `action` parameter for create/reindex/sync/status/clear to keep behavior explicit.

---

## MCP Quickstart

### 1. Add to your MCP client config

**JSON** (Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "satori": {
      "command": "npx",
      "args": ["-y", "--prefer-offline", "@zokizuan/satori-mcp@3.0.0"],
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

**TOML** (Claude Code CLI):

```toml
[mcp_servers.satori]
command = "npx"
args = ["-y", "--prefer-offline", "@zokizuan/satori-mcp@3.0.0"]
startup_timeout_ms = 180000
env = { EMBEDDING_PROVIDER = "VoyageAI", EMBEDDING_MODEL = "voyage-4-large", EMBEDDING_OUTPUT_DIMENSION = "1024", VOYAGEAI_API_KEY = "your-api-key", VOYAGEAI_RERANKER_MODEL = "rerank-2.5", MILVUS_ADDRESS = "your-milvus-endpoint", MILVUS_TOKEN = "your-milvus-token" }
```

### 2. Restart your MCP client

### 3. Index and search

```
> list_codebases                                    # verify connection
> manage_index  action="create" path="/your/repo"   # index a codebase
> search_codebase  path="/your/repo" query="authentication flow" scope="runtime" resultMode="grouped" groupBy="symbol"
> file_outline  path="/your/repo" file="src/auth.ts" limitSymbols=50
> call_graph  path="/your/repo" symbolRef={"file":"src/auth.ts","symbolId":"sym_auth_validate"} direction="both" depth=1
> read_file  path="/your/repo/src/auth.ts" mode="annotated" start_line=1 end_line=220
```

Results include file paths, line ranges, code snippets, and structural scope annotations.

Cold starts can take time on first install. Keep `timeout` / `startup_timeout_ms` at `180000`.

### Query Ideas for First Run

Use intent-based queries (not filenames) to feel the difference:

```text
> search_codebase  query="where is auth token refresh handled"
> search_codebase  query="trace request validation from route to service"
> search_codebase  query="where are retries, backoff, and timeout policies defined"
> search_codebase  query="find database write path for user deletion"
```

---

## Data Flow

```
INDEX
=====
  Source File (.ts, .py, .go, ...)
       |
       v
  File Discovery (5-layer ignore model)
       |
       v
  +----- AST parse? -----+
  | YES                NO |
  v                       v
  AstCodeSplitter     LangChainCodeSplitter
  (tree-sitter)       (fallback)
  + breadcrumbs            |
  |                        |
  +--------+---------------+
           v
      CodeChunk { content, path, lines, breadcrumbs }
           |
           v
      embedBatch(size=100) --> Milvus upsert
      deterministic IDs: hash(path + lines + content)


SEARCH
======
  Query: "how does auth work?"
       |
       +---> embed(query) --> Dense vector search
       |
       +---> BM25 sparse keyword search
       |
       v
  Reciprocal Rank Fusion (merge by rank position)
       |
       v
  Ignore-pattern + extension filter
       |
       v
  Adjacent chunk merging (contiguous lines -> single result)
       |
       v
  VoyageAI Reranker (optional, capability-driven)
       |
       v
  Response: path + lines + code + "Scope: class Foo > method bar"


SYNC
====
  Trigger (3-min timer / fs watcher / manual)
       |
       v
  Hash all files --> diff against stored Merkle DAG
       |
       v
  Delta: { added[], removed[], modified[] }
       |
       v
  Delete old chunks --> re-embed changed files --> update DAG
```

---

## Codebase State Machine

```
                 manage_index(create)
  not_found ---------------------------> indexing
      ^                                   |     |
      |                              success   failure
      |                                   |     |
      |                                   v     v
      +-- clear -------- indexed    indexfailed
      |                     |            |
      |                    sync      create again
      |                     |
      |                     v
      +-- clear --- sync_completed --+
      |                     |        |
      |                     +--------+
      |                    sync succeeds
      |
      |             fingerprint mismatch
      |             (from indexed or sync_completed)
      |                     |
      |                     v
      +-- manage_index(action=reindex) --- requires_reindex
                                      Blocks: search, sync
                                      Recovery: manage_index(action=reindex)
```

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `EMBEDDING_PROVIDER` | yes | — | `OpenAI`, `VoyageAI`, `Gemini`, or `Ollama` |
| `EMBEDDING_MODEL` | yes | — | Model name for your provider |
| `MILVUS_ADDRESS` | yes | — | Milvus/Zilliz endpoint |
| `MILVUS_TOKEN` | yes | — | Milvus/Zilliz auth token |
| `EMBEDDING_OUTPUT_DIMENSION` | no | provider default | Output dimension |
| `VOYAGEAI_RERANKER_MODEL` | no | — | Reranker model (e.g. `rerank-2.5`) |
| `HYBRID_MODE` | no | `true` | Dense + BM25 hybrid search |
| `READ_FILE_MAX_LINES` | no | `1000` | Truncation guard for `read_file` |
| `MCP_ENABLE_WATCHER` | no | `true` | Auto-sync on file changes |
| `MCP_WATCH_DEBOUNCE_MS` | no | `5000` | Watcher debounce interval |

## Tool Reference

| Tool | Description |
|---|---|
| `manage_index` | Create, reindex, sync, check status, or clear a codebase index |
| `search_codebase` | Runtime-first semantic search with `scope`, grouped/raw modes, symbol/file grouping, and freshness decisions |
| `call_graph` | Traverse prebuilt TS/Python symbol relationships (callers/callees/both) using `callGraphHint` symbol refs |
| `file_outline` | Sidecar-backed per-file symbol outline with direct `callGraphHint` jump handles |
| `read_file` | Read file content with optional line ranges; `mode="annotated"` includes outline metadata without failing content reads |
| `list_codebases` | List all tracked codebases and their indexing state |

Full parameter docs: [`packages/mcp/README.md`](packages/mcp/README.md)

## Project Structure

```
packages/
  core/                     @zokizuan/satori-core
    src/
      core/context.ts         orchestrator (index, search, sync)
      splitter/               AstCodeSplitter + LangChain fallback
      embedding/              OpenAI, VoyageAI, Gemini, Ollama
      vectordb/               Milvus gRPC + REST adapters
      sync/                   FileSynchronizer (Merkle DAG)
  mcp/                      @zokizuan/satori-mcp
    src/
      index.ts                MCP server bootstrap + stdio safety
      core/handlers.ts        tool execution + fingerprint gate
      core/snapshot.ts        state machine + fingerprint storage
      core/sync.ts            background sync + watcher
      tools/                  per-tool modules (Zod schemas)
tests/
  integration/              end-to-end index + search + sync
```

## Development

```bash
pnpm install                                    # install dependencies
pnpm build                                      # build all packages
pnpm test:integration                           # run integration tests
pnpm --filter @zokizuan/satori-mcp start        # run MCP server locally
```

## Troubleshooting

If MCP startup fails (`initialize response` closed), check:

1. Pin a published version: `@zokizuan/satori-mcp@3.0.0`
2. Increase startup timeout to `180000` (cold start package download can be slow)
3. Remove local link shadowing: `npm unlink -g @zokizuan/satori-mcp` (and local `npm unlink @zokizuan/satori-mcp` if needed)
4. Restart MCP client

## Tech Stack

| Category | Technology |
|---|---|
| Runtime | Node.js 20+, TypeScript, pnpm monorepo |
| Code Parsing | tree-sitter (AST + breadcrumbs), LangChain (fallback) |
| Embeddings | OpenAI, VoyageAI, Google Gemini, Ollama |
| Vector Store | Milvus / Zilliz Cloud (gRPC + REST) |
| Search | Dense + BM25 hybrid, RRF, VoyageAI reranker |
| Protocol | MCP (Model Context Protocol) over stdio |
| Sync | Merkle DAG + chokidar filesystem watcher |
| Schemas | Zod -> JSON Schema |

## License

MIT © Hamza (@ham-zax)
