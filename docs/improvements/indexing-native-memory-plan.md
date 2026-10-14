# Indexing native memory — design B implementation

Approved Turn 4 scope: make full indexing fit 2 GiB, preserve publication/optional-provider/cancellation contracts, no dependencies or delegation. Baseline clean HEAD `400c15d7`.

Attribution: parser WASM optimizing compilation uses 2.30 GiB V8 malloced memory, closely matching 2.21 GiB libc mmap allocations, with only 32 MiB linear WASM memory in that isolate. Baseline-only WASM cuts V8 native compiler allocations to 5 MiB with vector writes unchanged. The largest owner is compiler working memory; parser/allocator capacity also survives thread exit.

Decision: code-change. One resource owner selects baseline-only parser child processes below 4 GiB planning headroom, bounds bytes/files and isolates large files; large budgets keep threads. The parser service owns queues, child lifecycle and awaited exit. Context only selects/wires the port. No reinterpretation of parser results or compiler project closures. TDD Route: off for general work; deterministic failure tests must fail before the lifecycle repair per repository policy.

1. Extend the frozen plan and add a parser process port/runner; prove fault paths before repair (cancellation at recycling, mid-file death, recycled startup failure).
2. Pass operation plan through Context and verify full/warm small/large publication equivalence, including recycling every file and all parser backends.
3. Measure a 2G acceptance run, identify any next owner rather than guessing, then 3G and 3×7G. Run affected tests, pnpm check and MCP contract/docs/manifest checks.
4. Write requested b-report.md, remove diagnostic instrumentation and owned state, confirm process exit and scoped diff; no commit.

Checkpoint: implemented and verified. Mutation workers additionally use MALLOC_ARENA_MAX=2 under small plans (Linux), and the idle semantic WASM worker exits before compiler resolution. A failed or cancelled file now drains every started read-ahead analysis before the pipeline rejects. Frozen-source measurements (6cc01f0e): 2G pass 2.000 GiB / 138.5 s; 3G pass 2.372 GiB / 108.5 s; forced thread-mode budgets 4.2 GiB pass 4.402 GiB / 61.6 s and 5.4 GiB pass 4.414 GiB / 47.1 s; 7G median 4.507 GiB / 49.7 s (historical 44.92 s under lower load, not a paired baseline). Residual risk: the 2G run reached its cap through reclamation; a larger single compiler project or native stage can still exceed a small plan.
