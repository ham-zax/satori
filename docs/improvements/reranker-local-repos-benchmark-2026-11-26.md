# Multi-repo offline reranker benchmark (LateOn vs Voyage), 26 November 2026

Benchmarked the installed `@satori-code/mcp@0.14.1` offline runtime (`Potion` `minishlab/potion-code-16M-v2` + `LanceDB`, zero code edits) across three local repositories outside Satori:

- `trufflehog` (`/home/hamza/repo/trufflehog`, Go, `bcfcf73aa`, 3,454 indexed files / 26,140 chunks, indexed in `36.8 s`)
- `tessera` (`/home/hamza/repo/tessera`, TypeScript/TSX, `2efa2ee`, 202 indexed files / 4,815 chunks)
- `claive` (`/home/hamza/repo/claive`, Python + Rust, `0caa38f`, 218 indexed files / 4,800 chunks)

Suite: `evals/reranker-benchmark/cases.json` (15 plain-English behavioral queries per repository, 45 total).  
Raw output: `docs/evidence/benchmarks/2026-11-26-reranker-3repo.json`.

## Summary: Clean 2-repo comparison (`tessera` + `claive`, 30/30 queries reranked)

Every reranked arm (`offline-lateon`, `offline-voyage-rerank-3`, `offline-voyage-rerank-3-lite`) applied reranking on **30/30** queries across `tessera` and `claive` with `0` reranker failures and `0` timeouts:

| Arm | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@10 | Strict Hit@1 | Strict MRR@10 | Warm p50 | Voyage Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `offline-none` | 40.0% (12/30) | 60.0% (18/30) | 73.3% (22/30) | 83.3% (25/30) | 0.5303 | 36.7% (11/30) | 0.5073 | 660 ms | 0 |
| `offline-lateon` | 63.3% (19/30) | 86.7% (26/30) | 90.0% (27/30) | 90.0% (27/30) | 0.7567 | 63.3% (19/30) | 0.7567 | 2,686 ms | 0 |
| `offline-voyage-rerank-3` | 83.3% (25/30) | 100.0% (30/30) | 100.0% (30/30) | 100.0% (30/30) | 0.9167 | 83.3% (25/30) | 0.9167 | 1,478 ms | 1,127,296 |
| `offline-voyage-rerank-3-lite` | **93.3% (28/30)** | **100.0% (30/30)** | **100.0% (30/30)** | **100.0% (30/30)** | **0.9667** | **93.3% (28/30)** | **0.9667** | **1,226 ms** | 1,140,976 |

### Per-repository breakdown (`tessera` & `claive`)

| Repo | Arm | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@10 | Warm p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tessera` (TS/TSX) | `offline-none` | 40.0% (6/15) | 66.7% (10/15) | 73.3% (11/15) | 80.0% (12/15) | 0.5356 | 710 ms |
| `tessera` (TS/TSX) | `offline-lateon` | 53.3% (8/15) | 73.3% (11/15) | 80.0% (12/15) | 80.0% (12/15) | 0.6467 | 2,601 ms |
| `tessera` (TS/TSX) | `offline-voyage-rerank-3` | 86.7% (13/15) | 100.0% (15/15) | 100.0% (15/15) | 100.0% (15/15) | 0.9333 | 1,855 ms |
| `tessera` (TS/TSX) | `offline-voyage-rerank-3-lite` | **100.0% (15/15)** | **100.0% (15/15)** | **100.0% (15/15)** | **100.0% (15/15)** | **1.0000** | 1,418 ms |
| `claive` (Py+Rust) | `offline-none` | 40.0% (6/15) | 53.3% (8/15) | 73.3% (11/15) | 86.7% (13/15) | 0.5250 | 161 ms |
| `claive` (Py+Rust) | `offline-lateon` | 73.3% (11/15) | 100.0% (15/15) | 100.0% (15/15) | 100.0% (15/15) | 0.8667 | 2,719 ms |
| `claive` (Py+Rust) | `offline-voyage-rerank-3` | 80.0% (12/15) | 100.0% (15/15) | 100.0% (15/15) | 100.0% (15/15) | 0.9000 | 979 ms |
| `claive` (Py+Rust) | `offline-voyage-rerank-3-lite` | **86.7% (13/15)** | **100.0% (15/15)** | **100.0% (15/15)** | **100.0% (15/15)** | **0.9333** | **875 ms** |

### Key findings

1. **LateOn vs None:** LateOn raised Hit@1 by **+23.3 pp** (`40.0% -> 63.3%`) and MRR@10 by **+0.2264** (`0.5303 -> 0.7567`) on `tessera` + `claive`.
2. **Voyage vs LateOn:** `rerank-3-lite` (Satori's default Voyage reranker) raised Hit@1 by another **+30.0 pp** (`63.3% -> 93.3%`), achieved **100% Hit@3**, raised MRR@10 from `0.7567` to `0.9667`, and was **2.2x faster** (`1,226 ms` vs `2,686 ms` warm p50). `rerank-3` scored `83.3%` Hit@1 (`MRR 0.9167`, `1,478 ms`).
3. **Voyage free tier runway:** The 30 queries used ~1.14M tokens (`~38k` tokens/query) on `rerank-3-lite`, which equals roughly **~5,200 searches** within Voyage AI's **200M free tokens per model** tier (no credit card required).

## `trufflehog` (Go, 3,454 files) & background-sync confound

In `docs/evidence/benchmarks/2026-11-26-reranker-3repo.json`, all 3 repos shared one `SATORI_STATE_ROOT` and one session per arm. Even with `MCP_ENABLE_WATCHER=false`, `startProviderSyncLifecycle` (`packages/mcp/src/server/provider-runtime.ts`) fires `startBackgroundSync()` after `BACKGROUND_SYNC_INITIAL_DELAY_MS` (5 s) and every `BACKGROUND_SYNC_INTERVAL_MS` (3 min), walking all indexed codebases in `SATORI_STATE_ROOT`. While `trufflehog` was syncing, `search-frontdoor.ts` served `freshnessMode: "served_previous_generation"`, which skips reranking in `packages/mcp/src/core/search-rerank-execution.ts:775-776`.

- Consequently, in the saved 45-query JSON, `trufflehog` only applied reranking on `1/15` queries in `offline-lateon` (`Hit@1 26.7%`, `MRR 0.5328`) and `3/15` queries in both Voyage arms (`Hit@1 40.0%`, `MRR 0.5994` — recovering `th2` `3->1` and `th3` `2->1`).
- In a subsequent partial run (`task-198`, before the 3-minute sync tick hit `th14-th15`), `offline-lateon` applied on `th1-th13` of `trufflehog` and reached **9/13 (69.2%) Hit@1** (`th1, th3, th5, th6, th7, th8, th10, th11, th12` at rank 1; ~3.5 s/query) compared to `4/15` without reranking.
- `evals/reranker-benchmark/run.mjs` fixes this benchmark harness issue by isolating per-repo `SATORI_STATE_ROOT` directories and calling `manage_index sync` before each query pass.

## Query-level ranks (`docs/evidence/benchmarks/2026-11-26-reranker-3repo.json`)

| Repo | ID | None | LateOn | Voyage-3-Lite | Voyage-3 | Query |
| --- | --- | --- | --- | --- | --- | --- |
| trufflehog | th1 | 1 | 1 | 1 | 1 | where does trufflehog cache credential verification results to avoid repeating remote API checks for the same secret |
| trufflehog | th2 | 3 | 2 | 1 | 1 | where does trufflehog apply multiple decoders recursively up to a maximum depth on each chunk |
| trufflehog | th3 | 2 | 2* | 1 | 1 | where does trufflehog use Aho-Corasick keyword matching to find candidate detectors for a chunk |
| trufflehog | th4 | 1 | 1* | 1* | 1* | where does trufflehog drop unverified findings or filter results by entropy thresholds |
| trufflehog | th5 | 2 | 2* | 2* | 2* | where does trufflehog map a detected secret back to its line number in a file fragment |
| trufflehog | th6 | 3 | 3* | 3* | 3* | where does trufflehog retry HTTP requests on 429 rate limits and honor Retry-After headers |
| trufflehog | th7 | 2 | 2* | 2* | 2* | where does trufflehog read an input file or stream in fixed chunks with peek overlap |
| trufflehog | th8 | 1 | 1* | 1* | 1* | where does trufflehog schedule concurrent source enumeration and wait for source workers to finish |
| trufflehog | th9 | 3 | 3* | 3* | 3* | where does trufflehog decode and skip already scanned repositories when resuming an interrupted scan |
| trufflehog | th10 | 2 | 2* | 2* | 2* | where does trufflehog extract visible text from HTML content while handling syntax highlighting |
| trufflehog | th11 | 1 | 1* | 1* | 1* | where does trufflehog scan base64 character substrings from a chunk for decoding |
| trufflehog | th12 | 8 | 8* | 8* | 8* | where does trufflehog validate HTTP endpoints, headers, and status code ranges for custom regex detectors |
| trufflehog | th13 | 2 | 2* | 2* | 2* | where does trufflehog build combinations of multiple named regex capture groups in custom detectors |
| trufflehog | th14 | 5 | 5* | 5* | 5* | where does trufflehog manage reusable byte buffers to reduce allocations during scanning |
| trufflehog | th15 | - | -* | -* | -* | where does trufflehog strip null bytes and replace invalid UTF-8 sequences in sanitized strings |
| tessera | ts1 | - | - | 1 | 1 | where does tessera compare and advance hybrid logical clocks when observing remote timestamps |
| tessera | ts2 | 1 | 1 | 1 | 1 | where does tessera deduplicate and apply a batch of remote sync operations inside a database transaction |
| tessera | ts3 | - | 1 | 1 | 2 | where does tessera resolve concurrent field-level updates and counter increments during sync merge |
| tessera | ts4 | 6 | 1 | 1 | 1 | where does tessera check for revision conflicts before rolling back an AI mutation batch |
| tessera | ts5 | 1 | 2 | 1 | 1 | where does tessera capture target revisions and issue single-use confirmation plans for Tier 2 actions |
| tessera | ts6 | 3 | 2 | 1 | 1 | where does tessera execute an AI agent turn with tool calling and compile turn results |
| tessera | ts7 | 3 | 1 | 1 | 1 | where does tessera validate and apply incremental UI view patch operations |
| tessera | ts8 | 1 | 5 | 1 | 1 | where does tessera evaluate collection query filters, sorting, and relation hydration against SQLite |
| tessera | ts9 | 1 | 1 | 1 | 1 | where does tessera classify schema changes as destructive or additive during collection updates |
| tessera | ts10 | 2 | 1 | 1 | 1 | where does tessera validate dynamic record field values against a collection schema |
| tessera | ts11 | 5 | 1 | 1 | 2 | where does tessera grant idempotent credits and place holds on user account balances |
| tessera | ts12 | 1 | 2 | 1 | 1 | where does tessera verify Stripe webhook signatures and fulfill credit pack purchases |
| tessera | ts13 | 1 | - | 1 | 1 | where does tessera enforce per-user sync rate limits and push/pull operation caps on the cloud API |
| tessera | ts14 | - | - | 1 | 1 | where does tessera estimate LLM token costs and parse non-JSON AI compilation responses |
| tessera | ts15 | 2 | 1 | 1 | 1 | where does tessera compute safe filter inheritance when creating new records inside a filtered collection view |
| claive | cl1 | 1 | 2 | 1 | 1 | where does claive run a subprocess under a resident memory cap and time limit and kill its session tree if exceeded |
| claive | cl2 | 4 | 1 | 1 | 1 | where does claive terminate a detached process tree using SIGTERM, cgroup.kill, and SIGKILL escalation |
| claive | cl3 | 1 | 1 | 1 | 1 | where does claive track token budgets and pause a worker with a handoff prompt for context recovery |
| claive | cl4 | 1 | 1 | 1 | 1 | where does claive decide whether to continue, stop, or warn a turn based on elapsed time and stall timeouts |
| claive | cl5 | - | 1 | 1 | 1 | where does claive submit, withdraw, and stage steering receipts across worker turn continuations |
| claive | cl6 | 6 | 1 | 1 | 1 | where does claive create recurring or one-shot scheduled wake files with file locking and deliver due wakes |
| claive | cl7 | 4 | 2 | 1 | 2 | where does claive detect noisy verifier byproducts and check changed workspace paths against an allowlist |
| claive | cl8 | 8 | 2 | 1 | 1 | where does claive redact API keys, passwords, and secrets from text in Python |
| claive | cl9 | 1 | 1 | 1 | 1 | where does claive redact bearer tokens, private keys, and secret fields in the Rust TUI event formatter |
| claive | cl10 | 1 | 1 | 1 | 1 | where does claive verify whether a worker or watcher process is still alive using proc stat start times and boot IDs in Rust |
| claive | cl11 | 2 | 1 | 1 | 1 | where does claive classify worker triage badges and compute sort keys for the TUI worker list |
| claive | cl12 | - | 2 | 2 | 2 | where does claive fold orchestration events and select the next implementer or critic lane in multi-agent runs |
| claive | cl13 | 1 | 1 | 1 | 1 | where does claive cache verifier results keyed by workspace state to skip redundant test runs |
| claive | cl14 | 4 | 1 | 1 | 1 | where does claive expire and clean up idle worker sessions while skipping protected active sessions |
| claive | cl15 | 3 | 1 | 2 | 2 | where does claive resolve the parent harness and sanitize session identifiers for the completion inbox |

`*` marks `trufflehog` queries that bypassed reranking (`served_previous_generation`) during the shared-state-root run.
