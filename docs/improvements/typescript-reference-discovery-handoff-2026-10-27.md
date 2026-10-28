# TypeScript reference discovery: implementation handoff

Status: implemented on 27 October 2026, then repaired after review. Results are
in `TASKS.md` and `change-proportional-sync.md`. The end-to-end WSL probe
remains open.

Review repair: the first version checked only previously observed paths, so a
source edit could add an import or reference and reuse a stale success. It also
charged JSON program inputs against the metadata budget alone. Every recorded
read now keeps the budget that admitted it and contributes to an aggregate
digest of the bytes the compiler consumed, and the saved format moved to 2. A
warm 713-file discovery now takes about 0.6 s against 3.3 s cold, and the
content check costs about 140 ms per hit.
Prepared on 27 October 2026 for a worker that needs explicit steps and stop conditions.

## 1. Outcome and scope

Avoid repeated declaration emission during TypeScript project discovery when a saved result remains valid.
Keep semantic evidence, diagnostics, resource failures, dependency invalidation, and published results equivalent to a fresh analysis.

The user's pasted report gives these measurements. This review did not reproduce them:

| Measurement | Reported time |
| --- | ---: |
| TypeScript edit-sync median | 3,165 ms |
| Python edit-sync median | 2,640 ms |
| Cold discovery | 2,515 ms |
| Second discovery in the same analyzer | 188 ms |
| New analyzer with parsed-config persistence | 2,422 ms |
| Config parsing across five projects | About 42 ms |

Treat 188 ms as a comparison point, not an acceptance promise.
The two discovery cases differ in analyzer lifetime as well as disk persistence.
The TypeScript/Python difference does not prove which TypeScript work is unnecessary.

Initial implementation scope: reference-discovery metadata and its persistence, integration, tests, and measurement.
Do not redesign shards, retain native compiler processes, introduce a daemon, add dependencies, or change public APIs.
Do not modify the Go tree-cache repair or rebuild its WASM asset.
Do not commit, push, reset, stash, change branches, or delete existing cache data.

## 2. Baseline and existing work

Review HEAD: `368bbc27ca0e08b3659d99cc197c62b8f40163e7`.
The working tree is part of the baseline. HEAD alone lacks the existing cache work.
Before implementation, read `AGENTS.md`, run `git status --short`, and inspect the current diff.
If another session changed the relevant files, reconcile the changes before editing.

Existing modified files at review time:

- `TASKS.md`
- `docs/improvements/change-proportional-sync.md`
- `packages/core/assets/semantic-engine/satori-semantic-engine.wasm`
- `packages/core/assets/semantic-engine/semantic-engine.manifest.json`
- `packages/core/src/relationships/typescript-resolution-state.test.ts`
- `packages/core/src/relationships/typescript-semantic-analyzer.ts`
- `packages/core/src/semantic/typescript-configured-project.ts`
- `third_party/cbm-semantic/satori_semantic.c`

Existing untracked source: `packages/core/src/semantic/typescript-configured-project-cache.ts`.
This plan and its README row are additional documentation changes from the review.
Preserve all earlier work. The five-file tree-cache work includes shared documentation edits.
Do not restore a whole file to HEAD when removing only parsed-cache additions.
Do not remove `/tmp/opencode` or any other session's scratch directory.

## 3. Required source reading and established facts

Read the named symbols and their nearest tests before editing:

| File | Read and understand |
| --- | --- |
| `packages/core/src/relationships/typescript-semantic-analyzer.ts` | `referenceDeclarationState`, `referenceStatesReady`, `referenceAuthorityReady`, `projectControlFiles`, `controlIdentity`, `discoverPlans`, root-state persistence, idle release |
| `packages/core/src/semantic/typescript-reference-cache.ts` | State shape, fingerprint lookup, entry and byte bounds, eviction |
| `packages/core/src/semantic/typescript-program-session.ts` | Native process ownership, bounded reads, snapshot refresh, resource accounting, disposal |
| `packages/core/src/semantic/typescript-configured-project.ts` | Config loading, identity, source budget tracker, optional parsed-project constructor argument |
| `packages/core/src/semantic/typescript-configured-project-cache.ts` | Existing uncommitted persistence and its witnesses |
| `packages/core/src/relationships/typescript-resolution-state.test.ts` | Existing persisted analysis tests and parsed-cache additions |
| `packages/core/src/semantic/typescript-reference-cache.test.ts` | Existing cache bounds and eviction tests |
| `packages/core/src/semantic/typescript-resource-regressions.test.ts` | Existing native resource and reference-readiness coverage |
| `packages/core/src/relationships/typescript-resolution-shards.ts` | Existing shard discovery and merge behavior |
| `scripts/perf/README.md`, `scripts/perf/index-probe.mjs` | Existing measurement commands and built-output requirements |

Established from source:

1. `referenceDeclarationState` creates a native `TypeScriptProgramSession` for declaration/composite projects.
2. It calls `getDeclarationEmit(project.fileNames)` and retains only declaration output paths.
3. Its returned state contains `outputs`, `references`, `unproven`, and an optional resource failure.
4. It disposes the native session. The memory cache stores metadata, not a live compiler program or declaration text.
5. Its current fingerprint includes config-chain hashes, project filenames, and resource budget values.
6. `TypeScriptReferenceDeclarationCache` belongs to the analyzer and disappears on disposal or state release.
7. `projectControlFiles` uses declaration paths to include outputs in environment invalidation.
8. `controlIdentity` hashes those control files. `referenceStatesReady` separately checks declaration-file existence.
9. The native session disables source redirection for project references. Preserve declaration authority.
10. Native `EmitOutput` includes `emitSkipped` and diagnostics. Discovery currently consumes only output-map keys.

The parsed-cache test named “a source edit reuses the persisted configured project” currently makes no intervening source edit.
Its name is not evidence that edit invalidation works.

## 4. Ownership and invariant

The analyzer owns the decision to request reference-discovery metadata.
The existing reference cache owns bounded retention of that metadata.
Extend that owner for persistence rather than adding a second reference cache.
Keep compiler semantics and resource accounting in their existing owners.
Add no state or policy to `Context`.

Invariant: a reused entry must produce the same discovery controls and downstream behavior as fresh discovery for current inputs.
The analyzer supplies current inputs. Only a successful, proven computation may publish a persistent entry.
The saved file is disposable derived state. Repository files and native compiler behavior remain authoritative.
Any unknown witness, malformed entry, failed read, or failed write uses fresh discovery.

Code is necessary because the current metadata cache dies with the analyzer.
Documentation or config changes cannot preserve its result across analyzers.

## 5. Batch A: establish the cache contract before implementation

Do not copy the existing memory fingerprint directly into a persistent cache.
The fingerprint's existence is not proof that it covers every compiler input.

Create a small composite fixture with a referenced library and a consuming project.
Use the installed TypeScript 7 API through the existing session owner.
Do not substitute TypeScript 6 examples or assumed upstream APIs.

Compare fresh declaration-output path sets and reference lists for these changes:

- A function-body edit with unchanged filenames and config.
- An export/type edit with unchanged filenames and config.
- A change between script and module source forms.
- A syntax or declaration-emission error, then its repair.
- `noEmitOnError` enabled, with an error introduced and repaired.
- A file added, removed, or renamed.
- Declaration inputs and `.ts`, `.tsx`, `.mts`, `.cts` outputs where the compiler accepts those configurations.
- Config changes to output directory, declaration directory, root directory, references, and inherited settings.
- Package/type dependency changes, including an added `@types` package.
- Source growth beyond the file or project budget without a budget-value change.

Record what the compiler actually reads and which changes affect the retained result.
Use bounded, targeted instrumentation if existing hooks cannot answer that question.
Do not create a general filesystem recorder or a permanent profiling subsystem.

Choose the cache witness from that evidence:

1. Always include format version, compiler version, provider version, normalized root/config identity, config-chain content hashes, ordered project membership, and budget values.
2. Include additional inputs that affect output-path discovery or the validity of a successful computation.
3. If source contents affect the result, invalidate affected entries on those contents. Do not claim that arbitrary source edits can reuse them.
4. If resource success requires current source sizes or dependency reads, preserve those checks on a hit or invalidate the entry.
5. A successful result from yesterday does not establish successful admission today.
6. Cache only when all required inputs have a reliable witness. Otherwise use fresh discovery for that project.

Batch A deliverable: a concrete witness definition, the evidence supporting it, and a list of edits that permit reuse.
If a correct witness requires rebuilding the same compiler program, stop this approach and report the evidence.
Do not disguise that cost as cache validation.
Do not promise the 188 ms target until the fixture and realistic source edit both permit reuse.

## 6. Batch B: persist the existing bounded reference cache

Proceed only after Batch A establishes a useful, correct reuse case.
Implementation files: `typescript-reference-cache.ts` and `typescript-semantic-analyzer.ts`.
Change `typescript-program-session.ts` only if Batch A proves a narrow witness hook is necessary.
Keep any such hook optional and internal. Do not change normal session behavior.

Extend the existing cache with an optional disk backing under `options.stateDirectory`.
Preserve memory-only behavior when that option is absent.
Keep existing entry and retained-byte bounds. Bound the disk read before parsing JSON.
Validate serialized field types, versions, root identity, and array sizes before retaining entries.
Never serialize native handles, compiler programs, source text, declaration text, or resource-failure results.
Persist only proven successful metadata. An `unproven` result stays on the fresh path.

Use deterministic ordering and normalization for keys and serialized path lists.
Keep the existing root-state JSON format and filenames unchanged.
Use a distinct reference-metadata filename namespace. Leave old parsed-config files untouched and unused after retirement.
Do not add a legacy-format reader or migration layer for disposable cache files.

Read saved metadata once per discovery operation, not once per project lookup.
Validate the current witness before returning a saved entry.
Publish new entries only after successful computation and witness validation.
Check that inputs did not change during computation before publishing a reusable entry.
If the witness changes, discard the candidate. Let the existing sync consistency checks handle the operation.

For writes, use a unique temporary file and atomic rename in the same directory.
Remove only that write's temporary file after a failed write or rename.
Avoid persistent locks and background flushes. Complete the write before the operation returns.
Concurrent shards may publish complete snapshots with the same root namespace.
Accept a lost cache update as a future miss. Never accept partial JSON or skip witness validation.
If shard entries differ, the last complete snapshot may reduce reuse but must preserve correctness.

Continue to check declaration existence through `referenceStatesReady`.
Continue to hash declaration controls through `controlIdentity`.
Never persist a readiness boolean as permanent authority.
Dispose every native session on misses, exceptions, and resource failures.

## 7. Batch C: regression and equivalence checks

TDD route: no blanket strict TDD request. Add targeted regression coverage for the changed persistence mechanism.
Repository policy requires deterministic failure-path tests before the failure-path fix.
Use fault injection, not sleeps, for write and cleanup failures.
Use the existing Node test runner and fixtures. Add no dependency or public test-only option.

Extend `typescript-reference-cache.test.ts` for the persistence mechanism:

- A second cache instance loads a valid saved entry.
- Each witness component that Batch A identifies invalidates reuse when changed.
- Malformed, truncated, oversized, wrong-version, and wrong-root files produce misses.
- Unproven and resource-failure states never persist.
- Existing byte accounting, entry limits, and eviction still hold.
- Inject write and rename failures. Assert no partial final file and no leftover owned temporary file.
- Two writers cannot produce a partially readable entry. Stale entries still require current validation.

Extend `typescript-resolution-state.test.ts` for analyzer integration:

1. Warm discovery with analyzer A. Dispose A completely.
2. Perform a real source edit that Batch A establishes as reusable.
3. Create analyzer B with the same state directory.
4. Compare B against a new analyzer with an empty state directory on the edited tree.
5. Assert equal control discovery and semantic evidence.
6. Count reference-discovery program construction. Assert a cold miss performs it and an eligible hit skips it.
7. Count at the public discovery seam, before normal semantic analysis creates its own programs.
8. Use Node mocks on the existing session seam and restore mocks after each test.
9. Exercise a referenced library plus consumer. A project without references cannot prove the targeted saving.
10. Delete an emitted declaration after warming. Check that the consumer observes lost reference authority.
11. Change an emitted declaration's contents. Check the environment identity and dependent evidence update.
12. Exercise shard-local analyzer instances and compare merged evidence with the existing unsharded oracle.

Cover source growth and budget changes in the nearest existing resource tests if integration coverage does not exercise them.
For source-sensitive cases from Batch A, assert correct invalidation and equality with fresh analysis.
Do not change expected evidence merely to accept the cache's output.

Mutation check: temporarily omit a required witness component.
Run its existing invalidation test and confirm failure. Restore the component and rerun that test.
Run one representative equivalent check for output-existence validation as well.
Leave no mutation or temporary instrumentation in the final source.

## 8. Batch D: retire the ineffective parsed-cache path

Retire it only after the reference-cache integration passes.
Remove the `ConfiguredProjectCache` import, creation, lookup, and flush from analyzer discovery.
Restore direct config loading while preserving the operation's existing local config map.
Remove only the uncommitted parsed-cache module after checking that no callers remain.
Do not delete saved cache directories or user data.

Inspect the optional parsed-project argument added to `TypeScriptLanguageServiceSession`.
Remove it and its call argument only if no surviving caller needs it.
Preserve all other constructor and session behavior.
Retarget parsed-cache-specific test cases and helpers to the replacement contract.
Retain coverage for inherited configs outside the root and added `@types` packages where those inputs affect the new witness.
Do not delete pre-existing root-resolution tests or weaken their assertions.
Do not retain two disk caches to recover the reported 42 ms parsing cost.

## 9. Commands and verification order

Run commands sequentially. Do not run tests, builds, and benchmarks together.
The package's `test:raw` script includes globs. For a focused run, use its Node flags with explicit paths instead.

From the repository root:

```bash
pnpm -C packages/core exec node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/semantic/typescript-reference-cache.test.ts src/relationships/typescript-resolution-state.test.ts src/semantic/typescript-resource-regressions.test.ts
```

The boundary affects sync invalidation. Run the existing publication equivalence cases once after focused checks pass:

```bash
pnpm -C packages/core exec node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/generation/index-equivalence-sync-typescript-warm.test.ts src/generation/index-equivalence-sync-typescript-warm-workers.test.ts src/generation/index-equivalence-sync-typescript-cold.test.ts src/generation/index-equivalence-sync-typescript-cold-workers.test.ts
pnpm run check
pnpm --filter @satori-code/core build
pnpm --filter @satori-code/mcp build
```

`build` regenerates package `dist` output through the existing scripts.
No native semantic-engine rebuild is necessary for these TypeScript source changes.
If a command fails, report whether unchanged baseline code causes the failure.
Do not fix unrelated failures or broaden to all repository tests without a causal reason.
Reuse passing checks while their inputs remain unchanged.

## 10. Measurement and acceptance

Measure the local discovery seam first, using the same fixture and repository snapshot for both variants.
Use a standalone temporary harness outside source if no existing harness covers that seam.
Use three or more runs per case. Dispose analyzers between fresh-instance cases.
Keep root-resolution state separate from reference metadata so the harness identifies the measured mechanism.

Cases: cold cache, warm same analyzer, warm new analyzer, eligible source edit, source-sensitive invalidation, and file/config invalidation.
Record discovery duration, reference-program construction count, cache read/validation/write duration, peak process-tree memory, and machine load.
Report all samples and medians. State which source edit each number measures.
Cold runs must use fresh owned state directories. Never clear a user's index to simulate cold state.

Use the previous harness if recoverable. The pasted report does not identify its exact command or input snapshot.
If unavailable, establish a new before/after baseline. Do not compare a new harness against the reported 188 ms as a matched result.
Record the baseline build and candidate build identities, including dirty source differences.
Do not use branch switching or stash to create comparison builds.

For the real WSL end-to-end comparison, use the existing probe after building core and MCP:

```bash
SATORI_PERF_TRACE=1 node scripts/perf/index-probe.mjs <same-TypeScript-fixture> --save-search 1 --ext .ts --runs 3 --sync-gap 6000
```

Replace the fixture placeholder with the actual earlier input only after locating it.
Use an expendable fixture copy if the probe edits tracked files.
Keep both sides on the same machine, fixture, helper binaries, memory policy, and build configuration.
Run alternating before/after trials with at least three observations per side.
Record explicit edit-sync wall time, discovery spans/counts, result equality, edited-file search success, peak process-tree memory, and load.
Do not infer memory from the parent process alone.
Do not add CPU times across shards and call the sum wall-time saving.

Treat host access as a capability to check, not an established blocker from the previous session.
If WSL access or the original fixture is unavailable, deliver local results and state that end-to-end acceptance remains open.
Do not claim that eliminating local discovery closes the 525 ms end-to-end gap.

Acceptance requires equal published results and a repeatable latency reduction for the same real edit.
An eligible warm fresh analyzer must skip reference-discovery program construction.
Source-sensitive edits may invalidate entries. Report that limit explicitly.
If two attempts produce no measured gain, stop changing code and report the bottleneck evidence under repository policy.

## 11. Final delivery and stop condition

After measurement, update only the relevant TypeScript section in `TASKS.md` and `change-proportional-sync.md`.
Preserve the Go results and unrelated task rows.
Record commands, input/build identities, samples, medians, memory, load, equivalence evidence, and open limitations.
Mark work for review according to the existing ledger. Do not declare a human-owned task done.

Check `git diff --check`, `git diff --stat`, and `git status --short`.
Separate earlier user changes from this implementation in the handoff summary.
Stop when the scoped checks pass, required commands finish, owned temporary files disappear, and the measured result is reported.
If a contract gate or host limitation blocks completion, report the exact remaining requirement without inventing behavior.

This plan authorizes no new worker budget, branch operation, commit, push, dependency, or service.
The receiving session must follow the user's current execution instruction and applicable skills.
