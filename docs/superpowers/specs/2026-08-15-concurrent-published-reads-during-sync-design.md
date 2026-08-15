# Concurrent Published Reads During Sync — Design

**Date:** 2026-08-15  
**Branch:** `integrate/language-spine-cbm-go`  
**Status:** Design approved; implementation plan pending

## 1. Problem

Satori treats incremental sync as a writer mutation and currently exposes that mutation as a read outage. While a sync is active, `search_codebase` and navigation front doors can return `not_ready` even when a fully proven previous generation still exists.

That behavior is especially costly because sync is both automatic and manual and is expected to be the common steady-state mutation path during development.

The CBM Go integration exposes a second problem: incremental semantic rebuilds can execute project-wide synchronous WASM work in the MCP process. Even if the read path is logically allowed to return `not_ready`, a long synchronous CBM resolve can monopolize the Node event loop long enough that MCP requests time out before Satori can emit the graceful readiness response.

The desired developer experience is therefore:

- ordinary background sync must not make an otherwise healthy published index unusable;
- parallel read-only searches must remain available during sync;
- each read must be pinned to one immutable proven publication;
- activation must remain atomic and fail closed;
- CPU-heavy semantic analysis must not monopolize the MCP request event loop;
- an incremental source edit should not require a whole-language semantic rebuild unless the semantic dependency boundary genuinely requires it.

## 2. Existing Architecture We Reuse

This design does not introduce a second publication authority.

The existing architecture already provides the required foundations:

1. Incremental publication forks the active vector collection into a staged candidate and applies the delta to the candidate rather than mutating the current publication in place.
2. Navigation artifacts are staged as a candidate generation and activated only after vector, checkpoint, navigation, and publication proofs converge.
3. `IndexAuthorityCoordinator` owns publication read leases and retention gates. Old generations can remain alive while readers are using them, and retention waits for readers to drain before cleanup.
4. `PreparedPublicationReadSession` already provides the read-lifetime boundary needed to bind one request to one publication.
5. Source freshness and current-source authority are distinct from immutable publication identity.

The design changes **read admission semantics and semantic execution placement**, not the logical publication authority.

## 3. Options Considered

### Option A — Serve the last sealed generation during sync **(chosen)**

When a normal sync is active and a previously proven publication still exists, new read requests bind to that previous publication. Activation atomically changes the publication seen by subsequent requests. Existing requests finish against the generation they already pinned.

**Advantages**

- sync no longer creates routine read downtime;
- preserves immutable-generation consistency;
- reuses existing candidate publication and retention machinery;
- supports parallel agents naturally;
- does not require a speculative working-tree overlay.

**Trade-off**

- during the sync window, a read may be one publication behind the current working tree. The response must disclose that state.

### Option B — Keep sync blocking, move only CBM off-thread

This would remove MCP transport starvation but retain `not_ready` for every normal sync.

Rejected because it fixes responsiveness without fixing the core developer-experience problem.

### Option C — Serve old generation plus a live working-tree overlay

This could expose the newest edited files before publication completes.

Deferred. It adds a second read-composition model, more source-barrier complexity, and much larger correctness surface. Satori already has changed-file awareness and can add a bounded overlay later if product evidence justifies it.

## 4. Core Read Contract

### 4.1 Generation pinning

Every search/navigation request that proceeds must bind to exactly one immutable proven publication before retrieval begins.

A request must never read vector state from generation N and navigation/relationship state from generation N+1.

The pinned publication consists of the existing proven vector generation plus the corresponding sealed navigation generation when navigation is available.

### 4.2 Sync read policy

For a normal incremental sync:

```text
Published generation N        remains readable
Candidate generation N+1      builds privately

search A ----> N
search B ----> N
search C ----> N

candidate N+1 verifies
candidate N+1 activates atomically

new search D --> N+1
A/B/C finish --> N
```

If a valid prior publication exists, `sync` is **not** a global read-blocking state.

### 4.3 When reads still block

`not_ready` remains correct when no safe published generation can be proven, including:

- first-ever `create` before a usable publication exists;
- source/index authority corruption that invalidates the prior publication;
- incompatible index format/policy requiring reindex;
- missing or unprovable publication artifacts;
- a destructive operation whose contract explicitly withdraws the previous publication.

A routine incremental sync is not in this list.

### 4.4 Reindex behavior

This phase does **not** require stale-while-reindex.

Reindex may keep the current behavior initially. Once sync semantics are proven, the same publication-pinning model may be extended to reindex if the old generation remains valid throughout rebuild.

## 5. User-Visible Freshness Semantics

A read served from the previous publication while sync is active should return `status: "ready"`, not `not_ready`.

The response should expose bounded freshness metadata conceptually equivalent to:

```json
{
  "freshness": {
    "state": "sync_in_progress",
    "servedGeneration": "<published-generation>",
    "pendingOperation": {
      "action": "sync",
      "generation": "<candidate-generation>"
    }
  }
}
```

Exact public field names must follow existing response-contract conventions, but the semantics are mandatory:

- results are valid for the published generation being served;
- current source may be newer while sync is active;
- no partial candidate state is exposed.

This metadata is informational, not an error.

## 6. Parallel Search Contract

Parallel read-only requests are supported.

There must be no root-level mutex that serializes independent searches merely because they target the same codebase.

Each request:

1. resolves the currently servable publication;
2. acquires a publication read lease;
3. performs search/navigation against that pinned generation;
4. releases the lease when the request completes or fails.

Retention must continue to wait for active readers before deleting a retired generation.

If activation occurs while multiple readers are active, those readers finish on the old generation and later requests use the new one.

## 7. MCP Readiness Changes

The current front-door rule effectively treats `state === indexing` as globally unavailable even for a sync with a searchable prior generation.

The new rule distinguishes **writer activity** from **publication readability**.

Conceptually:

```text
active mutation = sync
+ previous proven generation = yes
+ previous publication still authorized = yes
-------------------------------------------
read state = ready_from_published_generation
```

`waitForSearchableSync()` may remain useful for cases where no prior publication exists, but it must not be the normal path for an already-indexed codebase undergoing incremental sync.

The decision owner should remain the existing read/readiness layer. Core remains the owner of publication proof and activation authority.

## 8. CBM Execution Isolation

### 8.1 Requirement

CBM semantic analysis must not execute long synchronous WASM resolution on the MCP request event loop.

The public async surface is not sufficient if the underlying Emscripten export is synchronous.

### 8.2 Recommended execution model

Use a dedicated semantic worker boundary:

```text
MCP main process / request loop
  ├── search
  ├── read_file
  ├── file_outline
  ├── call_graph
  ├── manage_index/status
  └── semantic worker client
          |
          v
     worker thread or dedicated worker process
          |
          v
        CBM WASM
```

The worker owns the native semantic engine instance(s) used for project analysis.

The main MCP process sends immutable semantic project inputs and receives deterministic semantic evidence/results.

### 8.3 Worker failure semantics

Worker crash, timeout, malformed response, or resource exhaustion must fail the candidate mutation closed.

It must **not** invalidate the previously published generation.

The MCP request loop must remain responsive and able to:

- serve reads from the current publication;
- report mutation failure/status;
- accept recovery/repair operations.

### 8.4 Cancellation

Mutation cancellation or server drain should stop admitting new semantic jobs and attempt to cancel/terminate the active worker job cleanly.

Candidate artifacts remain disposable until activation.

## 9. Semantic Delta Scope

Moving CBM off-thread fixes responsiveness but does not justify whole-language rebuild cost for ordinary edits.

The steady-state invalidation target is semantic dependency scope, not language scope.

For Go:

```text
ordinary .go edit
  -> affected package
  -> dependent packages only when exported semantic facts require it

package/module topology change
(go.mod / go.work / relevant manifest)
  -> broader rebuild, potentially whole Go project
```

The first implementation may introduce this in stages, but it must establish an explicit invalidation owner rather than leaving “any changed Go file means all Go files” as the permanent contract.

This dependency boundary should later generalize to Rust crates/workspaces, Java packages/modules, C/C++ translation-unit/include graphs, and TS/JS module graphs.

## 10. Source Freshness During Stale-While-Sync Reads

Serving generation N during generation N+1 sync is not a claim that generation N matches the latest working tree.

It is a claim that:

- generation N is a valid, immutable, previously published Satori generation;
- the read is publication-consistent;
- source freshness is currently advancing toward a new publication.

The read path must therefore stop requiring “current source equals pinned publication” as a precondition **only for the explicit sync-in-progress stale-read mode**.

All existing generation-integrity, policy, vector/navigation, and publication-binding proofs remain required.

Once no sync is active, normal current-source freshness rules resume.

## 11. Unexpected Sync Churn / Gen-18 Diagnostics

A restart or missing watcher registration must not be documented as automatically requiring one extra generation.

The existing freshness path can prove unchanged source using an exact/full comparison and return `skipped_source_unchanged` without publishing another generation.

If a new sync nevertheless crosses the execution gate immediately after a clean sync, Satori must record the reason.

Add a bounded diagnostic classification for the transition into mutation, such as:

- `watcher_pending`
- `exact_compare_differs`
- `exact_compare_unavailable`
- `full_compare_differs`
- `full_compare_unavailable`
- `ignore_control_changed`
- `checkpoint_changed`
- `threshold_expired`

The exact enum may differ, but every unexpected auto-sync must be explainable from durable/debug evidence.

## 12. Installer / Runtime Replacement

Local MCP activation should not intentionally terminate an active writer without first attempting lifecycle drain.

Preferred sequence:

```text
install requested
  -> ask existing runtime to stop admitting new background mutations
  -> wait for active sync/reconcile/semantic worker job to drain or cancel cleanly
  -> terminate old runtime
  -> activate new runtime
```

If safe drain cannot be established, activation should fail closed rather than knowingly interrupting a writer and creating ambiguous recovery state.

This is a lifecycle improvement adjacent to, but separable from, stale-while-sync reads.

## 13. Public Go Call Graph Promotion

CBM relationship generation and public language capability are separate gates.

Go should remain publicly `symbol_only` until Go relationship qualification passes. Once qualified, promote Go to the existing calls-capable language declaration rather than routing users permanently to an alternate graph solely because the public capability has not yet been enabled.

This design does not lower the Go relationship qualification bar.

## 14. Error Handling Matrix

| Situation | Read behavior | Mutation behavior |
|---|---|---|
| Normal sync, valid prior publication | Serve prior publication | Continue candidate build |
| Semantic worker busy | Serve prior publication | Continue candidate build |
| Semantic worker crashes | Serve prior publication | Candidate fails closed |
| Candidate verification fails | Serve prior publication | Candidate discarded |
| Activation succeeds | New reads use new publication | Old readers finish on pinned old generation |
| Retention waits on readers | Reads continue | Cleanup waits |
| No prior publication (`create`) | `not_ready` | Build first publication |
| Prior publication corrupt/unprovable | `not_ready` / repair path | Fail closed |
| Reindex in this phase | Existing behavior | Existing behavior |

## 15. Required Tests

### 15.1 Read-during-sync

1. Begin with proven generation N.
2. Start an incremental sync and hold candidate N+1 before activation.
3. Run `search_codebase`.
4. Assert `status: ready`.
5. Assert the request is bound to generation N.
6. Assert response freshness indicates sync in progress.

### 15.2 Parallel reads during sync

1. Hold candidate sync in progress.
2. Start at least five searches concurrently.
3. Assert all complete without `not_ready` or transport timeout.
4. Assert all use the same proven generation N when started before activation.

### 15.3 Activation boundary

1. Start search A and hold it after acquiring its read lease.
2. Activate N+1.
3. Start search B.
4. Assert A completes against N.
5. Assert B binds N+1.
6. Assert retention does not delete N until A releases its lease.

### 15.4 Candidate failure

1. Hold valid generation N.
2. Start sync N+1.
3. Force semantic worker failure or candidate verification failure.
4. Assert N remains fully searchable.
5. Assert mutation reports failed.
6. Assert no partial N+1 state becomes canonical.

### 15.5 Event-loop responsiveness

1. Run a deliberately slow/heavy CBM semantic job in the worker.
2. While it is active, issue MCP `status`, `search_codebase`, and `read_file` requests.
3. Assert the MCP event loop responds within the normal tool deadline.
4. Assert read requests use the prior publication.

### 15.6 No-publication create

1. Start first index creation for an unindexed repository.
2. Search before first activation.
3. Assert `not_ready` remains unchanged.

### 15.7 Unexpected resync diagnostics

1. Establish a completed no-change source proof.
2. Force conditions that cause the next access to start sync.
3. Assert a stable trigger classification identifies why the execution gate was crossed.

### 15.8 Semantic invalidation

For Go, add characterization showing:

- private/local edit rebuilds only the required package scope;
- exported API change rebuilds dependent package scope as needed;
- `go.mod`/`go.work` topology change may trigger whole-project semantic rebuild;
- unaffected packages reuse prior relationship evidence.

## 16. Performance / UX Acceptance

The design is accepted only when all of the following hold:

1. A routine incremental sync with a valid prior publication does not return `not_ready` solely because the sync is active.
2. At least five parallel searches can complete during a deliberately held sync.
3. Heavy CBM semantic execution does not block MCP status/read/search responses on the main event loop.
4. Candidate failure never withdraws the previous proven publication.
5. Activation remains atomic across vector, source checkpoint, and navigation authority.
6. Old-generation retention waits for pinned readers.
7. A normal single-file Go edit does not permanently imply a whole-Go-project semantic rebuild contract.
8. Auto-sync starts are diagnosable by an explicit trigger classification.

## 17. Non-Goals

This phase does not:

- implement a working-tree overlay on search results;
- expose partial candidate relationships;
- weaken publication proof or source checkpoint integrity;
- make reindex non-blocking unless that falls out safely after sync is proven;
- promote Go `call_graph` before relationship qualification;
- introduce a second publication coordinator or second source of generation truth.

## 18. Implementation Sequencing

The implementation plan should preserve this order:

1. **Read-policy seam:** allow prior proven publication to remain servable during normal sync.
2. **Generation pin tests:** prove search/navigation consistency and activation/retention behavior.
3. **CBM worker isolation:** move project semantic resolution off the MCP event loop.
4. **Parallel-search qualification:** prove concurrent reads remain responsive during held sync and heavy semantic work.
5. **Sync-trigger diagnostics:** make unexpected resync reasons explicit.
6. **Semantic invalidation narrowing:** replace whole-language invalidation with package/dependency-aware scope.
7. **Lifecycle drain:** make local runtime replacement wait for/cancel active writer work safely.

Do not combine these into one unreviewable rewrite. Each step should preserve the existing publication authority and fail-closed invariants.

## 19. Architectural Invariants

The following are binding:

> **A background sync must never make an otherwise healthy previously published index unusable.**

> **A read sees exactly one immutable published generation for its full lifetime.**

> **A candidate generation is never readable before activation.**

> **A CPU-heavy semantic rebuild must never monopolize the MCP request event loop.**

> **Parallel read-only searches are a supported workload, not an error condition.**

> **Source freshness may lag during the explicit sync-in-progress stale-read mode, but publication integrity may not.**

> **Core remains the single authority for generation publication; MCP only decides whether an already-proven publication is servable for a request.**
