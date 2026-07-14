# Satori warm-read latency stabilization plan

This document defines the bounded implementation plan for reducing healthy
warm-read latency in Satori. It incorporates the review findings from the live
MCP latency investigation and replaces the earlier uncorrected proposal.

This is an implementation plan, not a completion or launch-readiness claim.
The baseline measurements and exact original workloads are recorded in
[`2026-07-14-live-mcp-context-latency-benchmark.md`](./2026-07-14-live-mcp-context-latency-benchmark.md).

## Objective

Remove avoidable repeated authority work from healthy reads without weakening:

- Canonical v3 vector authority.
- Generation-bound source-checkpoint behavior.
- Mutation fencing.
- Navigation seal and registry integrity.
- Remote marker deletion and mismatch detection.
- Existing MCP request schemas, tool names and response envelope versions.

The primary target paths are:

- `search_codebase`.
- `file_outline`.
- `call_graph`.
- The symbol-owned `read_file` request with `open_symbol`.

`open_symbol` is not a standalone MCP tool. It is a nested `read_file` request
and must remain on that public surface.

## Measured baseline

The live benchmark observed:

| Workload | Client wall time | Dominant internal cost |
|---|---:|---|
| Exact identifier search | approximately 5.0 s | approximately 3.2 s readiness plus 1.2 s freshness |
| Semantic search | approximately 7.6 s | repeated readiness plus provider work |
| Exact file outline | approximately 2.2 s | uncached completion proof plus navigation validation |
| Exact registry lookup | approximately 23 ms | result resolution itself |
| MCP/client remainder | approximately 50-70 ms | not the multi-second bottleneck |

The exact diagnostic reported two cold readiness checks and two exact payload
recounts in one request because the prepared-read observation was unavailable.
The semantic path then added legitimate embedding, vector retrieval and rerank
work.

## Existing behavior to retain

The implementation must extend the current design rather than replace it.

- `PreparedReadCache` is already bounded to 32 roots.
- Entries already expire after 15 minutes idle.
- Proof age is already bounded to 30 minutes, after which the path returns to a
  full proof.
- Current warm vector revalidation already avoids `listCollections` and exact
  payload recounts.
- Warm vector revalidation currently checks collection existence and queries
  the canonical completion marker.
- `skipped_source_checkpoint_unavailable` already preserves vector use and
  returns `SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE` with `blocksUse: false`.
- Exact identifier resolution already has a registry fast path. Its no-provider
  behavior should be retained and proven, not redesigned.

The live latency defect is primarily that the cache cannot be used when its
composite prepared observation is unavailable. A second issue is that
navigation tools bypass the prepared-read cache.

### Runtime lifecycle ownership discovered during implementation

The MCP server has more than one `SyncManager` owner. The startup context owns
one manager, while provider-backed tool contexts created by `ProviderRuntime`
own separate managers. Search executes in the embedding-capable provider
context, so starting watcher mode only on the startup manager does not make the
search handler's prepared source observation available.

The bounded correction is:

- Start background synchronization and watcher mode for the provider-owned
  embedding context in MCP mode.
- Do not start that lifecycle for metadata-only/vector-only contexts because an
  incremental sync may need to embed changed files.
- Do not start it for CLI-mode provider contexts.
- If watcher startup fails, stop background sync and watcher mode before
  returning the error.
- Keep shutdown responsible for stopping every provider-owned lifecycle.

This does not introduce another authority owner or readiness architecture. It
aligns watcher lifecycle with the `SyncManager` actually used by search.
Navigation tools may instantiate a separate vector-only provider context, so
the live benchmark must warm the navigation path independently from search.

## Frozen architecture

The following decisions are not open in this project.

### Canonical authority

Continue using the existing v3 authority:

- Completion marker.
- Index policy.
- Navigation pointer and seal.
- Generation-bound source checkpoint.

Do not add another authority document, readiness manifest, completion manifest,
schema version or persisted cache.

### Public MCP surface

Keep the six public tools unchanged:

- `manage_index`.
- `search_codebase`.
- `call_graph`.
- `file_outline`.
- `read_file`.
- `list_codebases`.

Do not change request schemas or response envelope versions. New diagnostics
must stay in an existing debug or diagnostics projection unless an additive
public field is separately justified, documented and contract-tested.

### Evidence separation

Prepared reads must preserve three independent evidence domains.

#### Vector authority

Proves which remote vector generation may be searched. It includes the existing
root, collection, marker, policy, runtime and mutation-fence evidence.

#### Source freshness

Describes whether the current worktree was observed to be represented by the
proven vector generation:

- `fresh`: an exact request-local check or successful sync established a
  freshness baseline, and any cross-request continuation of that baseline
  remains protected by a ready watcher and matching checkpoint observation.
- `dirty`: a source difference was observed.
- `unverified`: sufficient source evidence was unavailable.

Watcher readiness never establishes freshness from scratch. It only preserves
and invalidates a baseline established by an exact scan or successful sync.
Watcher absence prevents watcher-backed cross-request freshness reuse, but does
not erase an exact point-in-time source check completed within the current
request.

#### Navigation authority

Proves whether registry-backed operations are safe. It remains bound to the
marker, policy, navigation generation, seal, manifests and current navigation
observation.

A capability selector may request vector, navigation, or both, but it must not
collapse these evidence domains into one readiness boolean.

## Supported external-drift contract

The frozen v3 evidence cannot detect arbitrary out-of-band payload replacement
when an attacker or external writer preserves the marker and payload count.
The implementation must not claim otherwise.

The supported contract is:

- Local Satori mutations are detected immediately through mutation-generation
  and lease fencing.
- Collection absence, completion-marker absence and marker mismatch are detected
  by remote marker/collection revalidation.
- Payload-count drift is detected by the existing periodic full authority proof.
- Same-cardinality out-of-band payload replacement with an intact marker is
  outside this plan's proof model.

The initial implementation will not add a TTL cache for marker-query results.
An ordinary warm authority revalidation may perform at most one completion-marker
query. The existing `hasCollection` call may remain until a focused backend test
proves that the marker query alone distinguishes a missing collection safely and
deterministically.

The 30-minute proof-age boundary remains the maximum interval before a retained
receipt returns to a full payload proof. A proof-expiry request is an integrity
audit, not an ordinary warm read.

## Required invariants

1. A receipt cannot cross a mutation-generation change.
2. A receipt created before mutation-lease acquisition cannot be used after that
   acquisition, even when the lease was released before execution.
3. Source freshness cannot independently establish vector authority.
4. Watcher failure cannot claim source freshness.
5. Watcher or checkpoint unavailability alone cannot force a remote payload
   recount when vector authority can be revalidated safely.
6. Exact outlines, symbol jumps and call graphs require valid navigation
   authority.
7. Missing source evidence may preserve vector search with a deterministic,
   non-blocking source-freshness warning.
8. TTL or an in-memory watcher flag cannot be the only correctness evidence.
9. Marker deletion or mismatch cannot fall back to stale cached authority.
10. Ordinary healthy warm reads perform no exact payload recount or collection
    enumeration.
11. Scheduled proof-expiry audits may perform one exact payload recount.
12. Existing authority, checkpoint, mutation and navigation tests may not be
    weakened to reach a latency target.

## Intended internal contracts

The current observation string combines source, mutation, vector and navigation
state. Replace that coupling with explicit domain evidence. Exact names may
follow existing conventions, but the shape should preserve this separation:

```ts
type SourceFreshnessUnavailableReason =
    | "watcher_disabled"
    | "watcher_manager_not_started"
    | "root_not_registered"
    | "watcher_starting"
    | "watcher_failed"
    | "checkpoint_missing"
    | "checkpoint_corrupt"
    | "checkpoint_observation_mismatch";

type SourceFreshnessObservation =
    | {
          status: "fresh";
          freshnessEpoch: number;
          checkpointObservation: string;
          basis: "exact_request_scan" | "successful_sync";
          continuity: "request_local" | "watcher";
      }
    | {
          status: "dirty";
          freshnessEpoch: number;
          reason: "exact_scan" | "watch_event" | "debounce_active";
      }
    | {
          status: "unverified";
          freshnessEpoch: number;
          reason: SourceFreshnessUnavailableReason;
      };

type PreparedReadObservation = {
    mutation: {
        generation: number;
        active: boolean;
    };
    vectorAuthority: string;
    navigationAuthority?: string;
    sourceFreshness: SourceFreshnessObservation;
};
```

Mutation-active and authority-unavailable outcomes are authority failures, not
source-freshness reasons. They should remain separate from the bounded source
reason vocabulary.

A prepared read should carry immutable evidence for the request:

```ts
type PreparedRead = {
    canonicalRoot: string;
    vectorReceipt: ProvenVectorGenerationReceipt;
    navigationReceipt?: ProvenGenerationReceipt;
    observation: PreparedReadObservation;
};
```

The final types should reuse existing receipts rather than duplicate their
fields.

## Implementation phases

### Phase 1: Instrument and establish watcher truth

Add bounded diagnostics before changing reuse behavior.

#### Watcher lifecycle

Replace map membership as watcher health with explicit per-root state:

```text
starting -> ready -> failed | stopped
```

- Store `starting` when Chokidar construction succeeds.
- Transition to `ready` only after Chokidar emits `ready`.
- Transition to `failed` on an error that removes or invalidates the watcher.
- Transition to `stopped` before unwatch or watcher-mode shutdown completes.
- Only `ready` may preserve an already-established source-freshness baseline
  across requests.
- A watcher becoming `ready` without a baseline remains `unverified` until an
  exact scan or successful sync seeds one.
- Every transition out of `ready` must bump or invalidate the root freshness
  observation before watcher ownership is released.
- Restart starts with no watcher-backed evidence.

Do not infer health only from configuration, manager startup or the presence of
an `FSWatcher` object.

#### Diagnostics

Expose through `debugMode="full"`:

- First deterministic prepared-observation failure reason.
- Watcher configured state.
- Watcher manager state.
- Root registration state.
- Watcher lifecycle state.
- Last bounded watcher error classification, without unbounded stack output.
- Source-checkpoint observation status.

Retain or add operation counters for:

- `coldReadinessChecks`.
- `postFreshnessColdChecks`.
- `warmReceiptRevalidations`.
- `exactPayloadRecounts`.
- `completionMarkerQueries`.
- `listCollectionsCalls`.
- `registryLoads`.
- `navigationValidationRuns`.
- `embeddingCalls`.
- `vectorQueries`.
- `rerankCalls`.

Add source labels only where needed to explain duplicate work, for example
`initial_cold_proof`, `post_freshness_proof`, `warm_revalidation` and
`proof_expiry_audit`.

#### Phase 1 stop gate

Run the exact identifier diagnostic once. Record the actual unavailable reason
and watcher state. Do not choose a watcher repair based only on the previous
absence of an inotify descriptor.

### Phase 2: Separate authority reuse from source observation

Refactor the current composite observation so watcher or checkpoint failure can
degrade source freshness without deleting otherwise valid vector evidence.

Required behavior:

- A missing or failed watcher makes cross-request source freshness `unverified`.
- A successful exact request-local scan may still return `fresh` for that
  request.
- A missing or corrupt checkpoint uses the existing
  `SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE` warning and keeps incremental sync
  disabled.
- Vector search remains available when vector authority revalidates.
- Navigation remains independently gated by navigation authority.
- Watcher or checkpoint unavailability by itself does not request a payload
  recount.

When vector authority is valid but watcher evidence is unavailable and no exact
request-local scan established freshness, return a deterministic degraded,
non-blocking warning. The existing checkpoint warning remains specific to a
missing or corrupt checkpoint. Because the current warning set has no accurate
generic watcher-unavailable meaning, add one bounded code such as
`SOURCE_FRESHNESS_UNVERIFIED`; do not reuse a message that falsely claims the
checkpoint is missing or the worktree is known dirty.

The cache may retain and warm-revalidate vector authority while projecting
source freshness as `unverified`. It may not project watcher-backed `fresh`
across requests unless the watcher is `ready` and all checkpoint observations
still agree.

### Phase 3: Reuse the initial proof within one request

Pass the initial prepared read into freshness orchestration. After freshness,
compare the exact mutation and authority observations captured before and after
the decision.

Conceptual flow:

```ts
const initialPreparedRead =
    cachedPreparedRead ?? await coordinator.prepare(root, requirement);

const freshnessDecision = await syncManager.ensureFreshness(root, {
    preparedRead: initialPreparedRead,
});

const finalPreparedRead = freshnessChangedAuthority(
    initialPreparedRead,
    freshnessDecision,
)
    ? await coordinator.prepare(root, requirement, { forceRefresh: true })
    : coordinator.revalidateRequestLocal(initialPreparedRead);
```

Reuse must be based on evidence, not only on a freshness mode string.

A second cold proof is required when:

- Sync committed.
- Ignore reconciliation committed.
- A mutation lease was acquired after receipt creation.
- Mutation generation changed.
- Marker, policy or vector authority observation changed.
- Required navigation evidence changed.
- The source operation reports an ambiguous or contradictory state.

The initial proof may be reused for:

- `skipped_recent` with unchanged authority evidence.
- A completed no-change freshness scan.
- Watcher unavailability without mutation, while source freshness becomes
  `unverified`.
- Source-checkpoint unavailability without mutation, with the existing warning.
- Any other freshness inspection that proves it made no authority mutation.

If only the navigation observation changes, keep the valid vector receipt and
reprove navigation only when the requested capability requires it.

#### Phase 3 benchmark gate

Rerun exact and semantic diagnostics before adding another cache or coordinator.

For the first healthy request after a cold proof:

```text
coldReadinessChecks <= 1
postFreshnessColdChecks = 0
exactPayloadRecounts <= 1
```

For an ordinary subsequent warm request within proof age:

```text
coldReadinessChecks = 0
postFreshnessColdChecks = 0
warmReceiptRevalidations = 1
exactPayloadRecounts = 0
listCollectionsCalls = 0
completionMarkerQueries <= 1
```

If these results meet the search targets, do not redesign warm vector proof.

### Phase 4: Put navigation tools on the shared prepared-read path

Create or extract one MCP-owned prepared-read coordinator only to the extent
needed to remove duplicate readiness entry points. It accepts a requirement:

```ts
type ReadRequirement = "vector" | "navigation" | "vector_and_navigation";
```

The selector controls required evidence; it does not change the shape or
meaning of the evidence.

Route through it:

- `search_codebase`.
- `file_outline`.
- `call_graph`.
- `read_file` when `open_symbol` contains an exact symbol identity.

For navigation requests:

1. Prove or warm-revalidate vector authority.
2. Prove or warm-revalidate navigation authority.
3. Reuse the generation-bound registry when its complete identity matches.
4. Execute against the immutable prepared receipt.

Navigation reuse identity must include or validate:

- Canonical root.
- Collection name.
- Marker run ID.
- Policy document digest and policy hash.
- Navigation generation ID.
- Navigation seal hash.
- Required manifest hashes.
- Current navigation observation token.
- Mutation generation.

Do not reload the registry or rerun full navigation validation when all evidence
is unchanged. Do not reuse navigation evidence across policy, marker, seal,
manifest, observation or mutation changes.

Any new persistent in-memory registry/validation cache must have explicit bounds
and must be evicted on clear, reindex, sync mutation, unwatch, failure and
shutdown. Prefer reusing an existing bounded owner over creating a new map.

#### Phase 4 benchmark gate

Rerun outline, call-graph and symbol-open samples. Stop navigation optimization
when the targets and safety counters pass.

### Phase 5: Conditional per-root single-flight

This phase is not mandatory. Implement it only if the concurrent benchmark
still proves duplicate cold proof, marker query or registry-validation work.

Cold proof cannot initially be keyed by collection and marker because those
fields may be unknown before discovery. Use two stages:

1. Discovery single-flight keyed by canonical root, mutation generation and
   requirement.
2. Authority-specific work keyed by the complete receipt identity after
   discovery.

An authority-specific key should include:

- Canonical root.
- Collection name.
- Marker run ID.
- Policy digest/hash where relevant.
- Mutation generation.
- Requirement.
- Navigation generation and seal for navigation work.

Rules:

- A request under a new mutation generation cannot join old work.
- Every caller revalidates the returned receipt against its current observation.
- Failed promises are removed immediately.
- No rejected promise is retained as a cache entry.
- Pending maps are bounded by their active work and cleared on shutdown.
- Single-flight shares work; it does not extend receipt lifetime.

### Phase 6: Final validation and benchmark

Run the final relevant diff through the dependency-ordered validation below.
Update the benchmark record with the exact revision, environment, arguments,
samples, counters and response bytes.

Remove temporary comparison flags or dual-path code. Keep bounded counters and
reason enums that are useful for future diagnosis.

## Execution-path requirements

### Exact identifier

A definitive validated registry hit should execute:

```text
prepared-read revalidation
-> exact registry lookup
-> response construction
```

It must not call embedding, vector retrieval or reranking.

### Structural discovery

File, symbol and architecture-like queries may use:

```text
registry or lexical discovery
-> confidence check
-> optional semantic fallback
```

Do not force semantic fallback when exact or lexical evidence is definitive.

### Semantic search

Conceptual queries may use:

```text
query embedding
-> vector retrieval
-> optional reranking
```

Provider optimization is outside this implementation unless the final readiness
benchmark proves a remaining Satori-owned regression.

## Operation classification

Before changing Core proof behavior, classify every remote operation on the
affected path:

| Operation | Publication | Recovery | Cold proof | Ordinary warm revalidation | Proof-expiry audit | Explicit repair/integrity |
|---|---:|---:|---:|---:|---:|---:|
| Completion-marker query | Yes | Yes | Yes | At most one | Yes | Yes |
| Exact payload count | Yes | Yes | Yes | No | Yes | Yes |
| `listCollections` | Only if currently required | Possibly | Avoid when authority names collection | No | Avoid | Allowed when command requires enumeration |
| `hasCollection` | As currently required | Yes | Yes | Retain until marker-query absence semantics are proven | Yes | Yes |
| Policy retrieval/validation | Yes | Yes | Yes | Reuse bound local authority when unchanged | Yes | Yes |
| Full navigation validation | Yes | Yes | Required for navigation | Reuse when complete identity is unchanged | As required | Yes |

The plan does not authorize removing a publication or recovery check merely
because it is expensive on the read path.

## Primary implementation ownership

Expected files and responsibilities are:

| File | Intended responsibility |
|---|---|
| `packages/mcp/src/core/sync.ts` | Watcher lifecycle, source-freshness observations and freshness decision evidence |
| `packages/mcp/src/core/handlers.ts` | Prepared-read cache integration, counters and shared coordinator host wiring |
| `packages/mcp/src/core/search-frontdoor.ts` | Same-request initial proof reuse across freshness |
| `packages/mcp/src/core/search-types.ts` | Bounded debug contracts and counter fields |
| `packages/mcp/src/core/prepared-read-cache.ts` | Retain existing bounds and proof-age behavior; only change if the separated observation contract requires it |
| `packages/mcp/src/core/tracked-root-readiness.ts` | Cold proof receipt production and operation accounting |
| `packages/mcp/src/core/navigation-handlers.ts` | Shared prepared-read use for outline and call graph |
| `packages/mcp/src/tools/read_file.ts` | Shared prepared-read use for the nested `open_symbol` path |
| `packages/mcp/src/core/search-response-helpers.ts` | Reuse existing source-freshness warnings without duplicate meanings |
| `packages/core/src/core/context.ts` | Preserve warm authority revalidation and expose only bounded proof evidence needed by MCP |
| `packages/mcp/src/server/provider-runtime.ts` | Start and roll back provider-owned sync lifecycle only for embedding-capable MCP contexts |
| `packages/mcp/src/server/start-server.ts` | Select MCP versus CLI provider lifecycle behavior without changing the public tool surface |

Core must remain independent of MCP-owned mutation lease and request
orchestration. MCP acquires and observes leases; Core validates the receipts and
authority evidence passed through its existing boundary.

## Required tests

### Observation and watcher lifecycle

1. `starting` watcher state cannot establish cross-request freshness.
2. Chokidar `ready` preserves watcher-backed observation only after checkpoint
   and authority evidence agree and an exact scan or successful sync established
   the baseline.
3. Chokidar `ready` without a source baseline remains `unverified`.
4. Watcher error changes state and invalidates freshness before the next read.
5. Unwatch and shutdown invalidate state before ownership is released.
6. Restart begins without watcher-backed evidence or an assumed fresh baseline.
7. Each unavailable reason is deterministic and exposed only in the intended
   diagnostic projection.

### Same-request receipt reuse

1. `skipped_recent` with unchanged evidence reuses the initial receipt.
2. A no-change exact freshness result reuses the initial receipt.
3. Watcher unavailable preserves vector authority and reports source freshness
   as `unverified` unless an exact request-local check established `fresh`.
4. Source checkpoint unavailable preserves vector use and emits the existing
   warning.
5. Sync completion forces a new authority proof.
6. Ignore reconciliation forces a new authority proof.
7. Lease acquisition after receipt creation invalidates the receipt even if the
   lease is later released.
8. Mutation-generation change invalidates the receipt.
9. Marker, policy digest or vector authority change invalidates the receipt.
10. Navigation-only change preserves vector evidence but invalidates navigation
    evidence.

### Ordinary warm-read counters

Healthy warm exact search within proof age:

```text
coldReadinessChecks = 0
postFreshnessColdChecks = 0
warmReceiptRevalidations = 1
exactPayloadRecounts = 0
listCollectionsCalls = 0
completionMarkerQueries <= 1
embeddingCalls = 0
vectorQueries = 0
rerankCalls = 0
```

Healthy warm semantic search within proof age:

```text
coldReadinessChecks = 0
postFreshnessColdChecks = 0
warmReceiptRevalidations = 1
exactPayloadRecounts = 0
listCollectionsCalls = 0
completionMarkerQueries <= 1
embeddingCalls <= 1
vectorQueries <= 1
rerankCalls <= 1
```

Healthy warm outline with unchanged generation and seal:

```text
coldReadinessChecks = 0
exactPayloadRecounts = 0
listCollectionsCalls = 0
registryLoads = 0
navigationValidationRuns = 0
```

### Periodic audit

1. Receipt proof expiry causes a cold/full authority proof.
2. The audit may perform one exact payload recount.
3. The audit is labelled `proof_expiry_audit`, not reported as an ordinary warm
   regression.
4. A failed audit does not retain the expired receipt.

### Remote drift

1. Collection deletion fails safely through collection/marker proof.
2. Completion-marker deletion fails safely.
3. Marker mismatch cannot fall back to cached authority.
4. Count drift is detected during a full proof or scheduled audit.
5. Tests and documentation do not claim detection of same-cardinality external
   payload replacement with an intact marker.

### Navigation paths

1. Repeated outlines reuse a valid navigation receipt and registry.
2. Repeated call graphs reuse the same generation-bound navigation proof.
3. `read_file(open_symbol)` uses the same navigation preparation path.
4. Marker-run, policy, seal, manifest or observation change prevents reuse.
5. Vector-only `not_bound` behavior remains unchanged.
6. Missing or corrupt navigation retains the existing deterministic degraded or
   reindex result.

### Conditional concurrency tests

Run these only if Phase 5 is implemented:

1. Two simultaneous cold searches share one discovery proof.
2. Two simultaneous warm revalidations share one marker query.
3. Two simultaneous outlines share one registry load/validation.
4. A mutation-generation change prevents joining old work.
5. A failed flight does not poison the next request.

### Public compatibility

1. The six-tool registry is unchanged.
2. `read_file.open_symbol` request validation remains compatible.
3. Default response payloads do not gain unbounded diagnostics.
4. Existing `debug: true` remains an alias for full diagnostics.
5. The new generic source-freshness warning, if required, is bounded,
   non-blocking, documented and contract-tested; existing warning meanings and
   response envelope versions remain unchanged.

Likely focused suites include:

- `packages/mcp/src/core/sync.test.ts`.
- `packages/mcp/src/core/handlers.watchers.test.ts`.
- `packages/mcp/src/core/search-frontdoor.test.ts`.
- `packages/mcp/src/core/prepared-read-cache.test.ts`.
- `packages/mcp/src/core/tracked-root-readiness.test.ts`.
- `packages/mcp/src/core/handlers.scope.test.ts`.
- `packages/mcp/src/core/handlers.file_outline.test.ts`.
- `packages/mcp/src/core/handlers.call_graph.test.ts`.
- The focused `read_file` tool tests covering `open_symbol`.
- `packages/core/src/core/context.test.ts` only when the Core proof contract
  changes.

## Reproducible benchmark procedure

Use the same absolute root and workload arguments as the baseline record. Before
measurement:

1. Build the final relevant diff.
2. Restart the MCP runtime so startup and watcher state are real.
3. Run `manage_index status` with full diagnostics.
4. Reindex only if authority requires it.
5. Run one explicit no-change sync and wait for lease release.
6. Confirm the source checkpoint is valid.
7. Warm the exact, semantic and outline paths once; do not count a sample that
   performed sync or scheduled proof-expiry audit as an ordinary warm sample.

### Exact identifier

```json
{
  "path": "/home/hamza/repo/satori",
  "query": "runExactRegistryFastPath",
  "scope": "runtime",
  "resultMode": "grouped",
  "groupBy": "symbol",
  "limit": 5,
  "debugMode": "full"
}
```

### Semantic discovery

```json
{
  "path": "/home/hamza/repo/satori",
  "query": "where is search code behavior handled",
  "scope": "runtime",
  "resultMode": "grouped",
  "groupBy": "symbol",
  "limit": 5,
  "debugMode": "full"
}
```

### Exact outline

```json
{
  "path": "/home/hamza/repo/satori",
  "file": "packages/mcp/src/core/handlers.ts",
  "resolveMode": "exact",
  "symbolLabelExact": "method handleSearchCode",
  "limitSymbols": 20
}
```

Run and record:

- At least three ordinary warm exact samples.
- At least three ordinary warm semantic samples.
- At least three ordinary warm outline samples.
- One concurrent exact-search sample.
- One watcher-unavailable sample.
- One source-checkpoint-unavailable sample.
- One mutation-during-read sample.
- One proof-expiry audit sample using a controlled clock or focused harness.

For every sample record:

- Client wall time around `callTool`.
- Internal non-overlapping phase timings.
- Readiness operation counters.
- Provider call counts.
- Remote vector-database call counts.
- Source-observation reason and watcher state.
- Single-flight hit/miss only if Phase 5 exists.
- UTF-8 response bytes.
- Whether the sample was ordinary warm, cold, freshness-mutating or audit.

With three samples, report median and range only. Do not report p95 or make a
percentile claim. If a controlled run uses at least 20 samples, percentile
reporting may be added with the exact sample contract.

## Performance targets

### Exact identifier

- Ordinary warm median below 1 second.
- No embedding, vector query or rerank.
- No exact payload recount.
- No `listCollections`.
- At most one completion-marker query.

### Exact outline

- Ordinary warm median below 1 second.
- No exact payload recount.
- No registry reload or full navigation validation when generation and seal are
  unchanged.

### Semantic search

- No repeated same-request cold readiness proof.
- Initial target approximately 2.5-4 seconds.
- Provider latency above 1 second does not alone block this stabilization.

Sub-second semantic search is not required.

## Validation dependency graph

During iteration, run only the smallest affected suite. On the final relevant
diff:

1. Run focused watcher, front-door, prepared-cache and navigation tests.
2. Run the MCP package suite because the request orchestration and public tool
   boundary changed.
3. Run the Core package suite only if Core receipt/revalidation behavior changed.
4. Run CLI tests only if an adapter, status projection or shared contract used by
   CLI changed.
5. Run integration tests covering live MCP search/navigation and mutation
   fencing.
6. Run `pnpm run typecheck` and `pnpm run check` or the repository's canonical
   equivalent once against the final diff.
7. Run `git diff --check`.
8. Restart and execute the live benchmark.

After a failure, rerun the failed gate and only the downstream gates invalidated
by its fix.

## Completion criteria

The project is complete when all applicable conditions are proven:

1. Same-request no-mutation freshness does not trigger a second cold proof.
2. Ordinary healthy warm reads perform zero exact payload recounts and zero
   collection enumeration.
3. Scheduled proof-expiry auditing remains intact and separately identified.
4. Watcher unavailability degrades source freshness without invalidating proven
   vector authority.
5. Watcher-backed reuse begins only after the watcher is truly ready.
6. `file_outline`, `call_graph` and `read_file(open_symbol)` use shared prepared
   evidence.
7. Registry and navigation validation are reused only under identical complete
   authority evidence.
8. Mutation fencing tests pass.
9. Collection/marker deletion and marker mismatch fail safely.
10. Exact identifier search performs no semantic-provider calls.
11. Applicable package, integration, type, build and static checks pass.
12. The live benchmark shows substantial exact and outline latency reduction and
    records the required counters.

Do not claim detection of external mutations outside the supported drift
contract.

## Conditional and deferred work

The following work is permitted only after the readiness benchmark is rerun and
a concrete remaining cost is measured:

- Per-root single-flight.
- Removing warm `hasCollection` in favor of marker-query-only absence detection.
- Query-embedding cache keyed by normalized query, model and dimension.
- Search-result cache keyed by query and exact authority generation.
- Adaptive rerank candidate count.
- Rerank skipping on a strong score margin.
- Persistent provider clients or connection reuse.

Record these as deferred when targets already pass. Do not implement them for
completeness.

## Non-goals

Do not:

- Add persisted authority or cache documents.
- Add a schema version.
- Redesign markers, policies or source checkpoints.
- Change the public tool list, request schemas or envelope versions.
- Replace the watcher library without a demonstrated library-level defect.
- Add distributed caching.
- Add broad TTL-only readiness caching.
- Remove mutation fencing or remote marker verification.
- Redesign ranking, embedding, reranking or the vector database.
- Optimize indexing throughput.
- Review or fix unrelated repository defects.

## Hard stop

Benchmark after Phases 3 and 4. If the completion criteria pass, stop. Do not
continue into conditional single-flight, provider tuning, new caching
architecture, indexing optimization or unrelated hardening.

## Final implementation report

The implementation handoff must report:

### Verdict

- `LATENCY STABILIZATION COMPLETE`, or
- `LATENCY STABILIZATION BLOCKED`.

### Changes

List behavioral changes and modified files.

### Safety evidence

Report the exact mutation, authority, source-freshness and navigation tests run.

### Performance evidence

Report before/after exact, semantic and outline measurements with sample counts,
median, range and sample classification.

### Required counters

Report the final ordinary warm counters and the separate proof-expiry audit
counters.

### Remaining limitations

State provider latency, unsupported external-tampering cases and any unverified
environmental condition plainly.

### Deferred work

List only measured, non-blocking future optimization opportunities.

Do not claim completion unless the applicable tests, checks, restart and live
benchmark were actually run.
