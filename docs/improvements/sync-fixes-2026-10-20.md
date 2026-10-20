# Sync repair checkpoint

## Intent and baseline

Repair the eight sync defects in the user's report. Stop after focused regression
and affected consumer checks pass. No commits or adjacent repairs.

Task start: HEAD `94bb37ca`. Existing user edits cover root-bound-fs.ts and its
test, snapshot-codec.ts and its untracked test, and sync-scan.ts and its test.
Preserve those edits. Initial focused run: 46 tests pass across four files.

Baseline read-set: synchronizer-registry.ts and its tests, synchronizer.ts,
sync-scan.ts and its tests, root-bound-fs.ts and its tests, snapshot-codec.ts,
index-policy.ts, Context's three freshness comparison methods, generation
workflow control discovery, publication contracts, and package ownership discovery.
The code graph is dated 6 October. Changed source files require direct reads.

## Decision and boundary

Decision: code-change. The registry constructs comparisons without the control
paths supplied during publication. Reuse current control discovery through a
stateless generation helper. Pass its paths explicitly into the registry and
include them in the cache signature. Deriving only from the checkpoint misses
new controls. Context only wires the helper and awaits its result.

Invariant: generation and comparison use the same source-control discovery.
Lifecycle: discover for each operation, construct or reuse a comparison.
Authoritative writer: filesystem discovery reads current controls. The immutable
checkpoint remains source authority. No new persistent state or schema.
Callers: full indexing, incremental indexing, and Context freshness comparisons.

Patch shape: shared policy extraction and explicit comparison input. Canonical
owner: generation source-control discovery. Minimality: sufficient repair.
Remove the workflow's moved helpers. Preserve their filtering and ordering.
Architecture review: bounded owner-fit check, with Context limited to wiring.
TDD route: off. Add regression evidence where existing tests miss the defects.

The other seven defects stay within their existing filesystem, scan, and codec
owners. Keep ENOTDIR absent, symlinked parents not_indexable, and typed NoFollow
errors. Test policy-probe failure without relying only on permissions.

## Repairs

1. Registry comparisons receive current publication controls explicitly.
   Shared discovery also finds controls added after the checkpoint.
   Control paths participate in the comparison cache signature.
2. Policy-probe EACCES and ENOENT failures mark files unreadable.
   Scans preserve prior hashes and stats and continue with other sources.
3. Hash streams read at most one byte beyond the observed size.
   The existing stat comparison rejects concurrent growth.
4. Checkpoints accept finite negative timestamps and reject negative sizes.
5. NoFollow root escapes and final symlinks throw RootBoundFileError with
   root_binding_invalid. Existing messages remain intact.
6. Root containment accepts filesystem-root descendants while preserving
   separator boundaries. The test also uses the platform's native root.
7. Exact observation treats ENOTDIR as absent.
8. Exact observation rejects symlinked parents as not_indexable, matching scans.

## Evidence and closure

Both new registry tests fail before the repair. They pass afterward.
The checkpoint already contains controls, which excludes checkpoint omission
as the cause. Publication discovery is the policy owner.
The extracted helper matches previous output and analyzer requests across five
analyzer and source-selection branches. The old workflow helpers are removed.
No alternative discovery policy or persistent state remains.

114 distinct tests pass across 17 files:

| Scope | Tests |
|---|---:|
| root-bound-fs.test.ts | 18 |
| snapshot-codec.test.ts | 2 |
| sync-scan.test.ts | 17 |
| synchronizer-registry.test.ts | 14 |
| publication-source-controls.test.ts | 1 |
| Twelve publication, equivalence, and adjacent sync files | 62 |

The public Context comparison tests cover existing and newly created tsconfig
controls under the minimal profile. Registry tests cover changes and deletions.
Injected EACCES and ENOENT failures cover both policy probes deterministically.
Hash tests cover growth, empty files, one-byte files, and multiple stream chunks.

Tests use the package's test:raw Node flags with explicit file arguments and
test-concurrency=1. The twelve-file consumer run passes in 4 minutes 41 seconds.
Its files are auxiliary-publication, package-ownership-publication,
typescript-semantic-publication, four index-equivalence-sync files,
index-equivalence-toggles, merkle, root-bound-file-window,
synchronizer-ignore, and synchronizer-observation.

`pnpm run check` passes: lint, all three package typechecks, version references,
and package scope. Lint reports 60 existing warnings outside this repair.
The first check caught two unused bindings introduced by extraction.
The correction removes those bindings without changing calls or returned data.
`git diff HEAD --check` passes.

Confidence: B. Local evidence covers Linux. Windows execution is not tested.
Full repository tests are outside this focused run. No in-scope blocker remains.
Status: complete. Both public comparison tests also pass after the lint correction.

HEAD remains 94bb37ca on master. External staging occurred during this session.
The agent preserves that staging. Final corrections and this record remain
unstaged. No task branch, worktree, or worker needs cleanup.

## Brief retrospective and proposals

Combined reads exceeded the output budget and hid evidence. Budget total output
before batching future reads. The graph reports stale metadata for these files.
Use direct source checks for this run and refresh the graph before a future audit.
Lint caught unused bindings after extraction. Run focused lint immediately after
future extractions. These are process proposals, not additional code changes.
