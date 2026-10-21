# How a third agent found the LibreOffice indexing bottleneck

Date: 21 October 2026. Status: draft article. The speed result is confirmed on four runs per
variant with identical output; window 32 is not yet a product change. Technical record:
[LibreOffice critical path](libreoffice-critical-path-2026-10-21.md), section 5.1.

## The problem

Satori is the code-intelligence layer that coding agents use to search a repository before they
change it. Its benchmark target is a full index of LibreOffice (35,760 files) in 200 seconds. After
a long series of optimizations the run took about 305 s on a quiet machine and 347 s with tracing
on.

The most recent candidate, "Candidate C", moved LanceDB row encoding into a worker thread. It changed
the payload median by -3.7 s, inside the noise, and raised peak anonymous memory by 207 MiB. Codex
and Claude had both worked the problem at extra-high reasoning effort. Two reviews of the Candidate
C report disagreed on the details, but neither explained why main-thread work had moved and the
index had not become faster.

## The third agent

Hamza gave the same material to Gemini 4 Argon. It connected through WebHarness and read, in
read-only mode, the main repository, the Codex worktree with the Candidate C prototype, and the run
traces. Its report made three claims.

**A. Part of the Candidate C gain was a timer artifact.** In worker mode, `normalizeLanceDbRow` runs
on the main thread for every chunk before the `payload.lance_rows` timer starts. About 4 s of work
left the timer, not the main thread. This corrected a claim Claude had made in the Candidate C
analysis.

**B. The payload drain time is not on the critical path.** After the producer ends, the main thread
runs `index.prepare_changes`, a synchronous filesystem walk of 18-29 s. The last LanceDB write waits
behind it, so `drainSeconds` measures `prepare_changes`, not vector writes. Navigation then runs
longer than the drain, and `publication.payload_drain` waits 0 ms in all six runs.

**C. The producer waits on file analysis, not on embeddings.** `index.analysisWait` is 191.8-194.9 s
of the 212-217 s producer time. Embedding backpressure never triggers (`backpressureCount = 0`), the
three Potion embedding helpers spend 30-57 % of their time waiting for input, and the four
tree-sitter workers are 71-80 % idle. The gate is in front: `scheduleAnalyses()` keeps an analysis
window of 8 files, consumed strictly in path order, and each file passes through a chain of async
filesystem calls before it reaches a worker. Any main-thread stall stops all 8 chains at once.

## What we checked

Claude checked the three claims against the code and the traces before acting on them. All three
held:

- The timestamps of one traced run show `payload.producer` ending, then `prepare_changes` running
  for 21.0 s, the last LanceDB write ending inside it, then navigation for about 74 s.
- `index-generation-workflow.ts` starts the payload drain in the background, awaits
  `prepareChanges`, runs navigation, and only then awaits the drain.
- The window is `min(concurrency × 2, plan.analysisWindowFiles)` in `indexing-pipeline.ts`, which
  gives 8 files with 4 workers.

Some figures in the report stayed unverified: "about 17 async calls per file", "about 600,000
event-loop turns" and "18.7 s of filesystem CPU". The article does not rely on them.

A Codex (gpt-6.1-sol) cross-check of the full timeline then placed the critical path in seconds
from the benchmark start:

| Stage | Window | Duration |
| --- | --- | ---: |
| Source scan | 3.7-23.0 | 19.3 s |
| Payload producer | 23.0-234.8 | 211.9 s (191.8 s analysis wait) |
| `prepare_changes` | 235.7-256.7 | 21.0 s |
| Navigation | 256.7-330.6 | 73.9 s |
| Publication preparation | 330.6-346.7 | 16.1 s |

The finding changed the target. Candidate C and the planned binary Potion transport both worked on
stages that run off this path, which is why Candidate C gave nothing.

## The experiment

Gemini's recommendation was to remove the async filesystem hops per file. Before that larger change,
we tested the mechanism with a cheaper probe: if the 8-file window throttles the producer, a larger
window must shorten the producer. A temporary environment switch set the window, and a trace event
recorded the value the run used. Both variants used one build, one harness and one memory limit
(6 GiB, no swap). The claim was to count as disproved if the producer time fell by 10 s or less,
the noise level of these runs.

The first pair passed the check by a wide margin: producer -32.2 s, critical path -74.7 s. Three more
runs per variant, alternated, followed. Medians of four runs per variant:

| Metric | Window 8 | Window 32 | Change |
| --- | ---: | ---: | ---: |
| Critical path | 323.3 s | 291.1 s | -32.2 s |
| Producer | 195.9 s | 169.6 s | -26.3 s |
| Analysis wait | 176.8 s | 140.4 s | -36.5 s |
| Peak anonymous memory | 4,434 MiB | 4,416 MiB | -18 MiB |

The ranges do not overlap: the slowest window-32 run beats the fastest window-8 run on both the
producer and the critical path. Most window-32 runs started on a busier machine. The first pair
overstated the gain because its baseline was a slow outlier (371.5 s). The memory cost seen in that
pair (+308 MiB) did not repeat.

A larger window must not change the result. A comparator checked all eight published indexes: every
run holds 547,349 rows and 71,523 navigation files, with identical hashes for rows, vector bits,
source checkpoints and navigation contents.

## What is not proved yet

- **The root cause.** The analysis wait is still 140 s at window 32. The window size is a lever on
  the stall, not its cause. The per-file async read path that Gemini named is the next candidate.
- **The product change.** The experiment used a temporary override. A product change must decide the
  window inside the resource plan, which derives it from the memory budget.

## Lessons

- **A fresh reader found what the incumbents missed.** Codex and Claude had spent many runs on the
  payload stage. The third agent read the same traces without that history and asked what the
  producer waited on.
- **Check the claims before building on them.** The report was right on the mechanism and
  unverified on several numbers. Claude adopted only the claims the code and traces confirmed.
- **Measure the critical path, not stage totals.** `payloadSeconds` included time that overlapped
  `prepare_changes`. Stage totals pointed at the wrong work for several iterations.
- **Probe the mechanism cheaply first.** A one-line window switch tested the theory in two runs
  before any change to the file-read path.
