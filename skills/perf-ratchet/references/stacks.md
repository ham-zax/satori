# Recipes by stack and workflow

Each section lists three kinds of tool: **Truth** (wall clock), **Gate**
(deterministic counts for the ratchet), and **Explain** (profilers). Use the
project's existing harness first if it has one.

## Web / browser apps (React, Vue, Svelte, Angular, plain DOM)

- **Truth:** Navigation and Resource Timing, `performance.mark/measure` around the journey, Web Vitals (LCP, INP, CLS), real user monitoring split by platform and product. Lab runs with Playwright or Puppeteer, repeated 10+ times and reported as the median.
- **Gate:** render commits per interaction, style recalcs, layouts, DOM mutations, layout shifts by region, long animation frames, network requests and bytes, JS heap. See `browser.md` for the snippets. CDP `Performance.getMetrics` returns `RecalcStyleCount`, `LayoutCount`, `Nodes`, `JSEventListeners`, `ScriptDuration`, and `TaskDuration`.
- **Explain:** DevTools Performance panel, React Profiler, `chrome://tracing`, coverage of unused JS and CSS.
- **Typical wins:** a static shell before hydration, prefetch on hover, code splitting, narrower subscriptions, memoized finished content, work in Web Workers, cheaper selectors, reserved layout space.

## Electron / desktop shells

- **Truth:** cold start to first interactive frame, measured with the OS cache dropped where possible. Warm start is a separate journey.
- **Gate:** main-process instruction count at startup (Valgrind on Linux), modules loaded, IPC messages per journey, renderer metrics as for the browser.
- **Explain:** `--cpu-prof` for the main process, the DevTools profile for renderers, `--trace-startup` / `--enable-tracing`.
- **Typical wins:** V8 code cache or snapshot for the main bundle, lazy `require`, fewer synchronous IPC calls, deferred non-critical windows and services.

## Node.js / TypeScript services and CLIs

- **Truth:** `hyperfine 'node dist/cli.js ...'`, or `performance.now()` spans around request handlers. Report p50/p95 under a fixed load from autocannon, k6, or wrk.
- **Gate:** `instr-count.sh -- node --predictable --random-seed=1 bench/x.mjs` (subtract a `node -e 0` baseline), and `call-counts.mjs --filter src/ --json calls.json -- node bench/x.mjs`. Add allocations via `--trace-gc` counts or `process.memoryUsage()` deltas, and syscalls/file reads via `strace -c -f`.
- **Explain:** `node --cpu-prof` (summarize the `.cpuprofile` in the app or with speedscope), `--heap-prof`, `--prof` with `--prof-process`, `0x`, and clinic.js.
- **Notes:** `await` boundaries break call stacks in CPU profiles, so count calls to fill the gaps. Worker threads need their own `--cpu-prof`.

## Python

- **Truth:** `pyperf` (`python -m pyperf timeit` or a bench script), `hyperfine 'uv run app ...'`.
- **Gate:** `cProfile` total call count (`ncalls`, deterministic for fixed input), `tracemalloc` peak and allocation count, `valgrind --tool=cachegrind python ...` for instructions, and SQL query counts (Django `assertNumQueries`, SQLAlchemy event counters).
- **Explain:** `py-spy record --native`, `scalene`, `cProfile` plus snakeviz, `line_profiler`.
- **Typical wins:** vectorize with NumPy, Polars, or DuckDB; avoid per-row Python; move work to a C extension or Rust; batch I/O; avoid repeated import cost at CLI start (`python -X importtime`).

## Go

- **Truth:** `go test -bench . -count 10 > new.txt` then `benchstat old.txt new.txt`.
- **Gate:** `-benchmem` allocs/op and B/op (deterministic), and `testing.AllocsPerRun` in tests. Use Valgrind instruction counts for small binaries.
- **Explain:** `-cpuprofile` / `-memprofile` with `go tool pprof`, `go tool trace` for scheduler and GC latency, and `GODEBUG=gctrace=1`.

## Rust / C / C++

- **Truth:** criterion, `hyperfine`, Google Benchmark.
- **Gate:** instruction counts with `iai-callgrind` (Rust), `instr-count.sh`, or `valgrind --tool=callgrind` (call counts per function, deterministic). Count allocations with dhat, heaptrack, or a counting allocator.
- **Explain:** `perf record` / `samply`, `cargo flamegraph`, `callgrind_annotate`, `kcachegrind`.

## JVM (Java, Kotlin, Scala)

- **Truth:** JMH with forks and warmup; startup measured with hyperfine.
- **Gate:** JMH `-prof gc` (`gc.alloc.rate.norm`, bytes per op, very stable), JFR event counts, and class-loading count at startup (`-Xlog:class+load`).
- **Explain:** async-profiler (cpu, alloc, wall modes), JFR plus JDK Mission Control.
- **Typical wins:** AppCDS/CDS archives and CRaC for startup, fewer allocations on hot paths, avoiding autoboxing and reflection.

## .NET

- **Truth:** BenchmarkDotNet.
- **Gate:** `[MemoryDiagnoser]` allocated bytes per op and Gen0 count, `ThreadingDiagnoser`, and EventPipe counters.
- **Explain:** `dotnet-trace`, `dotnet-counters`, PerfView, the Visual Studio profiler.
- **Typical wins:** ReadyToRun or Native AOT for startup, `Span<T>`, pooling, avoiding LINQ in hot loops.

## Mobile

- **Android:** Jetpack Macrobenchmark (startup, frame timing) for truth; gate on frame-timing percentiles, Baseline Profile coverage, and allocation counts. Explain with Perfetto and Android Studio profilers.
- **iOS:** XCTest `measure(metrics:)` with `XCTClockMetric` for truth; `XCTCPUMetric` (instructions retired, close to deterministic), `XCTMemoryMetric`, and `XCTApplicationLaunchMetric` for the gate. Explain with Instruments (Time Profiler, Animation Hitches).
- Frame budget: 16.67 ms at 60 Hz, 8.33 ms at 120 Hz (ProMotion and high-refresh Android).

## Databases and backends

- **Truth:** request latency p50/p95/p99 under a fixed, recorded load (k6, wrk, vegeta, Locust), plus server spans (OpenTelemetry).
- **Gate:** queries per request (catch N+1), rows examined, `EXPLAIN (ANALYZE, BUFFERS)` shared-buffer hits/reads (Postgres), cache hits/misses, outbound calls per request, payload bytes.
- **Explain:** slow-query log, `pg_stat_statements`, tracing waterfalls, flame graphs of the service.
- **Typical wins:** indexes that match the query shape, batching, preloading, response caching behind correct invalidation, removing serial round trips.

## CI, builds, and test suites

- **Truth:** job wall time and queue time per pipeline, tracked as a trend because runners are noisy.
- **Gate:** number of tasks executed vs cached (Turborepo, Nx, Bazel, Gradle build scans), files compiled, tests run, bytes downloaded, container layers rebuilt.
- **Explain:** build profiles (`tsc --generateTrace`, `--extendedDiagnostics`, Gradle `--profile`, Bazel `--profile`, `cargo build --timings`), slowest-test reports.
- **Typical wins:** cache keys that actually hit, affected-only test selection, sharding, removing duplicate typechecks and installs.

## Agent and LLM workflows

- **Truth:** task wall-clock time to an accepted result, and time to first token.
- **Gate:** tool calls per task, model round trips, input and output tokens, prompt-cache hit ratio, retries, and bytes read into context. These counts are fixed for a scripted task and directly drive cost and latency.
- **Explain:** the session transcript or trace (which calls were redundant, which reads were too large, which steps ran serially but could run in parallel).
- **Typical wins:** batch independent tool calls, read targeted ranges instead of whole files, cache stable context and keep the cache warm, use narrower tools, make fewer and larger edits, run independent subtasks in parallel, and stop once acceptance passes.
