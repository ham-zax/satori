# Satori Repo Learning Roadmap

This guide is for understanding the Satori codebase from first principles.

It assumes you may have built parts of the app quickly and now need a clear map of what exists, why it exists, and what to learn next. Treat this as your repo-specific study plan, not a generic AI glossary.

## What Satori Is

Satori is an agent-safe semantic code retrieval system for coding agents.

Its job is to help an AI coding agent answer questions like:

```txt
Where is auth token refresh handled?
Trace request validation from route to service.
Find the database write path for user deletion.
Where does index freshness get checked?
```

Satori does this by:

1. Indexing a real codebase.
2. Splitting source files into useful chunks.
3. Embedding those chunks.
4. Storing vectors in Milvus or Zilliz.
5. Running semantic and keyword retrieval.
6. Returning exact files, line ranges, symbols, and graph hints through MCP tools.

The important product boundary:

- Satori helps agents investigate code.
- Satori does not directly edit user code through MCP.
- The host coding environment still performs edits.

That read-only boundary is one of the main trust features.

## What This Repo Is Not

Satori is not:

- a general agent framework
- a chat app
- a frontend-heavy UI product
- a code editor
- a replacement for tests or typecheck
- a write-capable MCP server
- a generic vector database wrapper
- a documentation-only search app

Its boundary is intentionally narrow:

```txt
index -> search -> navigate -> read -> manage lifecycle
```

## Top-Level Mental Model

Satori is a TypeScript pnpm monorepo with three runtime packages:

```txt
packages/core
  Indexing, chunking, embeddings, vector database access, incremental sync.

packages/mcp
  MCP server, six tool contracts, state gates, freshness, snapshots, call graph sidecars.

packages/cli
  Installer and shell client that talks to the MCP server.
```

The flow looks like this:

```txt
MCP client
  -> JSON-RPC over stdio
  -> @zokizuan/satori-mcp
  -> Tool registry
  -> ToolHandlers
  -> SnapshotManager / SyncManager / CapabilityResolver
  -> @zokizuan/satori-core
  -> splitter + embeddings + vector DB + sync
  -> Milvus/Zilliz and ~/.satori local state
```

The most important design idea:

```txt
MCP owns control flow and state gates.
Core owns indexing and retrieval computation.
CLI owns installation and shell invocation.
```

## Repository Map

```txt
.
|-- README.md
|-- ARCHITECTURE.md
|-- AGENTS.md
|-- package.json
|-- pnpm-workspace.yaml
|-- server.json
|-- docs/
|   |-- README.md
|   |-- SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md
|   |-- SATORI_FEATURES_AND_USE_CASES.md
|   |-- plans/
|   |-- release/
|   |-- remediation/
|-- packages/
|   |-- core/
|   |   |-- src/core/context.ts
|   |   |-- src/splitter/
|   |   |-- src/embedding/
|   |   |-- src/vectordb/
|   |   |-- src/sync/
|   |   |-- src/language/
|   |   `-- src/config/
|   |-- mcp/
|   |   |-- src/index.ts
|   |   |-- src/server/
|   |   |-- src/tools/
|   |   |-- src/core/
|   |   |-- src/telemetry/
|   |   `-- src/cli/
|   `-- cli/
|       |-- src/index.ts
|       |-- src/client.ts
|       |-- src/install.ts
|       |-- src/args.ts
|       `-- assets/skills/
|-- tests/integration/
|-- scripts/
`-- satori-landing/
```

Do not start by reading every file. Start with the architecture docs, then follow the actual runtime paths below.

## Main Packages

### `@zokizuan/satori-core`

Path: `packages/core`

This is the lower-level engine.

Responsibilities:

- file discovery
- ignore rule loading
- AST-aware code chunking
- fallback text splitting
- embedding generation
- vector database collection setup
- dense and hybrid search
- incremental sync through file snapshots
- deleting and replacing chunks for changed files

Key files:

- `packages/core/src/core/context.ts`
- `packages/core/src/splitter/ast-splitter.ts`
- `packages/core/src/splitter/langchain-splitter.ts`
- `packages/core/src/embedding/base-embedding.ts`
- `packages/core/src/embedding/*-embedding.ts`
- `packages/core/src/vectordb/types.ts`
- `packages/core/src/vectordb/milvus-vectordb.ts`
- `packages/core/src/vectordb/milvus-restful-vectordb.ts`
- `packages/core/src/sync/synchronizer.ts`
- `packages/core/src/language/registry.ts`
- `packages/core/src/config/defaults.ts`

The main class is `Context`.

Important methods in `Context`:

- `indexCodebase`
- `semanticSearch`
- `reindexByChange`
- `resolveCollectionName`
- `prepareCollection`
- `loadIgnorePatterns`
- `getCodeFiles`
- `processFileList`
- `deleteIndexedPathsByRelativePaths`

Core should stay MCP-agnostic. It should not know about MCP tool envelopes, MCP request schemas, JSON-RPC, or client install behavior.

### `@zokizuan/satori-mcp`

Path: `packages/mcp`

This package exposes Satori to AI clients through MCP.

Responsibilities:

- start the MCP server
- protect stdout for stdio JSON-RPC
- load runtime config from env
- build embedding and vector DB dependencies
- expose exactly six tools
- validate tool input schemas
- enforce index/fingerprint/completion-proof gates
- manage snapshot state
- manage background sync and watcher freshness
- build call graph sidecars
- shape deterministic tool responses
- emit search telemetry

Key files:

- `packages/mcp/src/index.ts`
- `packages/mcp/src/server/start-server.ts`
- `packages/mcp/src/server/stdio-safety.ts`
- `packages/mcp/src/config.ts`
- `packages/mcp/src/embedding.ts`
- `packages/mcp/src/tools/registry.ts`
- `packages/mcp/src/tools/*.ts`
- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/snapshot.ts`
- `packages/mcp/src/core/sync.ts`
- `packages/mcp/src/core/call-graph.ts`
- `packages/mcp/src/core/capabilities.ts`
- `packages/mcp/src/core/completion-proof.ts`
- `packages/mcp/src/core/search-types.ts`
- `packages/mcp/src/core/manage-types.ts`
- `packages/mcp/src/core/warnings.ts`
- `packages/mcp/src/telemetry/search.ts`

The main class is `ToolHandlers`.

Important methods in `ToolHandlers`:

- `handleIndexCodebase`
- `handleReindexCodebase`
- `handleSyncCodebase`
- `handleGetIndexingStatus`
- `handleSearchCode`
- `handleFileOutline`
- `handleCallGraph`
- `handleClearIndex`

The MCP package is where most system invariants live.

### `@zokizuan/satori-cli`

Path: `packages/cli`

This is the standalone CLI package.

Responsibilities:

- install or uninstall Satori MCP config for Codex, Claude, and OpenCode
- copy the first-party workflow skill
- start an MCP stdio session for direct shell tool calls
- reflect MCP tools through `tools/list`
- call MCP tools through `tools/call`
- parse wrapper flags from tool schemas
- keep stdout JSON-only and diagnostics on stderr
- map failures to stable exit codes

Key files:

- `packages/cli/src/index.ts`
- `packages/cli/src/client.ts`
- `packages/cli/src/args.ts`
- `packages/cli/src/install.ts`
- `packages/cli/src/format.ts`
- `packages/cli/src/errors.ts`
- `packages/cli/src/package-installability.ts`
- `packages/cli/src/resolve-server-entry.ts`
- `packages/cli/assets/skills/satori/SKILL.md`

There is also CLI-related code under `packages/mcp/src/cli`. Be careful when changing installer or CLI behavior: check tests in both locations before assuming only one package is affected.

## Required Prerequisites

### Tooling

You should know:

- Node.js 20+
- pnpm workspaces
- TypeScript strict mode
- ESM vs CommonJS basics
- npm package `bin` entries
- shell stdout/stderr basics
- environment variables
- Git basics

Repo commands:

```bash
pnpm install
pnpm run build
pnpm run check
pnpm run lint
pnpm run typecheck
pnpm run versions:check
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
pnpm --filter @zokizuan/satori-core test:integration
```

### Backend And Systems Basics

You should understand:

- async/await
- streams and stdio
- file system operations
- process signals
- concurrency and coalescing
- state machines
- idempotency
- retries and timeouts
- local cache/snapshot files
- external service adapters
- deterministic sorting
- validation at boundaries

### AI/RAG Basics

You should understand:

- LLM
- context window
- hallucination
- embeddings
- vector similarity
- vector database
- semantic search
- keyword search
- BM25
- hybrid search
- Reciprocal Rank Fusion
- reranking
- chunking
- AST-aware chunking
- retrieval-augmented generation
- tool calling
- MCP

## Runtime Requirements

To actually run Satori end to end, you need:

- an embedding provider
- a vector store
- an MCP client or the Satori CLI

Embedding provider options in the code:

- OpenAI
- VoyageAI
- Gemini
- Ollama

Vector store:

- Milvus/Zilliz through the `VectorDatabase` interface

Common env vars:

```bash
EMBEDDING_PROVIDER=VoyageAI
EMBEDDING_MODEL=voyage-code-3
EMBEDDING_OUTPUT_DIMENSION=1024
VOYAGEAI_API_KEY=...
VOYAGEAI_RERANKER_MODEL=rerank-2.5
MILVUS_ADDRESS=...
MILVUS_TOKEN=...
HYBRID_MODE=true
MCP_ENABLE_WATCHER=true
MCP_WATCH_DEBOUNCE_MS=5000
READ_FILE_MAX_LINES=1000
```

Never commit real API keys, Milvus tokens, or provider credentials.

## Six MCP Tools

The public MCP surface is fixed at six tools:

1. `list_codebases`
2. `manage_index`
3. `search_codebase`
4. `file_outline`
5. `call_graph`
6. `read_file`

This is a core invariant. Do not add a seventh MCP tool casually.

The normal agent workflow is:

```txt
search_codebase
  -> file_outline
  -> call_graph
  -> read_file
```

If `call_graph` is unavailable, search results should provide `navigationFallback` so the agent can still read exact spans without guessing.

## What Each Tool Does

### `list_codebases`

Lists tracked codebases by state.

Use it to answer:

- What roots are currently indexed?
- Which roots are indexing?
- Which roots failed?
- Which roots require reindex?

### `manage_index`

Manages lifecycle actions:

- `create`
- `reindex`
- `sync`
- `status`
- `clear`

Important:

- `clear` is destructive.
- `sync` handles normal changed-file convergence.
- `reindex` is for compatibility rebuilds and full recovery.
- If a tool returns `requires_reindex`, do not substitute `sync`.

### `search_codebase`

Runs semantic retrieval with deterministic defaults:

```txt
scope=runtime
resultMode=grouped
groupBy=symbol
rankingMode=auto_changed_first
debug=false
```

It is the only navigation tool that performs sync-on-read freshness gating.

Supported operators:

```txt
lang:
path:
-path:
must:
exclude:
```

Filtering order is:

```txt
scope -> lang -> path include -> path exclude -> must -> exclude
```

### `file_outline`

Returns symbols for a file from the call graph sidecar.

Modes:

- `outline`
- `exact`

Use it to lock exact symbol spans before reading or editing.

### `call_graph`

Traverses callers/callees/both from a `symbolRef`.

Currently strongest for:

- TypeScript
- JavaScript
- Python

The graph is sidecar-backed and bounded by depth/limit.

### `read_file`

Reads local files with optional line ranges.

Modes:

- `plain`
- `annotated`

It supports `open_symbol`, which resolves exact symbols through `file_outline` instead of guessing line ranges.

## Core AI/RAG Concepts In This Repo

### Embeddings

An embedding turns text into a vector of numbers.

In Satori:

- query text becomes an embedding
- code chunks become embeddings
- similarity search finds chunks near the query vector

Implementation:

- `packages/core/src/embedding/base-embedding.ts`
- provider files in `packages/core/src/embedding/`
- factory in `packages/mcp/src/embedding.ts`

### Vector Database

A vector database stores embedded code chunks and searches by vector similarity.

In Satori:

- `VectorDatabase` is the port/interface
- Milvus and REST implementations are adapters
- collections are named from the codebase path hash

Implementation:

- `packages/core/src/vectordb/types.ts`
- `packages/core/src/vectordb/milvus-vectordb.ts`
- `packages/core/src/vectordb/milvus-restful-vectordb.ts`

### Dense Search

Dense search uses embedding vectors. It is good for meaning-based search.

Example:

```txt
where is retry behavior implemented
```

can find code even when the exact word "retry behavior" is not present.

### BM25 And Sparse Search

BM25 is keyword-style ranking. It is good for exact terms:

- function names
- constants
- error codes
- config keys
- file path terms

### Hybrid Search

Hybrid search combines dense search and sparse keyword search.

In Satori:

- dense vector search handles meaning
- sparse BM25 handles exact words
- RRF merges result rankings

This is important because code retrieval needs both meaning and exact identifiers.

### Reciprocal Rank Fusion

RRF merges rankings without needing score calibration.

That matters because dense scores and lexical scores are not naturally comparable.

Satori uses RRF in both the vector backend hybrid path and MCP post-processing/rerank paths.

### Reranking

Reranking takes candidate results and performs a second ranking step.

In Satori:

- VoyageAI reranking is optional
- policy decides when to use it
- docs scope skips reranking
- failure degrades with warnings instead of breaking search

Implementation:

- `packages/core/src/reranker/`
- `packages/mcp/src/core/capabilities.ts`
- `packages/mcp/src/core/handlers.ts`

### Chunking

Chunking splits files into searchable units.

Bad chunking can hide important context or split functions badly.

Satori uses:

- AST-aware splitting when possible
- Recursive fallback splitting otherwise

Implementation:

- `packages/core/src/splitter/ast-splitter.ts`
- `packages/core/src/splitter/langchain-splitter.ts`

### AST-Aware Chunking

AST means abstract syntax tree. It is the parsed structure of source code.

Satori uses tree-sitter to split around code structures such as:

- functions
- methods
- classes
- interfaces
- type aliases

This makes results more edit-ready than arbitrary text chunks.

### Breadcrumbs

Breadcrumbs describe where a chunk lives structurally.

Example:

```txt
class UserService > method refreshToken
```

They help the agent distinguish similar chunks from different scopes.

### RAG

RAG means retrieval-augmented generation.

Generic RAG flow:

```txt
question -> retrieve relevant context -> send context to model -> answer
```

Satori is a code-agent retrieval system. Its version of RAG is more constrained:

```txt
query -> retrieve code spans -> inspect symbols/graph -> read exact file ranges -> edit in host environment
```

The important part is not "send lots of context." The important part is "send the right bounded evidence."

### MCP

MCP means Model Context Protocol.

It lets AI clients call tools exposed by a server.

In Satori:

- MCP transport is JSON-RPC over stdio
- tool schemas are defined with Zod
- schemas are converted to JSON Schema
- tools return deterministic text or JSON envelopes

Implementation:

- `packages/mcp/src/index.ts`
- `packages/mcp/src/server/start-server.ts`
- `packages/mcp/src/tools/registry.ts`

### Stdio Safety

When MCP runs over stdio, stdout is protocol traffic.

If normal logs accidentally go to stdout, JSON-RPC can break.

Satori patches console output and CLI stdout behavior to protect protocol traffic.

Implementation:

- `packages/mcp/src/index.ts`
- `packages/mcp/src/server/stdio-safety.ts`

### Snapshot State

Snapshot state records what codebases are indexed and their lifecycle state.

Stored under:

```txt
~/.satori/mcp-codebase-snapshot.json
```

States include:

- `indexing`
- `indexed`
- `indexfailed`
- `sync_completed`
- `requires_reindex`

Implementation:

- `packages/mcp/src/core/snapshot.ts`

### Fingerprint Gate

Each index stores a runtime fingerprint:

```txt
embedding provider
embedding model
embedding dimension
vector store provider
schema version
```

If the runtime fingerprint differs from the stored fingerprint, Satori blocks searchable access with `requires_reindex`.

This prevents mixing incompatible embeddings or collection schemas.

Implementation:

- `packages/mcp/src/config.ts`
- `packages/mcp/src/core/snapshot.ts`
- `packages/mcp/src/core/handlers.ts`

### Completion Proof

Satori writes a marker document into the vector backend after successful indexing.

Local snapshot state alone is not enough proof. The remote vector collection must also have valid completion proof.

Implementation:

- `packages/mcp/src/core/completion-proof.ts`
- marker read/write paths in `Context`

### Incremental Sync

After initial index, Satori should not re-embed everything for every small edit.

It tracks file changes and reindexes only changed files.

Implementation:

- `packages/core/src/sync/synchronizer.ts`
- `packages/core/src/sync/merkle.ts`
- `packages/core/src/core/context.ts`
- `packages/mcp/src/core/sync.ts`

### Merkle Snapshot

The synchronizer stores file hashes and computes a Merkle-style root.

This gives deterministic detection of:

- added files
- removed files
- modified files

It also has stat-first/hash-on-change behavior for speed.

### Ignore Reconciliation

`.gitignore` and `.satoriignore` changes should not require full reindex in normal cases.

Satori reconciles ignore changes by:

1. reloading ignore rules
2. deleting newly ignored indexed paths
3. running incremental sync for newly unignored paths
4. updating manifest/signature state

Implementation:

- `packages/mcp/src/core/sync.ts`
- `packages/core/src/core/context.ts`

### Call Graph Sidecar

The call graph is stored as a sidecar file under `~/.satori`.

It contains:

- symbol nodes
- call/import/dynamic edges
- notes for unresolved or missing metadata
- fingerprint metadata

Implementation:

- `packages/mcp/src/core/call-graph.ts`

## Key Data Flows

### Indexing Flow

```txt
manage_index(action=create)
  -> validate path
  -> check snapshot state
  -> check collection capacity
  -> set snapshot status=indexing
  -> start background indexing
  -> load ignore rules
  -> initialize FileSynchronizer
  -> prepare vector collection
  -> scan files
  -> split files into chunks
  -> embed chunks
  -> insert chunks into Milvus/Zilliz
  -> write completion marker
  -> set snapshot status=indexed
  -> rebuild call graph sidecar
```

Important files:

- `packages/mcp/src/tools/manage_index.ts`
- `packages/mcp/src/core/handlers.ts`
- `packages/core/src/core/context.ts`
- `packages/core/src/sync/synchronizer.ts`
- `packages/mcp/src/core/call-graph.ts`

### Search Flow

```txt
search_codebase
  -> validate args
  -> resolve requested path
  -> resolve indexed parent root if needed
  -> enforce fingerprint gate
  -> validate completion proof
  -> run sync-on-read freshness
  -> parse query operators
  -> classify query intent
  -> run primary and expanded search passes
  -> apply filters
  -> score candidates
  -> optionally rerank
  -> group by symbol or file
  -> attach callGraphHint or navigationFallback
  -> attach warnings/hints/debug payloads
  -> emit telemetry
```

Important files:

- `packages/mcp/src/tools/search_codebase.ts`
- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/search-constants.ts`
- `packages/mcp/src/core/search-types.ts`
- `packages/mcp/src/telemetry/search.ts`
- `packages/core/src/core/context.ts`

### Navigation Flow

```txt
search result
  -> callGraphHint supported
  -> file_outline to lock symbol spans
  -> call_graph to inspect callers/callees
  -> read_file open_symbol or line range
```

Fallback flow:

```txt
search result
  -> callGraphHint unsupported
  -> navigationFallback.readSpan
  -> read_file with exact args
```

Important files:

- `packages/mcp/src/tools/file_outline.ts`
- `packages/mcp/src/tools/call_graph.ts`
- `packages/mcp/src/tools/read_file.ts`
- `packages/mcp/src/core/call-graph.ts`
- `packages/mcp/src/core/handlers.ts`

### Sync Flow

```txt
trigger
  -> manual sync, search freshness, background timer, watcher event
  -> SyncManager.ensureFreshness
  -> coalesce if same root already syncing
  -> skip if recently synced
  -> check ignore-control signature
  -> maybe run ignore reconciliation
  -> Context.reindexByChange
  -> FileSynchronizer.checkForChanges
  -> delete removed/modified chunks
  -> embed added/modified files
  -> update snapshot
  -> rebuild call graph sidecar if needed
```

Important files:

- `packages/mcp/src/core/sync.ts`
- `packages/core/src/sync/synchronizer.ts`
- `packages/core/src/core/context.ts`
- `packages/mcp/src/core/snapshot.ts`
- `packages/mcp/src/core/call-graph.ts`

### CLI Flow

```txt
satori-cli command
  -> parse global args
  -> install/uninstall handled locally
  -> otherwise start MCP server in SATORI_RUN_MODE=cli
  -> connect MCP stdio client
  -> list tools or call tool
  -> emit JSON to stdout
  -> diagnostics to stderr
  -> map errors to exit code
```

Important files:

- `packages/cli/src/index.ts`
- `packages/cli/src/client.ts`
- `packages/cli/src/args.ts`
- `packages/cli/src/install.ts`
- `packages/cli/src/format.ts`
- `packages/mcp/src/server/stdio-safety.ts`

## Design Patterns Used

### Ports And Adapters

The core package defines interfaces such as:

- `Embedding`
- `VectorDatabase`
- `Splitter`

Provider-specific implementations sit behind those contracts.

This allows:

- OpenAI/VoyageAI/Gemini/Ollama embeddings
- Milvus gRPC and REST vector DBs
- AST splitter and recursive fallback splitter

### Dependency Injection

The MCP server builds dependencies in `start-server.ts`:

- embedding instance
- vector database
- `Context`
- `SnapshotManager`
- `SyncManager`
- `CapabilityResolver`
- `ToolHandlers`
- reranker

Then it passes them through `ToolContext`.

This keeps tools thin and testable.

### Zod Boundary Validation

Tool inputs are validated with Zod in `packages/mcp/src/tools`.

Why this matters:

- MCP clients can inspect JSON schemas.
- Invalid inputs fail before handlers run.
- Tool contracts stay explicit.

### Deterministic Envelopes

Many tools return structured JSON envelopes with:

- `status`
- `reason`
- `message`
- `hints`
- `warnings`
- `results`

This is important because agents need machine-readable recovery paths.

### State Machines

Index lifecycle is a state machine.

Important states:

- not indexed
- indexing
- indexed
- sync completed
- index failed
- requires reindex

Do not treat this as just booleans.

### Fail Closed On Ambiguity

Examples:

- fingerprint mismatch blocks search
- missing completion proof does not pretend ready
- ambiguous `file_outline exact` does not guess
- `open_symbol` does not guess a span
- unmanaged CLI config is not overwritten

### Background Work With Explicit State

Indexing runs in the background, but snapshot state is updated so clients can check progress.

This is why status handling and progress persistence matter.

### Coalescing And Debounce

Sync work can be expensive. Satori avoids duplicate work through:

- active sync coalescing
- watcher debounce
- periodic sync with non-overlapping scheduling

### Graceful Degradation

When optional parts fail, Satori should degrade predictably:

- reranker failure adds `RERANKER_FAILED`
- unsupported graph returns navigation fallback
- probe failure can add debug hints
- warnings mean usable but degraded

### Schema-Generated Docs

MCP tool docs are generated from live schemas.

This reduces drift between implementation and README documentation.

## Important Invariants

These are the rules you should protect when editing.

### Public Tool Surface Is Exactly Six Tools

Do not add tools casually.

If a new tool is truly needed, it should come with:

- architecture justification
- updated authoritative spec
- registry tests
- generated docs
- README updates
- client/skill impact review

### Satori MCP Is Read-Only For Code

No MCP tool should mutate user source files.

`manage_index` mutates index state, not project code.

### `requires_reindex` Means Reindex

Do not use `sync` to repair fingerprint mismatch.

`sync` is for normal file/ignore changes.

`reindex` is for incompatible index state.

### Search Owns Sync-On-Read

`search_codebase` runs freshness checks.

Other navigation tools do not run sync-on-read by design.

### Completion Proof Matters

Do not treat local snapshot ready state as enough if remote completion proof is missing or invalid.

### Stdout Is Protocol

In MCP over stdio, stdout must stay JSON-RPC safe.

Logs belong on stderr.

### Ignore Changes Should Not Usually Require Reindex

`.satoriignore` or root `.gitignore` edits should normally converge through sync/reconciliation.

### Local State Must Not Lie About Remote Delete

If remote collection deletion is indeterminate, do not clear local ready state as if success is proven.

### Tests Are Part Of The Contract

Behavior changes should update tests and docs together.

## Roadmap To Understand The Repo

### Phase 0: Get Oriented

Goal: understand what exists and how to run checks.

Read:

- `README.md`
- `ARCHITECTURE.md`
- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
- `docs/SATORI_FEATURES_AND_USE_CASES.md`
- `package.json`
- `pnpm-workspace.yaml`

Run:

```bash
pnpm install
pnpm run versions:check
pnpm run typecheck
```

You should be able to answer:

- What are the three runtime packages?
- What are the six MCP tools?
- Which package owns indexing?
- Which package owns tool state?
- Which package owns install/uninstall?

### Phase 1: Learn The Core Engine

Goal: understand how code becomes searchable vectors.

Read:

- `packages/core/src/core/context.ts`
- `packages/core/src/types.ts`
- `packages/core/src/vectordb/types.ts`
- `packages/core/src/embedding/base-embedding.ts`
- `packages/core/src/splitter/ast-splitter.ts`
- `packages/core/src/splitter/langchain-splitter.ts`
- `packages/core/src/language/registry.ts`

Trace:

```txt
Context.indexCodebase
  -> getCodeFiles
  -> processFileList
  -> splitter.split
  -> embedding.embedBatch
  -> vectorDatabase.insert or insertHybrid
```

Exercise:

- Write a one-page note explaining how a `.ts` file becomes vector rows.
- Include where line numbers, breadcrumbs, symbol IDs, and metadata are created.

### Phase 2: Learn Embeddings And Vector Storage

Goal: understand the external AI infrastructure.

Read:

- `packages/core/src/embedding/*-embedding.ts`
- `packages/core/src/vectordb/types.ts`
- `packages/core/src/vectordb/milvus-vectordb.ts`
- `packages/core/src/vectordb/milvus-restful-vectordb.ts`
- `packages/core/src/vectordb/remote-delete.ts`

Learn:

- embedding dimensions
- provider-specific model config
- dense vs hybrid collection schema
- collection naming by codebase path hash
- marker documents
- remote delete verification

Exercise:

- Explain why changing embedding model or dimension requires reindex.
- Explain why collection deletion must be verified before local state is cleared.

### Phase 3: Learn MCP Server Startup

Goal: understand how the server boots and exposes tools.

Read:

- `packages/mcp/src/index.ts`
- `packages/mcp/src/server/start-server.ts`
- `packages/mcp/src/server/stdio-safety.ts`
- `packages/mcp/src/config.ts`
- `packages/mcp/src/embedding.ts`
- `packages/mcp/src/tools/registry.ts`

Trace:

```txt
index.ts
  -> install stdio safety
  -> dynamic import start-server
  -> createMcpConfig
  -> ContextMcpServer constructor
  -> setupTools
  -> server.connect(stdio)
```

Exercise:

- Explain the difference between `SATORI_RUN_MODE=mcp` and `SATORI_RUN_MODE=cli`.
- Explain why static imports before stdio patching could be risky.

### Phase 4: Learn Tool Contracts

Goal: understand the public API and its response shapes.

Read:

- `packages/mcp/src/tools/manage_index.ts`
- `packages/mcp/src/tools/search_codebase.ts`
- `packages/mcp/src/tools/file_outline.ts`
- `packages/mcp/src/tools/call_graph.ts`
- `packages/mcp/src/tools/read_file.ts`
- `packages/mcp/src/tools/list_codebases.ts`
- `packages/mcp/src/tools/types.ts`
- `packages/mcp/src/tools/registry.test.ts`

Exercise:

- For each tool, write:
  - required inputs
  - optional inputs
  - normal success response
  - important non-ok statuses
  - what the agent should do next

### Phase 5: Learn Search Deeply

Goal: understand why search is the most complex path.

Read:

- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/search-constants.ts`
- `packages/mcp/src/core/search-types.ts`
- `packages/mcp/src/tools/search_codebase.ts`
- `packages/mcp/src/core/search.eval.test.ts`
- `packages/mcp/src/tools/search_codebase.test.ts`

Trace:

```txt
handleSearchCode
  -> validate path and indexed root
  -> enforce fingerprint gate
  -> validate completion proof
  -> ensureFreshness
  -> parseSearchOperators
  -> buildSearchQueryPlan
  -> semanticSearch primary and expanded passes
  -> filter
  -> score
  -> rerank if policy allows
  -> group
  -> add hints/warnings
```

Learn:

- runtime/docs/mixed scope
- prefix operators
- must retry
- path category multipliers
- changed-files boost
- exact match pinning
- grouping by file or symbol
- navigation fallback
- debug payloads
- telemetry

Exercise:

- Pick a query and manually predict how it will be classified.
- Then inspect `debug:true` output in a real indexed repo.

### Phase 6: Learn State And Lifecycle

Goal: understand why Satori is a state machine, not a stateless search tool.

Read:

- `packages/mcp/src/core/snapshot.ts`
- `packages/mcp/src/config.ts`
- `packages/mcp/src/core/completion-proof.ts`
- `packages/mcp/src/core/indexing-recovery.ts`
- `docs/plans/INDEX_STATE_STABILITY_PLAN.md`
- `ARCHITECTURE.md` for the current snapshot and readiness contract

Learn:

- snapshot v1/v2/v3 migration
- indexed vs sync_completed
- indexfailed
- requires_reindex
- clear tombstones
- lock file handling
- fingerprint equality
- completion marker validation
- interrupted indexing recovery

Exercise:

- Draw the lifecycle transitions for create, sync, reindex, status, clear, and failure.

### Phase 7: Learn Sync And Freshness

Goal: understand how Satori avoids stale indexes without full rebuilds.

Read:

- `packages/core/src/sync/synchronizer.ts`
- `packages/core/src/sync/merkle.ts`
- `packages/mcp/src/core/sync.ts`
- `tests/integration/synchronizer.integration.test.mjs`
- `packages/mcp/src/core/sync.test.ts`
- `packages/mcp/src/core/handlers.watchers.test.ts`

Learn:

- file stat signatures
- hash-on-change
- full hash interval
- partial-scan preservation
- Merkle root
- active sync coalescing
- watcher debounce
- ignore-control signatures
- no-reindex ignore reconciliation

Exercise:

- Explain what happens when `.satoriignore` changes.
- Explain why unreadable folders should not cause mass false deletion.

### Phase 8: Learn Call Graph And Navigation

Goal: understand symbol navigation and graph sidecars.

Read:

- `packages/mcp/src/core/call-graph.ts`
- `packages/mcp/src/core/handlers.call_graph.test.ts`
- `packages/mcp/src/core/handlers.file_outline.test.ts`
- `packages/mcp/src/tools/call_graph.test.ts`
- `packages/mcp/src/tools/file_outline.test.ts`
- `packages/mcp/src/tools/read_file.test.ts`

Learn:

- sidecar format
- symbol nodes
- edges
- notes
- supported language capabilities
- exact symbol resolution
- unsupported-language behavior
- navigation fallback

Exercise:

- For a TypeScript file, explain how a symbol found by search becomes a `call_graph` input.

### Phase 9: Learn The CLI

Goal: understand install/uninstall and direct shell calls.

Read:

- `packages/cli/src/index.ts`
- `packages/cli/src/client.ts`
- `packages/cli/src/args.ts`
- `packages/cli/src/install.ts`
- `packages/cli/src/format.ts`
- `packages/cli/src/errors.ts`
- `packages/cli/src/index.test.ts`
- `packages/cli/src/install.test.ts`

Learn:

- managed config blocks
- Codex TOML config
- Claude JSON config
- dry-run behavior
- schema-driven wrapper flags
- `tools list`
- `tool call`
- stdout JSON and stderr diagnostics
- exit codes

Exercise:

- Explain why the CLI does not implement tool logic directly.
- Explain why installer refuses unmanaged Satori config.

### Phase 10: Learn Testing Strategy

Goal: understand how behavior is protected.

Read:

- `packages/mcp/src/**/*.test.ts`
- `packages/cli/src/**/*.test.ts`
- `tests/integration/*.test.mjs`
- `scripts/check-version-freshness.mjs`

Test groups:

- tool schema tests
- registry tests
- snapshot lifecycle tests
- search behavior tests
- sync tests
- watcher tests
- call graph tests
- CLI parser/install/session tests
- integration tests for core indexing/search/sync

Exercise:

- Before changing behavior, find the existing test closest to that behavior.
- If none exists, add one before changing implementation.

## 30-Day Study Plan

### Week 1: Repo And Runtime Map

Focus:

- package layout
- build scripts
- six tools
- architecture docs
- TypeScript workspace basics

Tasks:

- Run `pnpm install`.
- Run `pnpm run versions:check`.
- Run `pnpm run typecheck`.
- Read `README.md`, `ARCHITECTURE.md`, and this file.
- Make a simple diagram of the three packages.

Outcome:

- You can explain the repo at a high level without opening code.

### Week 2: Core Indexing And Retrieval

Focus:

- `Context`
- splitters
- embeddings
- vector database interface
- file sync snapshot

Tasks:

- Trace `Context.indexCodebase`.
- Trace `Context.semanticSearch`.
- Trace `Context.reindexByChange`.
- Read embedding and vector interfaces.
- Read `FileSynchronizer`.

Outcome:

- You can explain how source files become searchable vector documents.

### Week 3: MCP Tools And Lifecycle

Focus:

- server startup
- tool registry
- handlers
- snapshot state
- fingerprint and completion proof
- search result envelopes

Tasks:

- Trace `start-server.ts`.
- Trace `toolRegistry`.
- Read all tool schema files.
- Deep-read `handleSearchCode`.
- Deep-read `SnapshotManager`.

Outcome:

- You can explain what every MCP tool does and why lifecycle gates exist.

### Week 4: Sync, CLI, And AI/RAG Theory

Focus:

- incremental sync
- watcher mode
- ignore reconciliation
- CLI install/client behavior
- AI retrieval concepts

Tasks:

- Trace `SyncManager.ensureFreshness`.
- Trace `reconcileIgnoreRulesChange`.
- Trace `satori-cli tool call`.
- Read CLI installer tests.
- Write a glossary note for every AI term in this doc.

Outcome:

- You can debug freshness/index lifecycle issues and explain Satori as an agent-safe RAG system.

## Common Change Recipes

### Add A New Embedding Provider

You likely need to touch:

- `packages/core/src/embedding/`
- `packages/core/src/embedding/index.ts`
- `packages/mcp/src/config.ts`
- `packages/mcp/src/embedding.ts`
- capability behavior if provider performance differs
- tests for config and provider creation
- docs and README examples

Protect:

- dimension detection
- fingerprint fields
- missing API key behavior
- no secret leakage in logs

### Add A New Vector Backend

You likely need to touch:

- `packages/core/src/vectordb/types.ts`
- new adapter in `packages/core/src/vectordb/`
- `packages/core/src/vectordb/index.ts`
- MCP server composition
- fingerprint provider values
- tests for backend-specific failure modes

Protect:

- collection creation
- hybrid support
- delete verification
- marker document read/write
- collection limit guidance if applicable

### Add Language Support

You likely need to touch:

- `packages/core/src/language/registry.ts`
- `packages/core/src/splitter/ast-splitter.ts`
- call graph builder/query support if applicable
- tests for splitter/symbol behavior
- docs language support table

Protect:

- honest capability reporting
- fallback behavior for unsupported graph/outline
- no fake call graph support

### Change Search Behavior

You likely need to touch:

- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/search-constants.ts`
- `packages/mcp/src/core/search-types.ts`
- search tests
- docs behavior spec

Protect:

- deterministic sorting
- warning/hint stability
- operator precedence
- grouped vs raw output shape
- debug payloads
- telemetry fields

### Change Tool Inputs Or Outputs

You likely need to touch:

- tool schema in `packages/mcp/src/tools/*.ts`
- handler implementation
- `search-types.ts` or `manage-types.ts`
- registry/schema tests
- README generated docs
- authoritative behavior spec
- CLI wrapper behavior if schema shape changes

Protect:

- backward compatibility
- machine-readable hints
- generated docs freshness
- wrapper parser limitations

### Change Index Lifecycle

You likely need to touch:

- `packages/mcp/src/core/snapshot.ts`
- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/core/completion-proof.ts`
- `packages/mcp/src/core/indexing-recovery.ts`
- lifecycle tests
- docs specs and hardening plans

Protect:

- local/remote state consistency
- clear tombstones
- fingerprint gates
- completion marker validation
- interrupted indexing recovery

### Change CLI Install Behavior

You likely need to touch:

- `packages/cli/src/install.ts`
- `packages/cli/src/args.ts`
- `packages/cli/src/index.ts`
- package the `satori` skill asset under `packages/cli/assets/skills`
- CLI tests
- maybe `packages/mcp/src/cli` if behavior is duplicated there

Protect:

- no overwriting unmanaged config
- dry-run accuracy
- owned skill directories only
- JSON stdout contract

## Red Flags While Editing

Stop and rethink if you are about to:

- add a new MCP tool without a spec update
- add write access to source files through MCP
- skip fingerprint checks
- return vague errors without hints
- parse user input with ad-hoc string hacks when Zod/schema logic belongs at boundary
- add a public knob for internal policy without a strong reason
- clear local state before remote deletion is verified
- make search ordering nondeterministic
- swallow errors silently
- duplicate lifecycle state in another place
- let stdout logs leak into MCP stdio
- treat sync and reindex as interchangeable
- claim unsupported language graph capability

## Best First Debugging Questions

When something breaks, ask:

1. Is this core computation, MCP state/control flow, or CLI transport?
2. Is the codebase indexed, indexing, failed, or requiring reindex?
3. Does the stored fingerprint match the runtime fingerprint?
4. Does completion proof exist and match?
5. Is the path the indexed root or a subdirectory?
6. Is search freshness running or skipped?
7. Are ignore rules hiding the file?
8. Is the language supported for the requested capability?
9. Is the tool response a structured envelope or plain text?
10. Which existing test should cover this?

## Reading Order

Use this sequence if you are starting from scratch:

1. `README.md`
2. `ARCHITECTURE.md`
3. `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
4. `packages/core/src/core/context.ts`
5. `packages/core/src/vectordb/types.ts`
6. `packages/core/src/embedding/base-embedding.ts`
7. `packages/core/src/splitter/ast-splitter.ts`
8. `packages/core/src/sync/synchronizer.ts`
9. `packages/mcp/src/index.ts`
10. `packages/mcp/src/server/start-server.ts`
11. `packages/mcp/src/tools/registry.ts`
12. `packages/mcp/src/tools/*.ts`
13. `packages/mcp/src/core/handlers.ts`
14. `packages/mcp/src/core/snapshot.ts`
15. `packages/mcp/src/core/sync.ts`
16. `packages/mcp/src/core/call-graph.ts`
17. `packages/cli/src/index.ts`
18. `packages/cli/src/install.ts`
19. tests closest to the feature you want to edit

## Minimum Explanation You Should Be Able To Give

After following this roadmap, you should be able to explain:

- why Satori uses a fixed six-tool MCP surface
- how `manage_index create` becomes vector documents
- why AST-aware chunking improves code retrieval
- why hybrid search is useful for code
- why fingerprint mismatch blocks search
- why completion proof exists
- how search resolves subdirectories to indexed roots
- what `navigationFallback` is for
- why `read_file.open_symbol` must not guess
- how `.satoriignore` changes converge without reindex
- why stdout safety matters for MCP
- what the CLI does and does not own

## North Star

Satori should stay small at the tool surface and strong at the contracts.

Prefer:

- deterministic behavior over clever behavior
- exact file evidence over summaries
- lifecycle honesty over optimistic success
- bounded reads over context dumps
- sync for normal freshness
- reindex for compatibility problems
- tests and specs with every behavior change
