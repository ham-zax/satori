# Private napi-rs search projection experiment

This standalone package compares a candidate ASCII kernel with the unchanged
TypeScript owner in `packages/core/src/core/search-projections.ts`. Production
code imports nothing from this directory. No corpus acceptance or production
readiness follows from fixture results.

Run commands from this directory. Rust stable, Node >=22.22, and pnpm 10 are
prerequisites. The local lockfiles do not change the root manifests or locks.

```text
pnpm --ignore-workspace install --frozen-lockfile
pnpm --ignore-workspace run build:test
pnpm --ignore-workspace run test:faults
cargo fmt --manifest-path Cargo.toml --check
cargo clippy --manifest-path Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path Cargo.toml --all-targets --features test-faults -- -D warnings
pnpm --ignore-workspace run licenses
node licenses.mjs --check
pnpm --ignore-workspace run build
pnpm --ignore-workspace run test
pnpm --ignore-workspace run typecheck
```

`build:test` builds a debug addon with opt-in deterministic test faults. `build`
replaces that local addon with a release build without test hooks. Run tests
immediately after the matching build. Tests require a real addon and assert
that supported fixtures execute natively. They load the addon in a fresh
worker thread before sending its first input. Expected panic-test diagnostics
come from Rust's panic hook. The task catches that panic and rejects its
promise. A subsequent call must succeed.

Generated `.node`, declarations, node_modules, and Cargo target files remain
local and ignored. The CLI and direct crates use exact pins. Cargo.lock pins
transitive crates. See LICENSE-NOTE.md and crate-licenses.json.

## Opt-in full-index pipeline

The reusable wrapper policy lives in
`packages/core/src/core/native-search-projections.ts`. This package keeps a thin
facade and the Rust build source in `src/lib.rs`. The pipeline does not import
experiment files or discover a platform package.

Build the release addon from this directory with
`pnpm --ignore-workspace run build`. Core ships the release build as
`packages/core/assets/native-projections/linux-x64/projection.node`, with a
`manifest.json` (source revision, toolchain, sha256) and
`THIRD_PARTY_NOTICES.md`. To refresh it, copy the new build there, regenerate
the notices from `cargo tree --locked -e normal`, and update the manifest.
`native-search-projections.test.ts` fails when the manifest and files differ.

On linux-x64, the full-index pipeline uses the bundled addon by default when
its sha256 matches the manifest. `SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS` set
to an absolute `.node` path overrides it. An empty value keeps the original
synchronous TypeScript path. Other platforms also use TypeScript.
The pipeline resolves the addon and loads the binding once per operation.
An invalid path, missing addon, or load exception uses TypeScript.
A native computation failure rejects the operation after owned work settles.

Native mode consumes the existing chunk iterator in windows of at most 64
inputs and 4 MiB of flattened strings. One oversized input uses TypeScript
alone. The pipeline preserves chunk identities, ownership, embedding batches,
and callbacks. Context supplies the current mutation signal. Cancellation
waits for native settlement before cleanup and preserves the exact reason,
including explicit `null`.

Set `SATORI_PERF_TRACE=1` to emit one `payload.native_projections` record per
configured operation, on success or failure. The record contains `total`,
`native`, `fallback`, `calls`, and elapsed operation wall time in `ms`.
On failure, completed-result counts can be less than `total`.
These counters prove addon use. They do not measure a full-index speedup.

`pnpm --ignore-workspace run typecheck` uses the already pinned TypeScript.
The local configuration checks the facade, tools, tests, and imported core
source. Bundler resolution supports their extensionless TypeScript imports.
Ordinary core tests inject a binding and require no compiled addon.
Full-index artifact comparisons and timing remain separate acceptance gates.
This opt-in adds no dependency or production packaging.

## Interfaces and bounds

`wrapper.ts` exports `buildProjectionBatch(readonly SearchProjectionInput[],
options?)`. Inputs use the canonical TypeScript type. Optional fields include
`signal`, `addonPath`, `loader` (test seam), and cumulative `counts`.
The default addon lookup caches success or absence once per module. An explicit
addonPath loads that exact file per invocation. Explicit loader injection is
uncached. Missing addons and load exceptions use the unchanged reference.
A runtime native rejection propagates to the caller.

The raw binding exports `buildProjectionBatch(rawInputs, cancellation?)`, which
returns a Promise of ordered four-field projections or null for unsure items.
Raw inputs have content, relativePath, optional language/symbolKind/symbolLabel,
and optional breadcrumbs. The raw binding validates at most 64 items and
4 MiB aggregate UTF-8 string bytes before scheduling libuv work. These limits
include metadata. Raw callers must supply canonical paths. The wrapper checks
all paths with the canonical validator before any native dispatch.

The proven subset includes only ASCII strings, identifier tokens of at most
256 bytes, and at most 256 breadcrumb entries per item. Excess breadcrumbs
fall back before wrapper flattening or native conversion. Raw inputs with
excess breadcrumbs return null. The wrapper also uses the reference for
Unicode (including lone surrogates), oversized items, long tokens, and null
native results. The wrapper splits supported work into bounded calls.

Each raw call has a cumulative 16 MiB native output budget. Conservative charges
cover content, JSON escaping, metadata, array framing, ordered terms, and alias
prefixes. The kernel charges each new alias before allocating its string. An
item that exceeds the remaining budget returns null and releases temporary
data without consuming the remaining budget. The wrapper then uses the
unchanged reference, so the experiment adds no limit to published semantics.
The native budget does not bound memory or output of the reference fallback.
The caller still owns the complete request and returned output arrays.

AsyncTask runs computation on libuv without a private thread pool. Each call
uses ProjectionCancellation with an atomic flag. The kernel checks cancellation
between items and in token/prefix loops. The wrapper cancels the flag, awaits
native settlement, then throws the signal reason and removes its listener.
A pre-aborted signal starts no native work. No Promise.race or with_signal is
used. Failure or panic rejects the complete batch without partial results.
Test-only barriers can hold computation until the test releases it. Default
builds expose no fault entry or barrier.

## Streaming JSONL comparison and timings

Each line is one canonical SearchProjectionInput object, for example:

```json
{"relativePath":"src/parser.ts","chunk":{"content":"parseHTTPResponse raw_value","metadata":{"startLine":1,"endLine":1,"language":"typescript","symbolLabel":"Parser.parseHTTPResponse"}}}
```

```text
pnpm --ignore-workspace run compare --input /absolute/path/inputs.jsonl
node --import tsx tools.ts compare --input - < /absolute/path/inputs.jsonl
pnpm --ignore-workspace run benchmark --input /absolute/path/inputs.jsonl --repetitions 3
```

Compare supports stdin in one pass. Benchmark needs a seekable file and at
least three repetitions. The tools read 64 KiB blocks and retain at most one
bounded batch plus one decoded line. The default line cap is 16 MiB. Set
`--max-line-bytes N` explicitly for larger lines. A line over that tool limit
rejects before JSON.parse. The tool does not open indexes or export corpora.

Both timings include output string materialization. Native timings include
wrapper checks, input flattening, napi marshalling, scheduling, Rust computation,
and return conversion. Addon initialization occurs before measured batches.
Reports include per-run times, medians, RSS, process peak RSS, start load, input
command, and total/native/fallback/call counts. Peak RSS is cumulative across
repetitions. Neither timings nor fallback counts establish a speedup or corpus
acceptance. `compare.ts` checks both text strings and both versions byte for
byte. The mutation test corrupts a real native result, observes comparison
failure, then checks the unchanged native result again.

## Open adoption gates

A worker-thread profile of the existing TypeScript path remains a prerequisite
to a production decision. The isolated native microbenchmark can reject this
candidate before that work. Full-index artifact parity,
three full-index measurements below 6 GiB, and platform packaging/CI remain
open. Only the current local platform is checked by this slice. The opt-in
pipeline adds no services, publication policy, cache of domain results, or
native state beyond per-call cancellation. Default indexing remains TypeScript.
Platform packaging and production adoption remain outside this slice.
