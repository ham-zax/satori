# How a third agent broke our LibreOffice indexing plateau

Date: 21–22 October 2026. Status: shipped on `master` (`41085c1a`, `3164ba50`, `9a85498b`, and the
`e4623a21..013cabdd` semantic series). Technical records:
[LibreOffice critical path](libreoffice-critical-path-2026-10-21.md) and
[Satori trial findings and CBM upstream gaps](satori-trial-and-cbm-findings-2026-10-21.md).

## The plateau

Satori is the local code-intelligence engine that coding agents use to search and navigate a
repository before editing it. Our performance benchmark is a cold, full index of LibreOffice
(35,760 indexable files, 547,349 chunks, 71,523 navigation sidecar files) under a strict 6 GiB
cgroup ceiling with no swap. Our target is 200 seconds. After a long campaign of native projections
and I/O fixes, the benchmark had stalled around 305 s on a quiet machine and 323–347 s with stage
tracing enabled.

Our latest attempt, "Candidate C", moved LanceDB row normalization and encoding off the main thread
into a worker thread. It moved the `payload.lance_rows` timer from 16.9 s to 8.1 s, yet the payload
median changed by only -3.7 s (well inside run-to-run noise) and peak anonymous memory rose by
207 MiB.

Both incumbent agents on the repo—Claude Opus and Codex (`gpt-6.1-sol`) at extra-high reasoning
effort—had spent days optimizing the payload stage. Two cross-reviews of the Candidate C report
disagreed on minor accounting details, but neither explained the core paradox: **why had we moved
main-thread work into a worker without making the index any faster?**

## Bringing in a third agent

Hamza connected a third model—Gemini 4 Argon—to the workstation through WebHarness in strict
read-only mode and pointed it at the main checkout, the Codex worktree containing the Candidate C
prototype, and the raw `stderr.jsonl` / `progress.jsonl` benchmark traces.

Because it had no sunk cost in the payload worker hypothesis, it read the timeline from scratch and
came back with three falsifiable claims:

**1. Half of the Candidate C timer win was an accounting illusion.**
In the worker variant (`lancedb-vectordb.ts:581`), `documents.map(normalizeLanceDbRow)` ran on the
main thread *before* the `payload.lance_rows` timer started; in the inline baseline, it ran *inside*
the timer. About 4 s of main-thread work had merely stepped outside the stopwatch.

**2. `payload.drain` is not on the critical path.**
Everyone was summing `payload.producer + payload.drain` (`payloadSeconds`) to judge payload
optimizations. But `index-generation-workflow.ts` starts `payloadDrain` in the background, immediately
awaits `synchronizer.prepareChanges()` (an 18–29 s main-thread scan), and then runs 74 s of
navigation before awaiting `payloadDrain`. The final LanceDB write finishes *during*
`prepare_changes`, so `publication.payload_drain` waits **0 ms** across all six runs.

**3. The producer is starved by an 8-file head-of-line window, not by worker or embedding CPU.**
Inside the 212 s `payload.producer` span, `index.analysisWait` accounted for **191.8–194.9 s**.
Yet the four Tree-sitter analysis workers were **71–80 % idle**, the three Potion embedding
processes spent **30–57 % of their time waiting for input**, and queue backpressure never fired
(`backpressureCount = 0`). The bottleneck sat in front of the workers: `scheduleAnalyses()`
(`indexing-pipeline.ts:883`) clamped the read-ahead window to
`min(concurrency × 2, plan.analysisWindowFiles)`—just **8 files** for 4 workers, consumed strictly
in path order. Because each file must pass through `readIndexableFileObservationInsideRoot` (two
root-bound opens and multiple `await` hops on the main thread) before reaching a worker, every
200–400 ms main-thread turn (Potion stdout parsing, symbol extraction, batch flushing) froze all
8 in-flight file reads at their next `await`.

## Trust, verify, and probe cheaply

Claude audited all three claims against the source code and trace timestamps before writing a line
of product code. Every structural claim checked out. A Codex (`gpt-6.1-sol`) cross-check of the
pipe receipt timestamps confirmed the true serial critical path:

| Stage | Window (s from start) | Duration |
| --- | --- | ---: |
| Source scan | 3.7–23.0 | 19.3 s |
| Payload producer | 23.0–234.8 | 211.9 s *(191.8 s in `analysisWait`)* |
| `prepare_changes` *(overlaps drain)* | 235.7–256.7 | 21.0 s |
| Navigation *(overlaps collection finalize)* | 256.7–330.6 | 73.9 s |
| Publication preparation | 330.6–346.7 | 16.1 s |

At the same time, we discarded unverified back-of-the-envelope numbers from the external review
("~17 awaits per file", "~600,000 event-loop turns") that weren't directly measured by traces.

Before refactoring the file-read path, we tested the head-of-line blocking mechanism with a one-line
disproving probe: if the 8-file window was starving the workers during main-thread turns, widening
the window from 8 to 32 files (8 per worker) had to cut `payload.producer` by more than the ~10 s
run noise.

We ran four interleaved pairs (`base-1..4` at window 8 vs. `w32-1..4` at window 32) on the exact
same build under the 6 GiB cgroup with no swap:

| Metric | Window 8 (median) | Window 32 (median) | Change |
| --- | ---: | ---: | ---: |
| **Critical path** | 323.3 s | **291.1 s** | **-32.2 s** |
| `payload.producer` | 195.9 s | **169.6 s** | **-26.3 s** |
| `index.analysisWait` | 176.8 s | **140.4 s** | **-36.5 s** |
| Peak anonymous memory | 4,434 MiB | **4,416 MiB** | **-18 MiB** |

The distributions did not even overlap: the slowest window-32 run (304.4 s critical path, 172.6 s
producer) beat the fastest window-8 run (309.5 s critical path, 192.1 s producer), despite the
window-32 runs starting under higher background load. A full artifact comparator confirmed all
eight runs produced byte-identical row, vector, checkpoint, and navigation hashes.

We shipped the 8-files-per-worker window for budgets above 4 GiB (`41085c1a`), together with two
additional findings from the same audit—dropping 71,527 redundant per-shard `fs.mkdir` calls across
the 256 pre-created sidecar directories (`3164ba50`) and reusing full-index policy rejections behind
a `stat` witness during `prepare_changes` (`9a85498b`). Together, those changes brought the traced
LibreOffice critical path down to **279.7 s median** (`screen-P`).

## Round two: auditing 1,271 upstream CBM commits

With the indexing pipeline unblocked, we pointed Gemini 4 Argon at a second problem: Satori vendors
its cross-file C/WASM semantic engine (`third_party/cbm-semantic`) from `codebase-memory-mcp` (CBM)
at commit `11b662f9`, while upstream CBM had advanced by 1,271 commits to `3457b21b`. We asked it
to compare the two trees and our TypeScript relationship resolvers.

That audit surfaced three classes of findings—and proved why every external claim still needs a
local fixture or benchmark gate:

### 1. A benchmark blind spot on LibreOffice C++
We had previously assumed our C/C++ semantic changes had zero cost on LibreOffice because
LibreOffice full-index times didn't budge. The audit caught why: LibreOffice has **22,111 C++
files**, which silently tripped `NATIVE_MAX_SESSION_SOURCES = 20_000` (`wasm-analyzer.ts:56`) and
skipped C++ semantic analysis completely. That changed our benchmarking rules: no "zero cost" claim
is accepted without checking the run diagnostics for skipped-language warnings.

### 2. WASM `TSTree` retention and per-file arenas (`f68d0271`, `919be800`, `44f2c821`, `c4808e78`)
When indexing the 1,733-file (75 MB) C/C++ set in the CBM repository itself, Satori's semantic
WASM engine hit the 1 GiB WASM ceiling and `abort()`ed, leaving `architecture_overview` with only
1 boundary. The audit identified the structural leak in `satori_semantic.c`: the C++, Java, C#,
Rust, and Go resolvers held **every parsed `TSTree` in memory across the entire batch** (at
26–38× source byte size) and allocated Pass-2 per-file resolver state inside the session-wide
`&s->arena`.

Moving Pass 2 to a per-file `CBMArena` that is destroyed after each file, deleting each `TSTree`
immediately after Pass 2, and capping retained Pass-1 trees at a **32 MiB source budget**
(`SATORI_MAX_RETAINED_TREE_SOURCE_BYTES`, re-parsing overflow files in Pass 2) cut WASM peak memory
on the CBM C/C++ set from **1,724 MiB $\rightarrow$ 859 MiB** (and **159 MiB** at a 0 MiB budget),
while Go on `trufflehog` (3,295 files) dropped from **397 MiB $\rightarrow$ 275 MiB** (4.3 s $\rightarrow$
3.9 s), all with identical output hashes. Combined with isolating parser workers in child processes
at every memory budget (`f68d0271`, cutting peak PSS on the 1,362-file `webharness` repo from
**3,613 MiB $\rightarrow$ 1,613 MiB median**), CBM's full index jumped from **29,113 to 127,192
relationships** and **1 to 15 architecture boundaries**.

### 3. High-leverage language ports vs. rejected claims
We required a failing fixture before porting any upstream bug fix:

- **Kept and shipped**:
  - **Python (`873146f0`)**: resolved `from . import x` submodule `IMPORTS` edges (CBM `e106c415`),
    marked `if TYPE_CHECKING:` imports `typeOnly` (CBM `3a46d692`), followed `__init__.py`
    re-exports across up to 16 hops (CBM `62191225`), and keyed class inheritance/MRO by
    `symbolInstanceId` instead of short class name so two files defining `class Config` no longer
    erase each other's base classes.
  - **Rust (`5ebfdf76`, CBM `ec4f0eaa`)**: stopped type-qualified associated calls (`Opts::write`)
    from falling back to `lsp_short_name_unique` free functions—removing **1,796 false-positive
    call edges** on `rust-analyzer` (`14,606` $\rightarrow$ `12,810`).
  - **Java, C#, and C++ recovery (`e4623a21`, `873146f0`, `8ab9f98d`, `013cabdd`)**: unwrapped
    single-argument macro definitions (`FNAME(foo)`, CBM `2ef6ba71`), parsed sources with a virtual
    trailing newline so directives at EOF don't break C# files (CBM `fa258d34`), and excluded
    localized parse-error regions instead of dropping whole Java/C#/C++ files (`44,309` $\rightarrow$
    `44,565` calls on Guava; `1,108` $\rightarrow$ `1,915` on `Newtonsoft.Json`).
  - **Kotlin & PHP (`54a1febc`, `b16320b3`)**: chained an own-file AST overlay registry so Kotlin
    primary-constructor `val` properties resolve method calls (CBM `67ff40d5`), and resolved PHP
    grouped `use Ns\{A, B as C}` declarations under the group prefix (CBM `d74579c9`).
- **Disproved and dropped**:
  - Upstream's `BT_STACK = 512` fix in `extract_defs.c` (`cdd8c895`) only affects `def->body_tokens`,
    which `satori_extractor.c` never reads.
  - Upstream's C expression-type memoization (`c3c97a99`, `e9e72d09`), Rust generic `impl<T>` self
    types (`f75af00a`), and C# same-name type probes (`a510646b`) did not reproduce in Satori:
    Satori's `C_EVAL_MAX_STEPS_PER_FILE` guard is per-expression rather than sticky, and our
    existing fixtures already resolved the Rust and C# shapes.
  - Raising the 20,000-source cap for LibreOffice C++ (`5f17c65c`) merely turned an immediate skip
    into a 241 s late abort at 2,000,000 call sites—proving that 22k-file C++ monorepos require
    session splitting, not bigger constants.

## Lessons from multi-agent engineering

1. **Use a fresh model to break confirmation bias.** When the agents writing the code have spent
   ten iterations inside one subsystem, a read-only auditor with zero sunk cost in their code will
   spot timer artifacts and off-critical-path work immediately.
2. **Separate mechanism from back-of-the-envelope math.** A model can be 100 % right about the
   structural bottleneck (the 8-file window and `TSTree` lifetime) while overestimating how many
   seconds a secondary rewrite will save. Adopt the mechanism; measure the numbers yourself.
3. **Measure the critical path, never summed stage timers.** Overlapping background queues
   (`payload.drain`, concurrent worker transfer sums) routinely masquerade as bottlenecks when
   viewed as totals.
4. **Gate every fix on a cheap probe or failing fixture.** A one-line env override proved the
   32-file window in two runs before we touched the resource planner, and strict fixture gates
   separated the six high-impact language ports from four upstream changes that Satori didn't need.
