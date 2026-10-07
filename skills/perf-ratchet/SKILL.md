---
name: perf-ratchet
description: Measurement-first performance loop for any app, repo, OS, or agent harness. Picks the right wall-clock, deterministic-count (instructions, calls, renders, DOM/style work, allocations, queries, requests) and frame-budget metrics, proves the proxy tracks wall clock, optimizes against it, guards behavior with equivalence tests and flags, and locks wins with a ratchet that can only go down. Use when the user says "make it faster", "speed up", "latency", "slow", "startup time", "jank", "frame drops", "perf regression", "benchmark", "profile", "ratchet", "wall clock", "instruction count", "call count", or wants a perf CI gate. Not for one-off micro-tuning without a user-visible journey.
---

# Perf Ratchet

> If it can be measured, it can be improved. Once a metric exists, an agent can
> iterate against it without waiting for field data.

Distilled from Anthropic's August 2026 claude.ai speed sprint
(<https://claude.dev/blog/how-we-made-claude-ai-faster/>). In that sprint, an
agent working in one shared channel made the core journeys 3.1x faster
(geometric mean across 13 metrics) in two weeks. It merged 3,000+ changes with
zero incidents and zero rollbacks. The useful part is not any single trick but
the **loop**, the **metric ladder**, and the **guardrails** below. They work for
any stack.

## 0. Adapt before you measure

Do this once per task. It decides which tools and which section of the references apply.

1. **Harness.** Map the verbs in this skill to your tools (table below). If you cannot run commands, produce the exact commands and ask the user to run them and paste the output.
2. **System.** Run `scripts/doctor.sh [repo]` (Linux/macOS/WSL) or `scripts/doctor.ps1 [repo]` (Windows PowerShell). It reports OS, cores, load, the available tools, and an install command for each missing one.
3. **Missing tools.** **Ask the user before installing anything.** Give the exact command for their OS (`references/tools-by-os.md`). Never run `sudo` or elevated installs yourself; ask the user to run them (in Claude Code: `! sudo apt-get install -y valgrind`). If they decline, fall back to the next metric on the ladder and say what precision you lost.
4. **Repo conventions win.** Look for existing bench, profile, and trace tooling first (`bench`, `perf`, `profile`, `benchmark` scripts, tracing env flags, CI perf jobs) and reuse it. Repo instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING) override this skill on run counts, memory caps, commit rules, and test commands.
5. **Stack.** Open the matching section of `references/stacks.md` (web/browser, Node, Python, Go, Rust, JVM, .NET, native, mobile, databases/backends, CI/builds, agent/LLM workflows).

| Verb in this skill | Claude Code | Codex / OpenCode / Gemini CLI / Aider | Cursor / Windsurf / IDE agents | Chat only (no shell) |
|---|---|---|---|---|
| run a command | Bash (cap memory per repo rules) | shell tool | terminal tool | give command, user pastes output |
| ask the user | AskUserQuestion, or ask in text | ask in chat | ask in chat | ask in chat |
| browser counters | browser skill / Playwright / CDP | Playwright via shell | built-in browser or Playwright | snippet from `references/browser.md` pasted in DevTools |
| parallel threads | subagents or workers, one journey each | separate sessions or worktrees | separate chats or branches | one journey at a time |
| long-running wait | background task plus notification | blocking wait | terminal | user reports back |

## 1. The loop

Run one loop per **journey**: a user-visible flow with a start and an end, such as "cold launch to typeable", "open conversation", "send to first token", "search request p50", "`index` on repo X", or "CI job wall time".

1. **Open the thread.** Name the journey, the user-visible endpoint, the current number, and an owner. Keep it narrow: one journey or benchmark per thread.
2. **Build the benchmark.** Trace the real flow end to end. Reproduce it in a lab harness with fixed inputs and fixed data size. Record a baseline (section 3).
3. **Find the dominant cost.** Profile; don't guess. Rank costs, and attack the biggest one the profile shows (section 4).
4. **Ship small changes, sized for risk.** Add tests or an equivalence check *before* optimizing. Put anything user-perceptible behind a flag (section 5).
5. **Watch the deploy.** Compare the lab metric and the field metric (RUM, logs, traces) before and after. Confirm the field moved, not just the lab.
6. **Lock it in.** Lower the ratchet ceiling (`scripts/ratchet.mjs update`) so the win cannot silently regress.
7. **Next.** Do not close the thread when the first target is hit. Look for the next cost *within the same journey*. Close it only at diminishing returns (section 7).

## 2. The metric ladder

Use three tiers. Each tier has a different job, so do not substitute one tier for another.

| Tier | Purpose | Examples | Property |
|---|---|---|---|
| **Truth** | What users feel; the number you report | wall clock per journey, p50/p95 latency, time-to-interactive, frames per second, peak RSS | noisy, hardware-dependent |
| **Gate** | CI ratchets, fast iteration, tiny diffs | instruction counts, function call counts, allocations/op, render commits, style recalcs, layouts, DOM mutations, DB queries, network requests, bytes | deterministic for fixed input; machine-independent or nearly so |
| **Explain** | Why a number moved | CPU profile, call tree, flame graph, per-function call counts, query log, frame-by-frame trace | diagnostic, not gated |

Rules:

- **Validate every gate proxy against truth** before trusting it. Make one real optimization and measure both the proxy and the wall clock. They must move in the same direction with a plausible ratio. In the sprint, cutting instructions by 48% cut wall clock by 78% on one hot path, and 31% fewer instructions gave 44% less wall clock on another. If the proxy moves and the wall clock does not, the proxy is measuring the wrong work. Pick another proxy.
- **Measure the noise of the gate.** Run it twice on unchanged code. Deterministic counts should agree within 0.1%; instruction counts under Valgrind with `node --predictable` typically agree within 0.001%. Set the ratchet tolerance just above the observed noise.
- **Subtract fixed startup cost.** A process-level count includes runtime boot. For example, an empty `node` process costs about 93M instructions, which can hide a 40% workload win as a 3% total change. Either measure a no-op baseline and subtract it, or measure in-process around the journey.
- **Count calls to explain instructions.** `scripts/call-counts.mjs` showed a resolver called 59,999 times instead of 20,000: the "resolve each ID once, not three times" fix is visible directly.
- **Several cheap counters beat one perfect one.** Each new instrument tends to expose new targets. In the sprint, about a third of the PRs added telemetry or a guardrail.

## 3. Measurement protocol

### Wall clock (truth)

- Use `hyperfine --warmup 3 --runs 10 '<cmd>'`, or the stack-native harness (pyperf, `go test -bench` plus benchstat, criterion, JMH, BenchmarkDotNet).
- Report **median of at least 3 runs** (more if the repo asks), the spread (IQR or min/max), and **peak memory** (`/usr/bin/time -v` on Linux, `/usr/bin/time -l` on macOS, `Measure-Command` plus process stats on Windows).
- Record machine load (`uptime` or `doctor.sh`), core count, power mode, and whether the cache was warm or cold. Compare before and after only on the same machine, input, and load.
- For cold-start journeys, state how you made the start cold: dropped OS caches, a fresh profile, or a cleared app cache.
- For p95/p99, collect enough samples (at least 100) and report the distribution, not one number.

### Deterministic counts (gate)

- **Instructions:** `scripts/instr-count.sh -- <cmd>`. It uses the Valgrind backend where available, then `perf stat` with a PMU, then macOS `time -l`. For Node, add `--predictable --random-seed=1`. Keep the workload small, because Valgrind is 20-80x slower.
- **Calls:** `node scripts/call-counts.mjs --filter <src-dir> --json calls.json -- node <entry>` for JS. For other stacks, see `references/stacks.md` (cProfile ncalls, Go pprof counts, callgrind call counts, JFR, EventPipe).
- **UI work:** render commits, style recalculations, layouts, DOM mutations, long animation frames, and layout shifts per interaction (`references/browser.md`).
- **I/O work:** queries per request, rows/buffers read, network requests and bytes per journey, file reads, cache misses, process spawns. These are often the biggest wins and the easiest gates.
- **Agent/LLM workflows:** tool calls, model round trips, input/output tokens, and cache-hit ratio per task.

Write every gate into a single flat `metrics.json` (`{"journey.metric": number}`) so `ratchet.mjs` can check it.

### Frame budget (smoothness)

For streaming, scrolling, and animation, use the frame budget: 16.67 ms per frame at 60 Hz and 8.33 ms at 120 Hz. Add an FPS readout computed from `requestAnimationFrame` timestamps. In CI, drive headless Chromium with deterministic frame stepping (CDP `HeadlessExperimental.beginFrame`) and step through the worst case frame by frame. Gate on **total main-thread blocking time** and **worst single frame**, not average FPS.

## 4. Hunting: where the time actually goes

Run a **census** before you guess. Each census below found a large, invisible cost in the sprint:

- **Subscription/re-render census:** count components, hooks, store subscriptions, and listeners that wake on one keystroke or event. One composer had about 6,900 hooks and 900 subscriptions re-rendering per keystroke.
- **Selector/rule audit:** a single expensive CSS selector (`:root:has(...)`) added 24 ms to every DOM change. The same applies to regex tables, middleware chains, and validation rules.
- **Code path tracing:** a forgotten `location.reload()` caused about 500k hidden reloads a day. Grep for reloads, retries, polling, and duplicate fetches.
- **Idle profiling:** profile while the user does nothing. One idle tab cloned cache snapshots into IndexedDB twice a minute on the main thread.
- **Encoding and representation:** one non-ASCII character can turn a whole string into two-byte UTF-16 and push every regex onto a slower path. Copying code blocks to a one-byte string before highlighting cut a 1.0 s freeze to 0.35 s.

### Pattern catalogue

Each fix below gives the same output with less work. Prove that with an equivalence test.

| Smell | Fix |
|---|---|
| Same lookup repeated per item | resolve once and pass it down; hoist out of loops |
| Expensive regex/parse on every line | cheap first-character or length prefilter, then the full check |
| O(total length) work per streamed chunk | memoize finished blocks; only process the growing tail |
| Heavy work on the UI/main/request thread | move it to a worker, thread pool, or background job; keep a fallback |
| Big layout/paint in one frame | split it across frames (cell by cell, row by row) to fit the budget |
| Interactive UI waits for framework boot | ship a static shell rendered from the same component, then hydrate over it; test the handoff |
| Recompiling the same code every start | bytecode or code cache, snapshot, AOT, persistent compile cache |
| Navigation waits on fetch | prefetch on intent (hover, focus, viewport), with cancellation |
| Constant per-session work repeated per request | cache it behind a witness (hash, stat signature, frozen value identity); fall back when unsure |
| N+1 queries or round trips | batch, join, or preload; gate on query count |
| Re-render storms | narrow subscriptions, stable props, selector memoization; gate on commit count |
| Late content moving the layout | reserve space, pin layout, and gate on layout shifts per region |

## 5. Guardrails: what makes bold changes safe

- **Tests come first.** Before any optimization, the behavior must be covered. If it is not, add the test, watch it pass on the old code, then optimize.
- **Equivalence, not just speed.** Changes that claim "same output, faster" need a differential test of new vs old over fixtures that hit every branch the new code takes. A fast path returns "unsure" and falls back unless it is provably correct. Mutation-check the test: break the cache key or witness, confirm the test fails, then restore it.
- **Hand-offs get their own tests.** Static-to-live UI swaps need layout comparisons across several viewport sizes (the sprint used 14 viewports with ±1 px tolerance) plus keystroke-ordering tests. Worker offloads need ordering and cancellation tests. Caches need invalidation tests.
- **Flags for anything user-perceptible.** Roll out to the team, then to 1% of users, then to everyone. Track flags in one list and retire them: the sprint created about 200 and retired more than half before it ended.
- **Review.** Every change gets automated review plus at least one human approval when the project has humans in the loop. Show user-visible changes as before/after recordings.
- **Ratchet everything you won.** `scripts/ratchet.mjs check` runs in CI or nightly. `update` only ever lowers ceilings. Raising a ceiling must be a reviewed edit with a stated reason.
- **Headless isn't the user's machine.** Headless browsers lack real browser UI, prerendering, extensions, and GPUs. When field data disagrees with the lab, reproduce the field condition in the lab and add it as a test.

## 6. Scaling: many narrow threads, not one wide one

- Run one journey or benchmark per thread or worker, and scale by opening more threads. The sprint ran 150+ in parallel.
- Each thread has a named owner who supplies **taste**: which trade-offs are acceptable, such as skeleton timing or animation cost against the frame budget.
- A coordinator supplies **direction**: sequencing, deduplication, closing threads at diminishing returns, and shared-file conflicts.
- Supply **ambition**: treat targets as starting points. Ask "what would make this 10x?" before settling for 10%.
- On a single machine, keep heavy measurements serial. Parallel benchmarks corrupt each other's wall clock. Deterministic counts are safer to parallelize.

## 7. When to stop

Stop a thread when either is true:

- the next win is below the measurement noise or below what users can perceive, or
- the complexity cost is greater than the gain. In one sprint decision, saving 2 ms per send did not justify maintaining a custom build plugin.

Open the remaining journeys as new threads (p95 tails, very large inputs, rarely-run flows) instead of stretching the current one.

## 8. Report format

```
Journey: <name> (<platform>, <input/fixture>, cold|warm)
Truth:   <before median> -> <after median>  (<x>x, n=<runs>, spread <IQR>, peak RSS <a> -> <b>)
Gates:   instructions <a> -> <b> (<-%>), calls <a> -> <b>, <other counts>
Proxy validated: <yes: proxy -% vs wall -%> | <no: why>
Cause:   <dominant cost from profile, file:line>
Change:  <what changed>; flag <name> | none
Safety:  <equivalence/differential test>, <mutation check result>
Ratchet: <baseline file> lowered: <metric> <old> -> <new>
Command: <exact commands used> ; machine <cores, load>
```

When summarizing several journeys, use the geometric mean of the speedups, not the arithmetic mean.

## Files

- `scripts/doctor.sh`, `scripts/doctor.ps1`: detect OS, stack, and tools, and print install commands. They never install.
- `scripts/instr-count.sh`: instruction counts (valgrind | perf | macOS backends).
- `scripts/call-counts.mjs`: deterministic JS function call counts via V8 precise coverage.
- `scripts/ratchet.mjs`: `check` / `update` ceilings that only go down.
- `references/tools-by-os.md`: tool matrix and install commands for Linux, macOS, Windows, and WSL.
- `references/stacks.md`: recipes per stack and workflow (truth, gate, and explain tools for each).
- `references/browser.md`: in-page counters (commits, style recalcs, DOM mutations, layout shifts, frame meter) and CDP frame stepping.
