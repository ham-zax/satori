# LanceDB, Voyage, and offline runtime plan

Date: 2026-07-15

Status: proposed implementation plan; no product behavior is implemented by this document

## Decision

Satori will use LanceDB as its installer-owned local vector and full-text store.
VoyageAI remains the initial/default embedding provider and the existing optional
reranker. A later offline runtime profile will keep the same LanceDB adapter,
chunking, query planner, result contract, and local fusion policy while replacing
VoyageAI with Ollama.

The target stacks are:

```text
Initial supported runtime
source -> Satori chunking/projections -> Voyage document embeddings
       -> LanceDB FP32 vectors + local FTS
query  -> deterministic route or Voyage query embedding
       -> dense/lexical candidates -> local RRF -> existing optional reranker

Later offline runtime
source -> the same Satori chunking/projections -> Ollama document embeddings
       -> the same LanceDB FP32 vectors + local FTS
query  -> deterministic route or Ollama query embedding
       -> the same dense/lexical candidates -> the same local RRF
```

LanceDB does not own embedding selection. Satori produces vectors through its
existing `Embedding` implementations and writes precomputed vectors through the
existing `VectorDatabase` port. LanceDB must not install or invoke a second
embedding function.

The initial Voyage plus LanceDB runtime is not an offline product: repository
data and search storage are local, but embedding and any Voyage reranking call
the Voyage API. Only the later LanceDB plus Ollama profile may be described as
offline.

## Scope

This program will:

- replace Milvus as the default vector-store runtime with embedded LanceDB;
- preserve current lifecycle authority, staged generations, completion markers,
  mutation fencing, repair, clear, and fail-closed fingerprint checks;
- preserve the existing query planner and exact structural routes;
- add deterministic lexical retrieval and local hybrid fusion over LanceDB;
- keep Voyage as the first supported embedding provider;
- add a later installer-owned switch to the already-supported Ollama provider;
- require a full reindex whenever the backend, embedding provider, model,
  dimension, or projection identity changes.

There is no automatic Milvus-to-LanceDB data import. Existing remote collections
are not deleted automatically. When LanceDB becomes active, old indexes are
incompatible by fingerprint and each repository must be reindexed into a new
LanceDB generation.

## Existing ownership to preserve

The implementation must extend current owners rather than create a parallel
search stack:

- `packages/core/src/vectordb/types.ts` remains the storage port.
- `packages/mcp/src/embedding.ts` remains the embedding-provider factory.
- `packages/mcp/src/server/provider-runtime.ts` remains the runtime-construction
  owner, but delegates vector construction to one typed backend factory.
- `packages/mcp/src/config.ts` remains the runtime-fingerprint owner.
- `packages/mcp/src/core/search-query-planning.ts` remains the query-route owner.
- `packages/cli/src/args.ts`, `packages/cli/src/install.ts`, and
  `packages/cli/src/doctor.ts` remain the setup and health-check owners.
- `docs/release/2026-07-15-search-quality-program.md` remains authoritative for
  route selection, bounded expansion, owner-family ranking, reranker policy, and
  provider budgets. This plan does not fork those policies.

## Retrieval contract

Good code search requires more than vector similarity. The runtime must preserve
four distinct evidence paths:

| Query class | Primary path | Embedding call |
| --- | --- | ---: |
| Exact identifier, path, or structural relation | Registry, navigation, or tracked lexical evidence | None when deterministic evidence succeeds |
| Quoted literal or configuration value | LanceDB FTS or tracked lexical evidence | None unless the bounded fallback requires it |
| Conceptual code question | Voyage query embedding and exact cosine search | One bounded query embedding |
| Mixed lexical and conceptual question | Dense candidates plus FTS candidates, fused locally | One bounded query embedding |

Exact ownership and caller/callee routes continue to bypass vector search when
the current registry or relationship generation can answer authoritatively.
Moving storage to LanceDB must not turn those routes into embedding calls.

### Document projection

`VectorDocument.content` remains the source text returned to Satori consumers.
Indexing derives two deterministic, versioned projections from the same chunk:

```text
embedding projection:
path + language + symbol kind + qualified name + signature
+ documentation + implementation text

lexical projection:
original identifiers
+ camelCase components
+ snake_case components
+ qualified-name components
+ path components
+ signature/type names
+ selected imported and called identifiers already known to the extractor
```

These are derived search inputs, not independent source truth. Their projection
versions and the existing parser/extractor identities enter the runtime
fingerprint. A projection change requires reindexing.

The lexical projection must retain original code tokens. It must not lowercase,
stem, or split away the only exact representation of an identifier. Any
additional normalized tokens are additive.

Voyage indexing uses `input_type: "document"`; query embedding uses
`input_type: "query"`. Index batches remain bounded by the existing provider
limits and retry policy. The configured Voyage model and output dimension, not
a LanceDB default, determine the vector schema and fingerprint.

### Dense retrieval

For the target workload of repositories around 10 MB, use FP32 vectors and
exhaustive cosine search. The LanceDB adapter explicitly bypasses vector indexes
when the SDK supports that control. No IVF, HNSW, or DiskANN index is created in
the initial release.

Exact search is the quality reference and is likely sufficient at this scale.
An ANN index may be added only after representative Satori corpora exceed a
frozen latency or memory gate and recall is measured against the exact result
set.

### Lexical and hybrid retrieval

Hybrid tables include a full-text index over the deterministic lexical
projection. Full-text indexes are created after bulk ingestion and before the
completion marker is published. Incremental writes are not acknowledged as
searchable until focused tests prove that newly added, updated, and deleted rows
are visible to FTS and remain visible after reopen. `optimize()` runs after full
indexing and later only at measured, bounded mutation thresholds.

Dense and FTS candidate lists are retrieved independently and fused in Satori,
not by backend-specific hybrid behavior. Local RRF has a versioned constant,
canonical score calculation, and a stable document-ID tie-break. Candidate
depth is frozen by the existing search-quality evaluation; the initial
evaluation range is 50 to 100 candidates from each arm before the existing
owner-family grouping and optional reranking.

The public result limit remains bounded independently of candidate depth.

## LanceDB storage contract

The adapter is implemented behind `VectorDatabase`. It maps Satori collection
and generation names deterministically to LanceDB tables under:

```text
~/.satori/vector/lancedb/
```

The installer owns that directory. Repository paths must not determine raw
filesystem paths directly; existing canonical collection identities remain the
only table-name input.

Each row stores at least:

```text
id
vector: fixed-size FP32 list with the fingerprinted dimension
content
lexical projection
relative path
start/end line
file extension
canonical metadata representation
```

Required adapter behavior:

- exact-ID fetch for completion markers and other intrinsic document IDs;
- idempotent upsert, bounded batch insert, delete, count, clear, and table drop;
- dense cosine results normalized to Satori's higher-is-better score contract;
- FTS/BM25 results normalized only enough to preserve deterministic ranking;
- metadata round-trip without loss;
- stable ordering for score ties;
- typed filter translation with escaped values and an allowlist of fields and
  operators;
- no forwarding of caller-controlled filter strings to LanceDB;
- deterministic failures for malformed, unsupported, or unrepresentable
  filters.

The current string-based `filterExpr` and `query(filter: string, ...)` boundary
must be replaced or contained behind a parsed filter AST before the LanceDB
adapter is public. Backend-specific SQL syntax must not leak into callers.

The current `HybridSearchRequest` fields `anns_field` and `param` are also
Milvus-shaped. Do not make the LanceDB adapter interpret those fields. Replace
that boundary with backend-neutral dense and lexical candidate requests; run
the versioned RRF policy above the adapter. Delete the obsolete hybrid request
shape once its first-party callers have moved.

Local connections use explicit cross-process freshness. The initial policy is
`readConsistencyInterval: 0`, or an equivalent explicit `checkoutLatest()` at
the existing operation boundary if measurements justify it. Satori's mutation
lease remains the sole writer authority; LanceDB locking is not a replacement
for the lease.

Do not assume a close method that the JavaScript SDK does not expose. Operations
must have bounded connection/table lifetimes, release SDK resources through
supported APIs, and prove reopen behavior in separate processes.

An insert or mutation is acknowledged only after the new table version and the
corresponding Satori authority record are durably observable from a fresh
process. The completion marker remains the final publication boundary for a
full generation. Crash tests, not API return alone, decide whether this
durability contract is met.

## Configuration and fingerprints

Introduce one typed public discriminator:

```text
VECTOR_STORE_PROVIDER=LanceDB
```

LanceDB is the product default after qualification. Its optional path override
is:

```text
LANCEDB_PATH=~/.satori/vector/lancedb
```

The default path is resolved by the installer/runtime; a literal `~` is not
passed to the database. Overrides must be absolute, root-confined to an
explicitly accepted local directory, and rejected when they resolve through an
unsafe or unsupported path.

Broaden `VectorStoreBackendInfo` into a discriminated backend union so local
LanceDB metadata does not pretend to have a Milvus transport or address. The
runtime fingerprint continues to bind at least:

```text
embedding provider
embedding model
embedding dimension
vector-store provider
vector schema version
embedding projection version
lexical projection version
parser/extractor/relationship identities
```

Changing any of these values yields `requires_reindex`; it never silently opens
an incompatible table.

`ProviderRuntime.validate()` validates the selected backend. LanceDB requires a
supported native package and safe writable local path, not `MILVUS_ADDRESS`.
The runtime uses one backend factory and must not retain scattered
Milvus-specific branches in configuration, diagnostics, startup hints, or
fingerprint construction.

## CLI and later offline profile

The existing CLI uses `satori-cli install` for managed runtime configuration and
`satori-cli doctor` for read-only verification. Do not introduce a second setup
owner named `offline setup` or a second status command.

Extend the installer with one strict runtime profile:

```text
satori-cli install --client <target> --runtime voyage
satori-cli install --client <target> --runtime offline --ollama-model <model>
satori-cli doctor
```

`voyage` is the initial default profile and writes/selects:

```text
VECTOR_STORE_PROVIDER=LanceDB
EMBEDDING_PROVIDER=VoyageAI
```

It does not copy or print `VOYAGEAI_API_KEY`; existing client-specific secret
forwarding remains authoritative.

The later `offline` profile writes/selects only non-secret local settings:

```text
VECTOR_STORE_PROVIDER=LanceDB
EMBEDDING_PROVIDER=Ollama
OLLAMA_MODEL=<validated model>
OLLAMA_HOST=<validated local endpoint or existing default>
```

Before changing managed client configuration, the offline preflight verifies:

- the LanceDB native package loads on the current Node/platform pair;
- the installer-owned database directory can pass a bounded write/read/reopen
  probe without touching repository indexes;
- the Ollama endpoint is reachable;
- the selected model exists and returns a stable supported dimension;
- switching from the current provider will require repository reindexing.

The command does not install Ollama, pull a model, start a daemon, index a
repository, clear an index, or delete cloud data. A failed preflight leaves
managed configuration unchanged. `--dry-run` shows the bounded mutation plan
without exposing keys or source paths.

`doctor` reports the selected backend/provider, LanceDB native-package support,
database-path safety, read/write/reopen probe, FTS capability, Ollama endpoint
and model dimension when selected, and fingerprint compatibility. It remains
read-only with respect to real Satori indexes.

Switching from Voyage to Ollama, or back, always requires a full reindex because
the embedding provider/model/dimension fingerprint changes. Search request and
response schemas do not change.

## Implementation phases

### Phase 0: freeze evidence and contracts

1. Pin a representative 10 MB code corpus and the existing search-quality
   workloads before changing runtime behavior.
2. Freeze the latest accepted Milvus/Voyage artifact as the historical product
   baseline. Record a new live baseline only when an authoritative Milvus
   generation is available; lack of remote publication must not make the
   documentation/contract phase impossible.
3. Add backend-neutral `VectorDatabase` contract tests before adding the
   LanceDB dependency.
4. Freeze the LanceDB table schema, typed filter AST, score normalization, RRF
   formula, lexical/embedding projections, and fingerprint fields.
5. Confirm the native package on Satori's actual supported Node floor
   (currently Node 22.13+) and release platforms.

### Phase 1: make backend ownership explicit

1. Replace the Milvus-only provider types with discriminated backend types.
2. Introduce the typed vector-backend factory in `ProviderRuntime`.
3. Make configuration, startup hints, doctor checks, diagnostics, runtime-owner
   identity, and fingerprints branch on the selected backend in one place.
4. Replace or parse string filters at the core boundary and replace the
   Milvus-shaped hybrid request with backend-neutral candidate operations.
5. Keep all existing lifecycle and completion-marker tests green.

### Phase 2: implement and qualify LanceDB

1. Add and pin `@lancedb/lancedb` only after the adapter contract tests exist.
2. Implement the table schema, exact dense search, FTS, exact-ID operations,
   typed filters, local RRF inputs, and deterministic score/tie handling.
3. Add bulk-finalization and bounded incremental optimization policy.
4. Add fresh-process, cross-process visibility, mutation-lease, and crash tests.
5. Preserve staged-generation rollback and fail-closed publication.

### Phase 3: make LanceDB plus Voyage the default

1. Route existing Voyage document/query embeddings into LanceDB unchanged.
2. Add the versioned embedding and lexical projections.
3. Update installer templates, runtime validation, doctor, docs, and generated
   contract artifacts together.
4. Require reindex for every old Milvus fingerprint; do not import or delete the
   old collection automatically.
5. Remove obsolete Milvus-only assumptions after first-party consumers have
   moved to the backend factory.

### Phase 4: validate search quality and indexing economics

1. Run the LanceDB/Voyage candidate against the pinned paired corpus and compare
   it with the frozen historical product baseline. Add a live Milvus arm when
   authoritative remote publication is available, but do not weaken the frozen
   quality gates when it is not.
2. Prove deterministic exact/direct routes still issue zero embedding calls.
3. Compare dense, lexical, hybrid, structural, and configuration-query quality
   separately.
4. Freeze candidate depths and `optimize()` thresholds from measurements.
5. Keep exhaustive FP32 search unless it fails the frozen latency gate.

### Phase 5: add the offline installer profile

1. Add the strict `install --runtime offline` parser variant and preflight.
2. Reuse the existing Ollama embedding adapter; do not add a LanceDB embedding
   function.
3. Extend doctor and installer-owned client configuration.
4. Run the same adapter, lifecycle, search-quality, and public-contract suites
   with Ollama.
5. Advertise offline support only after the full matrix passes without Voyage,
   another cloud model, Milvus, or a cloud reranker.

## Release gates

Correctness gates run before performance claims:

- exhaustive dense retrieval matches an independent brute-force cosine oracle;
- FTS results survive close/reopen and process restart with at least 3,000 rows;
- newly inserted, updated, and deleted rows have deterministic FTS visibility;
- a zero-match filtered dense, lexical, or hybrid query returns zero results;
- completion-marker fetch, upsert, delete, count, clear, repair, and rollback
  contracts pass;
- a successfully acknowledged batch survives forced process termination and is
  visible from a fresh reader;
- readers and the lease-held writer have bounded, deterministic behavior;
- cross-process reads observe the intended latest table version;
- metadata and UTF-8 source content round-trip without changes;
- backend/provider/model/dimension/projection changes require reindex;
- exact identifiers, paths, literals, configuration, ownership, and structural
  routes make zero embedding calls when deterministic evidence succeeds;
- Voyage and Ollama satisfy the same public search and lifecycle contracts;
- the supported Node/platform release matrix loads the native dependency;
- the existing paired search-quality corpus has no frozen regression;
- the 10 MB fixture records indexing time, provider calls/tokens, database size,
  exact-search p95, FTS p95, hybrid p95, and peak memory;
- no ANN index is added unless exhaustive search fails the frozen latency gate
  and the candidate ANN configuration passes a frozen recall gate.

## Non-goals

- No model inference inside LanceDB.
- No bundled Ollama daemon or automatic model download.
- No automatic indexing from installer commands.
- No automatic deletion or conversion of Milvus collections.
- No second query planner, chunker, reranker policy, or public search schema.
- No ANN index justified only by upstream benchmarks.
- No claim that local storage makes Voyage requests private or offline.

## Upstream API assumptions to verify when pinning

The current LanceDB JavaScript documentation exposes local embedded connections,
precomputed vector columns, `bypassVectorIndex()` for exhaustive search, FTS
indexes, `optimize()`, scalar filters, and `readConsistencyInterval`. These are
the intended primitives, but the pinned dependency and adapter contract tests
are authoritative for Satori:

- [LanceDB JavaScript basic example](https://github.com/lancedb/lancedb/blob/main/lancedb/nodejs/examples/basic.test.ts)
- [LanceDB `VectorQuery.bypassVectorIndex`](https://github.com/lancedb/lancedb/blob/main/docs/src/js/classes/VectorQuery.md)
- [LanceDB `Table.optimize` and search API](https://github.com/lancedb/lancedb/blob/main/docs/src/js/classes/Table.md)
- [LanceDB connection consistency options](https://github.com/lancedb/lancedb/blob/main/docs/src/js/interfaces/ConnectionOptions.md)
- [Voyage embedding quickstart](https://docs.voyageai.com/docs/quickstart-tutorial)

If the pinned SDK differs from those assumptions, change the adapter plan or
block the release; do not emulate a missing durability or freshness guarantee
with undocumented behavior.
