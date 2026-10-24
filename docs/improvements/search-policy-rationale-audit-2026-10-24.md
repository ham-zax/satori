# Search-policy rationale review, 24 October 2026

Status: Pi/DeepSeek completed its source audit. Parent validation in §7 corrects factual errors and qualifies the accepted findings.

Current correction (24 October 2026): the Swift signature and grouped-owner repairs described in
the checkpoint are committed as `cc9651b8`. One live f9 check after that commit returns the exact
owner at visible rank 4. §8 records the earlier pre-repair miss at adjusted rank 19. Keep §8 as
historical failure evidence; do not replace it with the later rank.

The preliminary parent review and the independent audit are separate evidence. §7 is the parent
validation against checked source and saved artifacts. The independent pass that starts at
"Independent audit" was source-read only: its own access limitation says it had no live Satori
tools and ran no search. `INFERRED` is a reconstructed purpose, not a documented requirement.
`/tmp` evidence paths are local transient artifacts, not versioned.

The earlier sections retain the original reasoning for provenance. Use §7 when an audit claim conflicts with checked source or artifacts.

## Initial attempt history

Both Pi runs use `opencode2api/deepseek-v4.1-flash-free` with `thinking=max`.
Both end with `Upstream response aborted before completion`. Neither produces a report.
The user-authorized third attempt returns HTTP 429 with `FreeUsageLimitError`: `Free usage limit reached`.
The requested Pi/DeepSeek audit cannot continue while the provider quota is exhausted. No independent audit section is produced.
The later continuation succeeds. The first section records the parent's preliminary checks, followed by the independent audit and parent validation.

## Scope and method

The checked production revision is `11889927`. The recovery helper and its focused tests are clean at that revision.
At the review date, other earlier changes remained uncommitted. This review changes no production policy.

The parent uses live Satori search to locate policy owners, then Satori source reads and narrow local reads to check current behavior.
Satori reports pending source changes and some degraded projection. Indexed results alone do not prove current-worktree behavior.
The review covers selected search-admission, recovery, rerank, and disclosure policies. It is not a repository-wide inventory.
No new model benchmark, index rebuild, or policy ablation runs for this review.

`DOCUMENTED` means the inspected code or session evidence explains the purpose.
`INFERRED` means the implementation supports a plausible purpose, with stated uncertainty.
`REVIEW REQUIRED` means the rationale or exact value needs a recorded decision or falsifying measurement.
A test that preserves a number establishes its contract. It does not establish that the number is optimal.

## Policies with a documented purpose

### Output-independent retrieval and reranking

- Owners: `search-policy.ts:28` and `search-rerank-policy.ts:108` under `packages/mcp/src/core/`.
- Status: `DOCUMENTED` purpose. Comments explicitly separate output counts from candidate discovery and rerank admission.
- Values: retrieval 80 and reranking 128, subject to a smaller provider document limit.
- Evidence: policy comments, focused policy tests, and the earlier output-limit investigation recorded in the accuracy checkpoint.
- Limit: this explains the chosen contract and recorded repair. It does not prove universal optimality for every repository.

### Rerank owner representatives and supplemental chunks

- Owner: `packages/mcp/src/core/search-rerank-policy.ts:70`, `buildRerankCandidatePool`.
- Status: `DOCUMENTED` purpose. The comment explains owner fairness and coverage beyond a long owner's first chunk.
- Value: two supplemental chunks per family, defined in `search-constants.ts:36`.
- Limit: a clear purpose exists. This review does not establish an empirical optimum for the exact sibling count.

## Review queue

### 1. Recovery file window: three files per lane

- Owner and use: `search-file-symbol-supplement.ts:5`, applied by the retrieval and declaration lanes at lines 36 and 46.
- Status: purpose `INFERRED`, exact value `REVIEW REQUIRED`. The lanes limit source reads and preserve two discovery paths.
- Effect: a retrieved file outside both windows cannot contribute recovered symbols, regardless of its symbol count.
- Evidence: the f9 replay records the intended file outside the earlier windows. The focused helper tests preserve both lanes.
- Review question: why three per lane, and which measured recall/cost tradeoff supports that number?
- Confidence: high on behavior, medium on inferred purpose. Do not confuse this window with the removed symbol quotas.

### 2. Recovery symbol span: 400 lines

- Owner and use: `search-file-symbol-supplement.ts:6`, enforced against callable spans at line 66.
- Status: purpose `INFERRED`, exact value `REVIEW REQUIRED`. A span bound limits individual recovered evidence.
- Effect: a valid, hash-matched function longer than 400 lines is excluded entirely from this recovery path.
- Related bounds: the source reader already limits bytes, and the reranker separately limits projected input.
- Review question: does this exclusion improve measured quality or cost beyond those existing byte bounds?
- Confidence: high on exclusion behavior, low on the justification for exactly 400.

### 3. Local suffix normalization

- Owner and use: `search-file-symbol-supplement.ts:8`, used for query, path, name, and source matching.
- Status: purpose `INFERRED`, transformations `REVIEW REQUIRED`. Approximate inflection matching is plausible.
- Effect: the expression removes a trailing `ing`, `ed`, or `s`. For example, `string` becomes `str`.
- Evidence: the f9 diagnostic observes `str` as the intended method's only matching source term.
- Review question: which identifier forms must this normalization equate, and which collisions must it avoid?
- Confidence: high on the transformation, low on its intended language contract. No alternative tokenizer is selected here.

### 4. Two-term thresholds and one-term contextual admission

- Owner and use: `search-file-symbol-supplement.ts:14`, query minimum at line 33, and eligibility at lines 70–74.
- Status: purpose `INFERRED`, exact thresholds and combined quality effect `REVIEW REQUIRED`.
- Effect: two path matches enable a contextual exception for one independent source match. Path/name-only evidence still rejects.
- Evidence: the helper tests exercise positive and negative cases. The saved f9 replay admits the exact intended owner.
- Limit: live final search quality for this committed mechanism remains unmeasured.
- Review question: does this exception improve final owner accuracy without admitting competing weak matches?
- Confidence: high on guards and local admission, limited on final search quality.

### 5. Preferred candidates reserve half the provider window

- Owner and use: `search-rerank-policy.ts:108`, `selectRerankCandidates`, through `Math.floor(budget / 2)`.
- Status: balance between recovered and ordinary candidates `INFERRED`; exact fraction `REVIEW REQUIRED`.
- Effect: preferred source evidence can reserve half the available slots before the ordinary pool fills the remainder.
- Evidence: `search-rerank-policy.test.ts:15` asserts a 16/16 split for a 32-document budget.
- Review question: which measured failure supports a half-window reservation instead of another allocation?
- Confidence: high on the split, medium on its purpose. The assertion proves the split, not its quality.

### 6. Final grouping file caps and exceptions

- Owner and use: `search-constants.ts:30` and `search-grouping.ts:34`, `applyGroupDiversity`.
- Status: diversity purpose `INFERRED`; values and exception interactions `REVIEW REQUIRED`.
- Values: base file cap two, relaxed cap three, and one-per-symbol handling. A complementary executable-owner slot also applies.
- Effect: final disclosure can omit a ranked group or admit an additional owner under an exception.
- Evidence: `search-group-ordering.test.ts` exercises this policy. The owner-ranking handoff records earlier file-cap losses.
- Review question: do the combined passes preserve the intended owners while controlling file dominance?
- Confidence: high on code behavior. Historical failures do not prove a current regression on every query.

### 7. Current-source inspection ceiling: 256 KiB

- Owner and use: `current-source-symbols.ts:17`, passed to `prepareInspectableSource` by `readCurrentSourceEvidence`.
- Status: resource purpose `INFERRED`; exact ceiling `REVIEW REQUIRED` if its numeric justification is required.
- Effect: `inspectable-source.ts:180` rejects a file above the caller's byte ceiling before the complete read.
- Evidence: `inspectable-source.test.ts:104` checks explicit ceiling rejection. Another test supports reads above the legacy ceiling with a larger limit.
- Review question: which source sizes and memory measurements support this caller's 256 KiB choice?
- Confidence: high on allocation protection. This is not a whole-indexer RAM guarantee or a symbol quota.

### 8. Aggregate reranker input ceiling: 1 MiB

- Owner and use: `search-constants.ts:39` and `search-rerank-policy.ts:158`, `selectRerankInputWithinUtf8Budget`.
- Status: units and bounded-input contract `DOCUMENTED`; resource purpose `INFERRED`; exact threshold `REVIEW REQUIRED`.
- Effect: input selection keeps a deterministic whole-document prefix within the configured UTF-8 budget.
- Evidence: rerank-policy tests cover the prefix, oversized first documents, and mismatched candidate/document arrays.
- Review question: which provider constraints or measured memory/latency results justify exactly 1 MiB?
- Confidence: high on behavior. Review the value without bypassing an upstream provider limit.

## Priority and limits

Review quality exclusions first: the file window, span guard, token normalization, contextual threshold, preferred reservation, and grouping interactions.
Their ordering can lose an owner before later ranking has a chance to assess it.
Keep resource ceilings distinct from those heuristics. A defensible reason for a bound does not justify every chosen value.

The removed six-per-file and derived36 symbol-count quotas are historical context, not active review findings.
The no-quota helper returns all 118 eligible symbols in the saved f9 input, including the exact intended owner.
That observation proves local admission only. It does not prove final search accuracy or arbitrary-repository safety.

At that point the requested independent DeepSeek review remained unavailable. These source findings were preliminary and awaited review.

---

# Independent audit — delegated second pass (Pi + DeepSeek, 2026-10-24)

This section is a separate, independent audit appended by a delegated research sub-agent. The preliminary parent review above is preserved unchanged; where this pass disagrees or qualifies it, the correction is stated explicitly in §2 instead of editing the earlier text.

* Tree: `/home/hamza/repo/satori`, HEAD `11889927` (`fix(search): recover source-backed symbols without file quotas`), which commits the source-recovery helper and tests with **all** recovery symbol-count quotas removed.
* Scope inspected: `packages/mcp/src/core/` search policy owners (`search-constants.ts`, `search-policy.ts`, `search-rerank-policy.ts`, `search-file-symbol-supplement.ts`, `search-lexical-scoring.ts`, `search-definition-discovery.ts`, `search-ranking-policy.ts`, `search-grouping.ts`, `search-flags.ts`, targeted ranges of `current-source-symbols.ts`), their nearest callers in `search-execution.ts`, `search-group-results.ts`, `search-query-support.ts`, `search-query-planning.ts`, `search-result-finalization.ts`, `search-coordinator.ts`, `inspectable-source.ts`, the owning tests, four checkpoint documents, commits touching the literals, and the parent's saved `/tmp/orch/f9-*` artifacts.
* Method: read-only. No source edit, no test, build, index, model call, or process change. No claim below was produced by running Satori.
* **Access limitation, stated because it changes the evidence tier:** this sub-agent session exposes no Satori MCP tools (`search_codebase` / `read_file` are not in its tool catalog; only codebase-memory MCP is). Running the Satori CLI was not attempted because it can touch index/publication state, which the task forbids. Every finding is therefore source-read plus saved-artifact verification, with live-search confirmation still open for the parent.

## 0. Evidence standard used here

Four categories, kept distinct because the remedy differs:

* **implementation invariant** — a coupled value (e.g. derived constants, or a bound that is also a chunk size). Changing it alone breaks something.
* **resource safety ceiling** — protects memory, bytes, or provider limits.
* **output contract** — a value a consumer or test relies on for shape, not for quality.
* **quality heuristic** — changes which symbols reach the answer.

Three statuses: `DOCUMENTED` (code comment, doc, commit message, or measurement states the purpose), `INFERRED` (purpose reconstructable from structure with stated limits), `REVIEW REQUIRED` (neither purpose nor exact value is recorded, or the recorded purpose does not settle the value).

Two claims are kept separate throughout: *why the policy class exists* and *why this exact number*. A test that asserts `16` proves the slot arithmetic is contractual, not that half the budget is right. The repository's own precedent for a justified bound is commit `8459fa0e` (`perf(mcp): raise the dirty overlay limits to 32 files`), whose body records `about 3.2 ms per file … keep the overlay near 100 ms`; none of the search policies reviewed here carries an equivalent measurement.

## 1. f9 causality, reconstructed from the saved artifacts

The f9 question (`in the Swift library where does the builder add a string`, publication `534ff052…`, 140 input candidates) is the only failure with instrumented evidence, so it anchors prioritization. Three helper versions exist as artifacts, and they separate two independent gates:

| helper version | files read | identities returned | intended `create` recovered |
| --- | --- | --- | --- |
| production before path context | 5 (`swift_code_4.swift`, `flexbuffers.h`, `BUILD.bazel`, …) | 19 | no — owner file never read |
| + path-context lane, quotas still active | 6 (adds `swift/Sources/FlatBuffers/FlatBufferBuilder.swift`) | 22 | no — dropped inside the file (rank 12 of 13 eligible, `matches` 1 vs 2) |
| committed (path context, no count quotas) | 6 | 118 | yes, at post-recovery rank 18 |

Sources: `/tmp/orch/f9-fusion-replay/recovery/evidence.json` (readCount 5, targetReturned false, `targetRetrievalFileRank` 8, declaration rank 12), `/tmp/orch/f9-context-candidate/replay.json` + `replay-ranking.json` (readCount 6, returnedCount 22, eligibleCount 13, selected 6, target rank 12), `/tmp/orch/f9-no-quota-candidate/replay.json` (`sourceSha256` equals the committed helper hash, readCount 6, returnedCount 118, `targetRecovered` true, `targetReturnRank` 18).

Two consequences that change how the review priorities should be read:

1. **The file-window loss in f9 was already repaired before this commit.** The committed declaration lane admits `FlatBufferBuilder.swift` because `pathContextScore` returns a nonzero value when at least two distinct whole-query terms occur in the path (`search-file-symbol-supplement.ts:17` `matches >= 2 ? matches : 0`, consumed at `:44-46` and `:61`). The f9 path offers exactly two (`swift`, `builder`). So `MAX_FILES = 3` no longer excludes this owner, and the remaining exclusion risk is conditional: a file reachable in neither lane, whose path does not share two whole query terms.
2. **The residual f9 gate was the count quota, and its removal is demonstrated at admission level only.** The saved counterfactual shows the identity returning at rank 18 of 118. `search-accuracy-checkpoint-2026-10-23.md:337-352` set its own retention condition: "Retain it only if the intended f9 method reaches the visible ten". Rank 18 after the recovery stage is not the visible ten, and it is measured against a 140-candidate pool that the retrieval cap then reduces to 80 (`search-constants.ts:18`). The saved evidence therefore does **not** satisfy the checkpoint's own condition, and the counterfactual never ran a live search: `/tmp/orch/f9-no-quota-measurement/blocker-check.md` records `search_codebase` was never called ("No search ran during this check"). The only measured cost of the removal is helper-local: median `27.12 ms → 28.50 ms` (+1.37 ms), peak RSS flat at 162.7 MiB (`/tmp/orch/f9-no-quota-candidate/helper-comparison.json`).

Discrepancy to preserve rather than smooth over: the session context records the no-quota replay as "118 vs 25", but the saved context-candidate artifact returns **22**, not 25. The comparison denominator is unconfirmed; the 118 and the rank-18 position are confirmed by artifact.

## 2. Corrections and qualifications to the preliminary review

### 2.1 Item 1, file window `MAX_FILES = 3` (+3, so ≤6 reads)

Owner: `packages/mcp/src/core/search-file-symbol-supplement.ts:5`, used at `:37` (retrieval lane) and `:46` (declaration lane); the read loop starts at `:49`.

* Observable effect: at most six files per request are read from disk and searched for symbols; the retrieval lane preserves candidate order (`:35-37`, comment), the declaration lane is re-ordered by path context then name-match count then original rank (`:42-45`).
* Class: resource safety ceiling (bounded source reads) plus a deterministic-order contract for the retrieval lane.
* Evidence of reason: the ceiling class is inferable from the loop it guards and from `:22-24` ("Recover bounded symbol evidence inside files already found by retrieval. The source hash must match the Publication; this never retargets a broad chunk or infers ownership from a function name"). `git log -S` shows the value introduced by `31d3be0a` (`fix(search): widen LateOn rerank pool and recover symbols, scope, and prefix matches`) with no body and no number rationale.
* **Qualification of the parent finding:** the session evidence cited for it (`FlatBufferBuilder.swift` unreachable) is *historical*. The committed source reads that file because of the path-context exception, so f9 is no longer a demonstration of this window excluding an owner; it is a demonstration of the count quota (now removed) excluding one. The window's current demonstrated cost is the narrower case of a file whose path shares fewer than two whole query terms.
* Status: ceiling **INFERRED**; the exact `3` **REVIEW REQUIRED**. Confidence: high that the cap is intentional and bounded; high that `3` is arbitrary (no artifact, doc, or measurement ties it to a cost target).
* Consequence if altered: 3→6 doubles worst-case source reads per request (the same class as the measured dirty-overlay precedent) and expands recovery output further, which then competes inside the fixed 128-slot rerank window (§2.5). 3→1 removes the declaration lane's purpose. Tests `search-file-symbol-supplement.test.ts:122-135, 156-178` assert `reads.length <= 6`, so the doubled read cost would break an existing contract.
* Smallest falsifying check: replay one recovery request with `MAX_FILES` 3 vs 6 over the saved 140-candidate pools and compare (a) files read, (b) whether any *additional* identity reaches the visible top-10, (c) wall time. If no additional identity reaches the visible answer, `3` stays adequate; the check does not justify `3` as a maximum, only as sufficient.

### 2.2 Item 2, symbol span guard `MAX_SYMBOL_LINES = 400`

Owner: `search-file-symbol-supplement.ts:6`, applied at `:66` (`… + 1 > MAX_SYMBOL_LINES) return []`).

* Observable effect: a `function`/`method` whose span exceeds 400 lines is dropped from recovery **entirely**, not truncated. Verified from the guard shape, not inferred from a comment. The helper emits no per-symbol omission reason, so the exclusion is silent at this layer; whether the caller surfaces it was not traced.
* Class: resource safety ceiling (bounded per-symbol source payload) + an all-or-nothing admission rule.
* Evidence of reason: none recorded. `31d3be0a` added it without a body.
* Status: **REVIEW REQUIRED** for both class choice and value. The class is defensible (a long function would dominate the reranker document budget, cf. `SEARCH_RERANK_DOC_MAX_LINES = 200` at `search-constants.ts:37`, so a >400-line symbol can never fit a bounded excerpt anyway) but that reasoning is mine, not the repository's, and it also argues for truncation-with-marker rather than exclusion.
* Confidence: medium. Consequence if altered: lowering to ~200 aligns with the reranker document bound and would drop exactly the symbols that already cannot be excerpted; raising removes the exclusion but feeds documents that are then truncated at 200 lines/4000 chars (`search-constants.ts:37-38`), which can decouple the matched evidence from the excerpt shown.
* Smallest falsifying check: over a repository with long generated methods, count recovered symbols between 200 and 800 lines and check whether any reaches the visible top-10; also record the excerpt actually shown for one such symbol (matched line inside or outside the truncated excerpt). If a >400-line symbol is admitted elsewhere yet excluded here, the guard is inconsistent with the rerank bound.

### 2.3 Item 3, suffix normalization `ing|ed|s`

Owner: `search-file-symbol-supplement.ts:11` inside `normalizedTerms` (`:8-12`), which splits camelCase, lowercases, splits on `[^a-z0-9]+`, then removes **one** trailing suffix.

* Observable effect: applied symmetrically — the query side at `:32-33` (`normalizedTerms(term.value)` over whole-kind lexical terms) and the source side at `:56` (paths), `:62-76` (name/body tokens). So `string` in the question matches `str` in the body; in f9 exactly that overlap is what makes the intended method eligible (`target.matched` = `["str"]`).
* Class: quality heuristic (term identity), not a bound.
* Evidence of reason: none in code or commit. The costs are documented elsewhere: `s1-normalization-experiment-2026-10-23.md:120-127` records that the same suffix thinking produces collisions (`buses→buse`, `statuses→statuse`, `user`/`use`) and concludes "These controls show why a suffix list is not a proven general search policy". This pass adds an ownership observation: suffix stripping exists **only** here. Query planning lowercases and strips punctuation without stemming (`search-query-planning.ts:268-285`), the ranked-term filter adds `length >= 3` plus `SEARCH_QUERY_STOPWORDS` (`search-query-planning.ts:364-374`), and BM25 has no stemmer (`search-symbol-metadata-bm25.ts:17-18`, `BM25_K1 = 1.2`). So recovery evidence and retrieval score use different term identities: an overlap that counts for recovery may not count for ranking.
* Status: **REVIEW REQUIRED**. Confidence: high that it is undocumented; medium that the asymmetry is unintended (it may be deliberate — recovery is a recall stage and ranking a precision stage).
* Consequence if altered: removing the rule drops `string`/`str`-style owner recovery in exactly the f9 shape and would re-open the failure this commit fixed. Widening it (multi-suffix, `es`, `ly`) increases false matches, and the S1 experiment shows the collision class is real.
* Smallest falsifying check: on the saved 28-question set, compare recovery hits with and without the suffix rule, and label each added/removed hit as true or false owner. If every added hit is a true owner, the rule earns a documented purpose; any false owner among them is the counter-example to record.

### 2.4 Item 4, two-term threshold and path-context exception

Owner: `search-file-symbol-supplement.ts:73-74` (`if (!matched.some(t => !pathTerms.has(t)) || (matched.length < 2 && !(hasPathContext && sourceOnlyMatch))) return []`) with `:71-72` and `:17`.

* Observable effect: a symbol is recovered only if it has a source-backed term that is absent from the path *and* either two such terms, or one such term while the file path shares two distinct whole query terms and the matched term is source-only. In f9 the intended method has `matched` length 1, so its admission depends on the path-context branch.
* Class: quality heuristic (conjunction of admission predicates), no numeric knob — the number here is the `2` inside two predicates.
* Evidence of reason: `search-accuracy-checkpoint-2026-10-23.md:355-360` states the intent ("Two distinct whole-query path terms can prioritize a file inside the existing three-file declaration lane") and tests preserve it (`search-file-symbol-supplement.test.ts:156-178` "path context admits an exact source-only owner below both old file windows", `:179-190` "context does not admit one-term name evidence or path-only source evidence"). Neither records why two terms rather than one or three.
* Status: predicate structure **INFERRED** (it is a deliberate anti-overreach guard, demonstrably tested); the `2` **REVIEW REQUIRED**. Confidence: high on structure, medium on value.
* Consequence if altered: `2→1` admits files on a single generic path term (`src`, `lib`) and would pull unrelated same-named directories into recovery — the `:179-190` test exists to prevent exactly this. `2→3` re-breaks f9. Note a second copy of matching semantics inside the same function: the declaration lane computes its own name-match count inline (`:44-45`) instead of reusing one helper, so any change to "what counts as a match" must be made in two places.
* Smallest falsifying check: over the saved candidate pools, lower the path threshold to 1 and measure how many *additional* files enter the six-file read set and whether any of their symbols reach the visible top-10 as a true owner. That is the empirical cost of the stricter rule.

### 2.5 Item 5, preferred half-window reservation

Owner: `packages/mcp/src/core/search-rerank-policy.ts:145-153` — `Math.floor(budget / 2)` slots are reserved for preferred candidates, then filled from the pool, and the final selection is filtered back into input candidate order.

* Observable effect: with `budget = 128`, the half-window reservation is 64 slots. The cited test uses budget 32 and reserves 16 slots (`selected = [...original.slice(0,16), ...refined.slice(0,16)]`). See the parent correction in §7. Project-specific code can compete with generic code within the provider window.
* Class: quality heuristic over a provider-bound window, plus an output-order contract (result order follows input order, not reservation order).
* Evidence of reason: purpose is documented in `docs/improvements/reranker-owner-investigation.md:40-60` ("This stops a file's generic helpers consuming its diversity allowance before its specific matching definition. It does not raise the result budget"). The fraction `1/2` itself has no recorded reason.
* Status: purpose **DOCUMENTED**, value **REVIEW REQUIRED**. Confidence: high.
* Possible consequence if altered: the reservation changes competition between preferred and refined candidates. Recovery emits 118 identities for the measured f9 helper case, which can compete for the same 128 slots. The reservation scales with the budget and is not a fixed 16 slots. No controlled measurement here establishes the combined effect on final ranking.
* Smallest falsifying check: replay a saved pool at its recorded budget and compare the current half-window reservation with a single alternative. Record whether any preferred owner enters or leaves the visible top ten. A dependent case can demonstrate sensitivity, but cannot establish an optimum.

### 2.6 Item 6, grouping caps and exceptions

Owner: `packages/mcp/src/core/search-grouping.ts:60-95` (`fileCap` 2, `relaxedFileCap` 3, `MAX_PER_SYMBOL = 1`, complementary executable-owner slot), `:119-155` (implementation-seeking repair at equal score), constants at `search-constants.ts:30-32`.

* Observable effect: a file contributes at most two results, a symbol at most one, and a third slot per file only when the page would otherwise under-fill; a same-score repair prevents a supporting path from outranking an implementation path.
* Class: quality heuristic plus a deterministic-order contract (tests `search-group-ordering.test.ts:175-186` assert authoritative sequence across relaxed passes; `:187-206` assert the complementary-owner slot; `:227-252` duplicate-owner rejection).
* Evidence of evidence: purpose documented in `reranker-owner-investigation.md:91` with a measured f9-family case ("trade reached grouped rank 8 but was omitted by the diversity cap: `startWorkflow` and `WorkflowStep` consumed the file's slots. Fixing that selection boundary produced the final visible rank 2 without adding slots") and in `retrieval-quality-investigation.md:135` (`file_diversity_cap` suppressed `areHookInputsEqual`). Exact `2` and relaxed `3` remain unrecorded.
* Status: purpose **DOCUMENTED**, values **REVIEW REQUIRED**. Confidence: high.
* Consequence if altered: `2→1` removes same-file pairs that carry a real call relationship; `2→3` narrows file coverage for the same page. Raising it also pushes recovered identities further down, same interaction as §2.5.
* Maintenance hazard found here, in scope because it is the same policy expressed twice: `search-grouping.ts:165-197` recomputes the cap decision (relaxed cap active, complementary-owner slot available) independently of `applyPass`'s own logic (`:62-95`). Two expressions of one rule can drift; the omitted-reason text is a user-visible explanation, so drift would mislabel *why* a result was dropped.
* Smallest falsifying check: construct a page where the relaxed cap and the complementary slot both apply and assert the reported `omitted` reason matches the branch that actually dropped the item. That is a differential check of the duplicate expressions, not a tuning measurement.

### 2.7 Item 7, current-source bound `CURRENT_SOURCE_MAX_BYTES = 256 KiB` — corrected classification

Owner: `packages/mcp/src/core/current-source-symbols.ts:17`, passed at `:81`, read again at `:506-509`.

This pass disagrees with the parent's framing in one respect: 256 KiB is **not only a resource ceiling**. It is simultaneously

1. a **language-analysis chunk size** — `:254` and `:292` pass it as `chunkSize` (`Math.max(CURRENT_SOURCE_MAX_BYTES, evidence.sourceBytes.byteLength)` at `:292`);
2. a **fail-closed evidence invariant** — `:506-509` rejects evidence larger than the constant, so raising the ceiling in one place without the other breaks the invariant;
3. **not a hard user-visible ceiling** — `inspectable-source.ts:148-152` accepts a caller-supplied `maxInspectableBytes` and rejects only above *that* (`:180-181`, `reason: "source_exceeds_inspection_limit"`), which `search-file-symbol-supplement` reaches through `readCurrentSourceEvidence` (`:53-58`). `inspectable-source.test.ts:23` is named "inspectable source reads above the legacy 256 KiB ceiling under an explicit limit".

* Status: coupling **DOCUMENTED** by code and test (implementation invariant); the number `256 KiB` **REVIEW REQUIRED** as a chunk-size choice. Confidence: high on classification.
* Consequence if altered: files between 256 KiB and the caller's limit already yield symbols only when an explicit limit is passed; changing the constant alone makes chunk size and evidence rejection disagree. Enlarging it increases per-file parser work and memory (the same class the parent measured elsewhere), shrinking it silently removes symbol coverage for large sources.
* Smallest falsifying check: for one file between 256 KiB and 1 MiB, list symbols with and without an explicit `maxInspectableBytes`. If the explicit-limit path already recovers the same symbols, the constant's clause (1) is the only remaining reason to keep the value.

### 2.8 Item 8, aggregate reranker input `1 MiB`

Owner: `search-constants.ts:40`, consumed in `search-rerank-policy.ts:158` (`selectRerankInputWithinUtf8Budget`, prefix semantics).

* Arithmetic that qualifies the value: per-document bounds are `SEARCH_RERANK_DOC_MAX_LINES = 200` and `SEARCH_RERANK_DOC_MAX_CHARS = 4000` (`search-constants.ts:37-38`), so 128 documents at the character bound are ≈ 512 K characters before framing; for ASCII content the 1 MiB aggregate is roughly twice the per-document ceilings and therefore almost never binds, while for dense multi-byte scripts the effective average document drops toward ~512 bytes. The real constraint on document size is the 4000-char/200-line pair, not this aggregate.
* Class: provider/payload safety ceiling (transport framing and model input limits).
* Status: `REVIEW REQUIRED` for the value; the class is **INFERRED** from the surrounding comment ("Aggregate UTF-8 bytes of selected reranker document strings; excludes query and transport framing") and from `search-rerank-policy.ts:130-137`, which documents that capacity is capped by three owners (global 128, provider maximum documents, complete family pool). Confidence: medium.
* Consequence if altered: raising it admits more/larger documents to the model; lowering it silently drops tail documents, and because selection is prefix-ordered the dropped tail is the lowest-ranked candidate, which is also where recovered supplemental identities sit. Note this bound is not the same as "one document never sliced" — `search-rerank-policy.test.ts:73-92` asserts a whole-document prefix, `:113-134` the complete-family-pool reason.
* Smallest falsifying check: log the actual aggregate bytes and document count for the 28-question set with debug mode on. If no request approaches 1 MiB for ASCII repositories, the value is unexercised and should be documented as a guard, not tuned.

## 3. Additional material policies found in the same scope

### 3.1 The must-retry policy is unreachable — `REVIEW REQUIRED` (policy integrity)

`search-policy.ts:65-66` now sets `maxCandidateLimit = candidateLimit = SEARCH_MAX_CANDIDATES`, with the comment at `:59-64` deliberately making the candidate budget output-independent. Consequences, all verified in source:

* `resolveNextSearchCandidateLimit` (`:84-89`) returns `Math.min(80, Math.max(current + 1, current * 2))`; with `current = 80` it returns `80`. The retry round loop advances only when the new limit exceeds the current one (`search-execution.ts:1131-1136`, `:1268`), so at the cap it stops with `rounds` still 1.
* `search-result-finalization.ts:341-347` reports `mustRetry: rounds < maxAttempts`. Attempts is 2 for must-operator queries (`search-policy.ts:79`, tested at `search-policy.test.ts:35`), but rounds never reach 2, so a `must_terms_not_satisfied` result still says `mustRetry: false`.
* `SEARCH_MUST_RETRY_MULTIPLIER` (`search-constants.ts:29`) is now used only by that unreachable function, and `search-policy.test.ts:37` (`[32, 64, 80].map(resolveNextSearchCandidateLimit)`) keeps the dead arithmetic under contract.

This is a second owner of one concept (candidate budget) still expressed in code, and a policy whose stated diagnostic cannot occur. It is not a tuning value, so no measurement applies; the smallest review question is whether the retry round should exist at all now that the cap is fixed, and if not, whether `mustRetry` may keep a field that is always `false`. Consequence if "fixed" carelessly: emitting `mustRetry: true` while the budget cannot grow would instruct an agent to repeat a request that cannot retrieve more.

### 3.2 `answerFocus` and the implementation-seeking gate — purpose `DOCUMENTED`, boundary cost unmeasured

`search-execution.ts:1131-1136` documents the design: once `answerFocus` or `scope: "implementation"` applies, lexical overlap no longer narrows results because every candidate already matched the query. Callers: `search-execution.ts:790`, and the coordinator at `search-coordinator.ts:1741` when implementation-seeking binds but no implementation candidate exists. Class: ranking policy with an explicit justification; no numeric value involved. Residual question: a how-does-X-work question that *does* name a class gets no symbol focus, so the ranking key is the metadata score alone. Status: `DOCUMENTED` for the gate, `INFERRED` that the boundary case is acceptable. Smallest check: the saved 28-question set split into "names a symbol" vs "does not", comparing visible rank of the intended owner in each half.

### 3.3 Project-specific path literals inside the classifier — `REVIEW REQUIRED`

`search-ranking-policy.ts:81-94` classifies paths as artifacts by literal segments — `"reports"` (`:82`), `"investigations"` (`:84`), `"scripts/archive"` (`:86`), `".codebase-memory"` (`:87`), `".satori"` (`:88`) — and as landing pages by `"satori-landing"` (`:92`) and `"landing-page"` (`:94`). Precedence is fixed at `:123-136`, and `shouldIncludeCategoryInScope` (`:140-152`) excludes `artifact`, `landing`, `docs`, `generated`, `fixture` from the default runtime scope.

These are quality heuristics keyed to *this* repository's layout, but the classifier also runs on every indexed repository, including the eval repos. A downstream repository with a top-level `reports/` or `investigations/` directory loses those files from default runtime search by path alone. `"landing-page"` is generic enough to hit unrelated projects; `"satori-landing"` is not. No comment or commit records why these names are the right set. Status: `REVIEW REQUIRED`. Consequence if altered: removing the literals surfaces archive noise in this repo; keeping them silently mis-scopes other repos. Smallest check: take one eval repo containing such a directory and confirm whether any question's intended owner lives there; if it does, the literal is a demonstrated cross-repo loss.

### 3.4 Two stopword owners and a length floor that hides short identifiers — `REVIEW REQUIRED`

`search-definition-discovery.ts:12` defines `QUERY_STOP_WORDS` ("the a an and or of to in for is are be does do where when how what which current against") and `:75` filters definition terms by `term.length >= 3 && !QUERY_STOP_WORDS.has(term)`. Separately, query planning defines `SEARCH_QUERY_STOPWORDS` and the ranked-term floor `term.value.length >= 3` (`search-query-planning.ts:364-374`). Two lists, two maintenance points, differing contents by construction.

Consequences worth recording: identifiers of one or two characters (`id`, `db`, `io`, `os`, `ui`, `fs`) never contribute a definition-discovery term, so a query naming them cannot receive a definition vote by name; and the two lists can disagree, in which case a term can be ranked by one stage and ignored by the other. Status: `REVIEW REQUIRED` for the duplication and for the 3-character floor (no comment, no measurement). Smallest check: query a repository for a two-character identifier and inspect whether definition discovery contributes any candidate; then compare the two stopword lists element by element and record which differences are intentional.

### 3.5 Writer-action verb table — `INFERRED` purpose, `REVIEW REQUIRED` coverage

`search-ranking-policy.ts:152` `isWriterActionTerm` lists build/generate/emit/write/create/construct/render/serialize/deserialize/encode…, consumed by `isWriterIntentQuery` (`:160-163`), which drives `SEARCH_MAX_DIAGNOSTIC_CANDIDATES`-style budget widening to 160 and the writer ranking mode (`search-query-support.ts:1130-1160`). The purpose (recognise "where does X write Y") is inferable from the call sites; the table's coverage is not argued anywhere, and any verb outside the list silently demotes an implementation question to a generic one. Status: `INFERRED`/`REVIEW REQUIRED`. Smallest check: classify the saved 28 questions by whether each is implicitly a writer question and note which intended owners fell outside the table.

### 3.6 Two fusion constants for one concept — `REVIEW REQUIRED`

`search-constants.ts:17` `SEARCH_RRF_K = 60` is used by MCP multi-pass fusion; `search-accuracy-checkpoint-2026-10-23.md:325-329` records that core fusion uses `k = 100` and states the split as fact without a rationale. `k = 60` matches the RRF paper's default, which justifies the *class* and not the divergence. Status: value `INFERRED` (standard default), divergence `REVIEW REQUIRED`. Consequence if changed: the two stages' score scales stop being comparable only if scores cross a boundary; the checkpoint records the rank-80 cutoff score `0.0070921985815602835`, so the fusion constant does move admission near that boundary. Smallest check: recompute one saved pool at `k = 60` and `k = 100` and record whether any intended owner crosses the 80-candidate admission line.

### 3.7 Noise-hint guidance compound — `INFERRED`, low risk

`search-constants.ts:46-47` (`TOP_K = 5`, `THRESHOLD = 0.60`) are consumed at `search-query-support.ts:1194` and `:1221` to decide whether to append "these results look like tests/fixtures" guidance. The compound effect is "≥3 of the top 5 files look noisy". This changes guidance text only, never ranking or membership, so its risk class is low; the exact 0.60 has no recorded reason and no measurement, and no test asserts the emitted guidance boundary was checked. Status: `INFERRED`/`REVIEW REQUIRED` (value), low consequence. Smallest check: count how many of the 28 saved queries cross the threshold; if none do, the policy is effectively dead for the eval set.

### 3.8 Proximity window in grouping identity — `INFERRED`, low risk

`search-constants.ts:26` `SEARCH_PROXIMITY_WINDOW = 25`, used once at `search-group-results.ts:705` (`Math.floor((startLine - 1) / WINDOW)`) to bucket nearby candidates when deciding whether two results are the same logical hit. Class: grouping-identity heuristic with a boundary artifact (two symbols 24 lines apart group; 26 apart do not). No comment, no test of the boundary. Status: `INFERRED`/`REVIEW REQUIRED`, low consequence; a differential check at the 25/26-line boundary is sufficient to prove the artifact exists.

### 3.9 Derived constants: inheritance, not separate review items

Recorded so the parent does not treat them as independent knobs: `SEARCH_DIVERSITY_RELAXED_FILE_CAP = MAX_PER_FILE + 1` (`search-constants.ts:32`, used at `search-grouping.ts:62-95`), `SUPPLEMENT_ALTERNATIVES_MAX = MAX_PER_SYMBOL * 2 + 4` (`search-grouping.ts:293`), grouped response budget `1.5 × limit + 3` (`search-grouping.ts:~196`), and `resolveSearchPolicy`'s `Math.min(normalizedResultLimit, SEARCH_DEFAULT_DISCLOSURE_LIMIT)` (`search-policy.ts:55-56`). Each inherits the risk of the constant it derives from; none needs its own rationale, and changing a base silently changes the derivative.

### 3.10 Literals deliberately excluded from review

Protocol and payload contracts, not tuning knobs: `SEARCH_RESULT_SET_HANDLE_PLACEHOLDER` (48 zeros) and `SEARCH_RESULT_SET_DIGEST_PLACEHOLDER` (64 zeros) at `search-constants.ts:44-45` (opaque handle shape consumed by continuation); `SEARCH_MAX_FROZEN_RESULTS`, `SEARCH_MAX_PAGE_SIZE`, `SEARCH_MAX_RESULT_INDEX_ENTRIES` all 200 (`:22-24`, one contract expressed three ways); `SEARCH_MAX_RESULT_INDEX_UTF8_BYTES` 32 KiB (`:25`); `SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES` 48 KiB with an explicit documented reason (`:42`, "Matches the file_outline and detect_changes budgets so one grouped page fits common MCP client limits") and its 2 MiB debug counterpart (`:43`); `WARNING_CODES` and path-category string unions (`:63-79`) which are serialized output vocabulary.

## 4. Classification summary

| Policy | Owner | Class | Status | Value risk |
| --- | --- | --- | --- | --- |
| `SEARCH_MAX_CANDIDATES = 80` design | `search-policy.ts:59-66` | quality policy | DOCUMENTED | none (design) |
| `SEARCH_RERANK_TOP_K = 128` | `search-constants.ts:35` | provider window | DOCUMENTED (doc+tests) | contract |
| `MAX_FILES = 3` | `search-file-symbol-supplement.ts:5` | resource ceiling | INFERRED / value REVIEW REQUIRED | read cost, tests assert ≤6 |
| `MAX_SYMBOL_LINES = 400` | `search-file-symbol-supplement.ts:6` | resource ceiling | REVIEW REQUIRED | silent full exclusion |
| suffix `ing\|ed\|s` | `search-file-symbol-supplement.ts:11` | quality heuristic | REVIEW REQUIRED | re-breaks f9 if removed |
| two-term + path-context gates | `search-file-symbol-supplement.ts:17,73-74` | quality heuristic | INFERRED / value REVIEW REQUIRED | over/under-admission |
| preferred `floor(budget/2)` = 64 at budget 128 | `search-rerank-policy.ts:145-153` | quality heuristic | purpose DOCUMENTED / value REVIEW REQUIRED | changes competition with refined candidates |
| supplemental chunks = 2 | `search-rerank-policy.ts:88-90`, `search-constants.ts:36` | quality heuristic | DOCUMENTED | none demonstrated |
| grouping 2 / relaxed 3 / per-symbol 1 | `search-grouping.ts:60-95` | quality heuristic | purpose DOCUMENTED / values REVIEW REQUIRED | page coverage |
| `omitted` reason duplicate | `search-grouping.ts:165-197` | output explanation | REVIEW REQUIRED (drift) | mislabels cause |
| `CURRENT_SOURCE_MAX_BYTES = 256 KiB` | `current-source-symbols.ts:17,254,292,506-509` | implementation invariant + ceiling | coupling DOCUMENTED / value REVIEW REQUIRED | chunk size vs rejection |
| `SEARCH_RERANK_INPUT_MAX_UTF8_BYTES = 1 MiB` | `search-constants.ts:40` | payload ceiling | class INFERRED / value REVIEW REQUIRED | tail documents |
| must-retry rounds + multiplier | `search-policy.ts:79,84-89` | dead policy | REVIEW REQUIRED | diagnostic cannot fire |
| `answerFocus` gate | `search-execution.ts:1131-1136` | ranking policy | DOCUMENTED | boundary case unmeasured |
| project path literals | `search-ranking-policy.ts:81-94` | quality heuristic | REVIEW REQUIRED | cross-repo mis-scoping |
| duplicate stopwords, `length >= 3` | `search-definition-discovery.ts:12,75` vs `search-query-planning.ts:364-374` | quality heuristic | REVIEW REQUIRED | short identifiers |
| writer verb table | `search-ranking-policy.ts:152` | intent classifier | INFERRED / REVIEW REQUIRED | intent missed |
| RRF `k = 60` vs core `100` | `search-constants.ts:17` | fusion constant | INFERRED / split REVIEW REQUIRED | admission near cutoff |
| noise hint 0.60 × top 5 | `search-query-support.ts:1194,1221` | guidance only | INFERRED / value REVIEW REQUIRED | low |
| proximity window 25 | `search-group-results.ts:705` | grouping identity | INFERRED / value REVIEW REQUIRED | low, boundary artifact |

## 5. Review priorities and the smallest falsifying check for each

Ordered by demonstrated loss first, then by cost of being wrong:

1. **Does the committed recovery change any visible answer?** The only build-blocking question, because the commit is in tree. Check: run the saved 28-question set live and compare visible top-10 ranks against the pre-commit baseline. Stopping condition: an intended owner enters or leaves the visible ten. This is the precondition for every other item — if recovery is invisible, the quotas' removal is unproven and the review should not spend effort tuning its remaining constants.
2. **`MAX_SYMBOL_LINES = 400`** — the only policy that deletes candidates entirely and silently, with no recorded reason and no diagnostic. Check: count symbols in 200–800-line spans and test whether one reaches the visible top-10.
3. **Project path literals** — the only policy that mis-scopes *other* repositories by name, so a false demotion is invisible in this repo. Check: one eval repo with a `reports/`-like directory.
4. **Suffix normalization** — load-bearing for the commit's own demonstration; removing it re-opens f9. Check: recovery hits with and without the rule, each labelled true/false owner.
5. **Preferred half-window reservation** — 64 at budget 128, not a fixed 16. Its interaction with the larger recovery pool remains unmeasured. Check one alternative against the current fraction on the same frozen pool and budget.
6. **File window 3** — its demonstrated f9 cost is already covered by path context, so this is a coverage question now, not a known loss. Check item in §2.1.
7. **`256 KiB`** — implementation invariant first: change only with the chunk size. Check: explicit-limit path for a 256 KiB–1 MiB file.
8. **Grouping `omitted` duplicate + must-retry dead policy** — correctness-of-explanation and dead-code questions, cheap to settle by reading the branch that fires, not by measurement.
9. **1 MiB, stopwords, writer verbs, RRF split, noise hint, proximity** — documentation-class items; settle each with the one logged number that shows whether the policy is even exercised.

## 6. Limits and unknowns of this pass

* Nothing was executed. The only numeric evidence quoted is the parent's saved helper-only timing and the saved replay counters; no Satori build, test, index, or model call was performed, and no live search confirmed any of it.
* The 118-identity f9 recovery reaches the visible answer only if the identities survive the 80-candidate admission and the 128-slot rerank window. The saved artifacts stop at the recovery stage, so at the audit date the checkpoint's own retention condition (`search-accuracy-checkpoint-2026-10-23.md:337-352`, "Retain it only if the intended f9 method reaches the visible ten") was **unmet by available evidence**. That was the reason to keep this audit provisional, not a reason to revert the commit. The later live check after `cc9651b8` returns the exact owner at rank 4; that recovery is outside this source-only audit.
* The "118 vs 25" comparison in the session context is not reproducible from the saved artifacts, which show 22 for the context-candidate run; the exact comparison denominator is unconfirmed (§1).
* Not inspected in this pass: BM25 beyond its constants, `search-execution.ts` outside the cited ranges, `current-source-symbols.ts` outside the cited ranges, indexing/publication/retention/admission/security policies, and file history beyond commit messages.
* Deliberate non-findings: no claim here says a policy is wrong because it lacks a comment. Every `REVIEW REQUIRED` names either an unrecorded exact value that a demonstrated failure depends on, a duplicated rule that can drift, or a literal that mis-scopes other repositories.

## 7. Parent validation of the completed audit

The independent audit completes after the user requests another continuation. Its initial raw text is preserved at:
`/tmp/orch/search-policy-audit-deepseek-raw-2026-10-24.md`.
The following corrections govern the report's conclusions. No production code changes during this validation.

### Confirmed review topics

- The remaining recovery file window, 400-line exclusion, and matching thresholds need value-specific explanations or measurements.
- Path classification explicitly treats leading `reports` and `investigations` directories as artifacts, and `landing` path segments as landing content.
  These literals can affect other repositories. An actual false classification or lost answer remains unmeasured.
- Query planning and definition discovery maintain different stopword sets. Both inspected ranking-term paths apply a three-character floor.
  This is a review topic for short identifiers, not proof that every short identifier is undiscoverable.
- The normal policy starts at candidate limit 80 with maximum 80. The attempt-ending branch therefore stops before widening.
  This supports reviewing dormant retry arithmetic and the tests that still encode widening below the normal starting limit.
- Core fusion uses 100 and MCP fusion uses 60. The core comment explicitly identifies separate policies.
  Separate ownership is documented. The exact numeric choices and their measured effects remain review topics.

### Corrections to evidence and arithmetic

1. **The 25-candidate baseline is confirmed.** `/tmp/orch/f9-capacity-candidate/replay.json` records 25 candidates and the target at position 24.
   `/tmp/orch/f9-no-quota-candidate/baseline-helper.json` repeats that result three times using source hash `849fdea22d68401743a2521e3e95840dbe9c76cc5c3543e99d9abaf3a1266305`.
   The 22-candidate context trial is a different, earlier source variant. The confirmed helper comparison remains 25 → 118.

2. **The reservation is half the available budget.** At budget 128, it reserves at most 64 preferred candidates, subject to availability.
   The cited test uses budget 32 and therefore reserves 16. There is no fixed 16-slot production reservation.
   Increasing this allowance favors preferred candidates and can displace ordinary candidates. The independent section reverses that direction.

3. **Recovery follows retrieval fusion.** `search-execution.ts:1131-1163` appends validated recovered candidates to the scored pool after retrieval.
   The recovered pool is not then clipped back to the earlier 80-candidate retrieval limit.
   Later provider selection and byte budgets still apply. Recovery position 18 is neither provider rank nor final visible rank.

4. **The must-retry diagnostic is an object.** `search-result-finalization.ts:341` reports attempts, maximum attempts, applied, satisfied, and final count.
   It is not the boolean expression described in §3.1. The configured maximum is three for must-operator requests, not two.
   The dormant widening finding follows from the actual candidate-limit branch, not the incorrect diagnostic description.

5. **A large symbol can supply a smaller excerpt.** A 200-line projection budget does not prove that a function over 400 lines cannot be excerpted.
   The recovery guard does reject that whole symbol. Its cost and quality justification still needs measurement.
   Lowering it to 200 is not justified by the argument given in §2.2.

6. **The source constant has several uses.** Its inspection, analyzer chunk-size, and supplied-evidence checks are confirmed.
   Updating the shared constant updates those references together. That change does not automatically create the disagreement asserted in §2.7.
   The generic inspectable-source API accepts an explicit larger ceiling. This does not remove the recovery reader's fixed 256 KiB ceiling.

7. **Aggregate byte arithmetic needs correction.** One MiB divided across 128 documents is 8,192 bytes per document, not roughly 512 bytes.
   Actual canonical document sizes must be measured. Source-excerpt character limits alone do not prove that the aggregate budget never binds.

8. **Grouping has an early complementary slot.** A third executable owner can be admitted during the first pass when its conditions hold.
   The third slot is not limited to under-filled pages, as §2.6 implies.

9. **Proximity grouping is a fallback bucket.** `search-group-results.ts:697-706` uses owner identity first and the 25-line bucket only without an owner.
   Bucket membership depends on the starting line. Nearby lines on opposite sides of a boundary can occupy different buckets.
   The assertion that every pair 24 lines apart groups together is incorrect.

10. **Some additional claims remain unsupported.** The writer-verb table exists, but its listed verbs differ from the independent section's description.
    Its claimed `isWriterIntentQuery` caller and widening to 160 were not established in the cited owners.
    The claimed `SUPPLEMENT_ALTERNATIVES_MAX` and grouped-response formula were not found in the cited file.
    Those claims are not accepted findings. The exclusive claim that recovery contains the only search stemmer also exceeds the checked scope.

11. **Undocumented does not establish arbitrary.** The introducing commit has an explanatory body, contrary to the repeated claim that it has none.
    A missing numeric justification supports `REVIEW REQUIRED`. It does not establish that the original choice had no reason.

### Current decision and verification gap

The user explicitly authorizes commit `11889927` after the earlier conditional retention wording. The commit is authorized and remains unchanged.
The earlier visible-ten condition is still an unperformed quality check. It is not evidence of an unauthorized commit.
The indexing blocker later clears. A later parent run at `11889927` measured 28 queries: overall
hit@10 was 21/28 and strict hit@10 was 20/28 (see the priorities document). That run is a single
baseline, not a before/after test of this change, so it does not attribute a score change to the
quota removal. Final owner accuracy and end-to-end latency remain open. Helper-only timings cannot
close that gap.

The review queue is source-based. It establishes no new production regression, optimal threshold, or instruction to remove another policy.

## 8. Follow-up live probe

The later current-checkout probe completes one exact saved f9 request against the same Publication.
The exact owner enters the reranker at position 87, scores at provider rank 22, and leaves the adjusted ranking at 19.
It is absent from the final ten disclosed results. A broader same-file result does not satisfy the exact-owner check.
The call takes 4,929.5 ms and peaks at 2,416.2 MiB sampled RSS across the driver and observed descendants.
This is a single first-in-session call. It does not establish a speed change or a broad accuracy result.
The grouped trace is truncated, so a specific grouping-exclusion mechanism remains unproved.
The parent checks the raw response and records the result in the accuracy checkpoint. No further policy changes follow.
Evidence: `/tmp/orch/f9-current-head-probe/parent-check.json` and its referenced raw artifacts.

Current correction (24 October 2026): after the grouped-owner repair in `cc9651b8`, one live f9
search returns the exact owner at visible rank 4. This section remains the pre-repair result.
The earlier miss and the later recovery are both part of the record.
