# Release QA, October 2026 (mcp after 0.9.0)

Status: in progress. Fixes below are committed; every fix has a regression test that fails when the fix is broken. QA round 2 on the new build is running.

## How this QA ran

1. Manual QA by an agent driving the built `satori-dev` server against `/home/hamza/repo/colonist-assistant`
   (a large TypeScript + Rust repository with 1,000–6,000-line classes).
2. An independent read-only review of the staged diff (`git diff --cached`), with throwaway tests against temporary git
   repositories.
3. Four Muse QA workers (`muse-spark-1.3-contributor`, xhigh), one per area: freshness, detect_changes/file_outline,
   search, navigation. Each drives the built server through `evals/real-repo-quality/session.mjs` on clones and small
   TS/Python/Rust fixtures in its own scratch directory. One server at a time (shared lock, 3 GB cap per server).

## Why the earlier tests missed these defects

- Freshness: the unit test drove one `SyncManager`. The server has two: the provider runtime's, which runs the watcher
  and owns its epochs, and the provider-free `localSyncManager` that `manage_index sync` uses. Completion reached only
  the second one.
- detect_changes: `change-impact.ts` tests inject a fake outline where every symbol fits one page; the real outline is
  cut at 48 KiB, which only happens in files of thousands of lines.
- file_outline tool tests mock the handler, so the byte budget and range validation never ran there.
- No test drives the built server end to end on a repository large enough to hit response budgets.

## Fixed in the first pass

| Defect | Cause | Fix | Evidence |
|---|---|---|---|
| A. Freshness stays `watcher_event_pending` / `watcher_observation_gap` after `manage_index sync` | Completion recorded on the watcher-less `localSyncManager` | `captureExternalSyncFlight` captures the epoch before the worker starts and delegates completion to the watcher-owning managers (`sync.ts`, `provider-runtime.ts`, `shared-runtime.ts`, `manage-maintenance-handlers.ts`) | `sync-read-freshness.test.ts` with two-manager wiring; fails without delegation. Manual QA: verified after sync |
| B1. `detect_changes` default output overflows the client limit | No response budget | 48 KiB budget trimming `uncertainCallReferences`, `impacted`, then `seeds`, with `omitted` counts and `IMPACT_RESPONSE_BYTE_LIMIT` (`change-impact.ts`) | `change-impact.test.ts`; manual QA returned inline |
| B2. All 50 seeds come from one file | First-come seed allocation | Round-robin across files, `seedOmittedFiles`, `seed_limit` reason | `change-impact.test.ts`; manual QA 9 of 10 files seeded |
| B3. Seeds are whole files | Any symbol overlapping any hunk seeded; one import hunk seeded the whole file | Innermost overlapping symbols; whole-file fallback only when a file has no precise seed | `change-impact.test.ts` |
| B4. Edits inside very large classes seed the whole class | `detect_changes` read only the first 48 KiB outline page | `readCompleteFileOutline` follows `nextPage` (max 40 pages, dedupe by `symbolId`) in `tools/detect_changes.ts` | `tools/detect_changes.test.ts`; manual rerun pending |
| file_outline overflow | No response budget | 48 KiB budget with `hints.nextPage` (`registry-file-outline.ts`) | `registry-file-outline.test.ts`; manual QA bounded |
| file_outline `limitSymbols` cut gives no continuation | No hint on a limit cut | `nextPage` at the next symbol; omitted when it would not advance | `registry-file-outline.test.ts`; manual QA `start_line: 156` |
| file_outline inverted range accepted | No validation | `start_line > end_line` returns `invalid_request` (`navigation-handlers.ts`) | Manual QA; no automated test (tool tests mock the handler) |

## Open defects

### From the staged-diff review (all confirmed, all in code changed by this QA)

| # | Severity | Defect | Evidence | Planned fix |
|---|---|---|---|---|
| R1 | major, fixed (unstaged) | A class-header edit is lost when the same hunk also edits a member | `change-impact.ts:117` drops any overlapping symbol that contains another overlapping symbol. `class C extends A {` → `extends B` plus an edit in method `m`, one hunk: seeds `['m']`, no `C`, no warning. Callers and subclasses of `C` are missing | Each changed line now seeds its innermost containing symbol, so `C` (line 1) and `m` (lines 2–4) are both seeded. Test: "seeds a class header and a member edited in one hunk" |
| R2 | major, fixed (unstaged) | Deleting a whole symbol is blamed on its neighbour, silently | `change-impact.ts:110`: deleting all of `function gone()` between `f` and `h` (`@@ -4,3 +3,0 @@`) seeds `['f']`, no `IMPACT_FILE_LEVEL_SEEDS`. Same disclosure gap for ignored no-symbol hunks (test at `change-impact.test.ts:386` region) | A deletion seeds only a symbol enclosing both neighbouring lines; any hunk that maps to no symbol adds `IMPACT_UNMAPPED_HUNKS` and completeness reason `unmapped_hunks`. Test: deleting `gone` seeds `['h']` with the warning |
| R3 | major, fixed (unstaged) | The 48 KiB budget cannot be met on large diffs, and trimming discards every seed | `changedFiles` (`change-impact.ts:453`) is the full uncapped diff list. 1,500 changed files: 82,041 bytes, `seeds: []`, `omitted.seeds: 50`; the loop at `:497` empties every list and stays over budget | Trim order is now uncertain → impacted → `changedFiles` (`omitted.changedFiles`) → seeds. Test: 1,500 files fit 48 KiB with all 50 seeds |

### From manual QA on colonist-assistant

| # | Severity | Defect | Status |
|---|---|---|---|
| C | near-blocker | Exact-identifier search misses symbols defined in a dirty (edited, unsynced) file, e.g. `decisionSignature` | Fixed with S1 and S2 below |
| M1 | minor | First `manage_index sync` after a server restart stays `watcher_observation_gap`; the second verifies | Not a defect (D1 below) |
| M2 | minor | Reads are blocked while a reindex runs | By design (the reindex accept message discloses it); the reason mismatch was D2, fixed |
| M3 | minor | file_outline repeats the enclosing class on every page | Decided: enclosing symbols repeat on every page but do not count toward `limitSymbols` (O1) |
| M4 | non-blocker, fixed | Natural-language query for the 2000 ms budget constant (`LIVE_WASM_DECISION_TIME_MS`) misses | Cause: natural-language queries disable exact-match pinning, so the reranker reorders the whole slice and demoted the first-stage #1 (`deep-search.ts:59`) to 18–22. Caller `alt_terms` never counted as exact evidence, and `extractIdentifierFromSymbolLabel` read `variable FOO` labels as `variable`. Fix: when a caller alt_term names the symbol declared by the first-stage #1, `resolveRerankBoundary` pins it (`search-rerank-boundary.ts`, `search-rerank-execution.ts`; not for automatic repository vocabulary). With the identifier in `alt_terms` it is #1. Without `alt_terms` the reranker can still demote it; a default-off `first_stage_owner_floor` flag (keep a strong first-stage #1 in the top 3) measured no named-symbol wins or losses on real-repo-quality (17 questions) and the Colonist ablation, so it stays off |

### From the navigation QA worker

| # | Severity | Defect | Evidence | Decision |
|---|---|---|---|---|
| N1 | major (documented limitation) | Rust receiver calls (`deadline.with_budget_ms(...)`) are invisible to `call_graph` in both directions; `find_references` finds them | colonist `depth.rs:2405` → `deadline.rs:53`. Extractor tags them `type_dispatch`; `cbm.ts:151-158` drops non-`direct_call` strategies for languages without receiver-aware capability; Rust has `typeReceiverAwareCapability: NONE` (`capabilities.ts`). Tool description already excludes receiver dispatch | Fixed as disclosure, no edges (user decision; Rust stays non-receiver-aware). `cbm.ts` now keeps a non-admitted strategy as an `unresolved` claim with its candidates and an `unresolved_dependency` proof step instead of dropping it; admission requires `resolved`, so no CALLS edge results, and `call_graph` exact references show the site. Root cause on colonist is wider: since 28fcb259 the CBM provider skips every Rust file with a non-`cfg(test)` `#[cfg(...)]` as `unmodeled_source` (9 of 44 files, `depth.rs` and `deadline.rs` included), so those files have no claims at all. `call_graph` now discloses that (N4). `RELATIONSHIP_BUILDER_VERSION` bumped (`cbm-gated-unresolved-claims-v1`) |
| N2 | minor | Responses over the ~50 KB agent limit: `find_references` limit 500 = 108 KB; `call_graph` 172 KB (`limit` unbounded, `navigation-handlers.ts:1384` only clamps the minimum); `read_file` on a 60 KB single line = 60 KB | Logs in the worker scratch `qa/navigation/logs/05b_readfile.txt`, `09_colonist.txt` | Fixed: the public `call_graph` schema caps `limit` at 50 (the handler keeps larger internal limits for `detect_changes`). No change for the rest: `find_references` reaches 108 KB only at an explicit `limit: 500` (default 100 ≈ 35 KB), and `read_file` stays within its existing line and byte limits |
| N3 | minor | Python `x = lambda v: helper(v)` caller missing from `call_graph` edges and exact-reference evidence | `findEnclosingCaller` (`cbm.ts:19-55`) skips non-callable kinds; `isCallableSymbolKind` (`core/src/symbols/contracts.ts:43-49`) | Fixed: the Python adapter gives a module binding whose value is a `lambda` kind `function`, matching TypeScript arrow bindings (`tree-sitter-adapter.ts`). `SYMBOL_EXTRACTOR_VERSION` bumped. Test in `builder.test.ts`; verified on the built server |
| N4 | minor | `call_graph` callees direction returns an empty result with no warning when calls were dropped | Observational fallback and hints exist only for the inbound path (`relationship-backed-call-graph.ts:883-1000`) | Fixed: `call_graph` reads `providerCoverage[].skippedFiles` from the relationship manifest it already loads and warns `CALL_GRAPH_SOURCE_FILE_UNANALYZED:<reason>` (callees, root file skipped) and `CALL_GRAPH_INBOUND_UNANALYZED_FILES:<n>` (callers, same-language skips). Verified on colonist: `belief_search_backend` callees and `with_budget_ms` callers. Gated receiver calls are disclosed per N1 |
| N5 | minor | `read_file` serves untracked files despite the description promising `FILE_NOT_PUBLISHED` outside the Publication | Deliberate live-path admission (`read_file.ts:403-421`) | Fixed: description now matches the live-path admission |
| N6 | minor | `read_file` silently clamps `start_line > end_line` and ranges past EOF | `read_file.ts:905-926` | Fixed: inverted ranges are rejected; clamping past EOF is disclosed |
| N7 | not a defect | Identical `call_graph` requests differ only in `freshnessDecision.checkedAt` | — | By design |

Observed, not a defect: `detect_changes` on an edited, unsynced file returns `seeds: []` with `unavailableFiles: [{reason: stale_symbol_ref}]` and `coverage: partial`. It refuses to map changed lines onto symbols from an outdated index; the watcher normally syncs first. Whether it should do better before a sync is a product decision.

Passed in navigation QA: TypeScript callers including re-export aliases and closures; Python `self.method`; Rust qualified and imported calls; `trace_path` multi-hop, unconnected pairs and budget honesty; limit/depth honesty; schema validation; dirty-file staleness disclosure; freshness reasons agree across `manage_index status`, `call_graph`, `find_references` and `file_outline` in the same state.

### From the freshness QA worker

| # | Severity | Defect | Evidence | Decision |
|---|---|---|---|---|
| D1 | major | A completed sync leaves `unverified/watcher_observation_gap`; a second sync verifies (same as M1) | Confirmed in code: `coverWatcherObservation` (`sync.ts:646-666`) closes the gap only when `coverage === 'ready'`; `setWatcherCoverage('ready')` (`:486-505`) never closes the startup gap. The post-restart sync is captured while the watcher is `starting`, so the gap survives it. Repro: worker `p12_lifecycle3.mjs` | Not a defect. The "completed sync" in the repro was an operation persisted by an earlier server process; a sync started in the current session verifies. Keeping the gap open for a scan that may predate watcher readiness is correct |
| D2 | minor | During reindex, `search_codebase` says `not_ready/indexing` but `file_outline`, `call_graph`, `find_references` say `not_ready/source_state_unverified` | `navigation-handlers.ts` `buildSourceStateUnverified*` (~246-291) vs `handlers.ts` `prepareReadableState` (~1035-1043) | Fixed: `file_outline`, `call_graph`, `find_references`, `trace_path` and `architecture_overview` report `indexing` during a reindex, like search |
| D3 | minor | `syncStats` is documented on `manage_index` but never emitted | Only the type (`manage-types.ts`) and a gated assignment (`tool-response-builders.ts:152-154`) exist; no handler supplies it | Fixed: field removed (sync is asynchronous; nothing could populate it) |
| D4 | minor | Every server restart runs a full supervised sync with no source change, briefly flapping status to `unverified/sync_active` | `lastSyncTimes` is in-memory only (`sync.ts:385`), so the first background tick always syncs | By design: the startup sync is what establishes freshness after a restart |

Passed in freshness QA: create/status, sync accept shape and `mutation_in_progress`, edit → pending → sync, rename, delete, branch checkout, `.satoriignore` add/remove, reads during sync vs create/reindex, cancel paths, killed create/reindex recovery, root authorization, determinism, response sizes ≤ 6.5 KB.

### From the detect_changes/file_outline QA worker

Ran on the build from before the R1–R3 fixes.

| # | Severity | Defect | Evidence | Decision |
|---|---|---|---|---|
| O1 | major | file_outline paging dead-ends: `hasMore: true` with no `nextPage` when the enclosing symbol fills the page | `limitSymbols: 1` on a 2,883-line class: page 1 → `Mega`, `nextPage.start_line: 2`; page 2 → `Mega`, `hasMore: true`, no hint. The stall guard (`registry-file-outline.ts:273-281`) drops the hint because the first omitted symbol is the enclosing repeat; the byte-budget path (`:311-315`) uses the same guard. Code changed by this QA | Fixed (`registry-file-outline.ts`): enclosing repeats do not count toward `limitSymbols` or the continuation, so `nextPage` always advances. Test in `registry-file-outline.test.ts` |
| O2 | minor | `symbolIdExact`/`symbolLabelExact` are silently ignored in outline mode (all symbols returned, no warning) | `tools/file_outline.ts:17-47`, `navigation-handlers.ts:1025` | Fixed: rejected unless `resolveMode="exact"` (`tools/file_outline.ts`) |
| O3 | minor | A pure rename seeds the moved symbols as changed and uses two of the 50 file slots | `--no-renames` in `change-impact.ts:62-63`; `git mv util.py helpers.py` seeds `helper` | Fixed: `detect_changes` detects renames; a pure move seeds nothing and uses one file slot, a move with an edit seeds only the edited symbol |

Passed in detect_changes/file_outline QA (against `git diff -U0`): a method edit inside the 2,883-line class seeds only that method (B4 confirmed on the built server); property, Python, TypeScript and Rust edits seed precisely; import-only edit falls back with the warning; untracked/staged/unstaged/deleted files; 60 changed files cap at 50 seeds; `baseRef` forms and validation; determinism; all responses ≤ 48 KiB; file_outline inverted range, past-EOF, window slices and detail modes.

Not exercised: round-robin with `seedOmittedFiles` non-empty; a single symbol over the 48 KiB budget.

### From the search QA worker

| # | Severity | Defect | Evidence | Decision |
|---|---|---|---|---|
| S1 | major | A dirty file over 256 KiB loses all its symbols from search: exact-identifier queries return 0 results (Python: unrelated symbols instead) | Confirmed in code: the dirty overlay skips files over `SEARCH_DIRTY_OVERLAY_MAX_BYTES` (`search-query-support.ts:52,485`), and every non-overlay pass suppresses dirty paths (`search-candidate-fusion.ts:103-111`), so nothing represents the file. colonist `overlay.ts` is 252,513 bytes, 9.6 KB under the cap. Recovers after sync | Fixed: the overlay reports the dirty paths it did not read, and only re-read paths suppress indexed results (`search-query-support.ts`, `search-candidate-fusion.ts`, `search-execution.ts`) |
| S2 | major | A one-line comment edit to a dirty, under-cap file demotes an unchanged exact-identifier definition out of the frozen top 10 (`decisionSignature`: #4 clean → absent, not reachable via `continue_search`) | Worker trace: 15 `dirty_source_suppressed` removals; dirty run uses `["dirty_overlay","primary"]`, and the overlay re-adds at single-pass RRF weight (`search-execution.ts:819-840`). Mechanism not yet traced by me | Fixed: the overlay runs once per request and its results enter fusion with one pass weight, replacing the suppressed stale passes |
| S3 | minor | Grouped responses can exceed the ~50 KB client limit (51,545 bytes at `limit: 200`) | The grouped cap is 128 KiB (`search-constants.ts:45`) | Fixed: grouped cap is 48 KiB |
| S4 | minor | Fallback groups lose `symbolKind` and report `navigation.graph: missing_symbol` for an existing current-source symbol | `search-group-results.ts:515-520` | Fixed: overlay results keep the chunk's `symbolKind`. `graph: missing_symbol` stays; it is accurate for a symbol not in the published graph |

Passed in search QA: untracked and deleted files before and after sync; small dirty edits with repaired spans; duplicate names; determinism; filters and validation; `continue_search` paging, replay and error codes; exact constant query; root authorization.

Not exercised: continuation expiry, `alt_terms`, vocabulary flags, Rust, more than 16 dirty files.

### Independent manual QA on the committed build (d89eb809), colonist-assistant

Verdict given: not ready, one blocker. Confirmed fixed on this build: dirty-file exact search (`decisionSignature` rank 4,
blocker C), freshness after sync, file_outline `nextPage` and inverted range, concurrent-mutation blocking,
`continue_search` paging and conflicts, and the new `call_graph` unanalyzed-file warning (`with_budget_ms`: 14 files).

| # | Severity | Defect | Evidence | Decision |
|---|---|---|---|---|
| Q1 | blocker (reported) | `detect_changes` seeds whole large classes (`AssistantOverlay` 411–6573, `GameSession` 519–1874, `CompactGameBuilder` 1177–2313) although the hunks (≈11, 13, 4) sit inside methods; small classes seed precisely | Repro: defaults on colonist vs `git diff -U0 src/content/overlay.ts`. Not yet reproduced by me. Hypotheses, in order: (1) `readCompleteFileOutline` stops at 40 pages and, with `callGraphHint` making pages byte-bound (Q8), never reaches the methods, so the class is the innermost known symbol; (2) some hunks touch class-level lines (fields, blank lines between members), which seed the class by design (R1) | Fixed. Reproduced on `session.ts` (`GameSession` 519–1874): the hunk 563–567 adds a JSDoc block before a new field, and the comment lines lie outside every member span, so they mapped to the class. Hypothesis 1 refuted (the outline pages were complete). `change-impact.ts` now attributes a changed comment, decorator, attribute or blank line to the declaration that starts right after it; a changed line still inside the class body between members seeds the class |
| Q2 | minor | Natural-language query for the 2000 ms budget misses `deep-search.ts:59` in the top 5, also with the identifier in `alt_terms` | Same as M4 | Fixed for `alt_terms` (pinned #1); natural-language-only query still reranker-ordered |
| Q3 | minor | Exact-identifier query `scheduleDecisionAnalysis` ranks test and mock declarations above the real method (`overlay.ts:3361`, not in the top 3) | The exact registry lookup found several declarations with that name, treated them as ambiguous and fell back to hybrid ranking, so the order depended on `limit`. (`scripts/ui-preview/scenarios.ts:103` is `internals.scheduleDecisionAnalysis`, not an exact-name match) | Fixed: an ambiguous exact name or qualified name now returns every declaration (up to `limit`), with runtime files before tests, fixtures, scripts and docs (`selectAmbiguousExactDeclarations` in `search-exact-fast-path.ts`). `overlay.ts:3361` ranks #1 at both the default limit and `limit: 50` |
| Q4 | minor | A `usableSessionDiceHistory` span (`overlay.ts:3083`) is labelled `class AssistantOverlay` | The `overlay.ts:3083` hit is labelled `method usableSessionDiceHistory`; the `class AssistantOverlay` hit is 411–450, the class's own field lines | Not reproduced; label is correct |
| Q5 | minor | Reads return `not_ready` (`retryAfterMs: 2000`) for ≈72 s during reindex | Same as M2 | By design |
| Q6 | minor | `call_graph` returns 0 callers for `with_budget_ms` (Rust) | The 28fcb259 `unmodeled_source` skip removed `depth.rs`. With the skip gone, `depth.rs` is analyzed, but the call `deadline.with_budget_ms(..)` stays unresolved: the receiver comes from `let deadline = CooperativeDeadline::start(..)`, and the resolver does not infer that return type | Coverage fixed (rust-v3). 0 proven edges, reported as `member_call` partial (1 observed, 1 unresolved), plus an observational source reference to `depth.rs:2405`. The remaining `CALL_GRAPH_INBOUND_UNANALYZED_FILES:1` is `build.rs` |
| Q7 | minor | `find_references` includes a test-local `decisionSignature` (`tests/recommendation-integrity.test.ts:26`) | Line 26 is a same-named module-level function in the test. `find_references` is documented as exact textual occurrences with the owning symbol disclosed | By design |
| Q8 | minor | `file_outline` reports `indexedAt: null`, `stalenessBucket: unknown` while `sourceState` is fresh and freshness verified | `NavigationFileFreshness` (`search-types.ts`) documents that the symbol registry keeps no per-file index time; `registryBuiltAt` and `sourceState` carry freshness | By design |
| Q9 | minor | `callGraphHint` per symbol makes the 100-symbol `overlay.ts` page hit `OUTLINE_RESPONSE_BYTE_LIMIT` | One exact outline symbol is ≈924 B, of which `callGraphHint` is ≈300 B. Pages stay under the byte limit and `nextPage` continues (O1) | Not a defect (size cost only); did not cause Q1 |
| Q10 | minor | First sync after one restart stayed `watcher_observation_gap`; did not reproduce after the next restart | Same as M1/D1 | Not a defect (see D1) |

Not tested by this report: cancelling a long operation, a full file_outline walk of `overlay.ts`, long-running-server
sync sequences, create on a new codebase, `architecture_overview`, other codebases, cancel racing a mutation, `clear`.

### QA round 2 on the committed build (d89eb809)

Freshness worker: D1 confirmed not a defect (a sync started in the current session verifies; this also explains Q10),
D2 and D3 fixed. Search worker: S1, S2 (`decisionSignature` #4 clean, #3 dirty), S3 (36–48.7 KB at `limit: 200`), S4
and C fixed.

| # | Severity | Defect | Evidence | Decision |
|---|---|---|---|---|
| S5 | minor | `resultMode: "raw"` has no byte budget: 65.9–66.1 KB at `limit: 200` | Raw branch of `search-result-finalization.ts` returns `scored.slice(0, limit)`; the S3 cap covers grouped only | Fixed: raw mode keeps the longest rank-order prefix that fits the grouped byte budget (48 KiB, 2 MiB with `debug: full`) and adds `SEARCH_RAW_RESULTS_TRIMMED_TO_BYTE_BUDGET`; the top chunk is always kept |
| S6 | minor | An unreadable dirty file (`chmod 000`) loses all its indexed results | `search-query-support.ts` dirty overlay: the `catch { continue; }` and `!stat.isFile()` paths do not record the path as unread, so its indexed results stay suppressed. A deleted file must keep suppressing (ENOENT) | Fixed: a read failure records the path as unread unless `lstat` reports it absent (`ENOENT`/`ENOTDIR`; the root-bound opener drops errno). A non-file path still suppresses |
| F1 | minor | Cancelling a reindex on a root whose create was cancelled leaves status `reindex/cancelled`; nothing recovers it automatically | Worker repro; a manual `create` recovers | By design (cancel is final) |
| O4 | minor | `file_outline` exact mode with duplicate labels and `limitSymbols: 1` returns `ambiguous`, `hasMore: true` and no `nextPage` | The exact branch of `registry-file-outline.ts` truncated matches to `limitSymbols` without giving a continuation. Repro: diffoutline worker fixture `dup/dup.py` | Fixed: exact mode returns every match with status `ambiguous` and `hasMore: false` |
| NV1 | major (reported) | In a session whose first calls are navigation tools, reads stay `unverified/watcher_manager_not_started`; after one `manage_index status`, reads verify | The watcher belongs only to the lazily created provider runtime (`provider-runtime.ts:499`). The local manager delegates observation to it (`shared-runtime.ts:272`, `sync.ts:1053-1063`), and it does not exist until a provider-backed call. Offline auto-index starts it at session start. Repro: navigation worker `r2h_order.mjs`, `r2i_race.mjs` | Fixed (reporting): the old answer was truthful but alarming, because "unverified" with a `degraded` warning reads as bad data when nothing has failed. `sync.ts` now reports the reasons that only mean live tracking is not running (`watcher_disabled`, `watcher_manager_not_started`, `root_not_registered`, `watcher_starting`) as `state: index_snapshot`, with the `info` warning `SOURCE_SERVED_FROM_INDEX_SNAPSHOT` ("Results come from the latest completed index…"). Real watcher failures, pending events and checkpoint problems still report `unverified`. Test: `sync-read-freshness.test.ts` (it fails with the old mapping). The colonist repro now shows `index_snapshot`, then `verified` after `manage_index status`. Not done: starting the watcher eagerly. The watcher needs the embedding-capable runtime (`provider-runtime.ts` `startProviderSyncLifecycle`), so it would load embedding providers for navigation-only sessions, and `ProviderRuntime.shutdown` does not own an in-flight runtime creation |
| NV2 | minor | `call_graph` callees gives no disclosure for gated or unresolved calls from the root | The Rust provider skipped cfg-gated files (28fcb259), so they produced no occurrences | Fixed with rust-v3: `belief_search_backend` returns 20 edges with `constructCoverage` `direct_call` partial (62/76 resolved) and `member_call` partial (0/93 resolved) |
| NV3 | minor | A Python class-body `cb = lambda ...` is not extracted as a symbol | `pythonModuleBindingName` required a module parent (`core/src/language-analysis/tree-sitter-adapter.ts`) | Fixed: class-body lambda assignments are extracted as `method` (extractor language-analysis-v20, which triggers a reindex) |

Detect/outline worker: O1, O2, O3, R1, R2 and R3 fixed (R3: 49,151 B, 50 round-robin seeds over 1,500 files; no
response in the round exceeded 49,151 B). Also passed: outline windows starting inside a member, rename plus edit,
cross-directory rename, `baseRef: HEAD~1`, staged new and copied files, deleted files, seed round-robin with per-file
omissions, pure deletion fallback, TS and Rust method seeds, determinism.

Passed in round 2: more than 16 dirty files, dirty bytes over the 2 MiB total budget, dirty rename, `continue_search`
with dirty files, trimming disclosure, determinism, kill mid-reindex recovery, reads during sync, `mutation_in_progress`,
response sizes. Not exercised: continuation expiry, `alt_terms`.

## Adjacent findings (not fixed)

- `scripts/satori-useful-context-fixture-record.mjs` and `scripts/satori-live-latency-benchmark.mjs` expect a synchronous sync that returns `syncStats`. Both were already broken by the asynchronous sync contract.
- Commit 28fcb259 marked every Rust file with any non-`cfg(test)` `#[cfg(...)]` as `unmodeled_source`, removing all call evidence from those files. Fixed (rust-v3): cfg-gated code is modeled, and alternate cfg variants with the same name resolve as ambiguous.

## Plan

1. Fix R1–R3 with a regression test each that fails on the current code. Done.
2. Fix the round-1 defects (O, S, D, N). Done, including the deferred N1, N3 and N4.
3. Rebuild, rerun the QA workers on their repros, repeat until a round finds no new major defect. Fixes committed (d89eb809); round 2 running.
4. Reproduce and fix Q1 (blocker), then triage Q3, Q4, Q7, Q8, Q9. Done: Q1, S5, S6 fixed (uncommitted); the rest triaged above.
5. Open decisions: ranking (Q2, Q3, M4), coverage (NV2, NV3, 28fcb259). Done: Q3, O4, NV2, NV3 and 28fcb259 fixed; Q2/M4 fixed for caller `alt_terms` (reranker pin); omitted-seed count (`omitted.seeds` now includes seed-budget drops, `change-impact-omitted-seeds.test.ts`) fixed; Q6 left at the resolver's receiver-inference limit.
