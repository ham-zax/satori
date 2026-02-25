# Satori Architecture

Reference for how requests, indexing, and sync flow through the Satori monorepo.

---

## 1. System Overview

```
  MCP Client (Claude, Cursor, Windsurf, etc.)
       |
       | JSON-RPC over stdio
       v
  +------------------------------------------------------------------+
  |  MCP Server  (@zokizuan/satori-mcp)                              |
  |                                                                   |
  |  +---------------+  +------------------+  +-------------------+  |
  |  | Tool Registry |  | Capability       |  | Snapshot          |  |
  |  | (4 tools)     |->| Resolver         |  | Manager v3        |  |
  |  | Zod -> JSON   |  | fast|std|slow    |  | fingerprint gate  |  |
  |  +-------+-------+  +------------------+  +--------+----------+  |
  |          |                                          |             |
  |  +-------v-------+              +-------------------v----------+  |
  |  | Tool          |              | SyncManager                  |  |
  |  | Handlers      |              | 3-min loop + chokidar watch  |  |
  |  +-------+-------+              +---------------+--------------+  |
  |          |    +-------------+                    |                |
  |          |    | VoyageAI    |                    |                |
  |          +--->| Reranker    |                    |                |
  |          |    | (optional)  |                    |                |
  |          |    +-------------+                    |                |
  +----------+--------------------------------------|----------------+
             |                                      |
             v                                      v
  +------------------------------------------------------------------+
  |  Core Engine  (@zokizuan/satori-core)                             |
  |                                                                   |
  |  +-----------------+  +--------------+  +---------------------+  |
  |  | Context         |  | Splitter     |  | FileSynchronizer    |  |
  |  | Orchestrator    |->| Layer        |  | (Merkle DAG)        |  |
  |  |                 |  +--------------+  +----------+----------+  |
  |  | indexCodebase() |  | AstCode      |             |             |
  |  | semanticSearch()|  |  (tree-sitter)|             |             |
  |  | reindexByChange |  | LangChain    |             |             |
  |  +--------+--------+  |  (fallback)  |             |             |
  |           |            +--------------+             |             |
  |  +--------v--------------------------+              |             |
  |  | Embedding Providers               |              |             |
  |  | OpenAI | VoyageAI | Gemini | Ollama              |             |
  |  +--------+--------------------------+              |             |
  |  +--------v--------------------------+              |             |
  |  | VectorDatabase Adapters           |              |             |
  |  | Milvus gRPC | Milvus REST         |              |             |
  |  +--------+--------------------------+              |             |
  +------------+----------------------------------------+-------------+
               |                                        |
               v                                        v
       Milvus / Zilliz                      ~/.satori/
       (dense + hybrid                     mcp-codebase-snapshot.json
        collections)                       merkle/<md5(path)>.json
```

**Boundary:** The MCP server owns state and control flow (snapshots, sync scheduling, capability resolution). The core engine owns computation (chunking, embedding, vector operations). Core stays MCP-agnostic and can run as a standalone library.

---

## 2. Repository Layout

```
packages/
  core/
    src/
      core/context.ts           orchestrator
      splitter/                  AstCodeSplitter + LangChain fallback
      embedding/                 OpenAI, VoyageAI, Gemini, Ollama
      vectordb/                  Milvus gRPC + REST adapters
      sync/                      FileSynchronizer (Merkle DAG)
      config/                    defaults, extensions, ignore patterns
      utils/                     shared utilities
  mcp/
    src/
      index.ts                   bootstrap + stdio safety
      core/handlers.ts           tool execution + fingerprint gate
      core/snapshot.ts           state machine + fingerprint storage
      core/sync.ts               background sync + watcher
      tools/                     per-tool modules (Zod schemas)
      telemetry/                 structured search telemetry
      config.ts                  env -> typed config
      embedding.ts               provider factory
tests/
  integration/                   end-to-end index + search + sync
```

---

## 3. Core Engine

### 3.1 Context Orchestrator

```
Context (core/context.ts)
  -> build effective config (defaults + constructor + env)
  -> indexCodebase: scan -> split -> embed -> insert
  -> semanticSearch: embed query -> dense/hybrid search -> filter -> merge
  -> reindexByChange: delete old chunks -> re-embed changed files
  -> manage per-collection synchronizers
```

### 3.2 Runtime Knobs

```
HYBRID_MODE           default: true
EMBEDDING_BATCH_SIZE  default: 100
Chunk cap per run:    450,000

Collection naming:
  dense:  code_chunks_<md5(path)[0..8]>
  hybrid: hybrid_code_chunks_<md5(path)[0..8]>

Operational note:
  Zilliz free tier (Milvus) allows up to 5 collections, so Satori indexes up to 5 codebases in that tier.
```

### 3.3 File Discovery and Ignore Model

Ignore rules are merged in five additive layers:

1. Built-in defaults (`DEFAULT_SUPPORTED_EXTENSIONS`, `DEFAULT_IGNORE_PATTERNS`)
2. Constructor overrides
3. Env custom values (`CUSTOM_EXTENSIONS`, `CUSTOM_IGNORE_PATTERNS`)
4. Repo-root ignore files (`.gitignore`, `.satoriignore`)
5. Global ignore (`~/.satori/.satoriignore`)

### 3.4 Splitter + Embedding + Vector Abstractions

```
Splitter:
  AstCodeSplitter       tree-sitter (TS, JS, PY, Java, Go, C++, Rust, C#, Scala)
  LangChainCodeSplitter fallback for unsupported languages

Embedding providers:
  OpenAI, VoyageAI, Gemini, Ollama
  Common contract: detectDimension(), embed(), embedBatch()

VectorDatabase adapters:
  MilvusVectorDatabase        (gRPC)
  MilvusRestfulVectorDatabase (HTTP)
```

### 3.5 Breadcrumb Metadata

`AstCodeSplitter` writes `metadata.breadcrumbs` at index time:
- Scope depth capped at 2 (`outer > inner`)
- Each label truncated to max length
- Label extraction is signature-focused for TS/JS/PY scopes
- Non-breadcrumbed files (Markdown, HTML) are still indexed and searchable — they omit scope annotation in results

### 3.6 Dense vs Hybrid Storage

```
Dense collection fields:
  id, vector, content, relativePath, startLine, endLine,
  fileExtension, metadata

Hybrid collection adds:
  sparse_vector + BM25 function on content
  dense+sparse index path with RRF rerank strategy
```

### 3.7 Incremental Sync

```
FileSynchronizer:
  1. Hash all current files (SHA-256)
  2. Load stored Merkle DAG from ~/.satori/merkle/<hash>.json
  3. Diff current vs stored
  4. Return { added[], removed[], modified[] }

reindexByChange:
  removed/modified -> delete old chunks from Milvus
  added/modified   -> re-split, re-embed, insert
```

---

## 4. MCP Runtime

### 4.1 Bootstrap

`packages/mcp/src/index.ts`:
- Starts MCP stdio server
- Redirects `console.log`/`console.warn` to `stderr` (protects JSON-RPC on stdout)
- Builds runtime fingerprint
- Wires Context, SnapshotManager, SyncManager, ToolHandlers, optional VoyageAI Reranker
- Starts background sync loop
- Enables watcher mode by default (`MCP_ENABLE_WATCHER=true`)

### 4.2 Tool Surface

```
manage_index     create | sync | status | clear
search_codebase  semantic search (+ optional rerank)
read_file        safe read with optional line ranges
list_codebases   tracked state summary
```

Tool schemas are defined in Zod, then converted to JSON Schema for MCP `ListTools`.

### 4.3 ToolHandlers

- Absolute path normalization/validation
- Cloud/local reconciliation before key operations
- Fingerprint compatibility gate before searchable access
- Background indexing kickoff for `manage_index(action=create)`
- Subdirectory smart-resolution to indexed parent root for search

### 4.4 Capability Model

```
Provider mapping:
  Ollama              -> local / slow     -> limit 10, max 15
  VoyageAI, OpenAI    -> cloud / fast     -> limit 50, max 50
  Others (Gemini)     -> cloud / standard -> limit 25, max 30

Rerank decision:
  useReranker=true    -> force (error if unavailable)
  useReranker=false   -> disable
  omitted             -> capability-driven default
```

### 4.5 Search Telemetry

`search_codebase` emits structured JSON telemetry to `stderr`:
- event, tool, profile
- query length, requested limit
- results before/after filter
- excluded-by-ignore count
- reranker used (boolean)
- latency (ms)

---

## 5. State Machine

### 5.1 Snapshot Lifecycle

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
         (force)
                     Blocks: search, sync
                     Recovery: create with force=true
```

### 5.2 Fingerprint Contract

```
{
  embeddingProvider    "VoyageAI"
  embeddingModel       "voyage-4-large"
  embeddingDimension   1024
  vectorStoreProvider  "Milvus"
  schemaVersion        "dense_v2" | "hybrid_v2"
}
```

Mismatch on any field -> `requires_reindex`.
Legacy v1/v2 snapshots auto-migrate on load but get flagged as legacy.

### 5.3 Gate Reasons

- Legacy assumed fingerprint (pre-v3 snapshot)
- Missing fingerprint field
- Provider, model, or dimension mismatch
- Schema version mismatch (`*_v1` -> `*_v2`)

---

## 6. Runtime Flows

### 6.1 Create Index

```
Client
  |
  v
ToolHandlers.handleIndexCodebase
  |-- validate path + collection capacity
  |-- sync snapshot <-> cloud
  |-- snapshot -> indexing
  `-- startBackgroundIndexing (async)

Background:
  load ignore patterns
  init FileSynchronizer
  prepare collection (dense or hybrid)
  scan -> split (AST/LangChain) -> embedBatch -> insert
  periodic progress saves

Terminal:
  success -> indexed (with fingerprint)
  failure -> indexfailed
```

### 6.2 Search

```
search_codebase
  -> rerank policy decision (CapabilityResolver)
  -> handleSearchCode
      -> fingerprint gate check
      -> ensureFreshness (sync-on-read)
      -> semantic/hybrid search (Milvus)
      -> filter by ignore patterns + extensions
      -> merge adjacent same-file chunks
      -> render "Scope: class Foo > method bar" for breadcrumbed results
  -> optional VoyageAI rerank
  -> telemetry emit
```

### 6.3 Sync

```
validate indexed + fingerprint gate
  -> FileSynchronizer.sync() (Merkle DAG diff)
  -> reindexByChange(delta)
  -> snapshot -> sync_completed (with delta counts)
```

### 6.4 Incremental Sync Detail

```
Trigger (3-min timer / chokidar event / manual sync call)
     |
     v
SyncManager.ensureFreshness(codebasePath)
     |
     +-- In-flight coalescing: already syncing this path? -> skip
     +-- Freshness throttle: synced recently? -> skip
     |
     v
FileSynchronizer.sync()
     |
     +-- 1. Hash all current files
     +-- 2. Load stored Merkle DAG
     +-- 3. Diff current vs stored
     |
     v
Delta: { added[], removed[], modified[] }
     |
     +--- No changes? -> skip
     |
     +--- Changes found:
          |
          +-- Delete chunks for removed + modified files
          +-- Re-split + re-embed added + modified files
          +-- Insert new chunks into Milvus
          +-- Persist updated Merkle DAG
          +-- Snapshot -> sync_completed
```

---

## 7. Data Lineage

```
file -> CodeChunk -> EmbeddingVector -> VectorDocument -> Milvus row
     -> search result -> MCP response snippet

VectorDocument fields:
  id:            deterministic hash(path + lineRange + content)
  vector:        float32[dimension]
  content:       chunk text
  relativePath:  file path relative to codebase root
  startLine:     first line of chunk
  endLine:       last line of chunk
  fileExtension: .ts, .py, etc.
  metadata:      breadcrumbs, language, codebase path
```

---

## 8. Extension Seams

```
New embedding provider  -> implement Embedding interface
New vector backend      -> implement VectorDatabase interface
New tool                -> add to tools/* + register in core/handlers.ts
Search policy tuning    -> CapabilityResolver + rerank decision
New language support    -> add tree-sitter grammar to AstCodeSplitter
```

Key files:
- `packages/core/src/core/context.ts`
- `packages/core/src/sync/synchronizer.ts`
- `packages/core/src/vectordb/*`
- `packages/mcp/src/index.ts`
- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/snapshot.ts`
- `packages/mcp/src/core/sync.ts`
- `packages/mcp/src/tools/*`

---

## 9. Testing

Integration (`tests/integration/context.integration.test.mjs`):
- Index creation and persistence
- Semantic retrieval quality signal
- Incremental add/modify/remove behavior
- Ignore + negation pattern behavior

MCP unit tests:
- Capability/rerank decision behavior
- Telemetry emission path
- Snapshot fingerprint gate behavior
- Tool registry/schema invariants
