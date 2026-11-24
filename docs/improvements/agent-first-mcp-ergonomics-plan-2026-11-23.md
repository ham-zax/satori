# Agent-First MCP Ergonomics & Workflow Plan (v2 — Oracle-Verified), 23 November 2026

Sequenced execution plan evolving Satori's MCP surface for AI coding agents across frontier and Flash models.

- **Synthesis inputs:** 2 critical thinking passes (`thinking-jobs-to-be-done`, `thinking-pre-mortem`), 2 lateral thinking passes (`lateral-thinking/inversion`, `lateral-thinking/concept-fan`), read-only architectural counsel (`gpt-6.2-sol` `xhigh`, Claive worker `c521ae18d481`), and two independent adversarial Oracle reviews — with **every cited defect and byte measurement independently verified against the live checkout** before locking v2.
- **Baseline:** `1dca4466` on `master` + uncommitted v4 offline benchmark & landing-page update + Phase 2 initial ergonomics edits (`PRESET_DEFAULTS.implementation` callers/callees, oversized exact-registry `open_symbol` routing, concise `tools/list` descriptions).
- **Core thesis:** Fix verified correctness and live-wiring bugs first (**`A9`** root pinning + `read_file` root/symlink/error fixes; **`A4`** live `detect_changes` unprojected graph port fixing dead `uncertainCallReferences` and adding honest `directSeedTestReferences`). Build a thin evidence-aware scorer (**`A0`**) and replay the current working tree to discover when agents first reach *sufficient evidence*. Then run **`A5`** (one-call hydrated exact hit) and **`A1`** (composer-aware line-numbered text rendering on `read_file` + fixing ordinary `>40`-line auto-compact JSON/`structuredContent`) as independent controlled experiments, followed by split **`A2`** (`file + symbolLabel` graph selectors + `dirname`-canonicalized `file_outline` paths) and targeted **`A6`** cold-start measurement/availability repairs. Keep all 11 tools (**`A8`** cut; guard full `tools/list` payload bytes instead).

---

## Live-Verified Findings from Counsel & Oracle Reviews

Every finding below was verified directly against `/home/hamza/repo/satori`:

1. **`A4` live integration bug + dead code (`detect_changes.ts:62–66`, `navigation-handlers.ts:2284`, `call-graph-evidence-projection.ts:236–240`, `change-impact.ts:253`):**
   - `detect_changes.ts` calls `handlers.handleCallGraph(...)` with no `evidence` parameter and parses its public JSON.
   - `handleCallGraph` passes the payload through `projectCallGraphEvidence`, whose `summarizePayload` explicitly executes `delete rest.exactReferences; delete rest.sourceReferences; delete rest.testReferences; delete rest.evidencePage;`.
   - **Verified live impact:** (a) `detectChangeImpact` does **not** receive `testReferences` today; (b) `change-impact.ts:253` (`for (const reference of graph.exactReferences ?? [])`) is **silently dead in live `detect_changes` calls** (`uncertainCallReferences` only passed in unit tests mocking `ports.callers` directly); and (c) `detect_changes.test.ts` only unit-tests `readCompleteFileOutline` without exercising the live `handleCallGraph` seam.
2. **`A4` unproven call-site fallback (`relationship-backed-call-graph.ts:442`):**
   - `buildTestReferences` computes `const startLine = record.span?.startLine ?? source.span.startLine;` and still emits `site` with `kind: "call"`, making missing-span fallbacks indistinguishable from recorded call sites.
   - `buildTestReferences` also collects only **direct** `TESTS` edges targeting `targetSymbolId` (not tests exercising transitive callers), and a `TESTS` source may be a fixture/helper rather than a runnable test.
3. **`A9` four live bugs in range recommendations & `read_file.ts`:**
   - `search-response-helpers.ts:479–485, 530–536, 662–666`: `buildSearchGroupRecommendedAction` (both plain-range branches) and `buildTopRecommendedRawSearchAction` omit `codebaseRoot`.
   - `read_file.ts:988` (`mode: "annotated"`): calls `resolveCodebaseRootForFile(absolutePath, ctx)`, completely ignoring `boundRoot` / `allowedRoot` on overlapping Publications.
   - `read_file.ts:615–619`: returns `symbolContextErrorResponse` (`formatVersion: 2, kind: "symbol_context"`) when `boundRoot` containment fails, even on plain non-`open_symbol` range reads.
   - `read_file.ts:609–619`: calls `canonicalizeFilesystemPath(resolvedPath)` *before* `isPathInsideRoot(absolutePath, boundRoot)` and *before* `readAuthorizedPublishedSource`, creating a final-symlink `ROOT_BINDING_INVALID` oracle instead of uniform `FINAL_SYMLINK_REJECTED` / unpublished denial.
4. **`A1` cross-host transport & budget traps (`read_file.ts:716, 945–984`, `symbol-context-composer.ts:626, 942–985`):**
   - **Host matrix:** Codex (`CallToolResult::as_function_call_output_payload`) and reported Claude Code builds prefer `structuredContent` over `content` when both are populated; Cursor has dropped `structuredContent`-only results; OpenCode (v1/v2) and Pi 1.6.0 (`convertMcpResult`) vary by mode/version. Therefore `format: "text"` must emit **one self-contained `content` text block and omit `structuredContent`**.
   - **Live contradiction in `read_file.ts:945–984`:** Ordinary `>40`-line range reads currently wrap raw source into a one-line JSON-escaped `compactEnvelope` (no line numbers) AND attach `structuredContent: compactEnvelope` alongside `content`.
   - **Composer budget mismatch:** `symbol-context-composer.ts:942–985` budgets excerpts and omission-based continuations against JSON `serializedBytes`. Post-hoc text trimming risks desyncing continuation start lines or throwing false `MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT` errors, while JSON-only budgeting prematurely truncates escape-heavy code by 15–30%.
   - **Adoption catch-22:** An opt-in `format: "text"` flag that `recommendedNextAction` never emits measures flag discoverability rather than agent ergonomics. Treatment arms must emit `format: "text"` in `recommendedNextAction` while keeping omitted/`"json"` defaults intact.
5. **Live `tools/list` payload measurement (`packages/mcp/src/tools/registry.ts`):**
   - Measured live via `getMcpToolList()`: descriptions = **`4,576 B`**, inlined JSON `inputSchema` = **`16,815 B`** (**3.7×** larger than descriptions; `search_codebase` schema alone is `3,865 B`, `call_graph` `2,370 B`, `find_references` `2,033 B`, `file_outline` `1,852 B`, `read_file` `1,705 B`), full serialized `tools/list` payload = **`22,041 B`**.
   - Guarding only `description.length` misses 79% of the per-turn schema token tax.
6. **`A0` & `A5` benchmark blind spots (`evals/agent-discovery/run-opencode.mjs:961–965`, `docs/improvements/agent-discovery-benchmark-2026-11-23.md`):**
   - `isOwnerSource` requires a named read tool and only checks for a filename + symbol substring; it credits signature-only reads and cannot credit a verified body delivered by `search_codebase`.
   - The Nov 23 v4 benchmark predates the current working-tree edits (oversized exact-hit `open_symbol` routing + default `implementation` callers/callees + concise descriptions), runs only Satori-only vs Native-only (missing a realistic **Hybrid Native+Satori** arm), and scripts Call 1 (`task.satoriQuery`).
   - `known-exact-target` (`runExactRegistryFastPath`, 434 lines) is oversized — a non-oversized-only `A5` pilot would skip the headline 8-call task unless explicitly paired with both an eligible exact task and the oversized control.
7. **`A6` `reindex` availability seam (`search-frontdoor.ts:253`, `read_file.ts:539`):**
   - `servePreviousGeneration` currently exits early on `if (operation?.action !== "sync") return null;`, and `read_file.ts` blocks on `activity.action === "create" || activity.action === "reindex"`. When a compatible previous Publication remains safely admitted (`searchableGenerationAvailable && searchableRead`), blocking reads/searches during background `reindex` creates avoidable downtime.

---

## Final Verdict Table

| Slice | Title | Verdict | Order | Primary Owners |
|---|---|---|---|---|
| **A9** | Pin `codebaseRoot` on range recommendations + fix 3 `read_file.ts` root/annotated/symlink bugs | **APPROVE — Ship #1** | Wave 1a | `packages/mcp/src/core/search-response-helpers.ts`, `packages/mcp/src/tools/read_file.ts`, `read_file-root.test.ts` |
| **A0** | Thin evidence-aware ergonomics scorer (sibling to frozen v4) + working-tree control replay | **APPROVE (narrow first increment) — Ship #2** | Wave 1b | `evals/agent-discovery/run-opencode.mjs`, `source-ledger.mjs` |
| **A4** | Corrected `detect_changes` internal graph port (fix live `uncertainCallReferences` bug + surface bounded `directSeedTestReferences` with honest site provenance) | **REVISE — Ship #3** | Wave 1c | `packages/mcp/src/tools/detect_changes.ts`, `packages/mcp/src/core/change-impact.ts`, `relationship-backed-call-graph.ts`, `navigation-handlers.ts` |
| **A5** | Controlled 1-call source hydration experiment on clean unique exact hits (JSON unchanged; eligible + oversized control) | **PROMOTE TO EXPERIMENT — Ship #4** | Wave 2a | `packages/mcp/src/core/search-exact-fast-path.ts`, `search-exact-registry-hit.ts` |
| **A1** | Composer-aware `format: "text"` on `read_file` (exact `open_symbol` + fix `>40`-line ordinary range auto-compact JSON/`structuredContent`); treatment `recommendedNextAction` emits `format: "text"` | **REVISE — Ship #5** | Wave 2b | `packages/mcp/src/tools/read_file.ts`, `symbol-context-public-contract.ts`, `symbol-context-composer.ts`, `search-response-helpers.ts` |
| **A2** | Split into **(A2a)** direct `file + symbolLabel` resolution on `call_graph` & `find_references` (shared resolver, bounded disambiguation) and **(A2b)** `dirname`-canonicalized absolute path normalization on `file_outline` (preserving symlinked roots & `FINAL_SYMLINK_REJECTED`) | **SPLIT & REORDER — Ship #6** | Wave 2c | `packages/mcp/src/tools/{call_graph,find_references,file_outline}.ts`, `navigation-handlers.ts` |
| **A6** | Cold-start phase profiling + anti-poll recovery + compatible-`reindex` previous-Publication serving (**KILL** provisional lexical scans; defer `<=3s` wait until cohort proven) | **REVISE / KILL provisional scans** | Wave 2d | `packages/mcp/src/core/search-frontdoor.ts`, `tracked-root-readiness.ts`, `read_file.ts`, `provider-runtime.ts` |
| **A8** | Tool consolidation (`11 → 5–6`) & passive repo map — replace with full `tools/list` (`description + inputSchema`) byte-budget guardrail (`22,041 B` baseline) | **CUT consolidation; ADD payload guardrail** | Wave 1/2 hygiene | `packages/mcp/src/tools/registry.test.ts` |
| **A3** | Flatten `open_symbol` schema + multi-symbol batch read (optional tiny win: default `contractVersion` to `2` if traces show hand-authored failures) | **DEFER both parts independently** | Backlog | `packages/mcp/src/tools/read_file.ts`, `prepared-publication-read-session.ts` |
| **A7** | Live mid-edit per-file AST/symbol overlay beyond existing 256 KiB `currentSpan` | **DEFER** | Backlog | `packages/mcp/src/core/current-source-symbols.ts`, `navigation-handlers.ts` |

---

## Sequenced Implementation Plan

### Step 1 — `A9`: Root-Pinned Range Recommendations & `read_file.ts` Root/Symlink Fixes (No Benchmark Required)
- **Owners:**
  - `packages/mcp/src/core/search-response-helpers.ts` (`buildSearchGroupRecommendedAction`, `buildTopRecommendedRawSearchAction`)
  - `packages/mcp/src/tools/read_file.ts` (`:605–625`, `:980–1015`)
  - `packages/mcp/src/tools/read_file-root.test.ts` & `packages/mcp/src/tools/read_file-security.test.ts`
- **Changes:**
  1. Emit `codebaseRoot: path.resolve(codebaseRoot)` in both plain-range branches of `buildSearchGroupRecommendedAction` and in `buildTopRecommendedRawSearchAction`.
  2. In `read_file.ts` (`mode: "annotated"`), pass `allowedRoot` instead of recomputing `resolveCodebaseRootForFile(absolutePath, ctx)`.
  3. On `boundRoot` containment failure in `read_file.ts:615`, return `symbolContextErrorResponse` only when `exactRequest` is set; return the ordinary `outsideIndexedRootResponse` / authorization denial on plain range reads.
  4. Eliminate the final-symlink `ROOT_BINDING_INVALID` oracle (`read_file.ts:609–619`) by validating logical/parent containment cleanly and delegating final-component symlink rejection uniformly to `readAuthorizedPublishedSource` (`FINAL_SYMLINK_REJECTED`).
- **Verification & ship gate:**
  - End-to-end tests executing generated `recommendedNextAction.args` against overlapping parent/child roots where the pinned root denies or is unready while the sibling/child root could serve the path.
  - Overlapping-root `mode: "annotated"` test proving outline uses `allowedRoot`.
  - Final-symlink test with `codebaseRoot` proving uniform symlink/unpublished denial (no target-leak oracle).
  - Existing manual range calls without `codebaseRoot` stay backward-compatible; focused MCP tests + `pnpm run check` green.

### Step 2 — `A0` (Thin First Increment): Evidence-Aware Scorer & Working-Tree Control Replay
- **Owners:** `evals/agent-discovery/run-opencode.mjs` (around `aggregateSessionData` and lines `961–965`, `1251`), `evals/agent-discovery/source-ledger.mjs`.
- **Changes:**
  1. Keep strict v4 grading and frozen Call-1 validation untouched.
  2. Add a sibling ergonomics scorer that inspects actual post-truncation host-visible tool output tied to the fixture file and revision:
     - Tracks **first turn with sufficient evidence** (accumulated across calls, checking task-required statements and witnessed relationship sites—not full-file dumps), **remaining calls after sufficient evidence**, and **answer-schema-only failures** (e.g., `"true"` vs `true`) separately from strict pass.
     - Credits verified evidence at the same ordinal whether delivered by `read_file` or `search_codebase`.
  3. Add **unscripted Call-1** variants and a **Hybrid (Native + Satori)** toolbelt arm alongside Satori-only / Native-only; gate jointly on `(strict_correctness, total_input_tokens, wall_time, calls_to_sufficient_evidence)` to prevent Goodharting.
  4. Replay the existing v4 transcripts and run the current working-tree control (post-ergonomics edits) to measure: (a) how many calls occurred *after* sufficient evidence was already delivered (testing the **"stop reading"** hypothesis), and (b) cold-start phases (launch-to-tools vs. first-search vs. first-Publication).
- **Falsifying kill tests & ship gate:**
  - Wrong-root copy, signature-only match, truncated body, and plausible relationship name without its witnessed site must all fail the new scorer.
  - A verified body must score at the same ordinal whether delivered by `search_codebase` or `read_file`.
  - Add cold-start, dirty-edit, and post-edit test-selection fixtures only as their respective slices enter implementation (keep all hidden oracles excluded from indexed source via `.satoriignore`).

### Step 3 — `A4` (Corrected): Live Unprojected Graph Port for `detect_changes` + Honest `directSeedTestReferences`
- **Owners:**
  - `packages/mcp/src/tools/detect_changes.ts`
  - `packages/mcp/src/core/navigation-handlers.ts`
  - `packages/mcp/src/core/change-impact.ts`
  - `packages/mcp/src/core/relationship-backed-call-graph.ts` (`buildTestReferences:425`)
  - `packages/mcp/src/tools/detect_changes.test.ts` & `packages/mcp/src/core/change-impact.test.ts`
- **Changes:**
  1. **Fix the live stripping bug:** Give `detect_changes.ts` an internal typed/unprojected port on `NavigationHandlers` (bypassing `projectCallGraphEvidence` and redundant `JSON.stringify`/`JSON.parse`, while preserving full workspace authorization, Publication lease, and `publishedSource` semantics) so `detectChangeImpact` actually receives both **`exactReferences`** (restoring live `uncertainCallReferences`!) and **`testReferences`** in one pass.
  2. **Preserve site provenance in `buildTestReferences`:** Stop disguising missing `record.span` as a recorded `"call"` site at `source.span.startLine`—either record explicit `siteProvenance: "recorded_call_site" | "symbol_start_fallback"` or omit unproven `site` coordinates on the new `detect_changes` surface.
  3. **Surface bounded `directSeedTestReferences` inside `DETECT_CHANGES_RESPONSE_MAX_UTF8_BYTES` (48 KiB):**
     - Deduplicate and cap direct seed test references strictly *after* preserving seeds and existing direct/transitive CALLS impact (including omission/truncation metadata in the byte check).
     - When the remaining budget cannot fit the test-reference metadata, omit the section. An absent `testReferenceCoverage` leaves test coverage unknown.
     - Explicitly disclose coverage limits: supported on **JS, TS, Python, Go**; direct seed edges only (tests calling transitive callers are not included in v1); entries are candidate test/fixture references (not guaranteed runnable tests), and edited/deleted test files can invalidate published locations.
     - No filename/import guesses or test-runner synthesis in v1.
- **Falsifying kill tests & ship gate:**
  - End-to-end test through the real `detect_changes` tool adapter (not mocked `ports.callers`) proving both `uncertainCallReferences` and `directSeedTestReferences` survive live execution.
  - Provenance test verifying a missing-span `TESTS` record is never presented as a verified call site.
  - Budget-saturation differential test comparing visible seeds and CALLS against control at 48 KiB (zero loss of seeds or CALLS).
  - Eval gate: removes `>= 1` test-discovery call on a real post-edit test-selection task with zero false verified test claims. Defer pre-edit `open_symbol` test refs until this proves demand.

### Step 4 — `A5` (Promoted Experiment): One-Call Source Hydration on Clean Unique Exact Hits
- **Owners:** `packages/mcp/src/core/search-exact-fast-path.ts`, `packages/mcp/src/core/search-exact-registry-hit.ts`.
- **Changes:**
  - Run as an independent experiment **with unchanged JSON** (decoupled from `A1`).
  - Under an opt-in flag (`hydrateExact` / treatment toggle), when `runExactRegistryFastPath` resolves a clean, unique, authorized exact match under the same admitted Publication, inline its bounded source projection directly in the search response while preserving ranking, canonical `symbolId`, and continuation semantics.
  - Ambiguous, stale, or unauthorized cases fall back cleanly to the existing handoff without losing handles.
  - Measure on **both** an eligible non-oversized exact task **and** the oversized `known-exact-target` control (434-line `runExactRegistryFastPath`), reporting eligibility frequency; only trial bounded continuation-backed excerpts on oversized exact hits if the non-oversized pilot passes.
- **Ship gate:** `>= 1` fewer call to sufficient evidence and `>= 10%` lower median time to verified evidence on eligible tasks, with zero lost handles, incorrect spans, extra dirty-source claims, or ranking/continuation regressions.

### Step 5 — `A1` (Revised): Composer-Aware Line-Numbered Text Rendering on `read_file`
- **Owners:**
  - `packages/mcp/src/tools/read_file.ts` (`readFileInputSchema`, `readFileTool.execute`, `:945–984`)
  - `packages/mcp/src/core/symbol-context-public-contract.ts`
  - `packages/mcp/src/core/symbol-context-composer.ts` (`:626`, `:913–985`)
  - `packages/mcp/src/core/search-response-helpers.ts` (treatment-arm `recommendedNextAction`)
- **Changes:**
  1. Add optional `format: z.enum(["json", "text"]).optional()` on `read_file`. Omitted `format` and `"json"` preserve exact existing v2 JSON output.
  2. **Single-block transport:** `format: "text"` emits one self-contained `content: [{ type: "text", text }]` block and **omits `structuredContent`**.
  3. **Composer-aware text budgeting:** Pass a text-byte budgeter into `symbol-context-composer.ts` so excerpt selection converges on actual rendered UTF-8 bytes—reserving authority, warnings, gap markers, and executable continuation arguments first so every omitted source interval remains recoverable (zero post-composition line-trimming drift).
  4. **Fix ordinary `>40`-line range reads (`read_file.ts:945–984`):** When `format: "text"` is requested (and prepare to deprecate the auto-compact JSON + `structuredContent` wrapper on default ranges once verified), return clean line-numbered raw text without `structuredContent` duplication.
  5. **Solve the adoption catch-22:** In the controlled treatment arm, have `recommendedNextAction` explicitly request `format: "text"` on eligible exact reads (behind a 1-line rollback toggle). Keep `search_codebase` output unchanged during this experiment.
- **Falsifying kill tests & ship gate:**
  - Unit tests: CRLF, multi-byte Unicode, noncontiguous excerpts, single over-budget multibyte line (bounded failure or forward progress), stale/unavailable source, continuation replay preserving `codebaseRoot` + `format: "text"`, and exact omitted/`"json"` legacy parity.
  - **5-host compatibility replay** (Claude Code, Codex, OpenCode, Pi 1.6.0, Cursor): replay a fixed result and verify model-visible receipt of source, identity, warnings, and the last continuation.
  - **Efficacy gate (paired Flash + frontier trial, `>= 5` repetitions):** Compare useful lines/sites delivered at equal byte budgets; ship as recommended default only if it improves model-visible tool tokens or time to verified evidence with zero dropped evidence and `>=` control strict correctness and schema validity. Expand to `search_codebase` compact text in a follow-on wave only if `A0` traces confirm search envelopes remain a primary token bottleneck.

### Step 6 — `A2` (Split & Reordered): Direct `file + symbolLabel` Graph Navigation & Safe `file_outline` Absolute Paths
- **Part A2a — Direct `file + symbolLabel` on `call_graph` & `find_references` (Higher Leverage):**
  - Extend `callGraphSymbolRefSchema` (`packages/mcp/src/tools/call_graph.ts`, shared with `find_references.ts`) to accept `{ file, symbolId }` **or** `{ file, symbolLabel }` (reusing `findExactRegistrySymbols` against the same prepared Publication).
  - Succeed only on exact unique match; return capped deterministic candidates (`AMBIGUOUS_SYMBOL`) and stop on `>= 2` matches. Keep `trace_path` on canonical IDs and defer line selectors until demand and dirty-line semantics are proven.
  - Evaluate on **known-location tasks** (stack trace / edited file + symbol name without starting from `search_codebase`).
- **Part A2b — Safe Boundary Absolute Paths on `file_outline` (When Trace Demonstrates Retry):**
  - Keep `repoRelativeFilePathSchema` and `requireRepoRelativeFilePath` strict (`utils.path-policy.test.ts:29` unchanged).
  - Resolve `file` against the **matched indexed root** (never against a requested subdirectory, which could silently select a same-basename sibling file).
  - Canonicalize **only `path.dirname(resolvedFile)`** (preserving symlinked workspace roots like `/tmp` → `/private/tmp`), reject `..`/`.`/empty basenames, and preserve the **untouched final basename** so `openAuthorizedPublishedFile` still enforces `FINAL_SYMLINK_REJECTED`.
  - Exercise nested roots, scoped subdirectories, traversal, drive-relative paths, symlinked roots, final symlinks, ignored/unpublished files, and dirty spans.

### Step 7 — `A6` (Revised) & `A8` Replacement Guardrail
- **`A8` replacement (Hygiene — land anytime in Wave 1/2):** Add a full `tools/list` serialized payload byte-budget guardrail (`description + inputSchema`, baseline `22,041 B`) in `packages/mcp/src/tools/registry.test.ts`, and trim oversized nested schema descriptions only where safe.
- **`A6` (Measured cold-start & availability):**
  1. **KILL** provisional unindexed lexical scans.
  2. Instrument and separate **launch-to-`tools/list`**, **first-search latency**, and **time-to-first-Publication** in `A0`.
  3. **Check compatible-`reindex` availability:** Audit `search-frontdoor.ts:253` and `read_file.ts:539` to allow serving an admitted, schema-compatible previous Publication during background `reindex` when `searchableGenerationAvailable && searchableRead` holds (never serving incompatible/dropped collections).
  4. Improve `not_ready` recovery messages with progress and explicit anti-busy-poll guidance. Reopen cancellable `<= 3 s` waiting only if profiling proves a meaningful cohort finishes within `3 s` with zero Publication leases held while waiting and clean `requestSignal` abort.
  5. Proposed test follow-up. Race the publication-admission test barrier against search completion so an early rejection reports its actual status immediately.

---

## Deferred & Rejected Backlog (Explicit Reopen Conditions)

- **`A3` (Flattening & Multi-Symbol Batch Read) — DEFER independently:** Reopen a flat alias (or defaulting `open_symbol.contractVersion` to `2`) only if `A0` traces show repeated invalid hand-authored calls. Reopen batch reads only if traces show sequential same-Publication reads of *already-known* targets that the host harness does not already parallelize, saving `>= 1` call and `>= 10%` median time without starving any target or mixing generations.
- **`A7` (Live Mid-Edit AST Overlay) — DEFER:** Reopen only if a dirty-edit `A0` fixture (moving or deleting a symbol while requiring a relationship decision) fails despite existing `256 KiB` `currentSpan` mapping + authorized source reads; must prove zero live coordinates paired with stale graph authority across renames, deletions, parse errors, and concurrent edits.
- **`A8` (Tool Consolidation `11 → 5–6` + Passive Repo Map) — CUT:** Reopen only if an isolated A/B demonstrates `>= 10%` lower **total input tokens**, `>=` Flash first-try validity and strict correctness, and an approved migration plan for existing tool names.

---

## Compatibility & Rollback Contract

- Preserve all 11 tool names, omitted-`format` JSON behavior, v2 exact request/response schemas, canonical symbol IDs, and continuation semantics across Waves 1–2.
- Every increment is independently reversible without rewriting Publications or rebuilding indexes.
- Before flipping any public default from JSON to text globally, require: full `@satori-code/mcp` test suite, CLI `install-preflight` / `install-postflight` tests, frozen v4 evals, the `A0` evidence-aware ergonomics suite (including Hybrid Native+Satori), and the pinned 5-host transcript matrix.
