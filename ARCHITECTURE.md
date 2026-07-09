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
  |  | (6 tools)     |->| Resolver         |  | Manager v3        |  |
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
      cli/                       shell client + install/uninstall lifecycle
      core/handlers.ts           tool execution + fingerprint gate
      core/snapshot.ts           state machine + fingerprint storage
      core/sync.ts               background sync + session-scoped watcher
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

### 3.8 Ignore-Rule Reconciliation (No-Reindex Path)

Ignore control files are first-class sync inputs:
- Repo-root `.satoriignore`
- Repo-root `.gitignore` (v1 scope: root only)

Behavior contract:
- Ignore control signatures are checked in `ensureFreshness()` before freshness throttle returns.
- On signature change, Satori runs reconciliation without full reindex:
  - delete indexed paths now ignored by the active matcher
  - run incremental sync to pick up newly unignored files
- Watcher mode and non-watcher mode both converge through the same reconcile path.
- Watcher mode is session-scoped: startup does not register every indexed root, only codebases touched by successful index/search/navigation/read flows in the current session.

---

## 4. MCP Runtime

### 4.1 Bootstrap

`packages/mcp/src/index.ts`:
- Starts MCP stdio server
- Redirects `console.log`/`console.warn` to `stderr` (protects JSON-RPC on stdout)
- Builds runtime fingerprint
- Wires Context, SnapshotManager, SyncManager, ToolHandlers, optional VoyageAI Reranker
- Starts background sync loop
- Enables watcher mode by default (`MCP_ENABLE_WATCHER=true`), but active chokidar watchers are created only for touched codebases in the current session watch list

### 4.2 Tool Surface

```
manage_index     create | reindex | sync | status | clear | repair
search_codebase  runtime-first semantic search (scope + grouped/raw)
call_graph       callers/callees traversal from symbolRef
file_outline     sidecar-backed per-file symbol navigation
read_file        safe read with optional line ranges / open_symbol
list_codebases   tracked state summary
```

Tool schemas are defined in Zod, then converted to JSON Schema for MCP `ListTools`.

**Semantic readiness vs navigation richness**

- `search_codebase` depends on **semantic readiness** (snapshot + fingerprint + completion marker + collection presence; see §5.4).
- `file_outline`, `call_graph`, and `read_file(open_symbol)` depend on **navigation/symbol artifacts** (registry and relationship sidecars).
- A codebase may be **searchable without being symbol-rich**. Check `manage_index status` / `list_codebases` `symbolQuality` (`symbol_rich` | `mixed` | `symbol_sparse` | `search_only` | `unknown`) before treating outline/call_graph as rich evidence.
- `indexed` / ready lifecycle means searchable-readable, not automatically symbol-rich.

### 4.3 ToolHandlers

- Absolute path normalization/validation
- Cloud/local reconciliation before key operations
- Fingerprint compatibility gate before searchable access
- Completion-marker proof validation on read paths (fail closed; read tools never write proof)
- Background indexing kickoff for `manage_index(action=create)`
- Subdirectory smart-resolution to indexed parent root for search

### 4.4 Capability Model

```
Provider mapping:
  Ollama              -> local / slow     -> limit 10, max 15
  VoyageAI, OpenAI    -> cloud / fast     -> limit 50, max 50
  Others (Gemini)     -> cloud / standard -> limit 25, max 30

Rerank decision:
  driven internally by capability profile
  (no public `useReranker` input on `search_codebase`)
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
  embeddingModel       "voyage-code-3"
  embeddingDimension   1024
  vectorStoreProvider  "Milvus"
  schemaVersion        "dense_v3" | "hybrid_v3"
}
```

Mismatch on any field -> `requires_reindex`.
Legacy v1/v2 snapshots auto-migrate on load but get flagged as legacy.

### 5.3 Gate Reasons

- Legacy assumed fingerprint (pre-v3 snapshot)
- Missing fingerprint field
- Provider, model, or dimension mismatch
- Schema version mismatch (any non-v3 fingerprint)

### 5.4 Readiness & Proof

Do not blur these roles:

```text
snapshot           = local bookkeeping (lifecycle status, last stats, stored fingerprint)
completion marker  = remote commit proof (vector collection document)
sync               = cheap maintenance of an already-trusted collection
repair             = re-proof local readiness without embedding/vector chunk writes
reindex / create   = recreate trust from scratch (full vector rewrite)
```

```text
Readiness invariant:
A semantic index is ready only when local snapshot state, runtime fingerprint,
remote completion marker, and vector collection presence agree.

Navigation richness is separate:
A ready semantic index may still be symbol_sparse or search_only.
```

#### What proves an index is ready (semantic)

Readiness is layered. Snapshot status alone is **not** proof.

| Layer | Source of truth | Ready when |
|-------|-----------------|------------|
| A. Snapshot searchable | `~/.satori` snapshot | Status is `indexed` or `sync_completed` |
| B. Runtime fingerprint gate | Snapshot fingerprint vs current runtime | Provider, model, dimension, vector store, and `schemaVersion` match; not legacy-unverified / missing |
| C. Completion proof | Marker doc in the vector collection (`satori_index_completion_v1`) | Shape valid, path matches, fingerprint matches runtime → `validateCompletionProof` outcome `valid` |
| D. Collection presence | Configured vector backend | Collection for the root still exists |

Implementation path: `TrackedRootReadiness.prepareTrackedRootForRead` returns `state: "ready"` only when those layers agree for the access mode.

**Navigation nuance:** under fingerprint / completion-proof mismatch, source-backed `file_outline` / `call_graph` may still run; semantic search must not pretend the vector index matches the current runtime.

#### What invalidates that proof

| Condition | Typical outcome |
|-----------|-----------------|
| Marker missing, wrong kind, bad payload, or path mismatch | `stale_local` (local snapshot can lie) |
| Marker fingerprint ≠ runtime fingerprint | `fingerprint_mismatch` → `requires_reindex` |
| Snapshot fingerprint mismatch / missing / legacy unverified | `requires_reindex` |
| Vector collection gone | `missing_collection` (fail closed; no implicit rebuild on read) |
| Provider config incomplete at runtime | Failed / not ready (config) — not a forged fingerprint story |
| Indexing failed mid-run | `indexfailed` — no successful completion marker |
| Incremental sync navigation recovery fails | `requires_reindex` (`navigation_recovery_failed`) |
| Remote chunks missing/extra vs current source set | Blocks **repair**; needs create/reindex |

Sync does **not** replace proof after a model/schema/provider change.

#### Who may write the completion marker

```text
Only create, reindex, repair, and trusted marker-maintaining sync may write a completion marker.
Read tools never write proof.
Snapshot recovery may restore local state from an existing valid marker, but does not create a marker.
```

| Path | Writes / recreates marker? | Notes |
|------|----------------------------|--------|
| `manage_index` **create** | Yes | Full index → marker + snapshot `indexed` (verified) |
| `manage_index` **reindex** | Yes | Full rebuild under current fingerprint |
| `manage_index` **repair** | Yes, conditional | See repair rule below; no vector chunk rewrite |
| **sync** / background sync / search sync-on-read | Maintains only | May refresh a marker only for an already-trusted committed collection; must not forge proof for an untrusted or unknown collection |
| **clear** | Destroys | User-explicit destructive |
| Read tools | Never | Fail closed; may recommend create / reindex / repair |
| Startup snapshot recovery from marker | No new marker | Restores local readiness view when the existing marker is valid |

#### Repair rule (precise)

```text
repair only when vector payload can be proven complete and fingerprint provenance is trusted
```

- Marker present and fingerprint matches runtime → repair may re-prove (rebuild nav sidecars, rewrite marker).
- Marker **missing**, but a **verified** snapshot fingerprint matches runtime and payload coverage is complete → repair may still succeed (this is the missing-marker recovery path).
- Marker missing and no trusted matching fingerprint → refuse (do not forge current fingerprint over unproven vectors).
- Fingerprint mismatch → `requires_reindex`, not repair.
- Missing/extra remote chunks vs expected split → blocked (`needs_create`); use create/reindex.

#### Cost ladder: sync vs repair vs reindex

```text
cheapest ──────────────────────────────────────────────── most expensive
  sync          repair              reindex / create(force)
  (incremental) (local re-proof)    (full vector rewrite)
```

| Path | Cost profile | When to use |
|------|--------------|-------------|
| **sync** | Cheap: merkle/change-driven embed upsert/delete | Already trusted index; working-tree or ignore/policy convergence |
| **repair** | Mid: CPU/IO to verify coverage + rebuild sidecars; **no** embedding spend | Local readiness broken; vectors complete; fingerprint provenance trusted |
| **reindex** / **create** | Expensive: full re-split, re-embed, re-insert | Fingerprint mismatch, missing collection, coverage failure, `indexfailed`, or repair returns reindex/create |

**Decision cheat sheet**

| Symptom | Prefer |
|---------|--------|
| Files changed, same embed model/backend | **sync** |
| `.satoriignore` / index-policy only | **sync** (unnecessary reindex often blocked by preflight) |
| Marker/sidecars broken; vectors match + trusted provenance | **repair** |
| Changed embedding model / dims / schema / provider | **reindex** (not sync, not repair) |
| Collection deleted / empty / chunk gaps | **create** / **reindex** |
| `provider_incomplete` | Fix env + restart MCP, then re-evaluate |

Primary code owners: `packages/mcp/src/core/completion-proof.ts`, `tracked-root-readiness.ts`, `snapshot.ts`, `sync.ts`, `manage-indexing-handlers.ts`; `packages/core/src/core/context.ts` (`writeIndexCompletionMarker`, `repairIndex`, `reindexByChange`).

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
  -> enforce fingerprint gate (pre-v3 -> requires_reindex envelope)
  -> handleSearchCode
      -> ensureFreshness (sync-on-read)
      -> 2-pass semantic retrieval + RRF fusion
      -> scope hard filters (runtime/docs/mixed) + path priors
      -> grouped or raw response shaping
      -> grouped mode emits callGraphHint + freshnessDecision
  -> telemetry emit

call_graph
  -> enforce fingerprint gate (pre-v3 -> requires_reindex envelope)
  -> resolve indexed root + sidecar
  -> traverse callers/callees/both with deterministic ordering
  -> return nodes/edges/notes (+ unresolved/dynamic diagnostics)
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
     +-- Ignore control signature changed?
     |      -> reconcile ignore rules (no full reindex)
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
