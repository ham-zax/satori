# Satori trial findings and CBM upstream gaps, 21 October 2026

Working plan for the remaining Satori dev-trial findings and the gaps found by a comparison with
`~/repo/codebase-memory-mcp` (CBM, HEAD `3457b21b`). Satori vendors CBM at
`11b662f9f7fba92012b872dd4fcaef7ee0c1300d` (`third_party/cbm-semantic/UPSTREAM.md`,
`third_party/cbm-extractor/UPSTREAM.md`). CBM has 1,271 commits after that pin.

## Trial findings

| # | Finding | Status |
|---|---|---|
| 1 | C navigation (region exclusion, include-aware targets, partial outline, `cpp-v3`) | Fixed: `e4623a21` |
| 2 | Memory peak 3.6-3.9 GiB on the 1,362-file webharness repo | Fixed: process mode at every budget |
| 3 | `find_references` stops at 100 of 134 with no continuation | Fixed: `6e8420b2` (`nextCursor`, `hints.nextPage`) |
| 4 | Sync `unverified` / `watcher_event_pending` | Fixed: status rereads when the operation turns terminal during the read |
| 5 | `architecture_overview` boundaries, fanIn, fanOut empty on the CBM repo | Fixed: WASM 2 GiB, 2,000,000 call sites |
| 6 | Unexplained completed sync at generation 3 after create | Fixed: handoff records the sync time |

### Finding 2 evidence

One run per switch, `packages/core/dist/indexing/resources.js` patched through environment
variables (patch removed). Peak is the highest PSS of the process tree.

| Switch | Peak | Wall |
|---|---|---|
| default | 3,613 MiB | 17.2 s |
| `releaseSemanticBeforeResolution` | 3,422 MiB | 16.9 s |
| `analysisWindowFiles` 4 | 3,378 MiB | 16.1 s |
| `analysisWorkerMode` `process` | 1,652 MiB | 14.9 s |
| all three | 1,644 MiB | 17.0 s |

Process mode alone gives the drop. Decision: process mode at every budget with analysis workers
(`packages/core/src/indexing/resources.ts`). Three runs after the change, budget 5.3-5.5 GiB:
peak 1,614 / 1,613 / 1,567 MiB (median 1,613), wall 16.1 / 15.9 / 16.0 s (median 16.0).
LibreOffice runs are not done.

### Finding 5 evidence

The CBM repo C/C++ set (1,733 files, 75 MB, `~/repo/bench-bugs/arch-20261021/cabort/`) fails one
whole-project session in two ways. WASM memory reaches the 1 GiB limit and the allocator calls
`abort()`. The 200,000 call-site limit (`SATORI_MAX_CALL_SITES`) fails at 600 files, and also on
the 1,059 files outside `grammars/`. WASM memory grows about 25 times the source bytes.
`resolve_cpp_project` now resolves each file in a per-file arena: 476 to 397 MiB at 450 files,
1,024 to 956 MiB on the 1,059-file set.

Decision: raise `MAXIMUM_MEMORY` to 2 GiB (the host reads pointers as signed `i32`, so 2^31 bytes
is the safe ceiling) and `SATORI_MAX_CALL_SITES` to 2,000,000. The full set then passes: 1,724 MiB
WASM memory, 184,581 published calls. Full CBM index with the dev build: boundaries 1 to 15, fanIn
and fanOut 15, relationships 29,113 to 127,192, `satori-cbm-semantic-cpp` present. Cost: the run
peaked at 5.4 GB under a 6,000 MB scope and was OOM-killed under 4,500 MB (one run each).

### Finding 4 evidence

- Reproduced on a webharness clone with back-to-back add syncs: 2 of 5 status reads showed
  `completed` with the old file count and `watcher_event_pending`. Every sync logged `+1`.
- Timing logs (`~/repo/bench-bugs/satori-dev-trial-20261021/luna-index/f4-instrumented-server.log`)
  show the manual sync covered the watcher event 57 ms before that status response. The watcher
  event arrives 4 ms after the write.
- Cause: `handleGetIndexingStatus` reads the Publication and freshness, awaits more reads, and
  reads the operation last. A completion in between gives a mixed response.
- Correct by design: a sync that starts before the watcher registers captures no flight epoch,
  so `watcher_observation_gap` stays. That sync can read source before the watcher observes it.
  A pending gap sets the threshold to 0, so the next background pass (5 s) closes the gap with
  a `watcher_pending` sync (log lines 224, 333).
- Fixed: after a server start, a read's full source comparison closed the startup gap but
  recorded no sync time. The background pass then ran one `threshold_expired` sync (log lines
  808, 968). Both full-comparison match paths in `SyncManager` now record the sync time.

### Finding 6 evidence

The first periodic pass (`handleSyncIndex`) read no sync time for a just-created root and ran a
`threshold_expired` sync. `SyncManager.completeFullIndexSourceHandoff` now records the sync time
when the handoff is proven.

### Correction: LibreOffice does not measure C++ analysis

LibreOffice has 22,111 C++ sources. `NATIVE_MAX_SESSION_SOURCES = 20_000`
(`packages/core/src/semantic/wasm/wasm-analyzer.ts:56`) skips its C++ analysis:
`Source count limit exceeded (20000): at least 22111 cpp sources`. The earlier claim that the C
change has no measured cost on LibreOffice is not valid. The C cost must be measured on a C/C++
repo with fewer than 20,000 sources.

## CBM comparison: verdicts

Confirmed in code:

- The Java, C#, C++ and Rust resolvers keep every `TSTree` until the end of the batch
  (`satori_semantic.c:1659`, `2338`, `2957`, `3390`). Their second pass uses the session arena
  `&s->arena`. Only Kotlin and PHP use a per-file `file_arena` (`satori_semantic.c:2109`).
  Fixed for pass 2: Java, C# and Rust now resolve each file in a per-file arena, and Java, C#,
  Rust and C++ delete each tree after its resolve call. WASM memory, old to new (deterministic,
  3 runs each, output hash equal): C# Newtonsoft.Json 951 files 275 to 229 MiB, Rust
  rust-analyzer 1,495 files 476 to 397 MiB, Java guava 3,275 files 763 to 673 MiB, C++ CBM C set
  1,733 files 1,724 to 1,628 MiB. Median wall: C# 2,491/2,402 ms, Rust 4,081/3,862 ms, Java
  31,794/32,114 ms, C++ 27,292/27,568 ms (load 1.5). Harness: node --import tsx wasm-mem.mts
  <language> <root> <assetsDir> (session scratchpad, repos in ~/repo/bench-bugs/wasm-mem-20261021).
  Not done: every tree is still alive at the end of pass 1, which probably sets the peak. Go not
  checked.
- The 20,000-source limit skips C++ analysis on LibreOffice (above).
- `index-generation-workflow.ts:517` reads each semantic source one at a time.
- `extract_defs.c:91` has a fixed `BT_STACK = 512`. Children are pushed last to first, so a full
  stack drops the first children. Not applicable to Satori: the stack only fills
  `def->body_tokens`, and `satori_extractor.c` never reads that field.
- `satori_semantic.c:504` admits `lsp_short_name_unique` as a direct call (Rust free-function
  fallback, CBM `ec4f0eaa`).
- Python: every import gets `typeOnly: false` (`tree-sitter-adapter.ts:1213`), and no
  `TYPE_CHECKING` handling exists. `builder.ts` resolves `from . import x` from the module
  specifier only, so the IMPORTS edge targets `__init__.py`. `buildPythonClassBases` keys on the
  short class name and drops bases when two files share it. `pythonMroNames` returns nothing when
  more than one class has the name (`python-resolution.ts:1078`).
- All 21 cited CBM commits exist.

Probable, a fixture must prove each:

- C/C++ macro-wrapped definitions (`IMPL_LINK(...)`): `cpp_find_callable_terminal` and
  `cppCallableTerminal` take the outer declarator name (CBM `2ef6ba71`).
- Python package re-exports through `__init__.py` (CBM `62191225`, `0ae936f0`).
- Missing final newline (CBM `fa258d34`): Java and C# still gate eligibility on
  `ts_node_has_error(root)`. With `cpp-v3` a C++ file with an error becomes partial, not dropped.
- C# same-name types (`a510646b`), Kotlin typed properties (`67ff40d5`), PHP grouped use
  (`d74579c9`), Rust generic impl self type (`f75af00a`).

Results:

- Rust `f75af00a`: not applicable. The fixture `impl<T> G<T> { self.Help() + Self::Assoc() }`
  already resolves. The upstream gap came from an upstream extractor change that Satori lacks.
- PHP grouped use `d74579c9`: fixed in `b16320b3` (`php-v2`).
- Missing final newline `fa258d34`: fixed in `8ab9f98d` (`satori_parse_source`). C# lost all
  evidence when a file ended with `#endregion` or `#pragma` and no newline. Java was not affected.
- C# same-name types `a510646b`: not applicable. Probes with `using`, enclosing namespace,
  qualified name, `using` alias and a `partial` member all resolve to the correct file in both
  directions and in both file orders.
- Kotlin typed properties `67ff40d5`: fixed. Before the port, calls on primary-constructor `val`
  and `this.prop` receivers had no evidence. Typed parameters and body properties already worked.

Not confirmed:

- C memo and depth (`c3c97a99`, `e9e72d09`): not applicable. The earlier note was wrong:
  `C_EVAL_DEPTH_LIMIT` (256) and `C_EVAL_MAX_STEPS_PER_FILE` (10,000) are in
  `languages/cpp/c_lsp.c:1477`. The Satori guard is not sticky: it makes only the deep
  subexpression unknown. Direct calls do not use the type evaluator, and Satori publishes no C++
  receiver evidence. Probes: 10,000 call statements in one function resolve all 10,001 calls
  (355 ms). A 300-term sum and a 200-link fluent chain keep the later call. 40 nested ternaries
  resolve. Only calls nested deeper than 256 levels are dropped (256 of 301), and upstream keeps
  that guard for genuine nesting.
- No measurement supports the 10-20x WASM memory gain or the read-path gain.

## Producer bottleneck note (verified)

- `readIndexableFileObservationInsideRoot` (`packages/core/src/core/indexing-pipeline.ts:410-469`)
  opens each file twice through `openRegularFileInsideRoot` (lines 416 and 453). The second open
  checks that the path was not replaced. `openInsideRoot`
  (`packages/core/src/sync/root-bound-fs.ts`) has 6 awaits.
- Do not make the reads synchronous on the main thread. In bench runs
  (`progress.jsonl` under `~/repo/bench-bugs/libreoffice-perf-20261020/napi-loop/`) main-thread
  CPU is 154.8 s and `payload.producer` is 165.6 s, so the main thread is close to full.
  Synchronous reads keep the same CPU on the main thread and stop the event loop. Worker replies
  then wait longer, and `payload.worker.transfer` can increase.
- `payload.worker.transfer` is a sum of concurrent waits and cannot be compared with wall time.
  With an 8-file window it was 68-72 s (`libreoffice-critical-path-2026-10-21.md:89`). With 32
  files in flight a larger sum is expected and does not prove a new bottleneck.
- The 110-125 s producer target has no evidence. The earlier profile
  (`rust-acceleration-loop-2026-10-20.md:163`) measured 14.3 s for `openInsideRoot` and 13.1 s for
  `readIndexableFileObservationInsideRoot`. If the two numbers overlap, about 14-27 s of
  main-thread CPU can move. That alone does not take a 165 s producer to 110-125 s.
- Better option: move the root-bound open, the read and the SHA-256 hash into the analysis
  workers. The descriptor-bound root checks move with them, so the change touches a security
  boundary.
- Next step: take a new CPU profile at `9a85498b` to rank the main-thread costs before any
  decision. Stop if the read path is not in the top three.

## Method changes

1. Upstream first: before a fix in vendored CBM code, run `git log 11b662f9..HEAD -- <files>` in
   the CBM repo and read the matching commits.
2. Benchmark validity: before a "no cost" claim, search the run diagnostics for limit and skip
   messages for the language under test.
3. Fixture first: prove each claim with one small fixture through the dev build before a code
   change. The fixture becomes the regression test.

## Work plan

TDD route: auto, decision strict (bug fixes in shared resolution code). Each fix starts with a
fixture test that fails on the current code and ports the cited CBM commit's approach.

| Slice | Owner files | Who | Check |
|---|---|---|---|
| P: Python resolution (from-dot import, TYPE_CHECKING, re-exports, class bases) | `packages/core/src/language-analysis/tree-sitter-adapter.ts` (Python part), `packages/core/src/relationships/python-resolution.ts`, `packages/core/src/relationships/builder.ts` | Worker, own worktree | Focused core test files |
| C: C/C++ macro-wrapped definition names | `third_party/cbm-semantic/satori_semantic.c`, `tree-sitter-adapter.ts` (C/C++ part) | Worker, worktree with main's diff applied | Engine build, focused tests |
| T: trial findings 5, 4, 6 | as found | Parent, inline | Dev build probes |
| D: finding 2 plan change | `packages/core/src/indexing/resources.ts` | Parent, after decision | 3 runs webharness and LibreOffice |

Later, after the slices above: WASM per-file arena and tree release, the 20,000-source limit,
the C memo check, the other languages, the extractor stack, and the producer profile. Each needs
its own measurement and approval.

Integration: review each diff against its brief, merge into main uncommitted, run the full suite
once, then ask for commit approval.
