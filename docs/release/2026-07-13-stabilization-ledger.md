# Satori v3 authority stabilization ledger

This record covers the bounded findings discovered while stabilizing the canonical v3 persisted-authority cut. The broader repository launch-stabilization run was stopped before exhaustive coverage and clean-cycle verification; this document is not a `READY TO LAUNCH` declaration.

## Findings

| ID | Severity | Component | File and symbol | Violated invariant and reachable failure | User impact | Fix strategy | Required proof | Status | Release blocker |
|---|---|---|---|---|---|---|---|---|---|
| STAB-001 | P1 | Explicit reindex | `Context.resolveIndexPolicyForCodebase`; `ManageIndexingHandlers.startBackgroundIndexing` | A coherent retired v2 policy was admitted while constructing a reindex candidate. The only remediation failed before publishing v3. | Retired indexes could not be rebuilt through the advertised operation. | Add a Core-owned fresh-input resolver that reads current repo config/ignores/defaults and explicit updates without reading or rewriting retired authority; select it only for forced reindex. | Core policy-isolation test, worker resolver-selection test, public v2-to-v3 lifecycle/restart/search test. | Fixed and verified | Yes |
| STAB-002 | P1 | Explicit reindex | `ManageIndexingHandlers.startBackgroundIndexing` prior-generation proof | Snapshot metadata could select the optional previous-generation preservation path; retired policy made `proveVectorGeneration` throw before the worker's guarded indexing body. | Explicit reindex could fail before candidate creation even though prior-generation preservation grants no authority. | On forced reindex only, treat a failed optional preservation proof as unavailable and continue; normal create behavior remains fail-closed. | Worker test with completed snapshot metadata and a retired-policy proof error. | Fixed and verified | Yes |
| STAB-003 | P1 | Call-graph publication | `RelationshipBackedCallGraph.rebuildForIndex`; reindex worker call site | After staged vector indexing, call-graph rebuild reopened active ignore policy and hit the retired v2 document before v3 publication. | Public reindex launched but failed after expensive indexing, leaving the retired tuple active. | Pass the already-resolved candidate effective ignore patterns into call-graph rebuild; do not reopen durable authority during candidate construction. | Public v2-to-v3 lifecycle test must publish v3, restart strict proof, and return semantic results. | Fixed and verified | Yes |
| STAB-004 | P2 | Durable rollback acknowledgement | `Context.restoreDurableIndexAuthority` | Restoration of unsupported future policy bytes committed and removed its journal, then runtime refresh threw and reported the committed restore as failed. | Misleading recovery telemetry and unsafe retry decisions. | Return `restored_unsupported_authority`, clear runtime/derived SQLite state, preserve exact bytes, and skip import. | Exact-byte unsupported-policy restore test. | Fixed and verified | No |
| STAB-005 | P2 | Schema diagnostics | `inspectCompletionMarker`; `inspectIndexPolicyDocument`; `resolveCurrentNavigationGeneration`; MCP `validateMarkerShape` | Prefix-only matching classified garbage/beta/nonexistent policy-v1 labels as future authority. | Incorrect “upgrade runtime” remediation and inconsistent repair classification. | Reserve unsupported for exact numeric family versions greater than v3; keep known retired versions explicit and malformed labels corrupt/invalid. | Core marker/policy/pointer tests and MCP invalid-kind test. | Fixed and verified | No |
| STAB-006 | P2 | Future marker repair regression | `Context.repairIndex` | The static review alleged future markers could be mistaken for missing. Current code already refuses before writes, but lacked an explicit regression proof. | Potential future regression could overwrite newer authority. | Retain current behavior and assert repair plus completion reads preserve exact marker/policy bytes. | Future marker/policy no-write repair test. | Covered and verified | No |
| STAB-007 | P0 | Durable rollback recovery | `Context.parseDurableAuthorityRestoreTransaction` | A journal could supply arbitrary temporary and displaced paths that startup recovery would rename or remove. | A malformed journal could modify files outside Satori-owned authority paths. | Bind the journal filename, transaction ID, canonical root, targets, temporary paths, and displaced paths to exact deterministic values before any recovery callback runs. | External-sentinel regression proving an escaping auxiliary path is rejected without writes. | Fixed and verified | Yes |
| STAB-008 | P1 | Startup recovery fencing | `Context.recoverDurableIndexAuthorityTransactions`; MCP context construction | Startup recovery could mutate policy and pointer authority without excluding a live mutation owner; missing or denied fencing still allowed context construction. | Recovery could race a current writer or a process could operate over an unresolved tuple. | Require a synchronous fenced recovery publisher, acquire the existing root mutation lease in production, and fail context construction without successful fenced publication. | Startup success, live-owner denial, no-publisher, and mutation-lease/provider tests. | Fixed and verified | Yes |
| STAB-009 | P2 | Vector-only navigation | Search readiness and maintenance warning projections | Canonical v3 `navigation: { status: "not_bound" }` was vector-readable but emitted repair guidance even though no navigation damage existed. | Users were told to repair an intentional vector-only generation. | Reserve navigation-repair warnings for missing, corrupt, incompatible, or unverified evidence; keep `not_bound` vector-readable without strict navigation claims. | Search and status regression proving semantic results remain usable without `NAVIGATION_REPAIR_REQUIRED`. | Fixed and verified | No |

## Verification

- `pnpm --filter @zokizuan/satori-core test`: 388 passed.
- `pnpm --filter @zokizuan/satori-mcp test`: 832 passed.
- `pnpm --filter @zokizuan/satori-cli test`: 112 passed.
- Focused Core context suite: 154 passed.
- Focused durable-recovery tests: 4 passed.
- Focused mutation-lease/provider tests: 17 passed.
- Focused `manage_index` tests: 15 passed.
- `pnpm run check`: passed lint, type checking, and version-freshness checks.
- `git diff HEAD --check`: passed for the combined worktree.

The standalone integration suite and the abandoned exhaustive launch workflows were not rerun in this bounded continuation. The MCP package suite includes the public retired-v2 reindex, restart-proof, and search lifecycle regression.

## Scope boundary

All findings listed above are closed. No claim is made here about unreviewed repository areas or the two clean launch cycles from the discontinued stabilization campaign.
