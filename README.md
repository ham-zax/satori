# Satori

**Semantic code search for AI agents — hybrid RAG, incremental sync, zero-config MCP.**

<p align="left">
  <img src="https://img.shields.io/badge/Built%20by-Hamza-blueviolet" alt="Built by Hamza">
  <img src="https://img.shields.io/badge/Architecture-Agent--Safe-brightgreen" alt="Agent Safe">
  <img src="https://img.shields.io/badge/VectorDB-Milvus-blue" alt="Milvus">
  <img src="https://img.shields.io/badge/Protocol-MCP-orange" alt="MCP">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT">
</p>

Satori (悟り — "sudden insight") gives AI coding agents deep codebase understanding through a production MCP server. It parses source files with tree-sitter into structure-aware chunks, embeds them into Milvus, and serves hybrid semantic + keyword search through a minimal 4-tool API.

Two runtime packages:
- `@zokizuan/satori-core` — indexing, AST chunking, embeddings, vector storage, incremental sync
- `@zokizuan/satori-mcp` — MCP server with agent-safe tools

---

## Why I Built This

Standard RAG pipelines are fundamentally unsafe for autonomous coding agents:

1. **Silent vector corruption.** If an agent queries a 1536-dimensional index using a 768-dimensional model, it either hallucinates or crashes. No existing tool caught this at runtime.
2. **Broken code chunks.** Naive text splitters slice through function signatures. The agent sees half a function, loses structural context, and wastes its context window on a second retrieval.
3. **Full re-indexing on every change.** Most systems re-embed the entire codebase when a single file changes. At scale, this burns through embedding API budgets.

I built Satori to solve all three: fingerprint-gated safety, AST-aware chunking, and Merkle-based incremental sync.

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
  |  4 Tools:                                                         |
  |    manage_index | search_codebase | read_file | list_codebases    |
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
Dense vector similarity + BM25 keyword matching, merged via Reciprocal Rank Fusion (RRF). RRF is rank-based, not score-based — no need to calibrate between incompatible scoring scales. Optional VoyageAI neural reranker for precision-critical queries.

**AST-Aware Code Chunking**
Tree-sitter splits code at function/class boundaries instead of arbitrary character limits. Each chunk carries structural breadcrumbs (`class UserService > method authenticate`) as metadata. 8 language grammars: TypeScript, JavaScript, Python, Java, Go, C++, Rust, C#, Scala. Falls back to LangChain splitting for unsupported languages.

**Incremental Merkle Sync**
File-level SHA-256 hashing with Merkle DAG diffing. Only changed files get re-embedded: 3 files changed out of 10,000 = only 3 re-embedded. Background polling every 3 minutes + optional chokidar filesystem watcher for near-real-time freshness.

**Fingerprint Safety Gates**
Every index is stamped with `{ provider, model, dimension, vectorStore, schemaVersion }`. On every search or sync call, the runtime fingerprint is compared against the stored one. Mismatch → state transitions to `requires_reindex`, blocking all queries. Error messages include the exact recovery command ("train-in-the-error" design).

**4-Tool Hard-Break API**
Reduced from 9 tools (pre-v1.0) to 4. Fewer tools = less agent tool-selection ambiguity. The `manage_index` tool uses an `action` parameter to handle create/sync/status/clear in a single tool.

---

## Quickstart

### 1. Add to your MCP client config

**JSON** (Claude Desktop, Cursor):

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

**TOML** (Claude Code CLI):

```toml
[mcp_servers.satori]
command = "npx"
args = ["-y", "@zokizuan/satori-mcp@latest"]
startup_timeout_ms = 180000
env = { EMBEDDING_PROVIDER = "VoyageAI", EMBEDDING_MODEL = "voyage-4-large", EMBEDDING_OUTPUT_DIMENSION = "1024", VOYAGEAI_API_KEY = "your-api-key", VOYAGEAI_RERANKER_MODEL = "rerank-2.5", MILVUS_ADDRESS = "your-milvus-endpoint", MILVUS_TOKEN = "your-milvus-token" }
```

### 2. Restart your MCP client

### 3. Index and search

```
> list_codebases                                    # verify connection
> manage_index  action="create" path="/your/repo"   # index a codebase
> search_codebase  query="authentication flow"      # semantic search
```

Results include file paths, line ranges, code snippets, and structural scope annotations.

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
      +-- create --- requires_reindex
         (force)     Blocks: search, sync
                     Recovery: create with force=true
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
| `manage_index` | Create, sync, check status, or clear a codebase index |
| `search_codebase` | Hybrid semantic search with optional reranking and query-time excludes |
| `read_file` | Read file content with optional line ranges and truncation guard |
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

If MCP startup fails (`initialize response` closed):

1. Pin a specific version: `@zokizuan/satori-mcp@1.0.2`
2. Increase startup timeout to `180000` (cold start package download)
3. Remove local link shadowing: `npm unlink -g @zokizuan/satori-mcp`
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
