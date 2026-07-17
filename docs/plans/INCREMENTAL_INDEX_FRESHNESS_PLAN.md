# Satori Incremental Index Freshness Plan

**Status:** planning document (contract baseline + phased improvements)
**Date:** 2026-07-17
**Review incorporation:** 2026-07-17 (semantic precision pass: multi-dimensional projection, target contracts, evaluation freeze)
**Authority for current runtime:** code under `packages/mcp` and `packages/core`. This plan is **not** public-contract authority until each change is implemented with tests and, where needed, a contract migration.

**Implementation policy:** only change production implementation when a real correctness or reproducibility gap is proven. Plan revisions alone do not require code edits.

---

## Executive decision

Satori has two separate five-second timers:

1. **Watcher debounce:** after a filesystem event, wait five seconds of quiet before requesting a forced freshness pass.
2. **Background startup delay:** after an embedding-capable runtime starts, wait five seconds before the first background freshness **consideration**.

Neither timer means:

> A file edit will always become searchable within five seconds.

With watcher enabled, edits are normally detected after the quiet period and then synchronized.

With watcher disabled, no filesystem event is captured. Incremental indexing still works, but it is **pull-based**:

- Search-triggered freshness decisions.
- Periodic background considerations.
- Explicit `manage_index sync`.
- Explicit reindexing.

The product problem is not “does incremental indexing exist?” It is communicating and enforcing the difference between:

- A **searchable publication**.
- A request that **reused a process-local recency window** (no live-tree comparison on this request).
- A **live-tree comparison** at a known time bound to a publication.
- **Continuous filesystem observation** (watcher), which is not the same as “index includes last keystroke.”

Core architectural stance:

> Model freshness as **evidence across independent dimensions**, then make strict freshness **prove request coverage and publication identity**. One incremental pipeline; additive contracts; phased rollout.

---

## Compatibility summary (current code)

Implementable without redesigning the indexing algorithm. Most of §1 already exists.

| Plan concept | Current owner | Status | Notes |
|---|---|---|---|
| Watcher debounce 5s | `WATCHER_DEBOUNCE_MS` / `DEFAULT_WATCH_DEBOUNCE_MS` + `MCP_WATCH_DEBOUNCE_MS`; `scheduleWatcherSync` | **Current** | Only if `watchEnabled && watcherModeStarted`. |
| Background initial delay 5s | `BACKGROUND_SYNC_INITIAL_DELAY_MS` in `config.ts` | **Current** | First consideration only. |
| Background interval 3m | `BACKGROUND_SYNC_INTERVAL_MS` | **Current** | Self-scheduling after tick completion. |
| Search freshness 3m | `SEARCH_FRESHNESS_THRESHOLD_MS` → search `ensureFreshness` | **Current** | `skipped_recent` reuses process-local recency. |
| Background freshness threshold 3m | `BACKGROUND_FRESHNESS_THRESHOLD_MS` | **Current** | Named separately from interval even when equal. |
| Manual sync threshold 0 | `MANUAL_SYNC_FRESHNESS_THRESHOLD_MS` | **Current** | Subject to lease/status gates. |
| Single pipeline | `ensureFreshness` → `syncCodebase` → `reindexByChange` | **Current** | Do not fork. |
| Embedding-only lifecycle | `startProviderSyncLifecycle` | **Current** | Local-only must not start bg/watcher. |
| Mutation single-flight | lease + `activeSyncs` + Core reindex queue | **Current** | Compose in Phase 2; do not replace casually. |
| Watcher-off observation | `watcher_disabled` → `SOURCE_FRESHNESS_UNVERIFIED` | **Current** | Index may still be searchable. |
| Multi-dimensional freshness projection | Partial (`freshnessDecision`, watcher diagnostics) | **Target** | §3; not a single enum. |
| Search modes `best_effort` / `require_current` / `published_index` | Not present | **Target Phase 3** | Public contract; default remains today’s best_effort. |
| Event-follow-up epoch | Partial | **Target Phase 2** | Strengthen without second pipeline. |

### Public contract constraints

- Prefer **additive** fields on `FreshnessDecision` over renaming `mode` values.
- Do not remove existing search envelope fields without migration.
- Prepared-read observation includes mutation generation: lease acquisition can invalidate warm cache even on zero-change work.
- Background must not use threshold `0` on idle recently-synced roots (would thrash warm readiness).
- Eval harnesses often set `MCP_ENABLE_WATCHER=false`; do not silently flip measured search to `require_current`.

### Zero-change invariant

> A zero-change synchronization may still alter **mutation or operation identity**. It must not be assumed to preserve prepared-read cache authority unless the publication and receipt contract explicitly proves revalidation. Evaluation warm paths can become cold if background or search thrashing acquires leases.

---

# 1. Current behavior (as implemented)

## 1.1 Watcher-enabled lifecycle

```text
File edit
  → filesystem event
  → scheduleWatcherSync (no-op if watcher disabled/not started)
  → debounce quiet period (WATCHER_DEBOUNCE_MS / MCP_WATCH_DEBOUNCE_MS)
  → ensureFreshness(root, MANUAL_SYNC_FRESHNESS_THRESHOLD_MS=0)
  → syncCodebase → reindexByChange
```

Debounce combines edit bursts. It is **not** a “searchable within 5s” guarantee.

Default: `MCP_ENABLE_WATCHER` true when unset.

## 1.2 Watcher-disabled lifecycle

```text
File edit → no FS observation
  → index unchanged until pull trigger
  → search (SEARCH_FRESHNESS_THRESHOLD_MS) |
    background (BACKGROUND_FRESHNESS_THRESHOLD_MS) |
    manage_index sync (threshold 0)
```

`skipped_recent` means: process-local last sync age is under threshold. It does **not** mean the working tree was inspected on this request.

## 1.3 Background lifecycle

Starts only on embedding-capable runtime (`startProviderSyncLifecycle`).

```text
First embedding-capable tool
  → ProviderRuntime embedding SyncManager
  → startBackgroundSync
  → wait BACKGROUND_SYNC_INITIAL_DELAY_MS
  → handleSyncIndex → ensureFreshness(root, BACKGROUND_FRESHNESS_THRESHOLD_MS)
  → after completion, schedule next BACKGROUND_SYNC_INTERVAL_MS later
```

First tick may return `skipped_recent` if a search just synced.

Local-only startup SyncManager must never run this loop.

## 1.4 Search-triggered lifecycle

```text
search_codebase → ensureSearchFreshness
  → ensureFreshness(root, SEARCH_FRESHNESS_THRESHOLD_MS [, preparedVectorReceipt])
```

Current `FreshnessDecisionMode` values include `synced`, `skipped_recent`, `coalesced`, lease/path/checkpoint skips, ignore reconcile outcomes. Front door maps authority-preserving vs post-freshness cold readiness.

## 1.5 Manual lifecycle

```text
manage_index sync → ensureFreshness(root, 0)
```

Bypasses the three-minute recency throttle. Outcome is still subject to lease, indexing state, checkpoint, and path validity. Not every non-error response is a **freshness-authoritative** success (see §2).

## 1.6 Process-local recency (`lastSyncTimes`)

Scope: **in-process map**, not durable across restarts.

After restart:

- Durable publication may still be searchable.
- Process-local recency is empty → first search/background tick may perform a new live comparison.
- That is a **safe extra comparison**, not a claim that durable state was “never synced.”

Near-term: keep process-local; when exposed, label `recencySource: process_local`.
Later optional durable timestamp only if bound to root + publication + fingerprint + completion identity.

---

# 2. Product guarantees (target contracts)

These are **target contracts**. Each must be tied to mechanical response conditions when implemented. Do not treat them as fully verified today unless tests prove them.

### Guarantee 1: Searchability (largely current)

When publication is searchable, Satori can search that publication. This does not claim the latest working-tree edit is included.

### Guarantee 2: Watcher observation (target precision)

Only when watcher dimensions support it (see §3.2), Satori may state that filesystem changes are being **observed**. Observation ≠ indexing complete; debounce and in-flight sync still apply.

### Guarantee 3: Verified live comparison (target)

Satori may claim a live-tree comparison only when a **real comparison** (§11 definition) completed at a known time and is bound to a publication/receipt context.
A search that returns `skipped_recent` is **not** a live comparison for this request.

`require_current` captures a request comparison boundary before starting or
joining work. A completing comparison must prove that it covers that boundary.
With a watcher, the boundary includes the process-local observed-change epoch.
Without a watcher, the request must start or join a post-request filesystem
comparison; process-local recency alone cannot satisfy it. This proves only the
captured boundary. It does not claim the filesystem remained unchanged after or
during portions of the comparison that the operating system cannot observe
atomically.

### Guarantee 4: Manual sync freshness-authoritative success (target mechanical)

A manual sync is **freshness-authoritative** only when all of the following hold (exact field names follow existing manage response shapes when wired):

```text
status = ok
operation.action = sync
operation.phase = completed
canonical root matches request
syncStats present (including zeros)
publication proof present when publication is claimed
mode is not a skip (mutation_in_progress, missing_path, checkpoint unavailable, …)
```

Otherwise label the outcome: `accepted` / `deferred` / `coalesced` / `blocked` / `failed` — never “successful current sync.”

### Guarantee 5: No false five-second promise (documentation + tests)

No docs, UI, diagnostics, or tests imply every edit is searchable within five seconds.

---

# 3. Freshness projection (not a single enum)

Freshness is **not** a mutually exclusive state machine. A root can be searchable, watching, and pending at once.

## 3.1 Independent dimensions

| Dimension | Answers | Must not replace |
|---|---|---|
| **Publication / availability** | Is a compatible published index searchable? | Snapshot + completion proof authority |
| **Observation** | Are live FS changes currently observed? | Watcher lifecycle facts |
| **Activity** | Idle / pending / syncing / follow-up? | `activeSyncs`, debounce, lease |
| **Verification** | When was live tree last **compared**, result, bound publication? | Real comparison + receipt |
| **Last outcome** | Latest freshness decision or failure | `FreshnessDecision` |

### Recommended response shape (target additive projection)

```json
{
  "publication": {
    "searchable": true,
    "receipt": {
      "canonicalRoot": "...",
      "runtimeFingerprint": {},
      "collectionName": "...",
      "markerRunId": "...",
      "indexPolicyHash": "...",
      "policyDocumentDigest": "..."
    },
    "publishedAt": "..."
  },
  "liveTree": {
    "lastComparedAt": "...",
    "comparisonResult": "no_changes",
    "comparisonTrigger": "search",
    "comparisonAuthority": "process_local",
    "recencySource": "process_local"
  },
  "watcher": {
    "enabled": false,
    "started": false,
    "rootRegistered": false,
    "watcherOperational": false,
    "unavailableReason": "watcher_disabled",
    "lastEventAt": null,
    "pendingDebounce": false,
    "lastWatcherSyncAt": null,
    "lastWatcherError": null
  },
  "mutation": {
    "state": "idle",
    "pendingReasons": []
  },
  "freshnessDecision": {
    "mode": "skipped_recent",
    "thresholdMs": 180000,
    "trigger": "search",
    "indexMayExcludeRecentEdits": true
  }
}
```

UI may render friendly text. Contracts keep independent facts.

### Terminology ban

| Avoid | Prefer |
|---|---|
| `recently_checked` for `skipped_recent` | `within_freshness_window` / `recent_sync_reused` |
| bare timeless `current` | `liveTreeComparedAt` + receipt + `changesDetected` + observation flags |
| `healthy watcher` alone | separate watcher dimension fields |

Human copy examples:

- With continuous observation: “No changes detected at 10:00:00; watcher observation active.”
- Without: “No changes detected at 10:00:00; later edits may not be reflected.”

## 3.2 Watcher status dimensions

Do **not** set `watcherOperational` merely because a watcher object exists.

Track at least:

```text
watcherConfigured | watcherStarted | rootRegistered
lastEventAt | pendingDebounce | lastWatcherSyncAt | lastWatcherError
watcherOperational
```

`watcherOperational` requires configured + started + root registered + not failed
and not in a degraded observation-unavailable reason. It is still a best-effort
observation claim: event loss, watch scope, and ignore policy remain residual
risk.

---

# 4. Timing constants (distinct names)

```text
WATCHER_DEBOUNCE_MS                    = 5s     # FS quiet period
BACKGROUND_SYNC_INITIAL_DELAY_MS       = 5s     # first bg consideration
BACKGROUND_SYNC_INTERVAL_MS            = 3m     # between ticks
SEARCH_FRESHNESS_THRESHOLD_MS          = 3m     # search skipped_recent window
BACKGROUND_FRESHNESS_THRESHOLD_MS      = 3m     # bg skipped_recent window
MANUAL_SYNC_FRESHNESS_THRESHOLD_MS     = 0      # force comparison attempt
```

Equal numbers ≠ shared meaning. Avoid `SYNC_DELAY_MS` / `FRESHNESS_DELAY_MS` / `INDEX_DELAY_MS`.

**Local implementation status (Phase 1A partial):**

```text
[~] Timing constants extracted and call sites wired
    Evidence: local uncommitted work on branch tip f93f060
    Files: packages/mcp/src/config.ts, sync.ts, handlers.ts, manage-maintenance-handlers.ts
    Tests: packages/mcp/src/config.freshness-timing.test.ts (2 cases; naming/defaults)
    Not committed; not CI-proven as a release unit
```

---

# 5. Lifecycle ownership

Only the **embedding-capable** provider runtime owns background sync and watcher start/stop.

Local-only path: recovery only (`runPostConnectStartupLifecycle`).

Invariants:

```text
At most one bg lifecycle per embedding SyncManager
At most one watcher lifecycle per embedding SyncManager
At most one mutation lease owner per root
```

Lifecycle must be idempotent, dispose-safe (including cancelled 5s initial timer), and diagnostically observable.

---

# 6. Watcher behavior (strengthen)

Events never call Core indexing directly. They:

1. Advance a **change epoch** (or equivalent pending marker).
2. Reset debounce.
3. Record `lastEventAt`.
4. After quiet period, call `ensureFreshness(root, 0)`.
5. Clear pending only when a completed pass **covers** the latest observed epoch.

### Burst

Multiple events within debounce → one forced pass after quiet.

### Event during sync (generation-safe)

```text
1. Observe event → bump observedChangeEpoch
2. Sync starts → capture epochStart = observedChangeEpoch
3. Sync completes publication (or classified terminal outcome)
4. If observedChangeEpoch > epochStart → schedule follow-up
5. Clear pending only when completed pass covers latest epoch
```

A bare boolean `follow_up_required` is weaker under multi-event failure sequences; prefer epoch.

Watcher epochs are deliberately process-local. They describe only events seen
by that watcher process. A process that wins the cross-process mutation lease
must still perform the filesystem comparison; it cannot treat another process's
unshared epoch counter as source coverage. A strict waiter may join in-flight
work only when canonical root, runtime fingerprint, index policy, captured
request epoch, and cancellation state are compatible. Caller cancellation
detaches that waiter and does not abort shared work owned by other callers.

### Watcher failure

Do not claim continuous observation. Keep search / background / manual. Structured reason; restart when safe.

---

# 7. Watcher-disabled policy

### Balanced (product default — current)

- Search threshold 3m; background threshold 3m; manual 0.
- `skipped_recent` may reuse publication.
- Continuous observation unavailable; warn without claiming vectors are invalid.

### Strict search (target Phase 3)

`require_current`: do not retrieve unless this request obtains or joins a completed, authority-preserving live comparison that covers the captured request boundary and binds retrieval to the resulting publication receipt. On failure: fail before results — **no quiet degrade**.

### Eval / manual freeze (preferred for measured runs)

Do **not** use measured `require_current` as the default eval search mode (lease/mutation thrash, non-determinism).

```text
1. Explicit manage_index sync (or require_current once in preparation)
2. Prove zero-change (or accept known delta)
3. Freeze publication receipt
4. Measured searches with published_index (no sync)
5. Reject run if publication identity changes mid-suite
```

### Evaluation controls

- Watcher off.
- Background off, or a mechanically proven inactive background lifecycle for
  the complete measured interval.
- `published_index` only for timed samples.

---

# 8. Search behavior and modes

### Keep current fields

`freshnessDecision.mode`, timestamps, threshold, stats, `SOURCE_FRESHNESS_UNVERIFIED`.

### Additive fields (later)

`trigger`, watcher facts, `indexMayExcludeRecentEdits`, `recencySource`, publication binding used for retrieval.

### Modes (Phase 3 — public contract)

| Mode | Meaning |
|---|---|
| `best_effort` (default) | Today’s search threshold behavior. |
| `require_current` | Retrieval only after this request’s covered live comparison + bound publication; else fail closed. |
| `published_index` (prefer over `index_only`) | Search only current publication; **no** search-triggered sync; no claim of live-tree freshness; still fail if publication becomes unusable while preparing the read. |

Both `require_current` and `published_index` must return the publication receipt
used for retrieval. The receipt includes canonical root, runtime fingerprint,
collection name, marker run ID, index-policy hash, and policy-document digest.
A backend publication generation may be included only when it is a stable
searchable-publication identity; mutation-lease generation is diagnostic and is
not part of publication equality. Retrieval must pin the named generation where
the backend permits it, otherwise revalidate the same receipt immediately before
and after storage reads and reject any mismatch.

#### `require_current` failure matrix (must be specified in contract tests)

| Condition | Expected |
|---|---|
| Lease held by another process | Fail or bounded wait then fail; never silent old index |
| Sync already active | Join compatible in-flight sync if authority-preserving; else fail |
| Checkpoint unavailable / corrupt | Fail closed |
| Path missing | Fail closed |
| Ignore reload failed | Fail closed (existing block semantics) |
| Pending watcher event after comparison | Must not claim coverage of later epoch |
| Timeout / cancel | No orphaned waiter; no partial “current” success |
| Tree changes after comparison before retrieval | Bound retrieval to comparison’s publication; do not claim post-retrieval disk identity |

#### Warning copy (watcher unavailable)

> The index is searchable, but continuous working-tree freshness is not verified. Run `manage_index sync` to check immediately.

---

# 9. Background synchronization

Already: start after embedding runtime; initial delay; self-schedule after completion; per-root try/catch; stop on dispose.

Document:

> Five seconds is the earliest time the first background freshness **consideration** begins — not a promise a scan or mutation runs.

Tick telemetry (later): considered / skipped_recent / synced / stats / failures / lease contention / duration / next run.

---

# 10. Single incremental pipeline

```text
trigger (watcher | search | background | manual)
  → requestFreshness({ root, trigger, threshold, policy, preparedReceipt })  // thin wrapper
  → ensureFreshness
  → syncCodebase
  → reindexByChange
  → publish / maintain completion marker
```

Trigger code chooses threshold + records metadata. No second algorithm.

### Phase 2 coordinator starts as instrumentation wrapper

```text
requestFreshness({ root, trigger, threshold, policy, preparedReceipt })
  → log trigger
  → ensureFreshness(...)
  → log result
```

No new scheduling/authority semantics until tests cover the wrapper; then add event-follow-up epochs.

---

# 11. Real live-tree comparison (definition)

A **real comparison** requires all of:

1. Canonical root resolved.
2. Source/completion checkpoint accepted (or classified unavailable — then not a successful comparison).
3. Ignore-control path checked or reconciled as required by policy.
4. Filesystem snapshot / merkle evaluation performed (not short-circuited solely by recency).
5. Added / modified / deleted counts produced (zeros allowed).
6. No skip due solely to `skipped_recent` or unavailable authority for the forced path.

### Comparison vs mutation timestamps

| Timestamp | Updated when |
|---|---|
| `lastSuccessfulComparisonAt` | Real comparison completed (including zero-change) |
| `lastSuccessfulMutationAt` | Mutation actually changed index payload or required durable mutation identity change |
| `lastPublicationChangedAt` | Published search identity / marker fields changed |

Search recency windows should prefer **comparison** time, not “any mutation.”
Today’s `lastSyncTimes` is a coarse process-local proxy; Phase 1B/2 may split without changing default thresholds until proven.

Thresholds and durations use a monotonic clock. Wall-clock timestamps are for
reporting only and cannot decide recency or timeout ordering. Failed epoch
coverage retains pending state and retries with bounded backoff.

---

# 12. Concurrency

Handle: event-during-sync, bg-during-manual, search-during-mutation, multi-client, dispose during delay/sync, ignore-file races, cross-process lease contention (not only process-local `activeSyncs`).

Per-root activity: `idle | pending | syncing | follow_up_required | failed` with
`pendingReasons`. The initial implementation defines no priority queue; manual
requests never bypass the lease.

---

# 13. Observability

Separate timestamps for: last watcher event, last sync attempt, last successful comparison, last successful mutation, last publication change, last background tick, last search freshness decision.

Recency diagnosis: always include `recencySource` when recency is reported.

Metric labels: avoid raw repository paths (cardinality); use bounded/hashed root ids.

---

# 14. Test plan (summary)

Fake timers for unit timing.

- Constants independent; disabled lifecycle creates no timers.
- Watcher: debounce, burst, disabled no schedule, event-during-sync follow-up covers epoch.
- Background: initial delay, skipped_recent, threshold expiry, no overlap, dispose cancels delay.
- Search: within window = reuse + not “compared”; after threshold = real comparison; `published_index` no sync; `require_current` fail matrix.
- Manual: threshold 0; mechanical success vs coalesced/blocked.
- E2E watcher on/off; eval freeze path rejects publication drift.
- Cross-process lease contention tests where feasible.

---

# 15. Defaults (current vs target)

```text
Watcher enabled:                 true (current)
Watcher quiet period:            5s (current)
Search mode:                     best_effort / 3m threshold (current)
Background initial delay:        5s (current)
Background interval / max age:   3m (current)
Manual sync max age:             0 (current)

Evaluation measured mode:
  Current:   explicit manage_index sync (+ zero-change proof when required), then normal or published-index-style reuse
  Target:    prepare with sync/require_current → freeze receipt → measure with published_index
  Not target as measured default: require_current on every timed sample
```

---

# 16. Canonical user-facing explanation

> Satori has two separate five-second timers. With the filesystem watcher enabled, five seconds is the quiet period after file events before an incremental sync is requested. Separately, when the embedding-capable runtime starts, the background loop waits five seconds before its first freshness consideration, then roughly every three minutes.
>
> Neither timer means every edit becomes searchable in five seconds.
>
> With the watcher enabled, saves trigger a debounced incremental sync. With the watcher disabled, incremental indexing is pull-based: search freshness, background consideration, or manual `manage_index sync`.
>
> Search and background normally use a three-minute recency window. Inside that window a request may reuse the published index without comparing the working tree again (`skipped_recent`). That is not a claim that the disk was just inspected. For workflows that must include the latest disk state, use manual sync or a strict search mode that requires a covered live comparison bound to a publication receipt.

---

# 17. Rollout

### Phase 1A — contract extraction and warm-read correction

- Named constants (local done; commit when ready).
- Trigger names on decisions/logs.
- Expose watcher lifecycle facts already available; do not invent continuous truth.
- No new public search modes.
- Freeze the intentional background-threshold change: recent roots skip without
  lease churn; expired roots compare; manual threshold zero remains forced.

### Phase 1B — evaluation hardening (reproducibility)

- Explicit pre-sync before measured suites.
- Zero-change proof where required.
- Freeze publication receipt.
- Measured `published_index` (or equivalent no-sync) searches.
- Reject unexpected publication identity change.
- Document zero-change / warm-cache interaction.
- Bind full corpus Git SHA and clean state, task-suite hash, MCP/Core build
  artifact hashes, recorder hash, Node/storage identities, and expected
  fingerprint differences. Release evidence rejects dirty runtime worktrees and
  missing or unequal artifact identities.
- Disable watcher and background mutation throughout timed samples, or prove
  mechanically that neither lifecycle was active.

### Phase 2 — event follow-up correctness

- Change epochs.
- Covering publication clears pending.
- Thin `requestFreshness` wrapper first; then follow-up logic.
- Fake-clock race tests; cross-process lease where possible.
- Rollback signals: duplicate sync rate, search p95, warm recount spikes, follow-up loop rate.

### Phase 3 — public search modes

- `best_effort`, `require_current`, `published_index`.
- Fail matrix for strict mode; bounded wait/cancel.
- Feature flag; compare latency, embed calls, blocked strict rate, stale-possible rate.

### Phase 4 — optional lifecycle decoupling

- Lightweight scheduling only if it cannot perform embedding without capable runtime.
- Optional durable comparison timestamps bound to authority (not bare clocks).

---

# 18. Definition of done

1. Two five-second mechanisms have distinct names and metrics.
2. Freshness triggers use one pipeline; coordinator starts as instrumentation.
3. Search responses can expose multi-dimensional projection without a single false enum.
4. Strict searches prove coverage + publication or fail closed.
5. `published_index` forbids request-initiated sync and live-tree claims.
6. Watcher-disabled behavior is tested.
7. Concurrent triggers cannot duplicate mutations; pending cleared only after covering publication.
8. Background lifecycle observable and dispose-safe.
9. Evaluation uses freeze path, not implicit timers alone.
10. Docs never imply “edits indexed in 5 seconds.”
11. Strict request never satisfied by a sync that cannot prove request-epoch coverage.
12. Zero-change sync does not change **published search identity** without an explicit contract that allows it; warm paths document receipt revalidation requirements.
13. Warm prepared reads that survive zero-change must prove revalidation (not assume it).
14. Watcher configured / started / ready / failed / disabled independently observable.
15. `require_current` and `published_index` results always identify the
    publication used and reject pre/post retrieval receipt drift.
16. Strict freshness has bounded waiting, cancellation, and explicit failure modes.
17. Cross-process contention tested where feasible.
18. Fake-clock determinism for timers/thresholds/skips where practical.
19. Zero-change operations may advance mutation generation, but a retained warm
    prepared read must revalidate the unchanged publication receipt without an
    exact payload recount.

### Rollback gates (Phases 2–3)

Duplicate synchronization rate; search p95; freshness timeout rate; embedding-call increase; warm-cache recount increase; strict-mode block rate; watcher follow-up loop rate. Use hashed/bounded root identifiers in metrics.

---

# 19. Implementation file map

| Concern | Primary files |
|---|---|
| Constants | `packages/mcp/src/config.ts` |
| Gate + watcher + bg | `packages/mcp/src/core/sync.ts` |
| Search threshold | `packages/mcp/src/core/handlers.ts`, `search-frontdoor.ts` |
| Manual sync | `packages/mcp/src/core/manage-maintenance-handlers.ts` |
| Lifecycle ownership | `provider-runtime.ts`, `start-server.ts` |
| Incremental mutation | `packages/core/src/core/context.ts` (`reindexByChange`) |
| Mutation fencing | `mutation-lease.ts` |
| Warnings / responses | `warnings.ts`, `search-response-helpers.ts`, `tool-response-builders.ts` |
| Timing tests | `config.freshness-timing.test.ts`, `sync.test.ts`, lifecycle tests |

---

# 20. Non-goals

- Full-tree hashing on every default search.
- Second background loop on local-only startup.
- Silent default flip to threshold 0 / measured `require_current`.
- Store-provider choice as part of freshness work.
- Single overall freshness enum as authority.
- Persisting bare timestamps without publication/runtime authority binding.

---

## Related documents

- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
- `docs/plans/INDEX_STATE_STABILITY_PLAN.md` (search remains sync-on-read exception; fail closed before results)
- Qual notes: process-local recency + watcher-off pull path; background threshold must not thrash warm readiness
