# Operational Trust Product Plan

Status: P0 operational trust is complete. The mutation-safe fixtures, current-source navigation hardening, language-capability evidence, workflow documentation, privacy-safe local diagnostics, and parser modernization are implemented. One active task remains: record a clean useful-context baseline and set regression budgets after rebuilding a searchable index with the new parser fingerprint. Embedded zvec storage is intentionally deferred and requires explicit user approval before implementation.

## Capability

Satori must remain deterministic when several MCP clients use the same repository. Multiple processes may read a proven index, but exactly one process may mutate a canonical repository root at a time. Every mutation must have a durable identity, an observable state, explicit proof, and a mechanically correct recovery action after refusal, timeout, or crash.

This positions Satori as a trust and evidence layer for coding agents rather than another semantic-search server.

## Original Baseline

Before the P0 work, the implementation had useful pieces, but their ownership boundaries did not provide end-to-end mutation exclusion:

- `SnapshotManager` uses a cross-process file lock while loading and saving the shared snapshot.
- `SyncManager.activeSyncs` coalesces sync requests inside one process only.
- The runtime-owner registry blocks mutations when live runtimes have conflicting package versions, fingerprints, or normalized configuration identities.
- Create and reindex return a kickoff response and continue in `startBackgroundIndexing`.
- Repair checks collection selection, fingerprint provenance, missing expected chunks, and unexpected remote chunks, but reports most proof as prose.
- `manage_index status` reports lifecycle state, observed symbol quality, fingerprint evidence, and live runtime owners.
- The language capability registry already separates public claims such as `search_only`, `symbol_only`, and `calls_v0` from observed symbol-quality evidence.
- The CLI already has a bounded stdio MCP client capable of initialization, `tools/list`, and tool calls.

That missing invariant was a lease held across the complete mutation, including remote writes and the final durable local transition. The implementation status below records how P0 closed the gap.

## Implementation Status

The mutation-ownership, durable-receipt, repair-evidence, and verified-installation P0 slices are implemented and regression-tested:

- A machine-local `MutationLeaseCoordinator` persists one fenced generation and optional active lease per canonical root.
- Lease takeover requires a dead PID or process-start mismatch; elapsed wall-clock time alone is not eviction proof.
- When process-start evidence is unavailable, a live PID is treated as the owner (fail-closed). That is deliberate writer safety; PID reuse can block operators until the listed PID exits. Lease age is diagnostic only and is never eviction authority.
- One coordinator instance is shared across local and provider-backed runtimes.
- Create/reindex transfers its lease into background indexing and releases it only after a terminal path.
- Repair, clear, manual sync, periodic sync, watcher sync, search-on-read sync, ignore reconciliation, missing-root cleanup, and startup interrupted-index recovery enter through the same ownership mechanism.
- Explicit Zilliz eviction holds both the create target lease and the proven mapped-root lease; deletion is refused when collection ownership cannot be proven.
- Stale-index recovery is fenced by the current mutation lease. Wall-clock grace applies only before exclusive ownership is proven; exclusive lease holders (create/reindex/repair/clear/startup) supersede abandoned `indexing` rows immediately. Read readiness no longer clears snapshot or watcher state when a collection probe reports missing.
- Startup recovery acquires a mutation lease per root, skips roots with a live writer, and reuses the fenced recovery helper rather than writing lifecycle state without a lease.
- `manage_index status` exposes a live `hints.activeMutation` record. It does not report an expiry because ownership is based on process liveness, not elapsed lease age.
- Lost generations refuse stale background terminal publication.
- The durable-transition audit fences vector inserts and deletes, completion-marker publication, symbol and relationship sidecars, SQLite navigation publication, call-graph publication (including fenced snapshot commit with in-memory sidecar rollback on fence failure), Merkle checkpoint commits, snapshot lifecycle publication, and staged-failure cleanup. Failed reindex publication restores captured policy and navigation-pointer bytes rather than reconstructing legacy authority through the forward seal-required publisher; a candidate-authority compare-and-swap rejects stale workers, while an fsynced restoration journal makes the cross-directory policy/pointer swap recoverable after process interruption.
- Snapshot v3 persists the latest operation receipt independently from lifecycle entries, including completed clear receipts.
- Create, reindex, sync, repair, clear, stale recovery, and cross-root eviction publish receipts through the same transactional snapshot commit.
- Receipt commits roll back in-memory receipt and lifecycle mutations when persistence fails, reject stale local or disk authority, and return only the post-save authoritative receipt.
- The final snapshot publication rechecks the mutation lease while the snapshot lock is held.
- `manage_index` mutation responses and status expose the same optional receipt without changing the version 1 envelope or six-tool surface.
- Generated MCP documentation is sourced from the runtime tool description and checked for drift.
- Repair preserves partial proof after evidence collection begins, distinguishes malformed from missing markers, reserves create for no related collection, and routes every existing untrusted or incomplete generation to reindex.
- Successful repair rebuilds navigation and may write a fresh completion marker without re-embedding or rewriting source chunks.
- Non-dry-run install now emits an additive postflight receipt after proving the exact managed launcher and client wiring, MCP initialization/version, canonical six-tool order, runtime-owner registration, and bounded child/owner cleanup.
- Postflight uses a dedicated non-mutating MCP run mode. It skips recovery, watchers, background sync, lifecycle tools, search, and provider-backed work; incomplete static provider/backend configuration is warning-only, while wiring or runtime proof failure returns a non-zero install exit without rolling back installed artifacts.
- Managed launchers retain the five-second signal grace for cooperative cleanup. They proxy stdin, trigger graceful MCP shutdown and owner unregister on EOF, and use a separate 1.5-second EOF fallback to reap non-cooperative children inside the MCP SDK shutdown window.
- Doctor now compares live owner versions and stable identities with the installed runtime, uses process-start evidence when available, reports lease state without age expiry or mutation, validates the managed launcher target/version, and reuses installer-owned parsers to verify configured Codex, Claude, and OpenCode entries.

Verified installation and expanded doctor diagnostics are implemented. Residual P0 fencing gaps for startup recovery, exclusive-lease supersede of abandoned indexing, repair recovery entry, and call-graph commit fencing are closed in the same ownership model.

## Remaining Roadmap

One active task remains after the operational-trust implementation:

1. Record a clean, searchable useful-context baseline and set numeric regression budgets.

One product decision is explicitly deferred and is not active implementation work: do not implement zvec unless the user approves reopening it.

## Fixed Boundaries

- Keep the six public MCP tools unchanged.
- Keep the MCP surface read-only with respect to source files.
- Keep lifecycle actions under `manage_index`.
- Scope the first ownership implementation to processes on one machine sharing `~/.satori` state.
- Treat hosted or multi-host coordination as a later capability requiring backend compare-and-swap or a distributed lease.
- Preserve current behavior that blocks search and navigation while lifecycle state is `indexing`.
- Preserve runtime scope semantics: tests remain eligible but are deterministically demoted unless the query expresses test intent.
- Do not add a public concise-response mode or another retrieval knob without an explicit contract change. Establish payload budgets and remove redundant default output first.
- Do not run provider-backed create or reindex as an installation side effect.
- Do not collect source, query text, paths, or symbol names in product diagnostics by default.

## Verified Navigation And Retrieval Findings

- Exact navigation now has one current-source span authority for TypeScript, JavaScript, Python, Go, Rust, Java, C#, C++, and Scala. It reparses bounded current source through the same language-analysis contract as indexing and fails closed when structural evidence is unavailable, ambiguous, oversized, or stale.
- `read_file(open_symbol)` already resolves one exact symbol and reads only the resolved span. Adjacent functions in its output are therefore evidence of a stale or incorrect registry span, not a separate read-window defect.
- Dirty-worktree recovery uses a bounded current-source structural and lexical overlay. Stale indexed candidates from dirty paths are suppressed; unavailable replacement evidence is reported explicitly instead of silently omitting the file.
- The exact-identifier registry fast path already bypasses semantic search and reranking for an unambiguous match. Work should benchmark and optimize that path rather than reimplement it.
- Runtime scope intentionally includes tests and demotes them unless the query expresses test intent. The runtime contract remains unchanged; stale external guidance that says runtime excludes tests is not authoritative.
- Grouped responses duplicate navigation and recommendation data across top-level actions, results, fallbacks, capabilities, spans, and previews. This is a payload-budget problem first; it does not justify a new public mode by itself.
- The supported workflow remains hybrid: use Satori for freshness-aware behavioral-owner discovery and deterministic symbol navigation, then use bounded native exact reads when ownership and path are already known.

## P0: Mutation Ownership

### Invariant

For one canonical repository root, no two live processes may concurrently execute create, reindex, sync, repair, clear, or mutation-bearing missing-root cleanup. Different roots may mutate concurrently.

### Lease Identity

Each accepted mutation owns a record containing:

```ts
interface RootMutationLease {
    canonicalRoot: string;
    generation: number;
    operationId: string;
    action: "create" | "reindex" | "sync" | "repair" | "clear";
    ownerId: string;
    pid: number;
    processStartTime?: string;
    acquiredAt: string;
}
```

The canonical root is the real repository path. The on-disk lease name uses a stable hash so repository paths are not used as filenames.

### Acquisition Rules

1. Validate and canonicalize the root before any remote mutation or local indexing-state transition.
2. Create the lease atomically with exclusive file creation.
3. Allocate a monotonically increasing per-root generation.
4. If a lease exists, prove owner liveness with PID and process-start identity.
5. Never steal a lease solely because a wall-clock expiry elapsed.
6. A dead or PID-reused owner may be replaced; replacement increments the generation.
7. Release only when owner identity and generation still match the current record.
8. A competing mutation returns a deterministic blocked response instead of waiting indefinitely.
9. When process-start evidence is missing, a live PID is fail-closed treated as the owner (operator may need to stop the PID).

`acquiredAt` is diagnostic metadata only. It is not authority to evict a live owner.

### Lease Scope

- Create/reindex: acquire before collection pruning, collection-limit validation, snapshot `indexing`, or background kickoff; transfer the lease into background indexing; release after the terminal snapshot transition.
- Sync: acquire before `Context.reindexByChange`; cover manual sync, periodic sync, watcher sync, ignore reconciliation, and search-on-read freshness.
- Repair: cover proof queries, navigation rebuild, completion-marker write, and snapshot commit.
- Clear: cover remote deletion, completion-marker cleanup, navigation cleanup, tombstone commit, and watcher removal.
- Missing-root cleanup: cover remote clear and snapshot removal.
- Cross-root Zilliz eviction: prove the collection-to-root mapping, hold the target create lease and mapped-root clear lease through remote deletion and local cleanup, and fail closed when ownership is unknown.
- Readiness and status: collection probes may report degraded readiness but may not clear shared state; interrupted-index recovery must acquire or inherit a fenced lease before publishing a terminal state.

The runtime-owner identity gate remains separate. It answers whether live runtimes agree on configuration; the mutation lease answers who may write this root now.

### Blocked Response

Use `status=blocked` and `reason=mutation_in_progress`. Include `hints.activeMutation` and a `manage_index status` hint. Status exposes the same live lease evidence. Do not invent an expiry or instruct callers to retry create or sync in a loop.

### Proof

Required deterministic tests:

- symlink aliases resolve to the same lease;
- two processes contend for one root and only one acquires;
- two different roots acquire concurrently;
- a live owner is never evicted by age alone;
- a dead owner can be replaced;
- PID reuse is rejected through process-start evidence;
- an old owner cannot release a replacement lease;
- create/reindex holds ownership after the kickoff response;
- manual sync and search-on-read sync contend through the same lease;
- clear, repair, and sync cannot overlap create/reindex;
- a crashed writer cannot publish a terminal transition under an older generation.

## P0: Durable Operation Receipts

### Public Contract

Add one optional object to the existing `ManageIndexResponseEnvelope`:

```ts
interface ManageIndexOperationReceipt {
    id: string;
    action: "create" | "reindex" | "sync" | "repair" | "clear";
    canonicalRoot: string;
    generation: number;
    acceptedAt: string;
    phase: "accepted" | "preflight" | "scanning" | "writing" | "proving" | "publishing" | "completed" | "failed" | "blocked";
    lastDurableTransitionAt: string;
    runtimeFingerprint: IndexFingerprint;
    writer: {
        ownerId: string;
        pid: number;
        satoriVersion: string;
    };
}
```

Create, reindex, sync, repair, and clear responses return the receipt when an operation exists. Status returns the same latest receipt after process restart.

### State Ownership

Persist the latest receipt in the snapshot v3 `latestOperations` map, keyed by canonical root. Do not create a second operation database or couple receipt survival to the lifecycle entry: a completed clear receipt must remain observable after the lifecycle entry is removed. Snapshot merge must prefer the higher operation generation before comparing lifecycle timestamps, so a stale process cannot overwrite a newer receipt.

Only durable transitions update `lastDurableTransitionAt`. Transient progress may be displayed separately but must not be labeled durable.

No operation history, operation lookup parameter, cancellation API, or server push is included in this phase. Explicit `manage_index status` remains the observation mechanism.

The envelope `action` is always the requested action. For a status response it is therefore `status`, while `operation.action` identifies the latest mutation (`create`, `reindex`, `sync`, `repair`, or `clear`). `operation` is omitted when no durable operation exists, including contention rejected before lease acquisition. Terminality is represented only by `operation.phase` (`completed`, `failed`, or `blocked`).

### Transition Order

1. Acquire lease and generation.
2. Persist `accepted` receipt and the corresponding lifecycle state.
3. Perform local scan and remote work.
4. Validate or write completion proof.
5. Publish compatible navigation state.
6. Persist the terminal lifecycle state and terminal receipt.
7. Release the lease.

## P0: Repair Evidence

Repair must return structured evidence in addition to deterministic human text:

```ts
interface RepairProof {
    collection: ProofItem;
    snapshot: ProofItem;
    marker: ProofItem;
    fingerprint: ProofItem;
    payload: ProofItem;
    staleRemoteChunks: ProofItem;
    navigation: ProofItem;
}

interface ProofItem {
    status: "matched" | "failed" | "missing" | "unproven" | "not_checked";
    basis?: string;
    expectedCount?: number;
    observedCount?: number;
    missingCount?: number;
    extraCount?: number;
}
```

Snapshot fingerprint evidence may establish trusted provenance when the marker is missing, but it never proves remote payload equality.

Mechanically correct actions:

| Evidence failure | Action |
| --- | --- |
| No related collection | `create` |
| Fingerprint mismatch | `reindex` |
| Expected chunks missing | `reindex` |
| Unexpected remote chunks | `reindex` |
| Multiple staged generations | `reindex` |
| Exact equality cannot be proven | `reindex` |
| Backend unavailable | diagnose backend, then retry |
| All required evidence matches | repair local readiness |

Repair avoids re-embedding and rewriting source chunks, but it may write a fresh remote completion marker. Documentation and responses must use that precise wording.

## P0: Verified Installation

Default install postflight must be bounded and non-destructive:

1. Start the exact installed launcher.
2. Complete MCP initialization.
3. Verify the fixed six-tool list.
4. Verify managed client configuration points to that launcher.
5. Verify runtime-owner registration and installed package version.
6. Run static provider and vector configuration validation.
7. Terminate the verification child within the configured timeout.

Implemented postflight follows this sequence automatically after every non-dry-run install and returns an additive receipt. Static provider/backend gaps are warnings and keep exit status zero. Launcher/config/protocol/tool/owner/termination failures return a non-zero exit but preserve the completed installation and its receipt. No provider-backed lifecycle or search call is part of this proof.

Doctor diagnoses stale launchers, unmanaged config, conflicting runtime identities, active or abandoned mutation leases, unsupported providers, and incomplete backend configuration.

Implemented doctor diagnostics are read-only and use installer-owned client parsers. Runtime-owner and lease liveness prefer PID plus process-start evidence; elapsed wall-clock time never expires a lease. Missing installation is warning-level, while stale launcher targets, stale live runtime versions, conflicting stable identities, malformed leases, and stale configured client commands are errors.

A deep smoke check may explicitly create a bounded temporary fixture, search an exact token, open it with `read_file`, and verify cleanup. It is never automatic because it consumes embedding quota and creates remote state.

## P1: Useful Context Measurement

Create a committed evaluation corpus with expected behavioral owner, exact symbol, relevant callers, and language. Record:

- owner found in top three;
- exact-symbol open success;
- caller recovery success;
- zero-result and fallback rates;
- cold and warm p50/p95 latency;
- p50/p95 latency for the existing exact-identifier fast path;
- serialized response bytes by query class and result count;
- context bytes read before reaching the expected owner;
- current-source span correctness for exact symbol opens;
- dirty-file owner discovery before explicit synchronization;
- stale-index detection and recovery success.

Release gates initially prevent regression from a recorded baseline. Absolute targets should be set only after baseline measurement. The benchmark must include explicit latency and serialized-payload budgets before response-shape optimization begins.

Runtime diagnostics cannot infer whether a result was useful or an edit was correct. Those measures belong to the labeled evaluation harness or an explicit user signal.

Current implementation state:

- The offline grader validates exact six-tool setup/invocation payloads, language labels, paired cold/warm observations, owner-in-top-three, parser-bounded exact opens, graph-derived callers, UTF-8 payload bytes, context bytes, and optional regression limits.
- Exact-open success requires `status=ok`, exact owner identity, and exact parser-derived boundaries. Configured limit failures remain in the report and make the CLI exit non-zero.
- A deterministic recorder starts one fresh MCP runtime per task, verifies the canonical six-tool order, performs an unmeasured explicit incremental sync, proves its completed receipt through status, then records prepared-cold and warm calls in the same runtime. Prepared-cold means the workload has not run yet; protocol and freshness setup have run. Measured calls that cause or join sync, or change the operation generation, are rejected.
- Recording is bound to one canonical root, clean Git revision, normalized task-suite hash, MCP server version, Node platform, preparation sync statistics, and per-task completed operation generation/runtime fingerprint. Output paths inside the measured repository are rejected. The current status envelope does not separately expose the indexed fingerprint, so the completed compatibility-gated sync receipt is the available proof.
- The current corpus contains source-read-only repeatable owner-discovery, exact-identifier, and exact-open workloads. Preparation sync may update stale index chunks and advances durable receipts before timing. The corpus has no measured baseline or absolute budgets.
- Caller, dirty-file, and stale-recovery grading use a dedicated fixture runner with a fresh temporary Git root per task. The runner rejects template symlinks, traversal, and output inside the template checkout. Dirty-file setup uses an explicit same-runtime no-change sync because the freshness throttle is process-local; it does not pre-run the exact workload. Dirty searches must return the expected owner with `freshnessDecision.mode=skipped_recent`. Stale recovery requires `syncStats.modified >= 1`, a completed durable sync receipt, and recovered expected-owner evidence.
- Fixture cleanup calls `clear` before removing a temporary root. It retains the exact root when clear fails and reports primary, clear, and runtime-close failures without hiding the original cause.
- A real baseline is currently blocked until the recorder changes are committed and this repository has a searchable index. Restore readiness through proven repair or sync evidence where possible; do not use an expensive provider-backed reindex merely to produce benchmark data.

### Navigation Correctness Work

1. Replace the Python-specific runtime repair path with generic current-source span validation covering every symbol-capable language.
2. Require an exact open to match parser-derived current-source boundaries. Neighboring declarations are classified and tested as span-authority failures.
3. Add a bounded dirty-file AST and lexical overlay for semantic searches, with deterministic ranking above stale indexed content and explicit fallback behavior when parsing is unavailable.
4. Benchmark the existing exact-identifier fast path before changing its implementation.
5. Add latency and serialized-payload budgets to the retrieval evaluation harness.
6. Reduce redundant default response fields only after measuring their decision value and payload cost; do not add a public response-mode parameter in this work.

Runtime scope does not change as part of this work. Hybrid Satori discovery followed by bounded native exact lookup remains workflow guidance, not a new runtime feature.

Implementation state: TypeScript, JavaScript, Python, Go, Rust, Java, C#, C++, and Scala exact navigation now reparses current source and fails closed when the persisted symbol cannot be proven. Dirty overlay work is bounded to 16 files, 256 KiB per file, 2 MiB total, and 16 results; stale indexed candidates from dirty paths are suppressed. The public MCP input surface is unchanged.

## P1: Language Capability Evidence

Reuse the existing language capability declarations and combine them with observed index state:

- declared public claim;
- indexed file count;
- observed symbol coverage;
- compatible symbol-registry evidence;
- compatible relationship-sidecar evidence;
- effective semantic search, exact symbol, outline, and call-graph capability;
- deterministic degradation reason.

Status owns the per-root summary. Search results retain their existing per-result capability evidence. A compatible relationship sidecar with zero observed edges is distinct from an unsupported language.

Implementation state: `manage_index status` exposes the summary. Summary and diagnostics read the compact, digest-bound navigation seal and never fall back to the per-file registry manifest; capabilities/full may load the exact registry generation for language evidence. Relationship shards are still fully validated before reporting compatible call-graph evidence; this I/O is intentional fail-closed proof rather than a manifest-only capability claim.

## P1: One Local Stack

Do not select an embedded vector backend from roadmap prose. Candidate adapters must first prove:

- deterministic exact-ID queries;
- completion-marker support;
- exact payload equality checks;
- deletion and crash recovery;
- required dense or hybrid ranking behavior;
- acceptable cold-index and incremental-sync performance.

Support one embedded backend only after it passes the shared adapter contract. Avoid several partially supported local backends.

### zvec Qualification State

Decision: zvec implementation is intentionally deferred. Research notes may remain in this plan, but no zvec dependency, adapter, catalog, configuration, fingerprint, runtime, installer, doctor, packaging, or migration work may begin without new explicit user approval. Absence of Milvus configuration must not activate zvec implicitly.

Prior research identifies the Apache-2.0-licensed zvec project as the preferred offline vector-store candidate, but `@zvec/zvec` 0.5.0 is not acceptable as a supported backend. It proved in-process persistence, dense and full-text retrieval, local RRF hybrid search, exact-ID fetch, upsert, deletion, scalar filters, metadata round trips, read-only opens, reader/reader concurrency, and native Node 24 loading on WSL. zvec would replace Milvus only; a fully local stack would also use a local embedding provider such as Ollama and would not require VoyageAI, Gemini, OpenAI, a cloud reranker, or a vector-database server.

The 0.5.0 qualification found four release-blocking failures:

1. Full-text matches disappeared after close and reopen in a 3,000-document test. Dense data remained. The upstream core fix is merged in [zvec PR 566](https://github.com/alibaba/zvec/pull/566), but is not present in Node package 0.5.0.
2. A zero-match scalar filter correctly returned no scalar or dense results, while hybrid search returned forbidden documents. This is tracked in [zvec issue 583](https://github.com/alibaba/zvec/issues/583).
3. Reader/reader access worked, but reader/writer, writer/reader, and writer/writer combinations failed because readers use a shared collection lock and writers require the exclusive lock. This is tracked in [zvec issue 586](https://github.com/alibaba/zvec/issues/586). Bounded writable opens may shorten interruption but do not prove uninterrupted multi-reader behavior.
4. A successfully acknowledged upsert did not survive process termination for a read-only reopen. A writable reopen recovered it in memory, but close or optimize did not durably publish it; a later unrelated write made both records persist. That is incompatible with durable Satori operation receipts.

If the user later approves reopening implementation, work must begin only after a Node release contains the full-text restart and zero-match hybrid-filter fixes. The approved sequence would be shared adapter contract tests, a typed filter compiler, the adapter, backend-specific fingerprints and runtime selection, installer/doctor support, then an Ollama plus zvec lifecycle fixture. The adapter boundary remains `VectorDatabase`; it would use installer-owned storage below `~/.satori/vector/zvec/`, FP32 vectors, FTS over `content`, exact fetch for intrinsic-ID marker queries, read-only handles for bounded queries, writable handles only under the mutation lease, `finally`-closed handles, and close-plus-reopen verification as the durability boundary.

Required release gates are:

- full-text matches survive restart with at least 3,000 documents;
- zero-match filtered hybrid searches return zero results;
- every successfully acknowledged batch survives process termination without a later write;
- reader/writer contention is bounded and deterministic;
- supported Node 22, 24, and 26 targets pass on every supported platform;
- completion-marker, repair, deletion, retry, payload-equality, and fingerprint contract tests pass;
- cosine distance is normalized to Satori's higher-is-better score contract;
- backend-neutral filters are parsed and translated rather than forwarded as Milvus expressions;
- collection catalog, concurrent-open, event-loop blocking, installer, doctor, and packaging gates pass.

Milvus collections would not be reused when switching to zvec. Moving from a Milvus/Voyage index to zvec/Ollama changes both embedding and vector-backend fingerprints and therefore requires one full reindex. Performance benchmarking starts only after the correctness gates pass.

## P2: Workflow Documentation

- Replace `SATORI_FEATURES_AND_USE_CASES.md` with short workflows for install, first index, navigate, recover, and diagnose.
- Keep `SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` as the authoritative maintainer contract.
- Add agent workflows for understanding ownership, assessing blast radius, debugging a failure, and verifying another agent's edit.
- Generate tool schema/reference material from the existing contract sources.
- Delete duplicated feature prose rather than maintaining compatibility copies.

## P2: Privacy-Safe Diagnostics

Local diagnostics may aggregate durations, warning codes, returned `search_codebase` result counts, fallback use, lifecycle outcomes, and recovery success. Outline symbols, graph nodes or edges, listed roots, and read bytes must not be combined into that search-result metric. Diagnostics must not persist source, query text, paths, symbol names, or stable repository identifiers by default.

Implementation state: CLI-mediated calls record the closed public outcome vocabulary and doctor reports per-tool call counts, duration, errors, search-result-bearing calls, total search results, and zero-result searches. The local log retains at most 1,000 revalidated events, refuses symlinked paths, and publishes mode-`0600` replacements atomically behind a bounded interprocess lock. Malformed or extra fields are removed during compaction. Recording remains best-effort and non-authoritative.

Any upload mechanism requires explicit consent, a versioned schema, documented retention, and a local preview of the exact payload.

## Delivery Sequence

1. Completed: root mutation lease with subprocess contention tests.
2. Completed: every mutation entry path uses the lease and generation-checked terminal commits.
3. Completed: latest operation receipts are persisted and exposed.
4. Completed: structured repair proof and deterministic next actions.
5. Completed: installer postflight verification and expanded doctor checks.
6. In progress: retrieval grader, corpus scaffold, and deterministic recorder implemented; measured baseline and absolute budgets remain blocked on a clean committed revision and searchable index.
7. Completed: mutation-safe caller, dirty-file, and stale-recovery fixtures use disposable indexed roots and clear them before deletion.
8. Completed: generic current-source span validation and bounded dirty-file AST/lexical overlay.
9. Completed: declared plus observed language-capability evidence is exposed by `manage_index status`.
10. Intentionally deferred: zvec passed basic local persistence/retrieval research, but no implementation is approved. Reopening adapter, concurrency, crash, score, filter, Node-platform, installer, or packaging work requires explicit user approval.
11. Completed: workflow-oriented documentation plus privacy-safe local diagnostics.
12. Completed: one language-analysis port replaces the native Tree-sitter splitter/extractor paths. Oxc handles JS/TS-family syntax, Tree-sitter WASM handles seven additional symbol languages, packed Scala assets are qualified, and durable parser/extractor/relationship fingerprints force a one-time reindex instead of accepting legacy navigation evidence.

Do not release the lease feature while any mutation path bypasses it.

## Quality Gates

Use the smallest relevant test while iterating, then run:

```bash
pnpm run lint
pnpm run typecheck
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
pnpm run test:integration
```

Provider-backed create and reindex are not required for deterministic lease tests; use fake vector and embedding adapters.

## Non-Goals

- Additional MCP tools.
- Source editing or write capabilities.
- Public reranking controls.
- Compatibility aliases.
- Operation history or cancellation.
- Serving an old generation while reindex runs.
- Hosted/team indexes before local ownership is proven.
- Automatic provider-backed fixture indexing during install.
- A chat UI or generated code explanations.
