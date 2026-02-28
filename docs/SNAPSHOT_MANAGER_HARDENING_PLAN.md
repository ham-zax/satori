# SnapshotManager Hardening Plan

## Summary
This plan hardens `packages/mcp/src/core/snapshot.ts` for deterministic multi-process behavior while preserving the current strict legacy policy (`assumed_v2` entries require reindex).

Scope: P0 + P1 + P2.

## Locked Decisions
1. Legacy v2 fingerprint policy remains strict: migrated searchable entries with `assumed_v2` are blocked and require reindex.
2. Snapshot lock timeout behavior remains non-fatal: warn and skip save.
3. Implementation includes correctness, robustness, and ergonomics in one patch.

### Legacy Policy Clarification
- `assumed_v2` is blocked for `search_codebase`, `file_outline`, `call_graph`, and `read_file` access until reindex.
- `manage_index` lifecycle actions remain allowed for remediation (`create`, `reindex`, `sync`, `status`).
- This policy does not implicitly grant trust via sync; sync is maintenance, not proof promotion.

## Core Invariants
1. No CPU-spin fallback in lock wait logic.
2. Stale lock break requires dead or unreadable lock owner metadata.
3. Save merges local + persisted state under lock and preserves explicit local removals.
4. Merge precedence is explicit and deterministic (state-classed).
5. Startup load only writes when migration/pruning materially changes persisted representation.
6. Metadata-only setters do not trigger derived-state rebuild.
7. Dirty state tracks unsaved changes and is cleared only after successful save.

## Non-Searchable State Precedence Over SEARCHABLE

### State Classes and Precedence Matrix
- ACTIVE: `indexing`
- TERMINAL_BAD: `indexfailed`, `requires_reindex`
- SEARCHABLE: `indexed`, `sync_completed`

Merge rules (local vs disk):
1. ACTIVE beats SEARCHABLE and TERMINAL_BAD.
2. TERMINAL_BAD beats SEARCHABLE.
3. ACTIVE vs ACTIVE:
   - higher `indexingPercentage` wins
   - tie -> newer `lastUpdated`
4. TERMINAL_BAD vs TERMINAL_BAD:
   - newer `lastUpdated` wins
5. SEARCHABLE vs SEARCHABLE:
   - newer `lastUpdated` wins
6. ACTIVE vs ACTIVE stale handling:
   - if one indexing entry is stale (`lastUpdated` older than `INDEXING_STALE_MS`), prefer the non-stale entry even when progress is lower
   - then apply progress/timestamp tie-breaks

## Material Representation Change Definition
`loadCodebaseSnapshot()` should persist only when representation changed semantically.

A change is considered material when either is true:
1. Source snapshot format is not `v3` (migration required), or
2. Canonical serialized `codebases` content differs from in-memory canonical map after load-time validation/pruning.

Canonical compare means:
- compare `codebases` only (exclude snapshot-level `lastUpdated`)
- same key set
- same per-key value after stable key-ordered serialization
- load-time normalization must not rewrite fields unless intentional; intentional rewrites are treated as material change

Implementation rule: semantic compare (normalized v3 object), not raw file byte compare.

## TDD Cycles

### Cycle 1: Correctness
- Add failing tests:
  - `setCodebaseSyncCompleted(..., fingerprintSource)` does not preserve stale `assumed_v2`.
  - `setIndexedFileCount` updates immutably.
- Implement fixes.

### Cycle 2: Lock Hardening
- Add failing tests:
  - stale lock with live pid is not broken.
  - stale lock with dead/unreadable pid can be broken.
  - unsupported Atomics wait path exits lock attempt cleanly (no spin fallback behavior contract).
  - unsupported wait path keeps lock-attempt count bounded (instrumented call-count assertion).
  - stale-lock break branch follows the same bounded non-spin pacing/abort contract.
- Implement lock metadata read + pid liveness + no-spin fallback.
  - If `Atomics.wait` is unavailable, do not enter a tight retry loop.
  - retry behavior must be bounded by explicit non-spin control (immediate graceful fail for lock path is acceptable).

### Cycle 3: Merge and Validation
- Add failing tests:
  - local active state survives merge against newer disk searchable state.
  - malformed v3/v2 payload entries are ignored safely.
- Implement active-state merge precedence and stricter format/entry validation.

### Cycle 4: Load/Save and Corruption Handling
- Add failing tests:
  - clean v3 load does not force write.
  - migration or pruning triggers write.
  - corrupt snapshot is quarantined (`.corrupt-*`) before reset.
  - merge-from-disk path tolerates malformed snapshots that are not v1/v2/v3.
- Implement deterministic save gating and quarantine logic.
  - On corrupt snapshot:
    - preferred path: acquire lock, then rename to `.corrupt-*`.
    - if lock cannot be acquired: copy bytes to `.corrupt-*` (preserve diagnostics) and leave original untouched.
  - load/save compare uses canonicalized unknown-record normalization for deterministic semantic comparison (not raw parse-object identity).

### Cycle 5: Derived State + Dirty Semantics
- Add failing tests:
  - metadata-only setters preserve derived fields and skip derived rebuild.
  - metadata-only setters do not change indexed membership and are persisted on next save.
  - negative ignore rules versions are rejected.
  - lock-timeout save leaves dirty state true.
  - indexed codebases order is deterministic.
- Implement guard rails and dirty-flag lifecycle.
  - Add guard rails that metadata-only setters cannot change `status`, `indexingPercentage`, or `indexedFiles`.

## Dirty Flag Rules
1. Mutating setters/removals set `isDirty = true`.
2. Metadata-only setters set dirty but skip derived-state rebuild.
   - these updates are eventually persisted on the next successful save.
3. `saveCodebaseSnapshot()` clears dirty only on successful write.
4. If lock cannot be acquired, dirty remains true.
5. `loadCodebaseSnapshot()` resets dirty to false after successful load.
6. If load detects migration/pruning change, it triggers save; on save-skip (lock timeout), dirty remains true.

## API / Type Adjustments
1. `AccessGateResult.reason` narrowed to reindex reason union.
2. `getCodebaseStatus` return type updated to `CodebaseInfo['status'] | 'not_found'`.

## Acceptance Criteria
1. No busy-wait fallback remains in lock wait path.
2. Stale-lock break branch cannot tight-spin when wait path is unavailable.
3. `setCodebaseSyncCompleted` honors supplied `fingerprintSource`.
4. `setIndexedFileCount` performs immutable updates.
5. Live lock owners are not deleted as stale.
6. Merge precedence protects active states.
7. Load avoids unconditional saves for unchanged v3 snapshots.
8. Corrupt snapshot is preserved for diagnostics.
9. Metadata-only setters avoid O(n) rebuild and enforce derived-field guard rails.
10. Corrupt snapshot filenames include PID + timestamp to avoid collisions.
11. All MCP tests and build pass.

## Follow-up Tightening (Implemented)
1. Added explicit regression coverage that malformed `indexFingerprint` payloads are rejected during v3 load.
2. Hardened `readCodebaseMapFromDisk()` to reject non-v1/v2/v3 payloads deterministically (warn + local-only merge fallback).
3. Hardened lock acquisition so stale-lock break attempts use the same bounded wait/abort semantics as normal EEXIST retries.
