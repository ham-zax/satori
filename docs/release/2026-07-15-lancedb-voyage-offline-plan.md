# LanceDB, Voyage, and offline runtime plan

Date: 2026-07-15

Status: implementation and qualification in progress

As of 2026-07-17, Phases 0 through 3 are implemented in the worktree: Core owns
versioned projections, embedding purpose is immutable per call, LanceDB provides
the backend-neutral dense/FTS adapter, asynchronous bootstrap resolves local
model identity before runtime ownership, and LanceDB plus Voyage is the default
while both Milvus adapters remain supported. The Phase 5 installer/runtime code
is also implemented, including awaited preflight, persisted non-secret runtime
identity, local-only policy, model-digest validation, target-filesystem LanceDB
proof against the installed MCP runtime, non-overwriting runtime upgrades,
guarded installer writes, and profile-aware read-only doctor checks.

Release qualification is not complete. The paired comparison contract and
three-arm harness are implemented in `evals/vector-stacks/` and
`scripts/satori-vector-stack-compare.mjs`, but authoritative live Milvus/Voyage,
LanceDB/Voyage, and LanceDB/Ollama observations have not yet all been recorded.
The offline profile therefore remains a qualification candidate rather than an
advertised offline release.

## Decision

Satori will use LanceDB as its installer-owned local vector and full-text store.
VoyageAI remains the initial/default embedding provider and the existing optional
reranker. The offline qualification profile keeps the same LanceDB adapter,
chunking, query planner, result contract, and local fusion policy while replacing
VoyageAI with Ollama.

The target stacks are:

```text
Connected default runtime
source -> Satori chunking/projections -> Voyage document embeddings
       -> LanceDB FP32 vectors + local FTS
query  -> deterministic route or Voyage query embedding
       -> dense/lexical candidates -> local RRF -> existing optional reranker

Offline qualification candidate
source -> the same Satori chunking/projections -> Ollama document embeddings
       -> the same LanceDB FP32 vectors + local FTS
query  -> deterministic route or Ollama query embedding
       -> the same dense/lexical candidates -> the same local RRF
```

LanceDB does not own embedding selection. Satori produces vectors through its
existing `Embedding` implementations and writes precomputed vectors through the
existing `VectorDatabase` port. LanceDB must not install or invoke a second
embedding function.

The Voyage plus LanceDB runtime is not an offline product: repository
data and search storage are local, but embedding and any Voyage reranking call
the Voyage API. Only the later LanceDB plus Ollama profile may be described as
offline after its full live release matrix passes.

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

- `packages/core/src/vectordb/types.ts` remains the storage port and owns the
  typed indexing/search-input contract presented to every backend. The existing
  source-document contract is not expanded merely to serve one backend.
- `packages/core/src/embedding/base-embedding.ts` remains the embedding port and
  gains one immutable, per-call document/query purpose contract.
- `packages/core/src/core/context.ts` remains the indexing, projection,
  retrieval, completion-marker, repair, and publication owner. The LanceDB
  adapter never derives embedding or lexical projections from source content.
- `packages/mcp/src/embedding.ts` remains the embedding-provider factory.
- `packages/mcp/src/server/provider-runtime.ts` remains the backend and provider
  runtime-construction owner, but delegates vector construction to one typed
  backend factory and receives a resolved execution policy.
- `packages/mcp/src/server/start-server.ts` remains the bootstrap owner and must
  resolve runtime identity before registering an owner or constructing snapshot,
  sync, or tool state.
- `packages/mcp/src/config.ts` remains the runtime-fingerprint and typed runtime-
  profile owner.
- `packages/mcp/src/core/capabilities.ts` remains the capability-policy owner; it
  must not infer a remote capability from an incidental credential when the
  resolved execution profile forbids network execution.
- `packages/mcp/src/core/search-query-planning.ts` remains the query-route owner.
- `packages/cli/src/args.ts`, `packages/cli/src/index.ts`,
  `packages/cli/src/install.ts`, `packages/cli/src/runtime-config.ts`, and
  `packages/cli/src/doctor.ts` remain the setup, orchestration, static-validation,
  and health-check owners.
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

Core constructs both projections before it calls `VectorDatabase`. Preserve
`VectorDocument` as the source-document contract and introduce one
backend-neutral indexing input equivalent to:

```text
IndexedVectorDocument {
    document: VectorDocument
    projections: {
        embeddingText
        lexicalText
        embeddingVersion
        lexicalVersion
    }
}
```

Only searchable-row write operations accept `IndexedVectorDocument`; search
results continue to expose `VectorDocument`. Completion markers and other
control records use separate typed control operations and never receive dummy
projection text merely to satisfy a searchable-row shape.

The backend-neutral control boundary is complete rather than write-only:

```text
VectorControlRecord { id, kind, metadata }
insertControl(collectionName, record)
getControl(collectionName, id)
deleteControl(collectionName, id)
```

Adapters may translate this record into a legacy physical representation, but
Core must not construct searchable placeholder fields or route control reads and
deletes through generic document operations.

The initial projection builder consumes only information synchronously and
identically available to full indexing, incremental sync, repair, and test
fixtures: the current `CodeChunk`, path, signature, documentation,
implementation text, and resolved symbol/extractor output. Projection
construction must not trigger a second analysis pass. Relationship-derived
identifiers remain retrieval and expansion evidence outside the projection.
They may enter a later projection version only after every indexing path can
supply the same canonical relationship snapshot. All paths use the same builder
and version constants. A backend may store or index those fields, but must not
reconstruct, normalize, or enrich them.

The frozen initial version identifiers are `embedding_projection_v1` and
`lexical_projection_v1`. The executable v1 input is a validated canonical
repository-relative path plus the current `CodeChunk` language, symbol kind,
symbol label, breadcrumbs, and original content. The shared builder rejects
empty, absolute, dot-segment, backslash-separated, and otherwise noncanonical
paths; callers may not normalize differently per indexing path. Path casing and
Unicode remain byte-preserving repository identity rather than host-dependent
normalization. Signatures, documentation, imports, calls, type names, and
implementation remain available through the original content; v1 does not
invent separate extractor fields that `CodeChunk` does not expose.

Projection metadata uses canonical JSON with fixed field construction order,
and original content is separated with its UTF-16 string length. The embedding
projection serializes metadata before unchanged content. The lexical projection
serializes unchanged content before metadata, followed by a canonical JSON array
of stable first-seen camel-case and underscore components. Golden tests freeze
the exact bytes and prove newline-bearing metadata cannot collide with a
different input tuple.

During the Milvus transition, both Milvus adapters accept
`IndexedVectorDocument` and persist the source document plus its Core-produced
dense vector. Their legacy schema continues to return and BM25-index source
content rather than adding a temporary projection column. Completion markers
use the complete `insertControl`/`getControl`/`deleteControl` boundary, with any
legacy placeholder row constructed inside the adapter. Its vector dimension
comes from Milvus adapter configuration or collection schema, never from logical
control metadata, and transport-only routing fields are removed again on read.
LanceDB is the first adapter required to persist and FTS-index `lexicalText`; no
adapter may derive it.

The lexical projection must retain original code tokens. It must not lowercase,
stem, or split away the only exact representation of an identifier. Any
additional normalized tokens are additive.

The FTS tokenizer is a separate compatibility contract from the stored lexical
projection. Phase 0 freezes the pinned tokenizer configuration and executable
probes for at least:

```text
camelCaseIdentifier
snake_case_identifier
Namespace.Type.method
src/auth/token-handler.ts
--configuration-flag
HTTP_401_UNAUTHORIZED
C++
operator<<
quoted literals
Unicode identifiers
```

Use the pinned SDK's tokenizer-inspection API when it exists; otherwise prove
the same behavior through end-to-end FTS queries. Identifier, path, literal,
and punctuation-heavy exact-token retrieval remains a deterministic Satori
route outside BM25. FTS supplements that route; it does not replace it.

Voyage indexing uses `input_type: "document"`; query embedding uses
`input_type: "query"`. Index batches remain bounded by the existing provider
limits and retry policy. The configured Voyage model and output dimension, not
a LanceDB default, determine the vector schema and fingerprint.

### Embedding purpose contract

Document/query purpose is an immutable property of each embedding operation,
not mutable state on a shared provider instance. Phase 0 freezes one
backend-neutral contract equivalent to:

```text
embedQuery(text: string): Promise<EmbeddingVector>
embedDocuments(texts: string[]): Promise<EmbeddingVector[]>
```

Providers that do not distinguish the roles implement both operations without
changing their provider request. Voyage maps them to the provider's `document`
and `query` input types respectively. Indexing always calls `embedDocuments`;
dense and hybrid query paths always call `embedQuery`; dimension and health
probes call an explicitly selected operation. Do not implement this by calling
`setInputType()` or by mutating another shared client field. Contract tests
overlap indexing and query calls, repeat them in mixed order, and prove that
provider requests cannot cross-contaminate their purpose.

### Dense retrieval

Use FP32 vectors and exhaustive cosine search for the initial release. The
LanceDB adapter explicitly bypasses vector indexes through the pinned SDK's
supported exhaustive-search control. No IVF, HNSW, or DiskANN index is created
in the initial release.

The representative 10 MB source corpus remains a product fixture, but source
bytes do not decide whether exhaustive search is sufficient. Every qualification
artifact also records searchable chunk count, embedding dimension, projection
bytes, database bytes, and peak RSS. Bytes read is an optional diagnostic when
the platform can collect it comparably; it is not a release gate. Exact search
is the quality reference. An ANN index may be added only after measured
chunk/dimension tiers exceed a frozen latency or memory gate and recall is
measured against the exact result set.

### Lexical and hybrid retrieval

Hybrid tables include a full-text index over the deterministic lexical
projection. Full-text indexes are created after bulk ingestion and before the
completion marker is published. An incremental mutation is not acknowledged as
searchable until its additions, replacements, and deletions are visible through
ordinary FTS from a newly opened local connection. The contract suite proves the
same visibility after process restart. The adapter must not select `fastSearch()`
or any equivalent mode that skips unindexed data on an acknowledged retrieval
path.

The expected path is the SDK's ordinary FTS behavior over acknowledged indexed
and unindexed rows. Phase 0 must prove that behavior on the pinned release. If it
cannot provide correct add, replace, delete, and reopen visibility, the only
planned fallback is a bounded Satori-owned lexical delta with deletion masks.
Running index maintenance before every acknowledgement is rejected unless
measurements unexpectedly prove its save-path cost acceptable.

`optimize()` is a measured maintenance boundary, not an assumed per-save
correctness boundary. Every call passes cleanup and pruning options explicitly
so staged-generation rollback and diagnostic versions are not removed by an SDK
default. It runs after full indexing and later only at measured, bounded mutation
thresholds.

Dense and FTS candidate lists are retrieved independently and fused in Satori,
not by backend-specific hybrid behavior. Each arm deduplicates by canonical
document ID and applies a stable document-ID tie-break before ranks are assigned.
Local RRF consumes those ordered ranks using a versioned constant and applies a
stable document-ID tie-break to equal fused scores. Dense distance and BM25 score
remain diagnostic values; they are not normalized into comparable evidence for
RRF. The initial release preserves the existing backend-neutral candidate-limit
policy: `Math.min(Math.max(resultLimit * 8, 32), 80)`, including the current
bounded retry escalation. Dense-only retrieval applies that formula unchanged.
Hybrid retrieval applies the same bounded formula to each local dense and FTS
arm. The query embedding is computed once per semantic pass and shared with the
dense arm; the lexical arm adds no embedding call. Per-arm retrieval is a new
local policy whose latency, memory, and fused output require evaluation. The
fused, owner-grouped, and reranked candidate budget remains bounded by the
existing provider-budget policy. A 50 to 100 per-arm range may be evaluated in
Phase 4, but is not accepted prior behavior. Increasing reranker input depth or
the production formula requires explicit quality, latency, memory, and provider-
cost acceptance.

The public result limit remains bounded independently of candidate depth.

## LanceDB storage contract

The adapter is implemented behind `VectorDatabase`. It maps each Satori
generation to one searchable data table and each canonical collection family to
one adapter-owned control table under:

```text
~/.satori/vector/lancedb/
```

The installer owns that directory. Repository paths must not determine raw
filesystem paths directly; existing canonical collection identities remain the
only table-name input. The layout consists of:

- one searchable data table per generation containing document rows only; and
- one non-searchable control table per canonical collection family containing
  completion and publication records without vector or FTS columns.

The control-table scope matches Satori's repository-root mutation lease. It does
not create one global mutable table shared by independently leased repositories.

Exact-ID completion-marker operations route to the control table behind the
existing port. Control records never receive fabricated zero vectors and cannot
enter dense or FTS candidates.

Each searchable document row stores at least:

```text
id
vector: fixed-size FP32 list with the fingerprinted dimension
source content (`VectorDocument.content`)
lexical projection
relative path
start/end line
file extension
content hash
canonical metadata representation
```

Each control-record key includes the collection identity, generation, control
kind, and intrinsic ID. The record stores at least its mutation ID, data-table
version, expected content digest, runtime fingerprint, and the existing
authoritative sidecar publication identity. This reuses Satori's current
navigation generation, registry manifest, relationship manifest, and seal
identity; this migration introduces no new sidecar hashing or publication
protocol. Dropping or rolling back a generation removes its data table and
matching control records as one recoverable adapter operation. Recovery treats
missing or mismatched data or control state as unpublished.

Required adapter behavior:

- exact-ID fetch for completion markers and other intrinsic document IDs;
- idempotent upsert, bounded batch insert, delete, count, clear, and table drop;
- dense cosine results normalized to Satori's higher-is-better score contract;
- FTS/BM25 results returned with deterministic ordered ranks and raw diagnostic
  scores, without cross-arm score normalization;
- metadata round-trip without loss;
- stable ordering for score ties;
- typed filter translation with escaped values and an allowlist of fields and
  operators;
- no forwarding of caller-controlled filter strings to LanceDB;
- deterministic failures for malformed, unsupported, or unrepresentable
  filters.

Idempotent upsert has an externally observable rule: repeating the same
canonical document ID and content hash in the current lease-held generation is
a no-op; changing the content hash replaces that document only within that same
generation. An operation must not overwrite another generation or bypass the
mutation lease. Start with one backend-neutral predicate AST and enforce
operation-specific field and operator allowlists. Split the AST types only if a
demonstrated semantic difference requires it. Contract tests cover escaping,
nulls, arrays where supported, Unicode, unknown fields, and attempted injection.

The current string-based `filterExpr` and `query(filter: string, ...)` boundary
must be replaced or contained behind a parsed filter AST before the LanceDB
adapter is public. Backend-specific SQL syntax must not leak into callers.

The current `HybridSearchRequest` fields `anns_field` and `param` are also
Milvus-shaped. Do not make the LanceDB adapter interpret those fields. Replace
that boundary with backend-neutral dense and lexical candidate requests; run
the versioned RRF policy above the adapter. Delete the obsolete hybrid request
shape once its first-party callers have moved.

Local OSS connections use `readConsistencyInterval: 0` so every read checks for
cross-process updates. `checkoutLatest()` is reserved for explicit recovery and
contract tests that leave version-pinned mode; it is not an interchangeable
runtime freshness policy. Satori's mutation lease remains the sole writer
authority; LanceDB locking is not a replacement for the lease.

The adapter uses only resource-lifecycle APIs supported by the pinned release
and proves bounded connection, table, and reopen behavior in contract tests.

### Publication and crash recovery

The existing mutation lease and Satori authority remain the publication
boundary. LanceDB does not introduce a second transaction coordinator. Every
full-generation or incremental mutation:

1. acquires the existing repository-root mutation lease and uses its operation
   ID as the mutation ID when that ID is persisted and reused across retries;
   otherwise, it assigns and persists a separate stable mutation ID;
2. invalidates the current completion record when mutating an active generation,
   confirms that unpublished state through a newly opened local connection, and
   then applies data and existing sidecar mutations idempotently;
3. verifies expected IDs, content hashes or digest, payload count, FTS visibility,
   data-table version, and relevant existing sidecar publication identities
   through a newly opened local connection in the current process;
4. writes the collection-family control-table completion record last;
5. acknowledges the mutation only after that record is readable through a newly
   opened local connection and matches the expected generation, mutation ID,
   data-table version, runtime fingerprint, and content digest; and
6. releases the mutation lease before returning success.

Invalidating an active generation intentionally makes new searches against that
generation unavailable until the replacement completion record is published.
This bounded fail-closed window is accepted for the initial local runtime and is
included in save-path measurements. Continuous availability during incremental
mutation is not an initial-release requirement.

A missing, prepared-only, mismatched, or unverifiable completion record is
unpublished. No data, navigation, or relationship reader may accept that
generation. Startup recovery may replay an idempotent prepared mutation, discard
a staged generation, or require reindexing when the expected proof cannot be
reconstructed safely.

Fresh-process and forced-termination contract tests prove that acknowledged
mutations survive reopen. `doctor` and startup recovery may use bounded
fresh-process probes where required. The production mutation path does not spawn
verification processes.

## Configuration and fingerprints

Keep the vector backend behind one typed public discriminator:

```text
VECTOR_STORE_PROVIDER=LanceDB
```

Add exactly one persisted execution-profile discriminator:

```text
SATORI_RUNTIME_PROFILE=<connected|offline>
```

The profile derives one network policy rather than creating a second set of
capability flags:

```text
connected -> remote-allowed
offline   -> local-only
```

The resolved profile and network policy are part of runtime-owner identity and
diagnostics. The provider, model, artifact digest, dimension, and projection
fields below remain the authoritative index-compatibility inputs.

Absence of `SATORI_RUNTIME_PROFILE` is parsed as the legacy `connected` profile
so existing installations preserve their current provider and reranker
behavior. It is never interpreted as offline. Only an explicit
`SATORI_RUNTIME_PROFILE=offline` enables the local-only prohibition and offline
product claim; any other explicit value is invalid.

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
resolved local embedding artifact digest when a local provider is selected
embedding dimension
embedding normalization policy
vector-store provider
vector schema version
embedding projection version
lexical projection version
parser/extractor/relationship identities
```

The normalization policy is Satori-controlled and versioned as either preserving
provider output or normalizing document and query vectors before storage and
search. It is not inferred from whether sampled provider vectors happen to have
unit length.

Changing any of these values yields `requires_reindex`; it never silently opens
an incompatible table.

Startup has an explicit asynchronous identity-resolution boundary. Before
constructing `SnapshotManager`, registering a runtime owner, or constructing
embedding, reranking, sync, or tool state, `startMcpServerFromEnv()` performs:

```text
parse and statically validate configuration
-> resolve execution profile and derived network policy
-> resolve provider identity
   -> configured Voyage identity, or
   -> live Ollama model metadata and local artifact digest
-> validate the resolved identity against local-only policy
-> construct the runtime fingerprint
-> construct snapshot and runtime-owner state
-> construct permitted provider and reranking clients
-> construct handlers
```

Ollama identity resolution is awaited and fails closed when the configured
model is missing, its digest cannot be established, or its live digest differs
from the installer-recorded digest. Fingerprint parsing remains compatible with
existing Milvus fingerprints so they are classified as `requires_reindex`, not
misreported as malformed configuration.

`ProviderRuntime.validate()` validates the selected backend. LanceDB requires a
supported native package and safe writable local path, not `MILVUS_ADDRESS`.
The runtime uses one backend factory and must not retain scattered
Milvus-specific branches in configuration, diagnostics, startup hints, or
fingerprint construction.

## CLI and offline qualification profile

The existing CLI uses `satori-cli install` for managed runtime configuration and
`satori-cli doctor` for read-only verification. Do not introduce a second setup
owner named `offline setup` or a second status command.

Extend the installer with one strict runtime-profile selector and two variants:

```text
satori-cli install --client <target> --runtime voyage
satori-cli install --client <target> --runtime voyage --vector-store milvus
satori-cli install --client <target> --runtime offline --ollama-model <model>
satori-cli doctor
```

`voyage` is the initial installer preset and writes/selects:

```text
SATORI_RUNTIME_PROFILE=connected
VECTOR_STORE_PROVIDER=LanceDB
EMBEDDING_PROVIDER=VoyageAI
```

LanceDB is the default backend. An explicit `--vector-store milvus`, or one
consistent literal Milvus selection across configured Satori client configs,
retains Milvus. The managed launcher persists the selected backend and Voyage
model identity that passed static validation/preflight so later ambient values
cannot silently change the runtime. It does not copy or print
`VOYAGEAI_API_KEY`; existing client-specific secret forwarding remains
authoritative. Milvus address/token values likewise remain client-owned. The
launcher is global to all installed clients, so an explicit backend selection
changes their effective runtime regardless of the `--client` mutation target.
Reinstall uses current environment values first, then existing managed
non-secret LanceDB/Ollama locations, then installer defaults.

The later `offline` profile writes/selects only non-secret local settings:

```text
SATORI_RUNTIME_PROFILE=offline
VECTOR_STORE_PROVIDER=LanceDB
EMBEDDING_PROVIDER=Ollama
OLLAMA_MODEL=<validated model>
OLLAMA_MODEL_DIGEST=<resolved local artifact digest>
OLLAMA_HOST=<validated local endpoint or existing default>
```

The offline profile is also a runtime prohibition, not only an installer
default:

```text
embedding provider = Ollama or another explicitly approved local provider
reranker = none or an explicitly approved local provider
remote inference, reranking, fallback, repair, and telemetry paths = disabled
```

Runtime construction derives reranker capability from the selected profile and
provider, not from the incidental presence of a Voyage key. A retained cloud key
must neither construct a cloud client nor make a cloud path reachable in offline
mode. Configuration validation rejects any selected remote execution path.

Installer execution has one guarded mutation boundary:

```text
resolve and validate the proposed runtime identity without I/O
-> resolve or install an immutable managed-runtime candidate without replacing
   the active launcher's runtime bytes
-> verify the candidate's resolved package name and exact installed version
-> start that exact candidate and prove MCP initialization plus the canonical
   six-tool surface for every backend
-> await the selected backend/provider probes against that exact candidate
-> read mutable client/project files into a pure synchronous install plan
-> revalidate every planned input immediately before managed writes
-> apply the managed configuration through the existing bounded mutation path
-> optionally run awaited post-apply verification
```

`executeInstallCommand()` (or its ownership-equivalent replacement) and
`runDoctor()` therefore return promises and are awaited by the existing
asynchronous CLI dispatcher. Planning remains pure and synchronous. Dry-run
executes only static selection and path-syntax validation: it does not inspect
target filesystem shape and performs no package install, native load, provider
call, or filesystem write. Preflight,
application, and diagnostics receive injected dependencies so their ordering
and failure behavior are deterministic in tests.

Application retains the installer's ordered, atomic-per-file writes. Mutable
client and project files are read only after package installation and live
preflight; each prepared mutation then carries its original file bytes and
refuses a later overwrite race. This plan introduces no
cross-file transaction or rollback protocol. The no-mutation guarantee applies
to rejected preflight; an application-stage failure reports completed, failing,
and unattempted mutations without overstating cross-file atomicity.

Before changing managed client configuration, every runtime variant starts the
candidate MCP package and proves its version and public tool surface. Rejected
new candidates are removed without changing the current launcher target. Tags
and ranges are not treated as immutable reuse identities. Both LanceDB variants
also verify:

- the LanceDB native package owned by the exact managed MCP runtime loads on the
  current Node/platform pair;
- a temporary database on the configured target filesystem can pass a bounded
  write/FTS/read/reopen probe without touching repository indexes; the global
  OS temporary filesystem is not accepted as evidence for another target.

The offline variant additionally verifies:

- the Ollama endpoint is reachable;
- the selected model exists and exposes a resolved local artifact digest;
- multiple probe inputs return finite vectors with one stable supported
  dimension, after which Satori applies its configured normalization policy.

Every variant reports when switching from the current provider requires
repository reindexing.

The command does not install Ollama, pull a model, start a daemon, index a
repository, clear an index, or delete cloud data. A failed preflight leaves
managed configuration and client files byte-for-byte unchanged, with
environment forwarding and repository indexes untouched. No post-apply check
may substitute for a probe whose failure would reject the planned mutation.
`--dry-run` shows the bounded mutation plan without exposing keys or source
paths and performs no live capability probe.

`doctor` reports the selected backend/provider, statically validates the
configured path, and read-only loads the LanceDB subpath from the exact managed
MCP runtime so a missing native dependency is explicit. The install preflight
owns the temporary write/FTS/reopen proof. Doctor also reports the Ollama
endpoint and resolved model identity/dimension when selected, fingerprint
compatibility, and an explicit offline-execution invariant result with any
detected remote execution path. It does not write configuration or database
state.

Switching from Voyage to Ollama, or back, always requires a full reindex because
the embedding provider/model/dimension fingerprint changes. Search request and
response schemas do not change.

## Implementation phases

### Phase 0: freeze evidence and contracts

1. Pin a representative 10 MB code corpus and the existing search-quality
   workloads before changing runtime behavior. Record searchable chunks,
   configured dimensions, projection bytes, and database cardinality; source
   bytes remain a fixture identity rather than the scale decision variable.
2. Freeze the latest accepted Milvus/Voyage artifact as the historical product
   baseline. Record a new live baseline only when an authoritative Milvus
   generation is available; lack of remote publication must not make the
   documentation/contract phase impossible.
3. Enumerate every first-party consumer before tightening the indexing,
   embedding, bootstrap, fingerprint, installer, or diagnostics contracts:
   production callers, both Milvus adapters, the unconfigured adapter, unit and
   integration tests, fakes, fixtures, scripts, and generated contract artifacts.
4. Freeze the backend-neutral `IndexedVectorDocument` projection input and
   version contract, the immutable `embedDocuments`/`embedQuery` contract, the
   single execution-profile/network-policy mapping, the asynchronous resolved-
   provider-identity bootstrap contract, and the current dynamic candidate-depth
   baseline of 32 to 80.
5. Add backend-neutral `VectorDatabase` and embedding-role contract tests before
   adding the LanceDB dependency.
6. Freeze the generation-data/family-control table schema, one predicate AST
   with operation-specific allowlists, idempotent-upsert semantics, score
   directions, rank-only RRF formula, tokenizer probes, publication crash states,
   and fingerprint fields.
7. Select a released `@lancedb/lancedb` version and record its release tag or
   source commit, Arrow peer version, lockfile integrity, exact APIs used, and
   supported Node/platform/architecture native-load matrix. Confirm it on
   Satori's actual supported Node floor (currently Node 22.13+). Documentation
   generated from upstream `main` is discovery evidence only. Run these probes
   in an isolated qualification harness; do not wire the dependency into the
   product before the backend-neutral contracts exist.
8. Prove ordinary FTS visibility on acknowledged indexed and unindexed rows and
   freeze the explicit `optimize()` cleanup policy. If ordinary FTS fails the
   add, replace, delete, or reopen contract, stop Phase 0 and freeze a bounded
   lexical-delta design before beginning the adapter. Do not begin the LanceDB
   adapter while control-record representation, publication recovery, or
   acknowledged FTS visibility remains ambiguous.

Phase 0 qualification completed on 2026-07-17 with:

- `@lancedb/lancedb@0.31.0`, upstream tag `v0.31.0`, source commit
  `3f8d76817e6020ea344fba8a66c5de9ad8c82234`, npm integrity
  `sha512-EUEVpheKhaCNE6ybcW760OUyfeei2dKR2ZwgLWeC/ntHL4BBiBLIErh9fuEuUP3/mAx4B5UFraB2m5nDUx5XEA==`;
- `apache-arrow@18.1.0`, npm integrity
  `sha512-v/ShMp57iBnBp4lDgV8Jx3d3Q5/Hac25FWmQ98eMahUiHPXcvwIMKJD0hBIgclm/FCG+LwPkAKtkRO1O/W0YGg==`;
- native packages for macOS arm64, Linux x64/arm64 with glibc or musl, and
  Windows x64/arm64;
- native load, exact cosine search, FTS, insert, replacement, deletion,
  explicit optimization, close, and reopen on the supported Node floor
  (22.13.0) and the development runtime (24.13.0); and
- 3,000-row ordinary-FTS visibility across indexed and unindexed rows, so no
  Satori-owned lexical delta is required for the pinned release.

The adapter uses `connect(..., { readConsistencyInterval: 0 })`, explicit Arrow
schemas and fixed-size FP32 vectors, `mergeInsert`, exhaustive cosine queries
with `bypassVectorIndex()`, `MatchQuery` over `lexicalText`, and
`optimize({ cleanupOlderThan: new Date(0), deleteUnverified: false })`. It never
uses `fastSearch()`.

### Phase 1: make Core and runtime compatible

1. Add the Core-owned projection builder and version constants plus the port-owned
   `SearchProjections`, `IndexedVectorDocument`, and `VectorControlRecord`
   contracts. Route full indexing,
   incremental sync, repair paths that rebuild searchable rows, and fixtures
   through that one builder; keep control-record insert, read, and delete
   operations separately typed.
2. Replace mutable embedding-purpose state with `embedDocuments` and
   `embedQuery`; update providers, production callers, probes, fakes, and tests,
   including overlapped Voyage document/query calls.
3. Add the single persisted execution profile and derived network policy. Make
   startup await provider identity and local-model digest resolution before
   fingerprint, snapshot, runtime-owner, provider-client, or handler construction.
4. Separate pure install planning from awaited preflight, bounded application
   through the existing atomic-per-file mutation path, and optional postflight.
   Make install orchestration and doctor asynchronous and prove a rejected
   preflight performs no mutation.
5. Replace the Milvus-only provider types with discriminated backend types and
   introduce the typed vector-backend factory in `ProviderRuntime`.
6. Make configuration, startup hints, doctor checks, diagnostics, runtime-owner
   identity, and fingerprints branch on resolved backend and profile state in
   their existing owners.
7. Replace or parse string filters at the Core boundary and replace the
   Milvus-shaped hybrid request with backend-neutral candidate operations.
8. Keep all existing lifecycle, completion-marker, and public-contract tests
   green while both Milvus implementations use the tightened Core contracts.

### Phase 2: implement and qualify LanceDB

1. Add the Phase 0-selected `@lancedb/lancedb` version only after the
   backend-neutral adapter contract tests exist.
2. Implement generation data tables, collection-family control tables, exact
   dense search over supplied vectors, FTS over supplied lexical projections,
   exact-ID operations, the typed predicate boundary, local rank-only RRF inputs,
   and deterministic score/tie handling. The adapter performs no projection,
   relationship analysis, or embedding-provider call.
3. Add bulk-finalization and bounded incremental optimization policy.
4. Add fresh-process, cross-process visibility, mutation-lease, and crash tests.
5. Preserve staged-generation rollback and fail-closed publication.

### Phase 3: make LanceDB plus Voyage the default

1. Preserve the existing Voyage model, dimensions, batching limits, retries, and
   provider ownership while routing indexing and query operations through the
   Phase 1 immutable role-aware embedding contract.
2. Make the Phase 1 Core projections and LanceDB adapter the qualified default;
   do not introduce or change projection semantics in this phase.
3. Update installer templates, runtime validation, doctor, docs, and generated
   contract artifacts together.
4. Require reindex when an installation switches from a Milvus fingerprint to a
   LanceDB runtime fingerprint; do not import or delete the Milvus collection
   automatically.
5. Remove hard-coded Milvus-only assumptions after first-party consumers have
   moved to the backend factory. Preserve Milvus as a supported optional backend
   for cloud deployments and future compatible Milvus adapters.

### Phase 4: validate search quality and indexing economics

1. Run the pinned paired corpus through three self-identifying arms when their
   authoritative providers are available: Milvus/Voyage, LanceDB/Voyage, and
   LanceDB/Ollama. Milvus/Voyage versus LanceDB/Voyage isolates storage;
   LanceDB/Voyage versus LanceDB/Ollama isolates embedding; the direct
   Milvus/Voyage versus LanceDB/Ollama delta is explicitly a full-stack result
   and must not be attributed to either component alone. Keep the frozen
   historical product baseline when live remote publication is unavailable.
2. Prove deterministic exact/direct routes still issue zero embedding calls.
3. Compare dense, lexical, hybrid, structural, and configuration-query quality
   separately.
4. Preserve the 32-to-80 dynamic candidate-depth policy while measuring any
   50-to-100 alternatives. Change production depth only after explicit quality,
   latency, memory, and provider-cost acceptance; freeze `optimize()` thresholds
   from measurements.
5. Keep exhaustive FP32 search unless it fails the frozen latency gate.

The reproducible comparison boundary is implemented. It consumes immutable
useful-context observation artifacts, rejects mismatched Git revisions, task
hashes, Node/server identities, sample shapes, within-arm runtime fingerprints,
published-generation receipts, or non-zero preparation syncs. Separate
no-change preparation operations may have different operation IDs and durable
timestamps when their canonical root, generation, runtime fingerprint,
collection name, marker run ID, index-policy hash, and policy-document digest
identify the same publication. The comparison reports result
overlap/order, owner-quality metrics, cold/warm latency, actual retrieval modes,
and logical provider work. Dense-only
correctness remains an adapter-level exhaustive-cosine gate because the public
query planner exposes lexical and hybrid product routes rather than an invented
dense-only request mode. Live arm observations and indexing-economics evidence
remain pending.

### Phase 5: add the offline installer profile

1. Add the strict `install --runtime offline` parser variant and its local-only
   preflight on the Phase 1 asynchronous installer boundary.
2. Reuse the existing Ollama embedding adapter; do not add a LanceDB embedding
   function.
3. Persist the offline profile and resolved model digest, then extend doctor and
   installer-owned client configuration without creating another profile owner.
4. Run the same adapter, lifecycle, search-quality, and public-contract suites
   with Ollama.
5. Advertise offline support only after the full matrix passes without Voyage,
   another cloud model, Milvus, or a cloud reranker.

Items 1 through 3 are implemented. Deterministic tests prove that retained cloud
credentials cannot construct cloud embedding, reranking, or Milvus clients in
the explicit offline profile. Items 4 and 5 remain open until a resolved local
Ollama artifact passes the full live lifecycle and paired-search matrix.

## Release gates

Correctness gates run before performance claims:

- exhaustive dense retrieval matches an independent brute-force cosine oracle;
- FTS results survive resource release, reopen, and process restart with at
  least 3,000 rows;
- newly inserted, updated, and deleted rows have deterministic FTS visibility;
- acknowledged retrieval never selects an SDK mode that skips unindexed data;
- tokenizer probes preserve the frozen exact-token contract on the pinned SDK;
- Core produces byte-stable projection text and versions for equivalent
  searchable full, incremental, repair, and fixture inputs, and every adapter
  receives exactly those supplied projections without reconstruction or
  additional analysis;
- overlapped and repeatedly interleaved Voyage indexing and query calls always
  send `input_type: "document"` and `input_type: "query"`, respectively;
- a zero-match filtered dense, lexical, or hybrid query returns zero results;
- completion-marker fetch, upsert, delete, count, clear, repair, and rollback
  contracts pass;
- every search excludes control records, stale generations, and incomplete
  generations even when its caller supplies no filter;
- a successfully acknowledged batch survives forced process termination and is
  visible from a fresh reader;
- readers and the lease-held writer have bounded, deterministic behavior;
- cross-process reads observe the intended latest table version;
- metadata and UTF-8 source content round-trip without changes;
- backend/provider/model/dimension/projection changes require reindex, while an
  existing Milvus fingerprint remains parseable and is classified as
  `requires_reindex`;
- exact identifiers, paths, literals, configuration, ownership, and structural
  routes make zero embedding calls when deterministic evidence succeeds;
- Voyage and Ollama satisfy the same public search and lifecycle contracts;
- offline configuration persists the offline profile, constructs no remote
  inference or reranking client even when cloud credentials exist, rejects every
  selected cloud execution path, and makes `doctor` report the invariant
  explicitly;
- local provider identity and artifact digest are resolved before fingerprint,
  snapshot, runtime-owner, or handler construction, and a missing or changed
  digest blocks startup before any index is opened;
- a rejected installer preflight leaves managed configuration and client files
  byte-for-byte unchanged, with environment forwarding and repository indexes
  untouched;
- the supported Node/platform release matrix loads the native dependency;
- the existing paired search-quality corpus has no frozen regression;
- initial LanceDB retrieval preserves the existing 32-to-80 candidate-depth
  formula and existing embedding and reranker provider budgets; a 50-to-100
  experiment cannot change production policy without the Phase 4 acceptance
  evidence;
- the 10 MB fixture and Phase 0-frozen cardinality cases record searchable
  chunks, dimension, projection bytes, indexing time, provider calls/tokens,
  database size, warm/cold p50 and p95 for exact/FTS/hybrid search,
  concurrent-reader behavior, and peak RSS; bytes read is diagnostic only when
  the platform can collect it comparably;
- no ANN index is added unless exhaustive search fails the frozen latency gate
  and the candidate ANN configuration passes a frozen recall gate.

## Non-goals

- No model inference inside LanceDB.
- No bundled Ollama daemon or automatic model download.
- No automatic indexing from installer commands.
- No automatic deletion or conversion of Milvus collections.
- No second query planner, chunker, reranker policy, or public search schema.
- No mutable embedding-purpose state, adapter-owned projection builder, or
  second execution-profile/capability system.
- No ANN index justified only by upstream benchmarks.
- No claim that local storage makes Voyage requests private or offline.

## Upstream API assumptions to verify when pinning

The current LanceDB JavaScript documentation exposes local embedded connections,
precomputed vector columns, `bypassVectorIndex()` for exhaustive search, FTS
indexes, tokenizer inspection, `optimize()`, scalar filters,
`readConsistencyInterval`, and resource lifecycle methods. These links track
upstream `main` and may describe unreleased behavior. They are discovery inputs
only; the Phase 0 release tag/source and adapter contract tests are authoritative
for Satori:

- [LanceDB JavaScript basic example](https://github.com/lancedb/lancedb/blob/main/lancedb/nodejs/examples/basic.test.ts)
- [LanceDB `VectorQuery.bypassVectorIndex`](https://github.com/lancedb/lancedb/blob/main/docs/src/js/classes/VectorQuery.md)
- [LanceDB `Table.optimize` and search API](https://github.com/lancedb/lancedb/blob/main/docs/src/js/classes/Table.md)
- [LanceDB connection consistency options](https://github.com/lancedb/lancedb/blob/main/docs/src/js/interfaces/ConnectionOptions.md)
- [LanceDB documentation release warning](https://github.com/lancedb/lancedb/blob/main/docs/README.md)
- [Voyage embedding quickstart](https://docs.voyageai.com/docs/quickstart-tutorial)

If the pinned SDK differs from those assumptions, change the adapter plan or
block the release; do not emulate a missing durability or freshness guarantee
with undocumented behavior.
