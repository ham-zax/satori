# Indexing Lock Hardening Plan (Implementation Contract)

## Purpose
Prevent drift while implementing indexing-state determinism and tool-gating behavior.

This document is the execution contract for the current work. If implementation changes behavior, update this document and tests in the same patch.

## Finalized Decisions

1. Lock scope is **per-codebase** (not global).
2. During indexing for a codebase, block index-dependent tools for that codebase.
3. `read_file` is blocked during indexing for that codebase (all modes).
4. Blocked responses use structured envelopes with `status: "not_ready"`.
5. Stable reason codes are required in non-`ok` envelopes:
   - `reason: "indexing"`
   - `reason: "requires_reindex"`
   - `reason: "not_indexed"`
6. Single completion SSOT is `marker_doc`.
7. Debug completion-proof visibility is exposed and must be:
   - `"marker_doc"` (for this implementation).

## Public Contract Changes

The following are public API changes and must be reflected in tests/docs:

1. `search_codebase.status` adds `"not_ready"`.
2. `file_outline.status` adds `"not_ready"`.
3. `read_file` blocked behavior returns structured JSON (not plain text error).
4. `call_graph` blocked behavior aligns with `not_ready + reason`.
5. Freshness decision adds mode `"skipped_indexing"`.

## Envelope Normalization (Cross-Tool)

For all touched tools, non-`ok` structured responses must include both:

1. `status` (tool response status)
2. `reason` (stable branch key from shared enum)

Rules:

1. `status: "not_ready"` => `reason: "indexing"`
2. `status: "requires_reindex"` => `reason: "requires_reindex"`
3. `status: "not_indexed"` => `reason: "not_indexed"`

Scope clarification:

1. The required shared `reason` contract applies to gating envelopes:
   - `not_ready`
   - `requires_reindex`
   - `not_indexed`
2. For existing non-gating tool statuses (`unsupported`, `not_found`, `ambiguous`, etc.):
   - `reason` is optional
   - do not reuse `NonOkReason` unless the response is semantically one of the three gating reasons above.

Blocked envelope transport location by tool:

1. `search_codebase`: JSON envelope in `content[0].text`
2. `file_outline`: JSON envelope in `content[0].text`
3. `call_graph`: JSON envelope in `content[0].text`
4. `read_file`: JSON envelope in `content[0].text` (no plain text block response)

## Blocking Envelope Requirements

When blocked due to active indexing, envelopes must include:

1. `status: "not_ready"`
2. `reason: "indexing"`
3. `message` (human readable)
4. `hints.status` pointing to `manage_index(action="status")`
5. `indexing` metadata object with:
   - `progressPct` (number or `null`)
   - `lastUpdated` (ISO string or `null`)
   - `phase` (string or `null`)
6. Effective-root correctness:
   - include requested path context
   - ensure status/reindex hints target effective root (`codebaseRoot`)
7. Debug-only completion-proof metadata:
   - `hints.debugIndexing.completionProof: "marker_doc"`
   - optional `hints.debugIndexing.markerPresent: boolean`

## Shared Reason Enum (No Drift)

All touched non-`ok` envelopes must use one shared enum:

1. `type NonOkReason = "indexing" | "requires_reindex" | "not_indexed";`
2. No ad-hoc reason strings for these tool responses.
3. Any reason expansion requires doc + tests update in the same patch.

## Gate Precedence (Deterministic)

When multiple gates could apply:

1. Return `requires_reindex` first.
2. Else if actively indexing, return `not_ready` with `reason=indexing`.
3. Else return `not_indexed` when applicable.

This prevents indexing lock from masking fingerprint incompatibility.

## Completion Proof (Single SSOT)

Promotion to `indexed` is only valid when completion proof exists via `marker_doc`.

### Marker storage strategy

Use **Option B**: store marker as a reserved metadata document inside the existing code collection (no extra collection).

Constraints:

1. Marker docs must be excluded from semantic search candidate sets.
2. Marker docs must be queryable deterministically by marker kind/version.
3. Marker docs must not affect result ranking/diversity.
4. Exclusion should happen at query-time (filter/partition) when supported; fallback is deterministic post-filtering in core semantic search paths.

### Marker requirements

Marker doc shape (versioned):

1. `kind: "satori_index_completion_v1"`
2. `codebasePath`
3. `fingerprint` (embedding/model/dimension/vector provider/schema version)
4. `indexedFiles`
5. `totalChunks`
6. `completedAt`
7. `runId`

### Forbidden inference

Collection existence alone is never proof of completion and must not trigger `indexing -> indexed`.

### Marker lifecycle guarantees

1. On any indexing start (`create`/`reindex`), clear/remove stale marker before work begins.
2. While status is `indexing`, marker is treated as absent even if present.
3. Marker is written only on successful completion.
4. On failed indexing, marker remains absent.

## State Machine Rules

Allowed transitions:

1. `not_found -> indexing`
2. `indexing -> indexed` (only with valid marker proof)
3. `indexing -> indexfailed`
4. `indexed|sync_completed -> requires_reindex` (fingerprint gate)
5. `indexed|sync_completed -> indexing` (explicit create force/reindex)

Forbidden:

1. `indexing -> indexed` from cloud existence heuristic only.

### Cloud reconciliation mutation guard

For codebases currently `indexing`, cloud reconciliation is read-only and must not mutate status to `indexed`.

## Freshness/Sync Rules

1. If a codebase is `indexing`, `ensureFreshness` returns `skipped_indexing`.
2. No mutating incremental sync (`reindexByChange`) may run for that codebase while indexing is active.

## Call Graph Output Safety

1. Notes must be capped deterministically.
2. Responses must include truncation metadata when capped.
3. Notes must be filtered to query-relevant scope (not global noise dump).
4. Emit stable truncation warning code:
   - `CALL_GRAPH_NOTES_TRUNCATED`

### Deterministic note relevance and truncation order

Relevant note set:

1. Keep notes whose `note.file` belongs to files present in returned nodes/edges.
2. If `note.symbolId` exists, keep only when symbol is in returned node set.

Truncation order:

1. Sort deterministically by:
   - `file` asc
   - `type` asc
   - `symbolId` asc (nulls last)
   - `startLine` asc (nulls last)
   - `detailHash` asc (stable hash of detail string; use empty-string hash if detail is missing)
2. Truncate to `noteLimit`.
3. Return:
   - `notesTruncated: boolean`
   - `totalNoteCount`
   - `returnedNoteCount`
   - warning `CALL_GRAPH_NOTES_TRUNCATED` when truncated.

## Hidden-Path Consistency

Indexing and call-graph source collection must use the same ignore matcher SSOT.

Rules:

1. Sidecar rebuild input set must derive from the same effective ignore policy as indexing (`getActiveIgnorePatterns` + same matcher semantics).
2. No extra unconditional hidden-directory exclusion in call-graph collector.
3. If hidden behavior changes, it must change in one shared policy layer only.

## Test Requirements

At minimum, implement/adjust tests to prove:

1. No premature `indexing -> indexed` without marker proof.
2. `not_ready + reason=indexing` envelopes for blocked tools.
3. `requires_reindex` and `not_indexed` include stable reason codes.
4. `ensureFreshness` returns `skipped_indexing` during active indexing.
5. `read_file` returns structured blocked envelope while indexing.
6. Call-graph notes cap/filter behavior with deterministic truncation metadata.
7. Multi-codebase behavior: only active codebase is blocked.
8. Gate precedence: `requires_reindex` wins over indexing lock.
9. Effective-root behavior for subdirectory requests uses parent root in hints.

## Actionable Task List

### P0. State correctness and blocking contract

- [x] **T1: Add shared indexing block context builder**
  - Files:
    - `packages/mcp/src/core/handlers.ts`
    - `packages/mcp/src/core/search-types.ts`
  - Implement helper that resolves effective root and returns:
    - `isBlockedByIndexing`
    - `progressPct`, `lastUpdated`, `phase`
  - Ensure helper is used by all index-dependent handlers.

- [x] **T1.1: Add shared non-ok envelope builders**
  - Files:
    - `packages/mcp/src/core/handlers.ts` (or extracted helper module under `packages/mcp/src/core/`)
  - Implement shared builders:
    - `buildNotReadyEnvelope(...)`
    - `buildRequiresReindexEnvelope(...)`
    - `buildNotIndexedEnvelope(...)`
  - Enforce required fields (`status`, `reason`, `message`, `hints`, indexing metadata where applicable).

- [x] **T2: Add stable reason codes to non-ok envelopes**
  - Files:
    - `packages/mcp/src/core/handlers.ts`
    - `packages/mcp/src/tools/read_file.ts`
  - Enforce:
    - `reason=indexing` for `status=not_ready`
    - `reason=requires_reindex` for fingerprint-gated responses
    - `reason=not_indexed` for missing index responses
  - Implement with shared enum to prevent drift.

- [x] **T3: Block tools during active indexing (per-codebase)**
  - Files:
    - `packages/mcp/src/core/handlers.ts` (`search_codebase`, `file_outline`, `call_graph`)
    - `packages/mcp/src/tools/read_file.ts`
  - Return deterministic blocked envelope with `hints.status`.
  - Include indexing metadata fields in all blocked envelopes.
  - Ensure hints are generated against effective root (`codebaseRoot`), not only requested path.

- [x] **T4: Add `not_ready` statuses to public envelope types**
  - Files:
    - `packages/mcp/src/core/search-types.ts`
    - any tool-level schema wrappers in `packages/mcp/src/tools/*`
  - Update type unions and downstream parsing expectations.

- [x] **T5: Add `skipped_indexing` freshness decision**
  - Files:
    - `packages/mcp/src/core/sync.ts`
    - dependent test fixtures/types
  - Short-circuit `ensureFreshness` when status is indexing.

### P0. Single completion SSOT (marker_doc)

- [x] **T6: Define marker doc payload type**
  - Files:
    - `packages/core/src/vectordb/types.ts`
    - optional helper module under `packages/core/src/vectordb/`
  - Include required fields from this contract.

- [x] **T7: Write marker doc at successful indexing completion**
  - Files:
    - `packages/core/src/core/context.ts`
    - `packages/core/src/vectordb/milvus-vectordb.ts`
    - `packages/core/src/vectordb/milvus-restful-vectordb.ts`
  - Ensure marker write is part of successful completion flow only.
  - Ensure stale marker is cleared at start of every create/reindex run.

- [x] **T8: Read/verify marker doc for completion checks**
  - Files:
    - `packages/core/src/core/context.ts` (add completion probe helper)
    - `packages/mcp/src/core/handlers.ts`
    - `packages/mcp/src/index.ts`
  - Replace collection-existence-based promotion with marker verification.
  - Ensure marker lookup uses effective root and fingerprint validation.

- [x] **T9: Remove unsafe indexing->indexed promotion paths**
  - Files:
    - `packages/mcp/src/core/handlers.ts`
    - `packages/mcp/src/index.ts`
  - Keep cloud reconciliation but disallow promotion without marker proof.
  - Enforce read-only behavior for roots currently in `indexing`.

### P1. Call graph and consistency

- [x] **T10: Cap and filter call_graph notes**
  - Files:
    - `packages/mcp/src/core/call-graph.ts`
    - `packages/mcp/src/core/handlers.ts`
  - Add deterministic note limit + truncation metadata.
  - Filter note set to response-relevant scope.
  - Emit warning `CALL_GRAPH_NOTES_TRUNCATED` when truncation occurs.

- [x] **T11: Align hidden-path behavior**
  - Files:
    - `packages/mcp/src/core/call-graph.ts`
    - `packages/core/src/core/context.ts`
  - Ensure sidecar file collection follows indexing ignore semantics.

## TDD Cycle (Required Execution Order)

Apply red-green-refactor per slice. Do not batch all code first.

### E1. Reasons and envelope contract (MCP only)
1. Write failing tests for shared `reason` + `status` invariants across:
   - search_codebase/file_outline/call_graph/read_file blocked/non-ok envelopes.
2. Implement shared envelope builders.
3. Refactor call sites to use builders.

### E2. Indexing gate behavior (MCP only)
1. Write failing tests for per-codebase `not_ready` blocking + indexing metadata + effectiveRoot hints.
2. Implement blocking guard in handlers/tools.
3. Refactor duplicate gating logic into shared helper.

### E3. Freshness gate lock (sync layer)
1. Write failing tests for `ensureFreshness => skipped_indexing`.
2. Implement short-circuit and no-mutation guarantee.
3. Refactor sync gate checks for clarity.

### E4. Marker SSOT (core + MCP glue)
1. Write failing tests for:
   - no promotion without marker
   - promotion with valid marker
   - stale marker ignored during indexing
2. Implement marker write/clear/read logic.
3. Remove collection-existence completion inference.

### E5. Call-graph note control
1. Write failing tests for relevance filter, deterministic cap order, truncation metadata, warning code.
2. Implement note filtering/capping.
3. Refactor note sorting/truncation helpers.

### E6. Hidden-path consistency
1. Write failing parity test between indexer candidate set and sidecar collector (under same ignore rules).
2. Implement sidecar collector alignment.
3. Refactor shared ignore/matcher use.

### P2. Observability

- [x] **T12: Replace misleading tracking log text**
  - Files:
    - `packages/mcp/src/utils.ts`
    - call sites in `packages/mcp/src/core/handlers.ts`
  - Log real action/state, not “not marked as indexed”.

- [x] **T13: Add effective-root tagging to key logs**
  - Files:
    - `packages/mcp/src/core/handlers.ts`
    - `packages/mcp/src/core/sync.ts`
  - Make interleaved multi-codebase activity readable.

- [x] **T14: Optional retry hint for blocked manage operations**
  - Files:
    - `packages/mcp/src/core/handlers.ts`
  - If same-root manage action is blocked due to indexing, include:
    - `hints.status`
    - optional `retryAfterMs` (when known)

## Validation Checklist (Run Before Merge)

- [x] `pnpm --filter @zokizuan/satori-mcp test`
- [x] `pnpm --filter @zokizuan/satori-core test` (or targeted tests for vectordb/context if full suite is heavy)
- [x] Re-run/adjust:
  - `packages/mcp/src/core/handlers.scope.test.ts`
  - `packages/mcp/src/core/handlers.file_outline.test.ts`
  - `packages/mcp/src/core/handlers.call_graph.test.ts`
  - `packages/mcp/src/core/sync.test.ts`
  - `packages/mcp/src/tools/read_file.test.ts`
  - `packages/mcp/src/tools/search_codebase.test.ts`
