# Live MCP context and latency benchmark

This record captures a controlled live comparison of Satori MCP discovery with
bounded native repository reads. It is an observational benchmark, not a launch
readiness declaration or a replacement for the committed useful-context corpus.

## Environment and authority preparation

- Recorded: 2026-07-14 (Asia/Shanghai)
- Repository: `/home/hamza/repo/satori`
- Git revision: `cb9333af08f6a2612a1e3415da318bcb189ee672`
- Worktree: clean before and after measurement
- Platform: Linux 6.18.33.2-microsoft-standard-WSL2 x86_64
- Node.js: v24.13.0
- pnpm: 10.28.2
- Satori runtime: 6.0.0
- Embedding provider/model: VoyageAI `voyage-code-3`, dimension 1024
- Vector provider/schema: Milvus `hybrid_v3`

Initial status proved the vector generation but reported a missing source
freshness checkpoint. An explicit reindex was therefore required and completed:

- Reindex operation: `336cf7c0-6344-4a4f-acbd-7ea3b020da8f`
- Reindex generation: 2736
- Indexed files: 358
- Indexed chunks: 7,948

The benchmark ran only after the mutation lease was released and a no-change
sync had completed. The final observed sync was operation
`1608c4d7-b8ef-4403-ab59-681c55e6072c`, generation 2739, with
`+0/-0/~0`. Final status was `ok` with `symbol_rich` evidence and no source
checkpoint warning.

## Measurement contract

Calls were issued sequentially. Wall time was measured immediately around each
MCP `callTool` or native command. Satori payload size is the UTF-8 byte length of
the decoded text blocks in `CallToolResult.content`; MCP transport JSON escaping
is excluded because it is not model-visible content. Native payload size is the
UTF-8 byte length of stdout after RTK filtering, which is the text shown to the
agent.

Conceptually, each MCP call was measured as:

```js
const startedAt = performance.now();
const result = await client.callTool({ name, arguments: args });
const latencyMs = performance.now() - startedAt;
const visibleText = result.content
  .filter((item) => item.type === "text")
  .map((item) => item.text)
  .join("");
const responseBytes = Buffer.byteLength(visibleText, "utf8");
```

No model tokenizer was available. Token figures below are explicitly heuristic:

```text
estimated tokens = UTF-8 bytes / 4
```

The exact byte counts are authoritative; the token figures are not. All reported
Satori search samples used `freshnessDecision.mode="skipped_recent"`. A preceding
conceptual sample that triggered a no-change sync was discarded and repeated
warm. One sample per workload was recorded, so these timings are observations,
not percentile claims.

## Reproducible Satori workloads

Use the absolute repository path shown below. For another checkout, replace only
the `path` value and re-establish a completed no-change sync before measuring.

### 1. Search owner discovery

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "where is search code behavior handled",
    "scope": "runtime",
    "resultMode": "grouped",
    "groupBy": "symbol",
    "limit": 5
  }
}
```

Expected owner: `packages/mcp/src/core/handlers.ts`, `handleSearchCode`.

### 2. Conceptual mutation-fencing discovery

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "how does Satori prevent stale search evidence across a concurrent index mutation boundary",
    "scope": "runtime",
    "resultMode": "grouped",
    "groupBy": "symbol",
    "limit": 5
  }
}
```

Expected evidence includes the MCP handler/read-preparation path and mutation
generation or lease fencing.

### 3. Exact identifier discovery

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "runExactRegistryFastPath",
    "scope": "runtime",
    "resultMode": "grouped",
    "groupBy": "symbol",
    "limit": 5
  }
}
```

Expected owner: `packages/mcp/src/core/search-exact-fast-path.ts`.

### 4. Bounded call graph

First resolve `handleSearchCode`:

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "handleSearchCode",
    "scope": "runtime",
    "resultMode": "grouped",
    "groupBy": "symbol",
    "limit": 5
  }
}
```

Pass the first result's `target` without rewriting it:

```json
{
  "tool": "call_graph",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "symbolRef": "<first grouped result target>",
    "direction": "both",
    "depth": 1,
    "limit": 20
  }
}
```

The recorded response contained seven nodes and eight edges, including
`handleSearchCode`, `runExactRegistryFastPath`, `runSearchExecution`,
`runSearchFrontDoor`, and `finalizeSearchResults`.

### 5. Exact file outline

```json
{
  "tool": "file_outline",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "file": "packages/mcp/src/core/handlers.ts",
    "resolveMode": "exact",
    "symbolLabelExact": "method handleSearchCode",
    "limitSymbols": 20
  }
}
```

### 6. Architecture discovery

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "Satori package architecture core mcp cli runtime responsibilities",
    "scope": "mixed",
    "resultMode": "grouped",
    "groupBy": "file",
    "limit": 8
  }
}
```

Expected anchors: `core`, `mcp`, and `cli`, with the canonical architecture
document considered stronger than derivative roadmaps or pitch material.

## Reproducible native workloads

Run from the repository root. RTK is intentionally included because its output,
not raw subprocess output, is what the agent consumed.

```bash
rtk rg -n -i "search_codebase|search.*handler|handle.*search" packages/mcp/src --glob '*.ts' --glob '!*.test.ts'

rtk rg -n -i "mutation.*(generation|lease)|stale.*(read|evidence)|prepareRead" packages/mcp/src/core --glob '*.ts' --glob '!*.test.ts'

rtk rg -n -m 20 "runExactRegistryFastPath" packages --glob '*.ts'

rtk rg -n "handleSearchCode\\(" packages/mcp/src --glob '*.ts' --glob '!*.test.ts'
rtk sed -n '2609,3175p' packages/mcp/src/core/handlers.ts

rtk rg -n -m 20 "class ToolHandlers|handleSearchCode|handleFileOutline|handleCallGraph" packages/mcp/src/core/handlers.ts

rtk rg -n -i -m 30 "core|mcp|cli|runtime" ARCHITECTURE.md packages/core/package.json packages/mcp/package.json packages/cli/package.json pnpm-workspace.yaml
```

The native graph comparison uses two calls because lexical reference discovery
alone does not expose callees; the handler body must also be read. The Satori
graph remains advisory and is not compiler-grade blast-radius proof.

## Results

| Workload | Satori response | Native response | Observed wall time (Satori / native) | Assessment |
|---|---:|---:|---:|---|
| Search owner discovery | 3,637 B (~909 tokens) | 3,358 B (~840 tokens) | 7.65 s / 0.13 s | Native was slightly smaller; Satori ranked the expected handler fourth. |
| Conceptual mutation fencing | 3,358 B (~840 tokens) | 14,282 B (~3,571 tokens) | 7.99 s / 0.09 s | Satori used 76.5% less context, but lower results contained noise. |
| Exact identifier | 1,448 B (~362 tokens) | 316 B (~79 tokens) | 5.01 s / 0.13 s | Native was materially smaller. |
| Bounded call graph | 5,554 B (~1,389 tokens), two calls | 29,471 B (~7,368 tokens), two calls | 7.59 s / 0.25 s | Satori used 81.2% less context and returned structured relationships. |
| Exact outline | 597 B (~149 tokens) | 347 B (~87 tokens) | 2.21 s / 0.12 s | Native was smaller. |
| Architecture | 5,910 B (~1,478 tokens) | 3,108 B (~777 tokens) | 8.01 s / 0.15 s | Native was smaller and reached the canonical document directly. |
| **Total** | **20,504 B (~5,126 tokens), seven calls** | **50,882 B (~12,721 tokens), seven calls** | **38.45 s / 0.86 s** | **Satori used 59.7% less model-visible text overall.** |

The total saving is dominated by conceptual retrieval and graph traversal.
Satori was not a universal context reduction: native bounded search remained the
better route for known identifiers, exact file structure, and direct canonical
documentation lookup.

## Latency diagnostic method

The latency follow-up used the same live MCP process and measured three paths:

1. Client wall time around `callTool`.
2. Satori's internal `debugMode="full"` readiness and search phase timings.
3. Direct calls to the configured Voyage and Milvus/Zilliz providers, bypassing
   MCP and Satori's readiness orchestration.

The paired exact-search diagnostic used:

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "runExactRegistryFastPath",
    "scope": "runtime",
    "resultMode": "grouped",
    "groupBy": "symbol",
    "limit": 5,
    "debugMode": "full"
  }
}
```

The paired semantic diagnostic used:

```json
{
  "tool": "search_codebase",
  "arguments": {
    "path": "/home/hamza/repo/satori",
    "query": "where is search code behavior handled",
    "scope": "runtime",
    "resultMode": "grouped",
    "groupBy": "symbol",
    "limit": 5,
    "debugMode": "full"
  }
}
```

The outline confirmation reused workload 5 without a debug selector because the
tool does not expose one. Follow-up confirmations observed 4,997 ms for exact
search, 7,338 ms for semantic search, and 2,206 ms for exact outline. These agree
with the paired diagnostic samples below; they are not included in the context
size totals.

## Satori phase decomposition

The paired exact diagnostic had a client wall time of 5,025 ms:

| Phase | Time | Interpretation |
|---|---:|---|
| `prepareRead` | 3,191 ms | Readiness before search. |
| `completionProof` | 3,187 ms | Nested inside `prepareRead`; do not add it again. |
| `ensureFreshness` | 1,208 ms | Worktree/checkpoint freshness decision. |
| `exactRegistry` | 23 ms | Exact identifier resolution itself. |
| `registryLoad` | 174 ms | Navigation registry materialization. |
| `navigationValidation` | 382 ms | Navigation-sidecar validation. |

The approximate non-overlapping internal total was 4,978 ms. The difference
between it and client wall time was about 47 ms. The readiness trace reported:

```json
{
  "proofMode": "cold",
  "invalidationReason": "observation_unavailable",
  "coldReadinessChecks": 2,
  "warmReceiptRevalidations": 0,
  "exactPayloadRecounts": 2
}
```

The paired semantic diagnostic had a client wall time of 7,603 ms:

| Phase | Time |
|---|---:|
| `prepareRead` | 3,193 ms |
| `ensureFreshness` | 1,205 ms |
| `semanticSearch` | 1,891 ms |
| `rerank` | 685 ms |
| `registryLoad` | 159 ms |
| `navigationValidation` | 401 ms |

The approximate non-overlapping internal total was 7,534 ms, leaving about
69 ms outside the instrumented Satori phases. This remainder includes the MCP
SDK, stdio transport, client decoding, and timing/rounding error; it is not a
pure transport measurement. It is nevertheless small enough to rule out MCP
transport as the multi-second bottleneck.

## Direct provider benchmark

The direct provider probe ran as a Node.js ESM script against the same running
MCP process:

```bash
rtk node /tmp/satori-provider-latency.mjs 132816
```

The PID argument was used only to read the live runtime configuration from
`/proc/<pid>/environ`. Credential values were passed to the provider clients and
were never printed. To reproduce after a restart, replace `132816` with the PID
reported by `manage_index status` or `list_codebases`. The probe imported the
built provider implementations from:

```text
packages/core/dist/embedding/voyageai-embedding.js
packages/core/dist/reranker/voyageai-reranker.js
packages/core/dist/vectordb/milvus-restful-vectordb.js
```

The exact constructor and request parameters were:

```js
const query = "where is search code behavior handled";

const embedding = new VoyageAIEmbedding({
  apiKey: runtimeEnv.VOYAGEAI_API_KEY,
  model: runtimeEnv.EMBEDDING_MODEL || "voyage-code-3",
  outputDimension: 1024,
});
embedding.setInputType("query");
await embedding.embed(query);

const reranker = new VoyageAIReranker({
  apiKey: runtimeEnv.VOYAGEAI_API_KEY,
  model: runtimeEnv.VOYAGEAI_RERANKER_MODEL || "rerank-2.5",
});
await reranker.rerank(query, documents, {
  topK: 41,
  truncation: true,
  returnDocuments: false,
});

const vectorDatabase = new MilvusRestfulVectorDatabase({
  address: runtimeEnv.MILVUS_ADDRESS,
  token: runtimeEnv.MILVUS_TOKEN,
  database: runtimeEnv.MILVUS_DATABASE,
});
const collectionNames = await vectorDatabase.listCollections();
const collection = collectionNames[0];
await vectorDatabase.hasCollection(collection);
await vectorDatabase.count(collection, 'fileExtension != ".satori_meta"');
await vectorDatabase.query(
  collection,
  'fileExtension == ".satori_meta"',
  ["id", "content", "metadata", "fileExtension"],
  10,
);
```

The rerank input was 41 deterministic synthetic documents totaling 58,989
JavaScript characters. Each document repeated this seed eight times and added a
zero-based candidate suffix:

```js
const documentSeed = [
  "export async function handleSearchCode(args) {",
  "  const readiness = await prepareTrackedRootForRead(args.path);",
  "  return runSearchExecution(args, readiness);",
  "}",
].join("\n");

const documents = Array.from({ length: 41 }, (_, index) =>
  `${documentSeed}\n// candidate ${index}\n${documentSeed.repeat(8)}`
);
```

Every operation ran sequentially five times. No warm-up sample was discarded,
so the first-call cost remains visible in each range. Median is the middle value
after sorting the five samples. The vector probe selected the first and only
collection returned in this environment; a later run with multiple collections
must select the Satori authority collection explicitly.

| Direct API operation | Samples (ms) | Median | Range |
|---|---|---:|---:|
| Voyage query embedding, `voyage-code-3`, 1024 dimensions | 517.1, 442.6, 340.0, 339.2, 352.4 | 352.4 ms | 339.2-517.1 ms |
| Voyage rerank, `rerank-2.5`, 41 documents | 672.7, 671.8, 668.7, 492.3, 663.3 | 668.7 ms | 492.3-672.7 ms |
| Milvus `listCollections` | 908.8, 760.2, 184.1, 186.3, 188.2 | 188.2 ms | 184.1-908.8 ms |
| Milvus `hasCollection` | 177.0, 168.5, 172.2, 173.1, 176.5 | 173.1 ms | 168.5-177.0 ms |
| Milvus exact payload count | 380.2, 382.5, 347.2, 353.8, 347.6 | 353.8 ms | 347.2-382.5 ms |
| Milvus completion-marker query | 358.5, 343.7, 348.0, 347.5, 352.3 | 348.0 ms | 343.7-358.5 ms |

These are provider round trips from this WSL2 environment to the configured
services. They are not service-wide performance claims.

## Root cause

The dominant avoidable cost is repeated remote authority proof, not result
construction or MCP transport.

`ToolHandlers.getPreparedReadObservation()` returns `null` when its SyncManager
observation is unavailable. `runSearchFrontDoor()` consequently cannot bind and
reuse the initial readiness proof across the freshness decision. Even when
freshness reports `skipped_recent`, the request performs two cold readiness
checks and two exact remote payload recounts. In the exact sample, that readiness
path consumed about 3.2 seconds while exact registry resolution consumed 23 ms.

The relevant runtime path is:

```text
packages/mcp/src/core/handlers.ts:getPreparedReadObservation
  -> packages/mcp/src/core/search-frontdoor.ts:runSearchFrontDoor
  -> packages/mcp/src/core/tracked-root-readiness.ts:prepareTrackedRootForRead
```

`SyncManager.getPreparedReadObservation()` requires all of the following:

- Watcher mode is enabled and started.
- The root has an active watcher.
- No debounce, sync, or ignore reconcile is active.
- The registered source-checkpoint observation remains available and equal.

The live process had no `MCP_ENABLE_WATCHER` override, so configuration defaults
watcher mode to enabled. It ran in MCP mode, and the startup path calls
`startWatcherMode()`. Search completion calls `touchWatchedCodebase()`, which is
the registration entry point. Despite those facts, PID 132816 had no
`anon_inode:inotify` descriptor immediately after exact search or after a
two-second follow-up wait.

System-wide inotify exhaustion was not established:

```text
max_user_instances=128
max_user_watches=524288
visible_inotify_instances=8
visible_processes_with_inotify=7
```

The current diagnostics do not expose which internal predicate made the
observation unavailable. The remaining possibilities are watcher startup not
completing, root registration not completing, watcher failure/removal, or an
independent source-checkpoint observation mismatch. Claiming one of these as the
specific failure would exceed the evidence. A bounded diagnostic reason enum at
this boundary is the next useful product change.

`file_outline` has a separate fixed cost. `NavigationHandlers.handleFileOutline()`
calls `prepareTrackedRootForRead(root, "navigation")` directly and does not use
the prepared-read cache. It therefore performs a full remote completion proof
on every outline request. One proof plus registry/navigation validation explains
the repeatedly observed approximately 2.2-second outline latency.

Semantic search then adds legitimate provider work: approximately 1.9 seconds
for semantic retrieval and 0.7 seconds for reranking in the paired request.
Direct API measurements show that individual provider calls are themselves
roughly 0.17-0.67 seconds when warm, so repeated sequential proof calls compound
quickly.

## Failed canonical recorder attempt

The repository's useful-context recorder was also attempted with the exact
command:

```bash
rtk pnpm eval:useful-context:record -- \
  --tasks evals/useful-context/tasks.json \
  --repo /home/hamza/repo/satori \
  --out /tmp/satori-useful-context-latency-2026-07-14.json \
  --warm-samples 3
```

It first correctly refused a dirty worktree. After the benchmark document was
temporarily removed and the worktree was clean, it still failed with:

```text
Task 'find-search-handler' freshness preparation failed (status: error).
```

No observation file was produced. This harness result is recorded as failed and
was not used for the result table.

## Deferred improvement backlog

The following work was identified during diagnosis but was not implemented as
part of this observational benchmark. Preserve the listed safety constraints
when returning to it.

### 1. Represent watcher readiness explicitly

`SyncManager.registerCodebaseWatcher()` adds the Chokidar object to `watchers`
immediately after construction. `getPreparedReadObservation()` subsequently
uses `watchers.has(root)` as its watcher-health test; it does not prove that the
watcher emitted `ready` and completed its initial scan.

Replace map membership as the health contract with explicit state, for example:

```text
starting -> ready -> failed/stopped
```

Only `ready` may support prepared-read reuse. An error, close, unregister, or
watcher-mode shutdown must invalidate the root's freshness epoch and cached
prepared evidence before releasing watcher ownership.

Required evidence:

- A request during initial watcher startup cannot reuse cross-request freshness.
- The `ready` transition enables reuse only after all other observations agree.
- Watcher error/removal invalidates reuse before the next read.
- Restart begins with no watcher-backed prepared state.

### 2. Decouple intra-request proof reuse from cross-request caching

Watcher-backed evidence is required to carry source-freshness confidence across
requests. Its absence should not automatically require two identical cold
authority proofs inside the same request.

Allow the initial generation proof to serve as the post-freshness proof only
when `ensureFreshness` is a no-op and all proof-bound observations remain equal
before and after freshness:

- Canonical root and source snapshot observation.
- Mutation-active state and mutation generation.
- Vector and navigation authority observations.
- Completion marker identity and exact payload evidence.
- Source-checkpoint document digest.
- Freshness epoch and watcher state, where applicable.

Any missing, malformed, changed, or contradictory observation must retain the
current cold-proof or fail-closed path. This optimization must not turn a TTL or
an in-memory `ready` flag into authority.

Required evidence:

- A no-op freshness decision performs one full proof, not two.
- Mutation, checkpoint, marker, navigation, or source change forces reproof.
- Watcher-unavailable mode does not enable cross-request receipt reuse.
- Exact payload evidence is never reused across an unobserved backend mutation.

### 3. Put `file_outline` on the common proof path

`NavigationHandlers.handleFileOutline()` currently invokes
`prepareTrackedRootForRead(root, "navigation")` directly and therefore pays a
full completion proof on every request. Make it consume the same immutable,
authority-bound generation receipt as search while retaining navigation seal,
mutation-generation, and checkpoint observation validation.

Required evidence:

- Repeated exact outlines reuse a valid receipt.
- Marker, policy, navigation, checkpoint, or mutation changes invalidate it.
- Missing or corrupt navigation preserves the existing deterministic degraded
  result rather than being reinterpreted as a generic exception.
- Warm exact-outline latency is measured separately from source reads.

### 4. Expose bounded prepared-observation diagnostics

The current `null` result loses the reason prepared evidence was unavailable.
Return an internal discriminated reason such as:

```text
watcher_disabled
watcher_starting
watcher_missing
watcher_failed
checkpoint_missing
checkpoint_mismatch
mutation_active
authority_unavailable
```

Expose the reason only through freshness/full diagnostics and operation counters;
do not expand default response payloads. The reason must describe the first
authoritative failing predicate in a stable order.

Use that diagnostic to repair the useful-context recorder's
`freshness preparation failed` result. The recorder should retain exact payload
bytes and operation counts, run multiple warm samples, and report p50/p95 without
silently accepting a degraded or synchronization-triggering sample.

### Recommended sequence

Implement items 1 and 2 together first: item 1 closes the watcher-readiness
ambiguity, while item 2 removes the largest demonstrated avoidable latency
without granting watcher-free cross-request caching. Then integrate outline
receipts, followed by diagnostics and benchmark gates. Provider tuning is lower
priority because the repeated proof path is the clearer product defect.

## Post-stabilization live validation

The latency stabilization implementation was rebuilt, installed through the
managed local launcher, and exercised in a fresh MCP subprocess. This validation
used the working tree based on Git revision
`cb9333af08f6a2612a1e3415da318bcb189ee672`; the implementation itself was still
uncommitted, so these results identify the tested diff and are not a claim about
that base revision alone.

The latency implementation diff under `packages/core` and `packages/mcp` had
SHA-256
`cdb3cdae7cac77904ce6f7676c6b39d4ed92ab665ed18889c4ae083f87abd68e`.
The later durable comparison artifact also records its complete tracked and
staged diff hashes plus every untracked-file hash, avoiding dependence on a
mutable verbal description of the working tree.

Full status returned `ok` with compatible symbol and relationship evidence. It
did not require reindexing. The measured run began with an explicit sync; the
final benchmark sync was operation `a1bda4e6-9ba5-467d-8427-615c1a5bb377`,
generation 2750, with `+0/-0/~0`.

### Post-change procedure

The client started this built entry directly in a fresh stdio session:

```text
command: /home/hamza/.nvm/versions/node/v24.13.0/bin/node
arguments: [/home/hamza/repo/satori/packages/mcp/dist/index.js]
cwd: /home/hamza/repo/satori
startup timeout: 30,000 ms
tool-call timeout: 300,000 ms
close timeout: 5,000 ms
```

The child inherited the managed local Satori environment. Credential values
were never printed. Calls used the argument objects already recorded in the
paired exact, semantic and outline sections above and ran in this order:

1. `manage_index status` with `detail="full"`.
2. `manage_index sync`.
3. One exact-search warm-up, followed by a 500 ms watcher-settle delay.
4. Three sequential exact identifier samples.
5. Three sequential semantic samples.
6. One exact-outline warm-up in the separately created navigation/vector
   runtime.
7. Three sequential exact-outline samples.
8. Two concurrent exact identifier calls using `Promise.all`.
9. One `read_file` call with the exact result's file and unmodified
   `target.symbolId` passed as `open_symbol.symbolId`, with `mode="annotated"`.
10. One `call_graph` call with the exact result target passed without rewriting,
    `direction="both"`, `depth=1`, and `limit=20`.
11. `manage_index status` with `detail="diagnostics"`.

### Durable benchmark recorder

The temporary benchmark programs used for the first validation have been
consolidated into:

```text
scripts/satori-live-latency-benchmark.mjs
```

Its parser and reproducible defaults are covered by
`scripts/satori-live-latency-benchmark.test.mjs`. The old temporary files map
to repository modes as follows:

| Temporary file | Durable replacement |
|---|---|
| `/tmp/satori-live-benchmark.mjs` | `--mode diagnostic` |
| `/tmp/satori-native-comparison.mjs` | default `--mode comparison` |
| `/tmp/satori-live-watcher-disabled.mjs` | `--mode watcher-disabled` with `MCP_ENABLE_WATCHER=false` |
| `/tmp/satori-live-status.mjs` | `--mode status` |

The default comparison suite exercises every public, non-destructive,
non-index/collection tool:

- `search_codebase`: exact identifier, semantic owner discovery, conceptual
  mutation-fencing discovery and architecture discovery.
- `file_outline`: exact outline by symbol label.
- `call_graph`: bounded depth-one graph for an unchanged exact symbol target.
- `read_file`: exact `open_symbol` and a bounded plain line read.

`manage_index` is excluded because it owns index mutation/status operations.
`list_codebases` is excluded because it is collection/index discovery rather
than code reading. The benchmark performs an initial `manage_index sync` only
as setup unless `--skip-sync` is supplied; setup time is recorded separately
and is not included in read-tool totals.

The normal invocation is:

```bash
node scripts/satori-live-latency-benchmark.mjs \
  --repo /home/hamza/repo/satori \
  --output-dir /home/hamza/repo/satori/.satori/benchmarks/live-latency
```

This writes a timestamped JSON artifact with mode `comparison`. It contains:

- Exact tool arguments, command, timeouts and workload identity.
- Satori and native per-workload wall time and response bytes.
- Derived current-Satori-versus-current-native comparisons.
- Git HEAD, tracked/staged diff SHA-256 values and hashes for untracked files.
- No environment-variable values or credentials.

To compare with the newest compatible artifact in the output directory:

```bash
node scripts/satori-live-latency-benchmark.mjs \
  --repo /home/hamza/repo/satori \
  --output-dir /home/hamza/repo/satori/.satori/benchmarks/live-latency \
  --compare-last
```

Compatibility is not inferred from filename order alone. The recorder compares
only artifacts with the same benchmark ID, format version and workload-identity
hash. The newest matching artifact is selected, so changed queries, file
targets, sample count or graph window do not produce a misleading historical
comparison.

The diagnostic mode retains the original three-sample exact, semantic and
outline procedure plus concurrent exact, open-symbol and graph observations:

```bash
node scripts/satori-live-latency-benchmark.mjs \
  --repo /home/hamza/repo/satori \
  --mode diagnostic \
  --samples 3 \
  --settle-ms 500
```

Other reproducibility controls are `--command`, repeated `--command-arg`,
`--startup-timeout-ms`, `--call-timeout-ms`, `--close-timeout-ms`,
`--graph-body-range`, `--label`, `--skip-sync` and `--dry-run`. `--dry-run`
prints the expanded arguments without starting MCP or writing an artifact.

The live process required provider credentials from the local Codex MCP
configuration. The benchmark itself never reads or prints them. The temporary
wrapper used to inject that managed environment was
`/tmp/satori-configured-exec.py`, with this exact content:

```python
#!/usr/bin/env python3
import os
import pathlib
import sys
import tomllib


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: satori-configured-exec.py <command> [args...]")

    config_path = pathlib.Path.home() / ".codex" / "config.toml"
    with config_path.open("rb") as config_file:
        config = tomllib.load(config_file)

    satori = config.get("mcp_servers", {}).get("satori", {})
    configured_env = satori.get("env", {})
    if not isinstance(configured_env, dict):
        raise SystemExit("Codex Satori MCP environment is not a TOML table")

    child_env = os.environ.copy()
    child_env.update({str(key): str(value) for key, value in configured_env.items()})
    os.execvpe(sys.argv[1], sys.argv[1:], child_env)


if __name__ == "__main__":
    main()
```

With that local helper, the exact managed-environment invocation is:

```bash
python3 /tmp/satori-configured-exec.py \
  /home/hamza/.nvm/versions/node/v24.13.0/bin/node \
  scripts/satori-live-latency-benchmark.mjs \
  --repo /home/hamza/repo/satori \
  --compare-last
```

If the provider environment is already exported, the wrapper is unnecessary.

The outline warm-up is required because navigation tools use a metadata-only
provider context distinct from the embedding-capable search context. Warming
search alone does not warm that context. An earlier sample set that omitted this
step observed 2,258 ms, 2,140 ms and 549 ms; it was rejected as a warm-outline
measurement rather than averaged into the result.

### Post-change results

All medians and ranges below are observational summaries of three samples, not
percentile claims.

| Workload | Before | Warm samples after (ms) | After median and range | Observed change |
|---|---:|---|---:|---:|
| Exact identifier search | 5,025 ms | 564.9, 571.3, 574.2 | 571.3 ms (564.9-574.2) | approximately 88.6% lower, 8.8x faster |
| Semantic search | 7,603 ms | 4,056.9, 2,991.7, 2,885.8 | 2,991.7 ms (2,885.8-4,056.9) | approximately 60.7% lower, 2.5x faster |
| Exact file outline | 2,206 ms | 546.1, 542.5, 547.8 | 546.1 ms (542.5-547.8) | approximately 75.2% lower, 4.0x faster |

Additional warm observations were:

| Workload | Wall time | Response bytes | Result |
|---|---:|---:|---|
| Concurrent exact call A | 676.4 ms | 15,191 B | `ok`, warm receipt |
| Concurrent exact call B | 649.7 ms | 15,190 B | `ok`, warm receipt |
| `read_file(open_symbol)` | 705.3 ms | 12,417 B | exact symbol opened |
| `call_graph` | 739.7 ms | 4,903 B | `ok`, 10 nodes and 9 edges |

Exact and semantic response sizes include `debugMode="full"` diagnostics and
therefore are not comparable to the compact default-response byte counts in the
original context-efficiency table.

### Three-way comparison: previous Satori, stabilized Satori and native

A separate fresh MCP session reran all six original production-shaped
workloads without debug output. The session completed a `+0/-0/~0` sync, then
warmed search, outline and call-graph execution contexts independently before
recording one sample per workload. The corresponding native RTK commands were
rerun immediately afterward against the same working tree and warm filesystem.

The native graph body window moved from `2609,3175` to `2913,3533` because the
implementation moved `handleSearchCode`; the updated window still captures the
same complete handler owner. This and the larger current source explain part of
the byte-count movement. These remain single observations, not percentile
claims.

| Workload | Previous Satori | Stabilized Satori | Current native | Satori latency change | Current Satori versus native |
|---|---:|---:|---:|---:|---|
| Search owner discovery | 7.65 s / 3,637 B | 3.077 s / 4,870 B | 0.054 s / 3,358 B | 59.8% lower | 57.1x slower; 45.0% more text |
| Conceptual mutation fencing | 7.99 s / 3,358 B | 2.726 s / 4,090 B | 0.042 s / 14,277 B | 65.9% lower | 65.3x slower; 71.4% less text |
| Exact identifier | 5.01 s / 1,448 B | 0.560 s / 1,812 B | 0.048 s / 316 B | 88.8% lower | 11.7x slower; 5.7x more text |
| Bounded call graph, two calls | 7.59 s / 5,554 B | 1.337 s / 5,918 B | 0.108 s / 32,401 B | 82.4% lower | 12.4x slower; 81.7% less text |
| Exact outline | 2.21 s / 597 B | 0.568 s / 597 B | 0.025 s / 347 B | 74.3% lower | 22.3x slower; 72.0% more text |
| Architecture | 8.01 s / 5,910 B | 3.277 s / 6,273 B | 0.028 s / 3,108 B | 59.1% lower | 115.1x slower; 2.0x more text |
| **Total, seven calls** | **38.45 s / 20,504 B** | **11.544 s / 23,560 B** | **0.306 s / 53,807 B** | **70.0% lower, 3.3x faster** | **37.8x slower; 56.2% less text** |

The stabilized implementation therefore improves Satori materially without
changing the original routing conclusion:

- Native bounded commands remain decisively faster for every workload.
- Native remains the better route for known identifiers, exact outlines and
  direct canonical-document lookup.
- Satori still earns its cost for conceptual mutation discovery and bounded
  graph traversal, where it reduced current model-visible text by 71.4% and
  81.7% respectively while returning ranked or structured evidence.
- Overall Satori context reduction versus current native output is 56.2%, down
  from the previous 59.7%. Stabilized Satori emitted 14.9% more text than the
  earlier Satori observation, while the current native corpus was also 5.7%
  larger because the compared implementation and handler body grew.

The correct product claim is consequently narrower: the latency defect is
substantially reduced, but Satori is not a native-command latency replacement.
Its remaining value is lower context and structured discovery on the workloads
where those benefits outweigh remote authority and provider round trips.

### Durable all-read-tool recorder result

The promoted recorder was then run in default comparison mode. It produced:

```text
.satori/benchmarks/live-latency/2026-07-14T14-53-14-333Z-comparison-post-stabilization.json
```

The initial sync took 24.389 seconds because the newly added benchmark sources
had to be indexed. Sync time is retained in the artifact but excluded from the
read totals. The recorded read workloads were:

| Public read workload | Satori | Native task comparator |
|---|---:|---:|
| Semantic owner discovery | 2.713 s / 5,238 B | 40.9 ms / 3,358 B |
| Conceptual mutation fencing | 2.815 s / 3,965 B | 40.2 ms / 14,277 B |
| Exact identifier | 555.2 ms / 1,812 B | 30.0 ms / 316 B |
| `call_graph` | 719.3 ms / 3,792 B | 106.5 ms / 32,401 B |
| `file_outline` | 540.3 ms / 597 B | 25.1 ms / 347 B |
| `read_file(open_symbol)` | 638.9 ms / 12,417 B | 78.6 ms / 11,102 B |
| Bounded plain `read_file` | 1.9 ms / 3,947 B | 75.2 ms / 3,948 B |
| Architecture discovery | 3.147 s / 6,168 B | 29.6 ms / 3,108 B |
| **Total** | **11.130 s / 37,936 B** | **426.1 ms / 68,857 B** |

The direct plain-read row measures an already-running MCP process against a new
native `rtk sed` subprocess, so it should not be generalized into an assertion
that MCP file I/O is intrinsically faster. Across the complete suite Satori was
26.1 times slower and returned 44.9% less text. The conceptual mutation and
graph workloads retained the meaningful context advantages: 72.2% and 88.3%
less text respectively.

The optional LIFO comparison was validated with a second run using
`--compare-last --skip-sync`. It selected the artifact above by workload
identity and wrote:

```text
.satori/benchmarks/live-latency/2026-07-14T14-54-00-563Z-comparison-compare-last-validation.json
```

The second artifact records both current-versus-native and current-versus-last
metrics. Total Satori wall time was 6.24% higher on the second single sample;
native total time was 2.72% lower. This is a functional validation of comparison
recording, not a statistically meaningful regression claim.

### Semantic comparison

There are two useful semantic comparisons, with different sampling contracts:

- The three-sample diagnostic workload improved from 7.603 seconds before the
  change to a 2.992-second median afterward, a 60.7% reduction and approximately
  2.5x speedup. Its observed range was 2.886-4.057 seconds.
- The production-shaped owner-discovery workload improved from 7.65 seconds in
  the original table to 2.713 seconds in the first durable-recorder artifact, a
  64.5% reduction and approximately 2.8x speedup. Its current native comparator
  was 40.9 milliseconds.

The native row is deliberately described as a task comparator: it is a bounded
lexical search, not an algorithmically equivalent semantic retrieval and rerank
pipeline. It establishes the latency floor for a well-formed native query, not
that native search provides the same ranked semantic evidence.

### Warm readiness evidence

Every measured exact and semantic sample reported:

```json
{
  "proofMode": "warm",
  "invalidationReason": "none",
  "operations": {
    "preparedCacheLookups": 1,
    "preparedCacheHits": 1,
    "coldReadinessChecks": 0,
    "postFreshnessColdChecks": 0,
    "warmReceiptRevalidations": 1,
    "exactPayloadRecounts": 0,
    "registryLoads": 0,
    "navigationValidationRuns": 0
  }
}
```

The watcher evidence on every sample was:

```json
{
  "configured": true,
  "managerStarted": true,
  "rootRegistered": true,
  "watcherActive": true,
  "lifecycleState": "ready",
  "checkpointStatus": "valid"
}
```

Focused Core tests separately prove that warm generation revalidation performs
zero `listCollections` calls, zero exact payload counts and one completion-marker
query. Exact-registry tests prove zero semantic search and reranker calls.
Repeated-outline tests prove that unchanged marker/navigation identity performs
zero additional registry loads and zero additional compatibility validations;
the public outline response does not expose search debug counters.

The exact warm phase timings were approximately 23-30 ms for registry lookup and
3-4 ms for freshness orchestration, with zero timed cold-readiness work. The
remaining approximately 530 ms of wall time is primarily the generation-bound
remote warm revalidation outside the search phase timer, not MCP transport or an
exact payload recount. Semantic search then added provider work: the median
sample observed 1,898 ms semantic retrieval, 451 ms reranking and 94 ms tracked
lexical work.

### Watcher-unavailable control

A separate fresh MCP subprocess set:

```text
MCP_ENABLE_WATCHER=false
```

It ran a no-change sync, one exact warm-up and one measured exact call using the
same arguments. The measured call completed in 561.7 ms with `status="ok"`,
returned `SOURCE_FRESHNESS_UNVERIFIED`, and reported
`observationUnavailableReason="watcher_disabled"`. Vector authority remained
warm-revalidated with zero cold checks, zero post-freshness checks, zero exact
payload recounts, zero registry loads and zero navigation validation runs.

This control demonstrates the intended separation: watcher loss makes source
freshness explicit and unverified, but does not force a full vector-authority
recount or make the proven generation unusable.

Direct checkpoint deletion/corruption and mutation-during-read were not injected
into this live repository because they would alter durable authority state while
another MCP owner was active. Their safety behavior was covered by the focused
checkpoint, mutation-generation, lease and navigation tests in the green Core
and MCP suites.

### Review follow-up and controlled evidence

The later review was correct that the first narrative did not enumerate the
controlled failure/audit samples precisely. That was an evidence gap, not a
demonstrated authority defect. The focused replay passed ten selected tests and
established:

- Absolute proof expiry reports `proofMode="cold"`,
  `invalidationReason="proof_expired"`,
  `auditClassification="proof_expiry_audit"`, one cold readiness check and one
  exact payload recount. `PreparedReadCache` removes the expired entry before
  the cold proof, so a failed audit cannot retain it.
- Missing and corrupt generation checkpoints return
  `skipped_source_checkpoint_unavailable`, never enter incremental sync and
  preserve their distinct `checkpoint_missing`/`checkpoint_corrupt`
  diagnostics.
- A mutation completed after cached receipt validation forces post-freshness
  readiness proof. Warm revalidation and cache seeding use one validated
  authority snapshot, preventing old-receipt/new-observation rebinding.
- Source-observation failure preserves vector results only with
  `SOURCE_FRESHNESS_UNVERIFIED`.
- `read_file(open_symbol)` resolves the provider vector context and calls
  `ToolHandlers.handleFileOutline()`. That method delegates to the navigation
  handler, whose outline path uses shared `prepareNavigationRead()` evidence.
  The provider-context delegation test and the generation-bound repeated-outline
  cache test both passed.

The exact focused command was:

```bash
cd packages/mcp
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='proof expiry|authority snapshot|prepared-read seeding|source observation failure|missing or corrupt|no-mutation freshness|committed sync|mutation completed|same marker generation|provider vector context' \
  src/core/handlers.scope.test.ts \
  src/core/sync.test.ts \
  src/core/search-frontdoor.test.ts \
  src/core/handlers.file_outline.test.ts \
  src/tools/read_file.test.ts
```

The broader proposed `authorityEffect` result type was not added. Current reuse
is deliberately limited to two known non-mutating decisions and also requires
identical before/after authority and mutation observations. The additional type
would improve future extensibility but does not fix a reachable current defect;
it remains deferred outside this bounded latency slice.

The request for explicit navigation-cache eviction at every lifecycle event was
also not expanded into new mutation plumbing. Cache entries are root-bounded,
their identity includes marker, policy, manifests, navigation seal and mutation
generation, and identity mismatch prevents stale reuse. Direct unwatch and
read-path invalidation clear both caches. Additional eager cleanup would reduce
short-lived retained memory, but no stale-evidence path was demonstrated.

## Conclusion

The measured client/MCP wrapper remainder is approximately 50-70 ms, not the
original 2-8 seconds. The main avoidable overhead was unavailable prepared-read
evidence causing repeated completion proofs and exact payload counts; the
stabilization removes those operations from ordinary healthy warm reads and
shares navigation preparation with outline, graph and exact symbol opening.
Voyage and Milvus/Zilliz latency accounts for the remaining legitimate provider
work, especially semantic retrieval and reranking. A bounded remote generation
revalidation remains the dominant exact/navigation cost.

The benchmark supports Satori's context-efficiency claim for conceptual and
graph-heavy discovery. The original measurements did not support the warm
latency target; the post-stabilization measurements meet the initial warm exact,
outline and semantic targets. Exact search and outline are now sub-second in the
measured environment; semantic search is dominated by provider retrieval and
reranking rather than repeated readiness proof. The remaining ordinary
exact-read cost is one bounded remote generation revalidation, while periodic
proof-expiry audits retain the full payload recount.
