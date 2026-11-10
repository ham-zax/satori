# Linux ARM64 compatibility

Author: Ahmed Hamza  
Status: Implementation authorized on 2026-11-10. Native component qualification passes. Packed product acceptance remains open.  
Date: 2026-11-10  
Baseline: `556165fd31e31161d4000a00b2b1ba1843262197`

## Overview

Support the existing Satori runtime on Linux ARM64 without changing embedding models, search rules, or installation commands.
The initial target is Linux ARM64 with glibc, consistent with the ARM server context.
ARM64 means the AArch64 processor architecture. glibc is the GNU C runtime library.
Support requires a native installation and product run. An architecture name in a dependency map proves only selection support.

The user requests a direct EGM draft, without brainstorming. The user also requests development through subagents.
This document supplies the specification and worker boundaries. The user now authorizes implementation through bounded DeepSeek workers.
The user limits future workers to Pi with `mistral/deepseek-v4-1-flash-1017`, thinking `max`.
The coordinator owns research, architecture, briefs, and integration. Workers execute bounded instructions and report blockers.

## The Problem

The offline runtime rejects ARM64 before installation. Its packaged Potion helper is an x86-64 executable.
The runtime independently rejects ARM64 when it checks Potion artifacts.
The installer selects an x64 asset directory and trusts one x64 manifest digest.
LateOn selection also rejects ARM64. The CLI metadata defines Sharp native dependencies for x64 only.
Native search projections use an x64 addon, but TypeScript already supplies the same published projection output.
Package allowlists and release smoke scripts also assume x64.

Changing the platform checks alone can select missing assets or load the wrong executable.
Rebuilding binaries alone leaves installation and release checks unable to select them.
The earlier handoff does not establish end-to-end ARM support or upstream binary availability.

## Goals

1. A clean Linux ARM64 glibc host installs the packed offline runtime and runs Potion, LanceDB, indexing, and search.
2. The default LateOn path works on ARM64 before Satori advertises full default-runtime compatibility.
3. The explicit `--reranker none` path works independently of LateOn qualification.
4. Native projection output matches the existing TypeScript output. Existing fallback and cancellation behavior remain intact.
5. Artifact selection preserves architecture identity, pinned manifests, file checksums, notices, and the existing model identity.
6. Existing Linux x64 behavior passes its affected checks.
7. An ARM runner checks packed artifacts and executes the product, rather than only compiling TypeScript.

## Non-Goals

Do not add macOS ARM, Windows ARM, Linux musl support, emulation, GPU execution, or new runtime profiles.
Do not change ranking, embedding dimensions, model revisions, vector-store defaults, or client configuration formats.
Do not add a remote service, dependency, compatibility shim, or package-per-platform distribution model.
Do not migrate indexes or duplicate model downloads by processor architecture.
Do not redesign `Context`, runtime leases, publication, or synchronization.
Do not claim a performance improvement. ARM performance measurement is separate from compatibility acceptance.

## Evidence and baseline read-set

Repository evidence is authoritative for the current code. Upstream package support remains subject to native qualification.

| Boundary | Evidence | Design consequence |
|---|---|---|
| Potion source | `experiments/potion-l0-l1/Cargo.toml`, `src/main.rs`, `src/lib.rs`, `rust-toolchain.toml` | Build the actual helper crate with its locked dependencies. Do not invent a binary name. |
| Network guard | `experiments/potion-l0-l1/src/main.rs`, `tools/network_guard.c` | Check the worker guard on ARM, including denial of networking. |
| Potion package | `packages/mcp/assets/potion/linux-x64/manifest.json`, `packages/mcp/package.json` | Add a separate ARM helper manifest and package allowlist entries. |
| Installer authority | `packages/cli/src/install-preflight.ts:29`, `:132`, `:247` | Select a trusted manifest by the actual target. Do not accept an arbitrary manifest because its architecture field matches. |
| Asset location | `packages/cli/src/managed-runtime-paths.ts:36` | Select the host helper directory at the path owner. |
| Provider authority | `packages/core/src/embedding/potion-embedding.ts:227` | Permit the qualified ARM helper without relaxing artifact checks. |
| LateOn selection | `packages/cli/src/runtime-selection.ts:59` | Enable ARM only after the exact runtime closure executes. |
| Managed dependencies | `packages/cli/src/managed-runtime-closure.ts` | Existing ARM map entries need executable checks, not duplicate maps. |
| Projection loader | `packages/core/src/core/native-search-projections.ts:34`, `:69` | Select an ARM addon while keeping the established fallback. |
| Projection source | `experiments/napi-search-projections/Cargo.toml`, `package.json`, `README.md` | Use the existing N-API build and differential fixtures. |
| Release closure | `packages/core/package.json`, `packages/mcp/package.json`, both package release smoke scripts | A source-tree success cannot replace packed-package success. |
| CI | `.github/workflows/ci.yml` | Existing runners do not establish native ARM execution. |

The starting worktree is clean. No builds, dependency installs, remote host changes, or model downloads occur during drafting.

## Critical User Journeys

### CUJ 1: Install and use the default offline runtime

Given a clean Linux ARM64 glibc host with a supported Node version and no development toolchain,
when the user installs the packed CLI with `install --runtime offline`,
then the installer acquires the pinned models, selects ARM helpers, and starts the default LateOn runtime.
The user can index a small repository and receive search results through the installed client entry.
Runtime processes do not require network access after model acquisition.

### CUJ 2: Use explicit no-reranker mode

Given the same host,
when the user installs with `install --runtime offline --reranker none`,
then Potion, LanceDB, indexing, and search work without LateOn initialization.
The installer does not silently select this mode when the default reranker fails.

### CUJ 3: Reject an invalid artifact

Given an ARM host and a helper with wrong architecture, altered bytes, or an untrusted manifest,
when preflight checks the helper,
then installation fails before the installer activates that runtime.
Existing client entries and the previous working runtime remain usable under the current installer contract.

### CUJ 4: Preserve x64 and projection behavior

Given the same fixtures on x64 and ARM,
when each runtime builds search projections,
then published fields match the existing TypeScript oracle exactly.
Missing, invalid, or unloadable optional addons retain the existing fallback behavior.
Cancellation still waits for owned work to finish before completion.

## Technical Plan

### Native artifact production

Build each Rust crate on a native ARM64 glibc builder using its repository toolchain and lockfile.
Potion installs an x86 target in its toolchain file, but that list does not force the Cargo compilation target.
Set the ARM target explicitly. Do not change the x64 build contract.
Use a generic target CPU. Do not use `target-cpu=native` for distributed artifacts.
Inspect the resulting ELF architecture, required shared libraries, and symbol-version requirements.
Record the builder image, toolchain, source revision, command, file size, and SHA-256 in artifact provenance.
The builder must supply C/C++ tooling required by transitive tokenizer dependencies.
Use a build environment compatible with the oldest Linux runtime the release declares.
Until that runtime floor is established, do not publish a minimum-glibc claim.

Create `packages/mcp/assets/potion/linux-arm64/` with `satori-potion`, `manifest.json`, `MODEL_CARD.md`, and `MODEL2VEC_RS_LICENSE`.
Use `aarch64-unknown-linux-gnu` as the Rust target. Capture the produced executable name from Cargo and copy it to the established packaged name.
Preserve the existing model repository, revision, file sizes, and checksums. Models stay in the existing managed cache.
The ARM manifest declares exactly six paths: `satori-potion`, `model/config.json`, `model/model.safetensors`, `model/tokenizer.json`, `MODEL_CARD.md`, and `MODEL2VEC_RS_LICENSE`.
Generate the helper entry from the produced ARM bytes. Generate notice entries from their actual bytes.
Copy the three model entries verbatim from the x64 manifest, including their sizes and hashes.
Do not package model files under `linux-arm64/`. The published x64 package also excludes those model files.
Never copy the x64 helper hash or falsify provenance.

Create `packages/core/assets/native-projections/linux-arm64/` with `projection.node`, `manifest.json`, and `THIRD_PARTY_NOTICES.md`.
Build through the existing N-API package. Preserve its license and interface.
Keep the existing adjacent-manifest trust model. Generate the ARM addon hash from the produced bytes.
Do not add a pinned manifest digest for projections. Installer-level Potion trust is a separate existing contract.
Replace the fixed bundled root with target selection inside `resolveNativeProjectionAddonPath`.
Preserve the explicit `assetRoot` test seam, environment override, and fallback behavior.
Add the three explicit ARM file entries beside the existing x64 entries in `packages/core/package.json`.
Run the existing differential corpus before enabling the addon on ARM.

### Installation and provider boundaries

Keep path construction in `managed-runtime-paths.ts`, installer trust in `install-preflight.ts`, and provider checks in `potion-embedding.ts`.
The provider checks structure and readiness without repeating installer hashing.
Select the existing x64 directory or the ARM directory from the actual runtime target.
Use an explicit per-target trusted manifest digest at the existing installer authority.
Select that digest from the resolved host platform and architecture, never from fields in the candidate manifest.
The ARM target also requires qualified glibc. Do not infer glibc from a directory name.
Reject a manifest whose platform or architecture differs from the resolved host, including when the caller supplies `potionAssetsRoot`.
Preserve existing x64 platform behavior. Do not broaden ARM support to musl.
Keep complete artifact-list validation, model identity, executable checks, byte counts, hashes, and safe paths.
Propagate the selected target through existing installer test seams. A simulated host must not read the real host's manifest.
Change `resolvePotionAssetsRoot` to accept the package root and an explicit target with platform and architecture.
Pass the same resolved target at both `install.ts` call sites and at the `runtime-upgrade.ts` call site.
Use that target for preflight and model-manifest resolution as well. Check all transitive callers before writing the worker brief.
Do not introduce a second policy registry or add state to `Context`.

The invariant is that the selected helper and trusted manifest describe the executing target.
The installer writes runtime files under its existing lifecycle. The provider only checks and executes them.
Manifests remain package artifacts. Model acquisition and persistence remain with the existing model-store owner.

### LateOn and managed dependencies

First execute the exact pinned ONNX Runtime, Transformers, Sharp, LanceDB, OXC, and TypeScript packages on native ARM.
Check Sharp package names and versions against the existing `lateOn` package metadata contract.
Check the real pinned LateOn model session and scoring call. An import-only success is insufficient.
Only then add the verified ARM glibc Sharp entries and extend LateOn qualification to ARM.
Preserve explicit reranker choice and diagnostics. Do not silently disable LateOn.
If the exact pinned dependency lacks an ARM build, stop this slice and report the owner and failure.
A dependency upgrade or alternative runtime requires a separate decision.

### Packaging and CI

Keep the current package layout and add explicit ARM artifact allowlist entries.
Resolve packed smoke helper paths by host architecture. Model fixtures remain architecture-neutral inputs.
Inspect tarball contents before execution. Check executable permissions and both manifest closures.
Add a native ARM job to the existing workflow without multiplying the full operating-system and Node matrix.
Check the minimum supported Node release on ARM. Keep the existing x64 checks.
The ARM job uses the same release smoke entry points as x64 and exercises the default offline journey.
Extend all five existing x64-only smoke conditions to the qualified ARM target.
In the CLI smoke, cover the `lateOn` fixture flag, `assertManagedRuntimeSizeBudget`, `assertPackedLateOnNativeRuntime`, and `assertPackedPotionExecutionCapability`.
In the MCP smoke, cover the gate that invokes `runPackedPotionSmoke`.
Retain the existing size budget. If ARM exceeds it, report the measurement instead of raising the limit.
Require the ARM smoke to fail when its ARM helper is absent. A skipped execution check cannot satisfy acceptance.
If a suitable hosted ARM runner is unavailable, record the runner requirement before changing CI.

```text
actual host target
  -> managed runtime paths + pinned installer manifest
  -> packaged ARM helper + shared model cache
  -> Potion provider + LanceDB + qualified LateOn
  -> installed MCP entry -> index -> search

projection loader -> verified ARM addon -> published projections
                  -> existing TypeScript fallback
```

## Alternatives Considered

| Approach | Benefit | Failure condition or cost | Draft disposition |
|---|---|---|---|
| Native ARM builds in existing package layout | Preserves install contract and offline behavior | Requires a native builder and qualification | Proposed |
| Voyage-only workaround | Avoids the Potion helper | Needs an external API and does not satisfy offline compatibility | Does not meet the stated goal |
| x64 emulation | Reuses current binaries | Adds a runtime requirement and does not prove native compatibility | Outside scope |
| Cross compilation | Can produce ARM artifacts from x64 | Needs linker/sysroot configuration and still needs native execution | Optional later build method |

These dispositions follow the compatibility requirements. They do not authorize dependency or distribution changes.

## Non-Functional Requirements

Preserve the offline network guard and existing integrity checks.
Do not regenerate reference embeddings or weaken numerical tolerances to make ARM pass.
Floating-point differences must pass the existing inference contract before support is declared.
Keep runtime rollback and client-edit behavior under their existing owners.
Keep all qualification jobs sequential on a memory-limited developer host.
The packed installation must not require Rust, C++, or a compiler on the user's machine.

## Detailed Implementation Plan

The coordinator completes Phase 0 before issuing implementation briefs.
Each brief contains exact paths, expected behavior, refusal cases, existing test names, the targeted command, and forbidden edits.
Workers do not choose architecture, dependency versions, runtime floors, or public behavior.
Workers must report any instruction that they cannot follow literally.
Workers share no editing phase. The coordinator checks each result before the next slice.

### Phase 0: Qualification and brief completion — coordinator

Check the exact upstream dependency artifacts and a native ARM environment.
Build both crates outside the source tree's generated asset directories until qualification succeeds.
Check Potion conformance, guarded worker startup, network denial, addon differential output, and the real LateOn score.
Record commands, versions, target CPU, glibc floor, shared-library closure, and native test results in this document.
Stop when a required dependency cannot execute. Do not pass an unresolved platform choice to a worker.

### Phase 1: Potion artifacts and selection — Pi worker

Create the four ARM Potion asset files listed above.
Modify `packages/mcp/package.json`, `packages/cli/src/managed-runtime-paths.ts`, `packages/cli/src/install.ts`, `packages/cli/src/runtime-upgrade.ts`, `packages/cli/src/install-preflight.ts`, and `packages/core/src/embedding/potion-embedding.ts`.
Extend `packages/cli/src/install-preflight.test.ts`, `packages/cli/src/install.test.ts`, and `packages/core/src/embedding/potion-embedding.test.ts` only where existing tests lack the changed mechanism.
Check x64 and ARM selection, mismatched architecture, altered hashes, unknown targets, model identity, and no compiler at install time.
Cover ARM asset selection for fresh installation, dry-run preflight, and runtime upgrade in `install.test.ts`.
Pass an ARM asset root on a simulated x64 host and require rejection before activation.
Do not edit model identity, installer leases, or client configuration policy.

### Phase 2: Native projection artifacts and selection — Pi worker

Create the three ARM projection asset files listed above.
Modify `packages/core/package.json` and `packages/core/src/core/native-search-projections.ts`.
Extend `packages/core/src/core/native-search-projections.test.ts` with target selection and fallback cases.
Run `experiments/napi-search-projections/test/projections.test.ts` through its existing package command on the real ARM addon.
Check exact published-output equivalence, rejected input fallback, corrupt or absent addon, and existing cancellation tests.
Do not change the Rust algorithm, batching, projection schema, or TypeScript oracle.

### Phase 3: Qualified LateOn closure — Pi worker

Modify `packages/cli/package.json`, `packages/cli/src/runtime-selection.ts`, and only necessary closure code in `packages/cli/src/managed-runtime-closure.ts`.
Extend `packages/cli/src/managed-runtime-closure.test.ts` and the existing direct reranker-selection coverage in `packages/cli/src/install-preflight.test.ts`.
Use the Phase 0 verified ARM glibc native package names and existing pinned versions.
Check default LateOn, explicit none, explicit Voyage, unsupported targets, and provider failures.
Do not add ARM musl entries or upgrade dependencies.

### Phase 4: Packed release proof — Pi worker

Modify `packages/cli/scripts/release-smoke.ts`, `packages/mcp/scripts/release-smoke.ts`, and `.github/workflows/ci.yml`.
Extend `packages/cli/src/release-smoke.test.ts` and `packages/mcp/scripts/release-smoke.test.ts` for host-specific packed asset paths.
The coordinator identifies affected support statements in package READMEs and supplies exact edits in the final brief.
Run both packed smoke commands natively on ARM and x64. Exercise CUJ 1 and CUJ 2 on ARM.
Do not publish packages, change branches, or alter release versions without a separate instruction.

## Verification Plan

For each changed package, use its existing `test:raw` invocation with explicit test paths replacing the glob.
Preserve the package's imports, test-state initialization, and reporter flags.
After the relevant build, run the core embedding and projection tests, CLI preflight/install/closure tests, and both smoke test files listed above.
Use `pnpm run check` for lint, types, versions, and scope after implementation.
Use `pnpm run release:smoke:cli` and `pnpm run release:smoke:mcp` on each qualified native architecture.
Read each smoke command's options before execution. Supply the pinned model fixture through its existing mechanism.
Use `pnpm run release:check:packed` to check the release graph when package allowlists change.
Do not run broad suites during draft creation.

Before acceptance, record one reproducible native install and index/search command sequence with actual outputs.
Acceptance requires successful default LateOn execution, not only explicit no-reranker mode.
For projections, compare new native output with the existing TypeScript oracle across every input branch changed by target selection.
An ARM checksum mutation must fail preflight. Restore the artifact after the check.
An absent addon must use the established fallback. Cancellation must leave no owned work running.
Finish with a scoped diff and no remaining qualification processes.

## Open Questions and Release Gates

1. Native ARM dependency imports, exact Sharp package availability, and real LateOn scoring pass on the qualification host.
2. Both artifacts reference GLIBC_2.34 at most. Runtime execution on glibc 2.34 and a native ARM CI runner remain unqualified.
3. Both Rust builds pass. Potion conformance, worker readiness, network denial, and projection differential/fault checks pass on ARM.
4. Packed-package installation, permissions, indexing, and search remain untested on ARM.
5. The coordinator binds changed signatures and callers in each implementation brief. Later product acceptance remains mandatory.

The remaining gates prevent an ARM-supported release claim. Component evidence now permits the first bounded implementation slice.

## Draft Review

A Pi Goldfish reviewer read the design persona, EGM template, implementation-readiness standard, draft, and nine selected repository sources.
The coordinator checked and addressed five findings: caller coverage, six-entry Potion manifests, smoke skip conditions, host-bound trust, and projection trust preservation.
The caller omission is a real planning gap. It does not prove a compilation failure before a signature change exists.
The six-entry closure was already required in general terms. The draft now states each entry and separates packaged files from acquired models.
Native component qualification now passes. This single critique does not constitute the full five-phase EGM review protocol.
No predecessor brief exists. The user request and repository evidence supply the requirements.

*Drafted with EGM.*

## Execution checkpoint — 2026-11-10

TaskStartSnapshot: baseline `556165fd31e31161d4000a00b2b1ba1843262197`, branch `master`.
Existing task files are this untracked draft and its one-row README registration. Preserve both.
Implementation starts with Phase 1. No production files changed before delegation.
ArchitectureReviewRequired: no new domain owner or state. Review target propagation and artifact trust at the existing owners.
TDD Mode: off. Add focused regression coverage for changed selection and integrity mechanisms.
Use Pi `mistral/deepseek-v4-1-flash-1017`, thinking `max`, in a tool-created worktree from HEAD.
The coordinator checks each slice before continuing. Workers make no Git commits or lifecycle changes.

Qualification host: `oci-hunter-arm`, aarch64, glibc 2.39, Node 24.19.0, matching baseline commit.
Temporary build root: `/home/ubuntu/arm64-qualification.fysrxa`. The existing server checkout remains clean.
Tooling and dependencies live under that temporary root. No system packages or repository dependencies changed.
Build toolchain: Rust 1.97.1, target `aarch64-unknown-linux-gnu`, two compilation jobs, no custom target CPU flags.
Potion command: `cargo build --locked --release --target aarch64-unknown-linux-gnu --manifest-path source/experiments/potion-l0-l1/Cargo.toml`.
Potion conformance uses the unchanged `reference-fixtures.json` and model files. All three fixtures pass with zero maximum absolute difference.
Guarded worker starts with `networkBlocked: true`, enters seccomp filter mode, emits 256 dimensions, and exits cleanly.
A scratch example includes the original `main.rs` and invokes its unchanged network-filter function. A socket call fails with EPERM.
The pinned ONNX Runtime, Transformers, LanceDB, OXC, and TypeScript packages import successfully on ARM.
Exact ARM Sharp packages `0.35.5` and libvips `1.3.4` exist. Transformers imports through this native closure.
The real LateOn encoder starts, encodes six query tokens and 17 document tokens, and returns finite score `4.862956260725331`.
All five pinned LateOn model files pass their SHA-256 checks before execution.
The temporary harness initially lacked esbuild's optional ARM package. Explicit installation fixes that harness error.
Projection build uses `napi build --platform --release --target aarch64-unknown-linux-gnu`.
The release projection tests pass 13 cases, with three fault-hook tests skipped as designed.
A separate `--features test-faults` build passes all 16 projection tests, including cancellation, panic, and mutation cases.
The release addon replaces the test build after the check. No test-hook artifact goes into a package.
Both release artifacts are ARM64 ELF files. Both reference GLIBC_2.34 at most. That inspection does not prove execution on glibc 2.34.
Potion helper SHA-256: `1ab2ef763651d7f73e4faa0904f7393184d8c476821441005f44439aefc203f2`.
Projection release SHA-256: `0876a557589f0f1457c02c4b1980e071866a1f30bc6a4512dac6aa6a44f0314f`.
Local helper staging path: `/tmp/satori-arm64-artifacts.NApvZU/satori-potion`.
Raw build logs remain in the temporary remote root until task completion. Remove task-created scratch data after product acceptance.

### Phase 1 implementation and first review

Implementation worktree: `/home/hamza/.t3/worktrees/satori/t3-5ebb5bd1-8c45fa9705f55d88`.
DeepSeek changes 12 tracked files and adds the four ARM Potion files. Integration remains pending.
Worker evidence: CLI preflight/install tests 188 pass. Core Potion tests 30 pass, one ARM-only case skips on x64.
Worker evidence: core and CLI type builds pass. Lint reports only three existing warnings outside the edits.
Coordinator checks helper provenance, all shipped sizes/hashes, unchanged model entries, notices, executable bit, and manifest pin successfully.
The Pi spec reviewer reports no critical or important mismatch. One minor gap concerns model-acquisition target forwarding.
The coordinator adds a network-free test that reaches a throwing fetch after accepting each target's manifest.
The focused new test passes. Removing target forwarding makes it fail with an untrusted-manifest error. The coordinator restores the source exactly.
The review's suggested wrong-host rejection alone would also reject after dropping the target on x64, so that proposal does not disprove the regression.
Next: separate code-quality review, then apply the scoped implementation to the parent without changing branches or losing existing docs.

### Phase 1 integration

Code-quality review reports no critical or important finding.
The architecture-only digest selector remains behind the Linux-only acceptance guard. That held invariant already constrains its key.
The coordinator rejects the proposed duplicate platform assertion because no current unsupported target can reach the selector.
The reader also checks manifest platform against the resolved host, so a future non-Linux admission would not silently accept a Linux manifest.
The ARM-only provider test now executes on the native ARM qualification host: one pass, zero skips.
Phase 1 integrates into the parent with `git apply`, plus byte-preserving copies of the four new ARM files. No branch changes or commits occur.
The coordinator checks every integrated file against the tested worker result byte-for-byte. Existing design docs remain intact.
The added acquisition test and mutation check pass. Prior unchanged focused test results remain applicable.
Phase 1 is integrated. Full packed product acceptance remains open.
Next: Phase 2, projection loader selection and three ARM asset files.
Local qualified release addon: `/tmp/satori-arm64-artifacts.NApvZU/projection.node`, SHA-256 `0876a557589f0f1457c02c4b1980e071866a1f30bc6a4512dac6aa6a44f0314f`.

### Phase 2 implementation and native check

Worker worktree: `/home/hamza/.t3/worktrees/satori/t3-698e9363-5dc3315b29467059`.
Worker changes three tracked files and adds three ARM projection assets. Parent integration remains pending review.
Worker evidence: all 14 focused projection tests pass on x64, type build passes, changed-file lint passes.
Worker mutation checks reject x64-only resolution and an altered ARM manifest hash. Both mutations are restored.
The coordinator checks ARM addon byte identity, all manifest sizes/hashes, target identity, and unchanged notices successfully.
The coordinator copies the changed source, tests, and both artifact directories into the temporary native qualification source.
Native ARM command: `node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-concurrency=1 src/core/native-search-projections.test.ts`.
Native result: 14 pass, zero fail, zero skips. The real bundled ARM addon differential test executes.
Next: spec review, code-quality review, then byte-preserving integration.

### Phase 2 spec review

Spec review reports no implementation mismatch. One minor documentation finding identifies obsolete x64-only descriptions.
The coordinator updates `experiments/napi-search-projections/README.md` and the native-path ownership comment in `packages/core/src/core/indexing-pipeline.test.ts`.
These edits synchronize the affected contract. They change no test behavior or scope of native support.
Next: independent code-quality review of the three production/test changes and three ARM assets before integration.

### Phase 2 integration

Code-quality review reports no critical or important defect. The three untracked ARM files must accompany the code in the eventual commit.
The coordinator copies all three alongside the byte-identical tracked patch. No Git staging or branch changes occur.
The optional exact native/fallback count assertion is outside the changed target-selection mechanism and stays unchanged.
All 14 focused tests already pass on both x64 and ARM. The review's inconsistent test count does not override those executed results.
Coordinator integration check compares every changed file and new artifact byte-for-byte with the tested worker output.
`git diff --check` passes. Existing Phase 1 work and documentation edits remain intact.
Phase 2 is integrated.
Next: Phase 3 adds the qualified ARM glibc Sharp metadata and widens the existing Linux reranker architecture gate.
The existing offline Potion preflight keeps sole ownership of ARM glibc acceptance. Do not duplicate libc policy in reranker selection.
Use the existing direct selection tests in `install-preflight.test.ts` instead of unrelated installer fixture expansion.

### Phase 3 implementation

Worker worktree: `/home/hamza/.t3/worktrees/satori/t3-e1aee562-95ecc166b57c3ea1`.
Four changed files add the ARM GNU Sharp pair, widen reranker architecture selection, and cover selection/closure behavior.
Worker evidence: 93 focused tests pass with zero skips, CLI typecheck and lint pass. Three existing lint warnings remain outside the changes.
Worker mutation check restores original selection/metadata and observes three new failures, then restores the implementation and reruns green.
Coordinator checks JSON metadata: the single new ARM GNU pair is the only package metadata change.
`git apply --check` proves the narrow Phase 3 patch composes with integrated Phase 1/2. No integration yet.
The diagnostic assertion update preserves Darwin ARM rejection and follows the changed supported-target message.
Next: spec review, code-quality review, then integration and combined checks before the final packed-release slice.

### Phase 3 spec review

The independent spec reviewer reports no mismatch or excess. Four files match the accepted scope and compose with Phase 1.
No second metadata whitelist or runtime architecture gate requires a companion edit. The exact ARM Sharp versions already exist in the lockfile.
Phase 4 must synchronize the x64-only support statement in `packages/cli/src/index.ts` and `satori-landing/docs/index.html`, alongside affected package README text.
These are affected support contracts, not a frontend redesign. Do not change unrelated copy or layout.
Next: independent code-quality review before integration.

### Phase 3 integration and combined verification

Both Phase 3 reviews report no findings. The coordinator applies its narrow patch without conflicts and checks reverse applicability.
Combined CLI check: `install-preflight.test.ts` 85 pass, `install.test.ts` 106 pass, `managed-runtime-closure.test.ts` 15 pass. Total 206 pass.
Combined core check: `native-search-projections.test.ts` 14 pass, `potion-embedding.test.ts` 29 pass and one ARM-only skip on x64.
The earlier worker summary counted that skipped core case as passed. Per-file results show 43 actual core passes and one skip.
That ARM-only case already passes separately on native ARM. No relevant gate remains unexecuted at the component boundary.
The integrated core build and CLI typecheck pass. `git diff --check` passes.
The coordinator saves the verified artifacts and runtime-selection slices in one local commit before Phase 4. No release or version bump occurs.
This commit gives the final worker a complete source baseline without copying uncommitted changes into its checkout.

### Phase 4 acceptance design

Use one `ubuntu-24.04-arm` CI job on Node 22.22.0, without multiplying the existing OS/Node matrix.
The label is listed in [GitHub's official runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), checked on 2026-11-10.
Extend every existing x64-only packed-smoke condition to Linux x64 or ARM64. Keep the 960 MiB size budget.
Use the existing `resolvePotionAssetsRoot` path owner in the CLI smoke. The MCP smoke keeps its existing local path resolver and gains target selection.
The existing workspace Potion model fixture is tracked and architecture-neutral. Keep its path and bytes unchanged.
Add a real packed offline journey to the CLI smoke, using the packed install module and the already installed packed closure.
Run the default LateOn choice and explicit none in separate temporary homes, with real preflight and no injected provider stubs.
Acquire the default LateOn model through its existing owner. Do not change model identity or acquisition policy.
Connect through each installed managed launcher with the existing MCP client. Index a small TypeScript fixture using `manage_index` create/status.
Search through `search_codebase` with a natural-language query and full diagnostics. Require the fixture file among grouped results.
For default mode require `hints.debugSearch.rerank.applied === true`. For none require false. Do not accept a silent reranker fallback.
Close each session and call the packed CLI's `terminateSatoriServers` for that temporary home/state root in finally. Never signal unrelated processes.
Require termination to report `terminated` or `not_running`, not `partial`, before deleting the temporary state.
Keep the existing not-installed doctor smoke in its own untouched temporary home.
Add focused negative checks for missing host helper and native dependencies, plus unchanged size-budget enforcement on supported Linux hosts.
Full packed CLI/MCP smoke runs on x64 and ARM remain mandatory after implementation.

### Three confirmed follow-up findings

The user authorizes a separate worker for three bounded corrections while Phase 4 continues.
Use Pi `opencode2api/deepseek-v4.1-flash-free` with thinking `max`, per the updated provider instruction.
Own only the two Potion real-helper test files, the candidate-install override line and its regression test, and the improvement-index status row.
The real-helper tests must select the native x64 or ARM64 helper and keep the shared x64 model directory. Both helper and model eligibility gates change.
The candidate installer must preserve an explicit `potionAssetsRoot`, including when no `runtimeCommand` is supplied. The overwrite predates the ARM change.
The status row must say Phases 1–3 are integrated and packed acceptance remains pending.
These paths do not overlap the running Phase 4 worker's files. Defer test/build execution to avoid concurrent heavy jobs.
The coordinator will run focused tests, including native ARM real-helper and pool parity tests, after the packed smoke worker finishes.

### Phase 4 handoff and parent review

Worker output: `/home/hamza/.t3/worktrees/satori/t3-adb7df67-0c1dffcb8f4311c1`, ten allowed files. Parent integration remains pending.
Worker reports both real x64 packed smokes pass, including default LateOn and explicit-none index/search journeys and packed native projections.
Reported installed runtime size is 970,901,721 bytes, below the unchanged 1,006,632,960-byte budget.
Worker reports smoke unit tests, package builds, `pnpm run check`, and MCP docs check pass. The coordinator still checks the handoff independently.
The packed-graph release check fails because core/MCP 0.11.0 already exist in the registry with different bytes. A future release requires version changes.
The coordinator accepts the out-of-home runtime binding to packed `exactRuntimePreflightDependencies`, matching the existing local installer.
Dynamic import in the smoke test avoids importing a file outside the CLI TypeScript rootDir and changes no production contract.
A fresh temporary npm cache avoids the worker's stale-cache ETARGET error without changing code or the operator cache.
Parent inspection finds that failed/unverified termination currently reaches unconditional main cleanup of runtime/home directories.
That path contradicts the required preservation of diagnostics/state when cleanup cannot prove termination. Spec review must assess this concrete failure path.
Native product-check source transfer completes successfully under `/home/ubuntu/arm64-qualification.fysrxa/product-check`.
It contains commit3934bc32 before the Phase4 working patch. Existing server checkout and user runtime remain untouched.
Next: apply the candidate patch to that temporary source, run native builds and packed smokes, and finish independent review.

The Phase4 patch now transfers to the temporary ARM product source. Frozen dependency installation and core/MCP/CLI builds start serially.
A managed shell session owns that job. Resume its returned session before starting any additional heavy work on ARM.

### Parent corrections after Phase 4 spec review

The coordinator accepts the cleanup and landing-support findings. The advisory resolver change conflicts with the accepted legacy path-helper contract and is rejected.
No current unsupported target bypasses the adjacent host gate. Keep that gate as the admission owner.
The cleanup regression first fails because the owner record disappears after a simulated partial termination.
The coordinator adds per-invocation preservation reporting to the existing journey/main owner and a narrow cleanup function for the filesystem invariant.
No module-global flag or new persistent state is added. Partial, unverified, and thrown termination failures preserve runtime/home evidence.
Seven CLI smoke unit tests pass, including all three deterministic cleanup-failure cases. CLI typecheck passes.
The coordinator synchronizes both missed landing-page phrases and all six current support statements in `docs/REFERENCE.md`. Historical measurements remain intact.

The five review-fix files integrate byte-for-byte. The new candidate-override regression passes and fails when the override operand is removed. Source is restored.
Real native ARM execution confirms all three helper conformance cases and pool parity run. Two older file-validation cases initially still skip on ARM.
Those two validation guards now admit ARM as well, preserving their existing assertions. The native job reruns the complete focused component set.

The shared-host question exposes a real remaining parity gap: `isSharedOfflineRuntimeEligible` admits x64 only.
Its owning predicate now admits Linux ARM64. No identity, lease, lifecycle, or libc policy changes.
A new eligibility matrix fails before that one-line repair and passes afterward, preserving disabled/connected/non-Potion/non-LanceDB/unsupported-host rejection.
The packed offline journeys now connect two managed clients, check one live host identity, and require both to observe the same Publication. Both sessions close before termination.
The ARM CI job now includes pool parity and runs the focused core files serially. YAML parses, existing jobs compare equal, and all new shell snippets pass shellcheck.

Integrated builds and `pnpm run check` pass. Existing lint warnings remain outside the changed lines.
Native final builds, CLI smoke-unit tests, and shared-identity/lifecycle tests pass on ARM. Packed default/none sharing proof starts next with a fresh task-owned npm cache.
Local combined shared-host/transport checks and installer/smoke tests run before final review.

### Final live checks and review

Parent focused checks pass: CLI installer107 plus smoke-unit7, total114. MCP shared identity/host/transport43 pass.
Native final source builds and component checks pass. Native packed CLI then MCP checks run in managed shell session62323.
The updated x64 packed CLI check runs in session87668, log `/tmp/satori-arm64-packed.QSwklZ.log`, task cache `/tmp/satori-arm64-npm.Jike4K`.
Do not restart these active commands. Resume their managed sessions.
The source under review is now the parent working tree against commit3934bc32, including Phase4 corrections, the five review fixes, and shared-host parity.
Remaining acceptance: observe both real packed runs, run the ARM skip-gate mutation check after the native packed job exits, finish independent quality review, and commit the verified final patch.
Release graph remains blocked on version reuse. Publishing and release version changes remain outside the authorized implementation scope.

### Paused by user

The user asks to pause and intends to perform ARM acceptance testing after the local handoff. Do not resume testing from automated notifications.
All parent-launched build/test commands finish. No new ARM checks start.
Updated x64 packed CLI smoke passes, including both two-client shared-host journeys.
Native ARM component checks pass49/49, CLI smoke-unit7/7, shared identity/lifecycle8/8.
The ARM packed CLI command fails its unchanged960MiB size gate at1,170,578,518bytes, so the chained MCP smoke does not run.
Measured native dependency metadata identifies LanceDB ARM413,059,581bytes versus x64211,640,370bytes as the dominant size difference.
A retained diagnostic closure at `/home/ubuntu/arm64-qualification.fysrxa/closure-probe-mzeQ1e` measures1,170,578,356bytes and independently passes real ARM Potion, projection, default-LateOn/none and two-client sharing checks. That is not a full size-gated smoke pass.
That diagnostic command exits0 and scoped host termination completes. The size cap remains unchanged.
An unapplied proposal at `/tmp/satori-arm64-budget-proposal-sw5l1h00.diff` would keep x64960MiB and use ARM1152MiB. It has no approval and must not be applied silently.
Final review text reports no critical/important defect and two minor items: stale D32 label on the changed CLI README line, and unconditional success wording for skipped host-gated smoke checks.
A subsequent interruption notification does not authorize restarting the reviewer or continuing work.
On explicit resume, finish only local review corrections, appropriate focused checks, scope check and final commit/handoff. The user owns further ARM acceptance runs.
Task-created caches/source copies and diagnostic logs remain for cleanup during that local handoff.
