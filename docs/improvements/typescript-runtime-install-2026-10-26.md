# Managed-runtime TypeScript compiler install, 26 October 2026

Status: native compiler and Potion startup fixes are checked. The latest full
packed smoke passes TypeScript, Potion, and LateOn native execution checks.
Installed runtimes receive the repair at the next CLI release and reinstall.

## Problem

Semantic analysis on a managed install fails with
`Unable to resolve @typescript/typescript-linux-x64`. The runtime installs
TypeScript but not the compiler binary that TypeScript executes.

## Evidence

- The installer runs `npm install --prefix <runtime> --omit=dev --omit=optional`
  in `packages/cli/src/install-application.ts`. Optional dependencies are
  deliberately omitted to bound runtime size, then required host-native
  packages are installed as explicit targets.
- TypeScript 7.1.0-beta declares the compiler binary as one optional dependency
  per host (`@typescript/typescript-<platform>-<arch>`, 21 packages).
  `typescript/lib/getExePath.js` reads the installed `package.json` and resolves
  that package upward from the `typescript` package.
- Reproduction in `/tmp/opencode/tsfix`:

  | Runtime contents | `getExePath()` |
  |---|---|
  | `typescript@7.1.0-beta` only | throws `Unable to resolve @typescript/typescript-linux-x64` |
  | plus `@typescript/typescript-linux-x64@7.1.0-beta` | returns `<root>/node_modules/@typescript/typescript-linux-x64/lib/tsc` |

- The installed runtime
  `~/.satori/mcp-runtime/@satori-code-mcp@0.10.5` has `typescript`,
  `@lancedb/lancedb-linux-x64-gnu`, and `@oxc-parser/binding-linux-x64-gnu`,
  but no `@typescript` package. LanceDB, oxc-parser, and Sharp natives were
  already restored as explicit targets. TypeScript was missed.
- The host compiler package is 28 MB unpacked. Release smoke measures the
  packed managed runtime at 963,988,210 bytes (919 MiB) against a 960 MiB gate,
  so the headroom is about 41 MiB.

## Decision

- `resolveTypeScriptNativePackage` in
  `packages/cli/src/managed-runtime-closure.ts` maps the host to the exact
  compiler package. The libc does not select a TypeScript package, so
  `linux-x64-gnu` and `linux-x64-musl` share one. Unsupported hosts raise
  `E_USAGE` before npm runs.
- `installManagedRuntimeCandidate` adds that package to the explicit install
  targets beside LanceDB, oxc-parser, and LateOn/Sharp.
- `packages/cli/package.json` pins `satoriManagedRuntime.typescript` to
  `7.1.0-beta`, and `managed-package.ts` accepts an exact prerelease for this
  field only. Every other managed-runtime field still requires an exact
  `major.minor.patch`.
- The closure manifest gains `typeScriptNativePackage` and its format rises to
  4. A runtime without the package fails the identity check and is regenerated
  instead of reused, so the repair also reaches existing installs after an
  upgrade.
- `scripts/release-graph.mjs` checks that the CLI pin equals Core's
  `typescript` dependency, so a dependency bump cannot leave the pin stale.
- `packages/cli/scripts/release-smoke.ts` installs the packed closure and runs
  `getExePath()` from the packed runtime, then checks that the path stays
  inside the install root.

## Verification

- `managed-runtime-closure.test.ts`: 12/12, including the host map, agreement
  with the upstream optional-dependency metadata, and rejection of an
  unsupported host.
- `install.test.ts`: 98/98, including the new explicit target in the npm
  arguments.
- `release-graph.test.mjs`: 30/30, including a stale TypeScript pin.
- `pnpm --filter @satori-code/cli typecheck`: clean.
- The earlier recorded release smoke passes its compiler-path check in the
  packed closure with `--omit=optional`. The later priority-run check also
  starts the native API and parses source, then fails at Potion readiness.
  The latest full release smoke does not pass.
- Before/after reproduction recorded above.

## Limits

- The runtime installed today still lacks the compiler package. The repair
  appears after a CLI release that contains this change and a reinstall.
- The host compiler package adds 28 MB unpacked to every managed runtime.
- Release smoke passed on linux/x64. Other hosts rely on the same explicit
  target and on the upstream platform packages they name.


## Priority-run check

The parent adds an actual native API parse to the packed-runtime check. The
check creates the API from the installed MCP dependency tree, parses a source
file, disposes the retained file, and closes the API in `finally` blocks.
The next smoke attempt reaches the later Potion execution check, which proves
that the native TypeScript steps return successfully. That attempt exits 1
with `Potion worker readiness timed out`, so it is not a full release-smoke
pass. Its packed runtime is 963,988,221 bytes, below the 1,006,632,960-byte gate.
The log is `/tmp/satori-pr-p0-packed-smoke.log`. The Potion timeout remains a
separate integration limitation pending diagnosis.


## Subsequent Potion startup repair

The earlier readiness timeout remains recorded above. A later controlled test
proves that the startup timer can expire before Node polls a valid ready frame
already written by the helper during a parent event-loop stall. The startup
expiry now gives I/O one poll opportunity and checks the current child and
starting state. The five-second configured default does not change.

The regression fails before the repair and passes afterward. All 29 Potion
tests pass, including a silent-worker timeout control. The full packed smoke
passes in
`/home/hamza/.cache/satori-remaining-repairs-20261026/packed-smoke-after.log`.
The old smoke's exact scheduling was not recorded, so that specific historical
failure is not claimed as causally proved. This repair addresses the reproduced
false-expiry class. Commit: `7c69c685`.
