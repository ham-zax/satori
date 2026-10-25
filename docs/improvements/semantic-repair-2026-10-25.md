# Semantic resolution repairs, 25 October 2026

Scope: six reproduced defects. The two deferred test-harness proposals stay outside scope.
Baseline: clean master at `8cb9c947`. No branch changes are required. Hamza later
requests a separate commit for the completed semantic repairs.

Owners and checks:

- Python resolution owns exact imports and import proof. Check repeated class
  imports, straight-line reimports, conflicting imports, and conditional reimports.
- TypeScript program sessions own native reads, overrides, and snapshot budgets.
  Check bounded disk reads, no disk-backed overrides, and rotating JSON imports.
- Configured projects own bounded config parsing. Reference declaration checks
  reuse that parsing and bounded program sessions. Check oversized references,
  config changes, reference outputs, and native process counts on warm checks.
- The declaration cache owns bounded reference metadata. Preserve TypeScript's
  config and output rules. Do not copy compiler glob or declaration-path rules.

Decision: code-change. Existing guards reject valid Python calls and miss
TypeScript limits. Documentation cannot repair either behavior.
TDD route: off, with diagnostic reproductions and focused regression tests.
Failure-path tests precede repairs where repository policy requires them.

State:

- Python: 38 focused tests pass. Parent reviewed the source diff.
- TypeScript: bounded reference config and source reads, no disk-backed overrides,
  and snapshot-specific source accounting are implemented.
- Review found native reuse of previously removed inputs without a read callback.
  The session now recovers missing byte witnesses from the active compiler snapshot.
  JSON and TypeScript A → B → A+B cases match cold budget failures.
- Mutation checks fail when snapshot-byte recovery or the config-chain hash is removed.
  Both source files were restored exactly after the checks.
- All 120 affected semantic and publication tests pass across focused runs.
  Final `pnpm run check` and diff checks pass. Review round two has no findings.
  OpenCode verification hit usage limits on both configured free providers.
  The parent completed the local check. Before the requested commit, a fresh run
  passes 85 tests across the seven directly affected semantic test files and
  `pnpm run check`. Earlier publication checks remain valid for unchanged inputs.

Retirement: remove unbounded reference parsing and disk-backed source overrides.
Preserve explicit in-memory overrides for callers that need them. No live data changes.

Reference-readiness measurement: one app references one composite library with an
existing declaration output. Each process primes the cache, then measures three
unchanged readiness calls. Both runs compile the selected analyzer module through
the same existing esbuild dependency. Baseline helper code comes from `8cb9c947`.
The remaining imported helpers use this checkout in both runs. The measurement
isolates reference-readiness setup, not full indexing.

Command: `SATORI_BENCH_MODE=before` or `after`, followed by
`/usr/bin/time -f 'peak_rss_kib=%M' node --liftoff-only --import tsx --input-type=module`,
with the fixture driver supplied on stdin. Node is 24.19.0.

- Before: 26.985, 22.927, 26.479 ms. Median 26.479 ms. Three native starts per call.
- After: 19.085, 17.716, 19.441 ms. Median 19.085 ms. Two native starts per call.
- Peak command RSS: 113,056 KiB before, 114,812 KiB after.
- Load averages: 0.67/1.26/1.14 before, 0.86/1.28/1.15 after.
- These fixture results do not establish an indexing speedup or a memory reduction.

Brief retrospective: source-mode tests missed seven TypeScript typing errors until
the existing workspace typecheck ran. Run that check before expanding a new test
family. Broad skill excerpts also consumed context. Read only the applicable ranges.
No new repository guard or rule is proposed because existing checks caught the errors.
