# Indexing Failure Containment and Degraded Publication Implementation Plan

**Goal:** Make create, reindex, auto-index, and sync resilient to repository-specific parser/compiler/resource failures so one pathological repository or optional semantic provider cannot kill the MCP runtime or discard an otherwise usable searchable Publication.

**Architecture:** Keep the existing durable per-root mutation lease and atomic Publication pointer as the authority boundary. Move repository-scale full-index execution behind the same supervised process-group boundary already used by sync, then make semantic intelligence an explicitly covered enrichment layer whose failure can degrade call-graph/navigation capability without invalidating vector search. Add bounded resource admission, crash-recoverable candidate ownership, and classified automatic-maintenance retry semantics around that execution boundary.

**Tech Stack:** TypeScript, Node.js child processes/IPC, existing Satori RootMutationRuntime and PublicationStore, LanceDB/Milvus/Zilliz vector backends, existing semantic analyzers and sidecars.

## Global Constraints

- Preserve the existing single-writer durable root lease and atomic Publication activation semantics.
- Preserve the previous completed Publication during reindex until the replacement is proven and activated.
- Heavy create/reindex/auto-index work must not execute in the MCP control process.
- Sync must retain its current supervised worker containment guarantees.
- One parser/compiler/semantic-provider failure must not kill the MCP host.
- Optional semantic enrichment failure must never silently become complete call-graph coverage.
- Searchable payload failure and optional semantic-enrichment failure must remain distinct states.
- Resource exhaustion must be converted into bounded, typed outcomes before host OOM where the runtime can detect it.
- Automatic maintenance may coalesce and back off, but must not retry deterministic failures indefinitely.
- Do not expand the public MCP tool surface without an explicit contract update.
- Repository policy requires architecture-impacting rationale plus matching docs and tests when behavior or public contracts change.

## File Structure

### Worker and mutation control

- Create: `packages/mcp/src/server/mutation-index-worker.ts`
  - Bound-executor entrypoint for full create/reindex candidate construction.
  - Reconstructs provider runtime inside the child process and emits bounded progress/result messages through the existing mutation-worker protocol.
- Modify: `packages/mcp/src/core/manage-indexing-handlers.ts`
  - Launch and bind the supervised full-index worker.
  - Feed the worker through `FullIndexOperation`'s existing candidate-runner seam.
  - Make create/reindex status and cancellation use the same executor lifecycle as sync.
- Modify: `packages/mcp/src/core/full-index-operation.ts`
  - Keep parent-owned watcher/publication acknowledgement behavior.
  - Accept the supervised candidate result without re-running repository-scale analysis in the parent.
- Modify: `packages/mcp/src/core/manage-maintenance-handlers.ts`
  - Generalize exact cancellation from sync-only to any live mutation with a bound supervised executor.
- Modify: `packages/mcp/src/tools/manage_index.ts`
  - Update public description text only if cancellation semantics broaden from sync-only to create/reindex.
- Modify: `packages/mcp/src/core/manage-indexing-handlers.test.ts`, `packages/mcp/src/core/manage-maintenance-handlers.test.ts`, and directly affected CLI/tool-contract tests
  - Prove worker binding, crash/failure projection, cancellation, and preservation of the previous Publication.

### Semantic analysis coverage and degraded Publication truth

- Modify: `packages/core/src/semantic/contracts.ts`
  - Define provider/project analysis coverage shared by semantic engines.
- Modify: `packages/core/src/semantic/wasm/wasm-analyzer.ts`
  - Project existing skipped-file evidence into the shared coverage contract.
- Modify: `packages/core/src/relationships/typescript-semantic-analyzer.ts`
  - Emit truthful TypeScript provider coverage, including bounded/skipped/failure states.
- Modify: `packages/core/src/generation/index-generation-workflow.ts`
  - Treat optional semantic/resolution provider failure as degraded enrichment rather than a reason to discard a completed searchable candidate.
  - Keep source-integrity, Publication-integrity, vector, ownership, and mandatory navigation failures fail-closed.
- Modify: `packages/core/src/relationships/builder.ts`
  - Consume only evidence admitted by coverage; never synthesize authoritative CALLS from failed/skipped provider state.
- Modify: `packages/core/src/symbols/contracts.ts`, `packages/core/src/symbols/sidecar-writes.ts`, `packages/core/src/symbols/sidecar-reads.ts`, and validators
  - Persist the coverage necessary for later status/capability truthfulness.
- Modify: `packages/core/src/languages/evidence.ts`
  - Derive `ready | degraded | unavailable` call-graph state from persisted provider coverage, not merely sidecar compatibility.
- Modify directly affected semantic/publication/capability tests.

### Resource budgets

- Modify: `packages/core/src/config/index-policy.ts`
  - Add a first-class maximum searchable source-file byte policy for explicitly supported source extensions, separate from the existing all-text probe limit.
- Modify: `packages/core/src/core/indexing-pipeline.ts`
  - Enforce per-file and aggregate searchable payload budgets before full source duplication/chunking.
  - Return typed partial/resource outcomes instead of relying on process exhaustion.
- Modify: `packages/core/src/relationships/typescript-semantic-analyzer.ts` and/or `packages/core/src/semantic/typescript-compiler-provider.ts`
  - Enforce TypeScript project semantic byte/file budgets before constructing compiler projects.
- Keep existing WASM semantic per-source limits and align their reporting with the common coverage contract.
- Modify directly affected index-policy/indexing/semantic tests.

### Crash-recoverable candidate ownership

- Create: `packages/core/src/generation/index-candidate-receipt.ts`
  - Durable candidate identity containing canonical root, operation id, vector collection name, runtime identity, creation time, and phase.
- Modify: `packages/core/src/generation/index-generation-workflow.ts`
  - Persist the candidate receipt before vector collection creation and clear/promote it after activation or proven cleanup.
- Modify: `packages/core/src/generation/publication-store.ts`
  - Recover local candidate artifacts only when no live mutation lease owns them.
- Modify: `packages/mcp/src/core/vector-backend-maintenance.ts`
  - Use durable candidate ownership to identify otherwise-empty orphan remote collections safely instead of relying only on document metadata.
- Add directly affected crash/orphan cleanup tests.

### Automatic maintenance retry policy

- Modify: `packages/mcp/src/core/index-maintenance-coordinator.ts`
  - Replace one-bit failed-epoch suppression with typed terminal failure classification.
  - Deterministic policy/resource/compatibility failures remain suppressed until a relevant state change or manual operation.
  - Retryable external/provider failures use bounded backoff and single-flight coalescing.
- Modify: `packages/mcp/src/core/index-maintenance-coordinator.test.ts`
  - Prove no retry storm, eventual retry for transient failure, and continued suppression for deterministic failure.

## Task 1: Supervise full create/reindex candidate construction

**Files:**
- Create: `packages/mcp/src/server/mutation-index-worker.ts`
- Modify: `packages/mcp/src/core/manage-indexing-handlers.ts`
- Modify: `packages/mcp/src/core/full-index-operation.ts`
- Modify: directly affected worker/indexing tests

**Interfaces:**
- Consumes: `RootMutationRuntime.runBoundExecutor`, `spawnSupervisedMutationWorker`, `FullIndexCandidateRunner`, `Context.indexCodebase`, `ObservedResolvedIndexPolicy`.
- Produces: one supervised full-index candidate runner returning the existing `IndexCodebaseResult` shape to the parent lifecycle owner.

**Steps:**
- [ ] Add a worker input schema containing canonical root, mutation action, force-reindex flag, resolved index policy, and partial-publication policy.
- [ ] In the worker, wait for containment start, attach to the exact bound root mutation operation, construct an embedding-capable provider runtime with watcher lifecycle disabled, and call `Context.indexCodebase` inside the bound executor scope.
- [ ] Convert Core progress into mutation-worker progress messages without allowing worker-generated terminal phases to override the parent lifecycle owner.
- [ ] Return only the bounded `IndexCodebaseResult` fields over IPC.
- [ ] In `ManageIndexingHandlers`, capture the `RootMutationExecution`, spawn the worker, await containment readiness, bind its executor, start it, and expose it through `FullIndexOperation`'s candidate-runner seam.
- [ ] On worker crash, protocol failure, no-progress timeout, cancellation, or OOM exit, preserve the previous Publication and publish a terminal operation failure in the parent.
- [ ] Do not duplicate repository-scale candidate construction in the parent after the worker path is active.
- [ ] Add focused tests required by repository policy for worker success, worker failure, and prior-Publication preservation.

**Acceptance criteria:**
- Create, reindex, and automatic full indexing execute repository-scale Core indexing in a child process group rather than the MCP control process.
- A worker process crash rejects only that mutation; the MCP runtime remains alive.
- Reindex worker failure leaves the previous complete Publication current.
- The child cannot mutate after the parent releases the root lease.

## Task 2: Unify cancellation and no-progress behavior

**Files:**
- Modify: `packages/mcp/src/core/manage-maintenance-handlers.ts`
- Modify: `packages/mcp/src/tools/manage_index.ts`
- Modify: directly affected manage-index and CLI tests

**Interfaces:**
- Consumes: live `RootMutationActivity`, bound executor metadata, `RootMutationRuntime.requestCancellation`.
- Produces: exact-operation cancellation for supervised create/reindex/sync.

**Steps:**
- [ ] Permit cancellation for live create/reindex operations only when they have a bound supervised executor; continue refusing unsafe force-unlock behavior.
- [ ] Preserve exact `operationId` matching and process-group quiescence before root-lease release.
- [ ] Apply a full-index no-progress timeout through the existing supervisor.
- [ ] Update public manage-index wording from “sync-only cancellation” to “supervised mutation cancellation”.
- [ ] Add required contract tests proving create/reindex cancellation and stale/wrong operation-id refusal.

**Acceptance criteria:**
- A hung full index becomes cancellable and eventually releases its lease only after executor quiescence is proven.
- No create/reindex/sync action gains a force-unlock path.

## Task 3: Persist semantic-provider coverage

**Files:**
- Modify: `packages/core/src/semantic/contracts.ts`
- Modify: `packages/core/src/semantic/wasm/wasm-analyzer.ts`
- Modify: `packages/core/src/relationships/typescript-semantic-analyzer.ts`
- Modify: `packages/core/src/symbols/contracts.ts`
- Modify: `packages/core/src/symbols/sidecar-writes.ts`
- Modify: `packages/core/src/symbols/sidecar-reads.ts`
- Modify: `packages/core/src/symbols/sidecar-validators.ts`
- Modify directly affected tests

**Interfaces:**
- Produces: persisted per-language/provider coverage containing provider id/version, status, analyzed source count/bytes, skipped files/reasons, and bounded failure classification.

**Steps:**
- [ ] Define one coverage status model: `complete | degraded | unavailable`.
- [ ] Carry current WASM `skippedFiles` through the common contract.
- [ ] Emit TypeScript semantic coverage independently of individual resolution claims.
- [ ] Persist coverage next to relationship evidence with strict validation and versioning.
- [ ] Reject malformed coverage as incompatible sidecar state rather than guessing.

**Acceptance criteria:**
- A consumer can distinguish “provider produced zero calls” from “provider did not successfully cover these files”.
- Existing proof-backed relationships remain unchanged when coverage is complete.

## Task 4: Degrade optional semantic enrichment without discarding search

**Files:**
- Modify: `packages/core/src/generation/index-generation-workflow.ts`
- Modify: `packages/core/src/relationships/builder.ts`
- Modify: `packages/core/src/languages/evidence.ts`
- Modify directly affected publication/capability tests

**Interfaces:**
- Consumes: persisted semantic-provider coverage from Task 3.
- Produces: a complete searchable Publication whose exact-symbol/call-graph capabilities may be degraded when optional provider analysis fails.

**Steps:**
- [ ] Classify navigation-build errors into mandatory integrity failures versus optional semantic-provider failures.
- [ ] On optional provider failure, produce empty authoritative claims for that provider plus `unavailable` or `degraded` coverage and continue staging the rest of navigation.
- [ ] Keep source hash drift, policy drift, corrupt registry, invalid ownership, vector finalization failure, and Publication activation failure fail-closed.
- [ ] Update capability evidence so failed/skipped provider coverage degrades call-graph state and reports a concrete reason.
- [ ] Add required tests proving late TypeScript/WASM provider failure still activates searchable content while call-graph capability is degraded honestly.

**Acceptance criteria:**
- A late optional semantic-provider exception cannot discard an otherwise valid completed vector candidate.
- Status never reports call-graph `ready` when the owning provider failed or skipped required source coverage.

## Task 5: Enforce repository-scale resource budgets before OOM

**Files:**
- Modify: `packages/core/src/config/index-policy.ts`
- Modify: `packages/core/src/core/indexing-pipeline.ts`
- Modify: TypeScript semantic analyzer/provider budget owner
- Modify directly affected tests

**Interfaces:**
- Produces: explicit resource-limit outcomes and semantic coverage degradation instead of uncontrolled heap growth.

**Steps:**
- [ ] Add bounded per-file searchable source bytes for explicitly supported extensions.
- [ ] Add aggregate searchable source and TypeScript project semantic budgets.
- [ ] Check byte/file budgets before materializing compiler projects or duplicating complete source sets.
- [ ] Define whether each budget produces a partial searchable Publication, skipped semantic coverage, or a hard configuration error; keep that policy explicit in returned status.
- [ ] Add required boundary tests at exactly-under, exactly-at, and over-limit cases.

**Acceptance criteria:**
- Generated or pathological multi-megabyte supported-extension files cannot consume unbounded process memory.
- Budget breaches appear in status/coverage rather than as host OOM.

## Task 6: Recover orphan candidate collections

**Files:**
- Create: `packages/core/src/generation/index-candidate-receipt.ts`
- Modify: `packages/core/src/generation/index-generation-workflow.ts`
- Modify: `packages/core/src/generation/publication-store.ts`
- Modify: `packages/mcp/src/core/vector-backend-maintenance.ts`
- Modify directly affected tests

**Interfaces:**
- Produces: durable proof mapping an unpublished candidate collection to its root and operation.

**Steps:**
- [ ] Persist the receipt before creating the candidate collection.
- [ ] Atomically advance/clear the receipt when activation or cleanup is proven.
- [ ] On startup/maintenance, reclaim only receipts whose root has no live mutation lease and whose collection is not referenced by a current Publication.
- [ ] Use the receipt to identify empty remote candidates that have no document metadata.
- [ ] Preserve ambiguous/unproven collections; never guess ownership.

**Acceptance criteria:**
- A crash between collection creation and Publication staging does not permanently leak an unmapped Satori collection.
- Current or live-reader-protected collections are never reclaimed.

## Task 7: Classify automatic-maintenance failures

**Files:**
- Modify: `packages/mcp/src/core/index-maintenance-coordinator.ts`
- Modify: `packages/mcp/src/core/index-maintenance-coordinator.test.ts`

**Interfaces:**
- Produces: terminal classification `deterministic | resource_blocked | retryable_external | cancelled` plus bounded retry/backoff state.

**Steps:**
- [ ] Carry a typed terminal reason from supervised full-index completion into the maintenance coordinator.
- [ ] Keep deterministic/resource failures suppressed until relevant state changes or a manual operation succeeds.
- [ ] Retry transient provider/network/worker-start failures with bounded backoff, retaining single-flight coalescing.
- [ ] Never retry cancellation automatically.
- [ ] Add required tests proving bounded retry and no retry storm.

**Acceptance criteria:**
- One transient failure does not disable automatic repair for an entire runtime epoch.
- One deterministic repository failure does not spin continuously.

## Task 8: Operational documentation and completion checks

**Files:**
- Modify: `docs/architecture/LANGUAGE_INTELLIGENCE.md`
- Modify lifecycle/index documentation that currently describes sync-only supervision/cancellation.
- Update this plan with completed task markers and any accepted deviations.

**Interfaces:**
- Produces: operator/developer documentation matching actual failure containment and degradation semantics.

**Steps:**
- [ ] Document the control-process/worker boundary and which failures are contained.
- [ ] Document searchable Publication versus semantic-capability degradation.
- [ ] Document resource-limit and automatic-retry outcomes.
- [ ] Run the repository-required focused tests for each changed behavior contract.
- [ ] Run package typecheck/lint/build checks required by the touched package instructions.
- [ ] Inspect the final diff for unrelated mutation before integration.

**Acceptance criteria:**
- Documentation, public tool description, status behavior, and executable behavior describe the same lifecycle.
- No documented guarantee claims that environmental failures such as disk-full or unavailable mandatory vector/embedding providers are impossible; they are instead bounded and non-destructive where technically possible.

## Progress

- [x] Task 1 — supervised full-index worker.
- [x] Task 2 — cancellation/no-progress unification.
- [x] Task 3 — persisted semantic coverage contract.
- [x] Task 4 — degraded semantic Publication behavior.
- [ ] Task 5 — repository-scale resource budgets.
- [ ] Task 6 — candidate receipt/orphan recovery.
- [ ] Task 7 — classified automatic retry.
- [ ] Task 8 — final operational documentation and integration closure.

## Implementation Order

1. Task 1 — supervised full-index worker.
2. Task 2 — cancellation/no-progress unification.
3. Task 3 — persisted semantic coverage contract.
4. Task 4 — degraded semantic Publication behavior.
5. Task 5 — repository-scale resource budgets.
6. Task 6 — candidate receipt/orphan recovery.
7. Task 7 — classified automatic retry.
8. Task 8 — final operational documentation and integration closure.

The first implementation wave should stop after Tasks 1–2 are stable because they change the mutation-executor ownership boundary. Tasks 3–4 form a separate semantic/publication contract wave and should not be mixed into the worker migration until the supervised full-index path is proven.
