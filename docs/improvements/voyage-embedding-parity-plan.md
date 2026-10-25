# Voyage embedding parity plan

Written 2026-10-13 against `master` at `9297b1db`. Status: plan only, awaiting
review and approval. Nothing in this document is implemented. The measurements
that motivate it are under [Baseline](#baseline). What changed around the plan
after it was written is under [Update](#update-2026-10-14).

A written plan is warranted because the change crosses three packages, removes
a dependency, replaces the runtime profile that gates indexing behaviour, and
makes a paid provider run automatically.

## Update (2026-10-14)

Checked against `master` at `224183ca`. No phase has started and no decision
below has been confirmed. Four things changed around the plan:

- **The batch-overflow patch is committed** (`861820e2`, together with this
  document). The rest of the Voyage code is as reviewed under
  [Findings](#findings).
- **Reranker scope.** `rerank-3-lite` is the Voyage default
  (`DEFAULT_VOYAGE_RERANKER_MODEL`,
  `packages/core/src/reranker/voyageai-reranker.ts:20`) and `rerank-3` is
  supported. `rerank-2.5` was ruled out of scope as obsolete
  ([root cause](definition-fusion-root-cause.md), "Scope"). Its rows under
  [Baseline](#baseline) stay as measured and no longer drive a decision. This
  changes the example order in Phase 5.
- **Definition fusion depends on the reranker.** It is skipped for Voyage
  `rerank-3` and `rerank-3-lite` and applied for every other reranker,
  LateOn included (`rerankerOrderNeedsDefinitionFusion`,
  `packages/mcp/src/core/search-definition-discovery.ts:38`). The rule reads
  the configured reranker (`rerankerIdentity(host)`,
  `packages/mcp/src/core/search-rerank-execution.ts:548`). Under Phase 5 the
  reranker that orders the results can differ from the configured one, so
  Phase 5 gains a requirement.
- **Owner recall work overlaps Phases 1 to 3.** The
  [owner recall checkpoint](owner-recall-design-checkpoint.md) is measuring
  changes to the retrieval arms and core fusion in
  `packages/core/src/core/semantic-search-service.ts` (lines 701 to 741),
  directly after the `embedQuery` call that Phase 1 changes (line 698). A
  retrieval change moves the ranks of every arm, so if one ships first the
  table under "Search quality and time" stops being the equivalence
  reference; see [Acceptance](#acceptance).

Not measured: everything in the owner recall checkpoint was captured on the
Potion index (47 of 72 owners inside the rerank window, 18 in no retrieval
arm's top 80, and on those 18 questions test files hold a median 27 of the
dense arm's first 80 rows). None of it has been repeated with Voyage
embeddings, so it is unknown whether the better unreranked Voyage row (13
against 7 at rank 1) comes from retrieving those owners.

Later the same day the owner recall work measured two things through the real
local pipeline, both on the Potion index. Caller alt terms bring 64 of 72
owners into the window (51 without, lenient) and raise MRR from 0.3559 to
0.4985. A cap on test rows per arm brings two more owners in and does not
move MRR, so no retrieval-arm change is proposed and the table under "Search
quality and time" remains the equivalence reference. The one product change
made is a sentence in the `search_codebase` tool description, which does not
alter ranking for a given request. What remains open there is ordering inside
the window with LateOn; the [handoff](owner-ranking-handoff.md) has the
state. Voyage embeddings with caller alt terms is not measured.

## Goal

A Voyage-embedding install behaves like the Potion install, and the embedder
can be switched in place:

- `satori embeddings use voyage|potion` switches the embedder without
  re-running `satori install`. A switch causes a full re-index, which is
  accepted.
- A Voyage-embedding install gets everything a Potion install gets:
  automatic indexing of workspace roots, automatic rebuild of an incompatible
  index, the shared runtime, and a free choice of reranker (LateOn, Voyage,
  none).
- The Voyage code path is trustworthy before it is allowed to run
  automatically: bounded, cancellable, rate-limit aware, and strict about what
  it sends.
- The vector store stays local LanceDB. Milvus is not part of this plan.

## Requested outcomes and where each is delivered

| Outcome (Hamza, 2026-10-13) | Delivered by |
|---|---|
| Index with `voyage-code-3` without Milvus | Already works (`satori install --runtime voyage`, LanceDB default); kept |
| Same behaviour as Potion, including auto-index of workspace roots | Phase 3 |
| In-place switch | Phase 4 |
| Full re-index on switch is fine | Phase 4 uses the existing fingerprint mismatch and background rebuild |
| Review the Voyage implementation, find the issues, better architecture | [Findings](#findings), Phases 1 and 2 |
| Results must not get worse; clean code | [Acceptance](#acceptance) |
| Reranker failover: other Voyage rerankers, then LateOn; never silently unreranked | Phase 5 |
| Faster Voyage indexing | Phase 6 |

## Findings

Read-only review at `9297b1db`. Each is `finding → evidence → impact`.

### Embedding (`packages/core/src/embedding/voyageai-embedding.ts`)

1. **A search can block for about nine minutes.** `embedQuery` shares the
   indexing timeout (`VOYAGE_INDEXING_REQUEST_TIMEOUT_SECONDS = 180`) and
   `VOYAGE_REQUEST_MAX_ATTEMPTS = 3`, and accepts no abort signal.
   `packages/core/src/core/semantic-search-service.ts:698` calls it with no
   deadline. Impact: a slow or unreachable provider hangs the search tool.
2. **Rate limits fail a large index.** A 429 is retried twice with 1 s and 2 s
   waits; `Retry-After` is ignored. Voyage limits are per minute. Impact: a
   repository large enough to reach the per-minute token limit cannot be
   indexed.
3. **The per-chunk size check uses the batch limit.**
   `packages/core/src/core/indexing-pipeline.ts:855-866` compares each chunk to
   `hardTokenLimit` (120,000, the batch limit). The per-document limit is
   32,000 tokens. With `truncation: false`, one oversized chunk gets HTTP 400
   and aborts the index without naming the file.
4. **The token estimate is `text.length / 4`** (`indexing-pipeline.ts:185`).
   The real ratio for code is not measured. If code tokenizes more densely,
   batches aimed at 100,000 estimated tokens exceed 120,000 and are rejected,
   then split and resent.
5. **Batch overflow is detected by a regex on the provider's error message**
   (`isExplicitVoyageBatchLimitError`). A reworded error disables the
   split-and-retry path silently.
6. **Text is truncated at 128,000 characters without notice**
   (`base-embedding.ts:89`, `maxTokens * 4`), while the Voyage code states it
   avoids silent truncation.
7. **Only `voyage-code-3` has a batch policy** (`getBatchPolicy`). The other
   24 models in `getSupportedModels()` get no item or token cap; the table's
   `maxBatchTokens` field is never read.
8. **Unsafe or dead surface.** `outputDtype` accepts `int8`, `uint8`,
   `binary`, `ubinary`, but the decoder handles float32 only. `setModel`
   changes the model after construction without updating the identity owner.
   `getClient` and `updateDimensionForModel` are unused. `packages/mcp/src/config.ts:246`
   returns `encoderOutputDimension || 1024` for every Voyage model, including
   models with a fixed 1536 or 512 dimension.
9. **Indexing sends one batch at a time.** Correct, and slow for a first index
   of a large repository. Measured under [Baseline](#baseline).

### Reranker (`packages/core/src/reranker/voyageai-reranker.ts`)

10. Sound overall: plain `fetch`, abort signal honoured, each response row
    validated, its own failure kinds.
11. **Worst case 60 s per search.** `RERANK_TIMEOUT_MS = 30_000` and two
    attempts; `packages/mcp/src/server/provider-runtime.ts:652` passes no
    shorter timeout.
12. **Duplicate or missing indices in the response are not rejected.**
13. **The document sent to Voyage differs from the LateOn projection**
    (`buildNativeProviderRerankDocument`,
    `packages/mcp/src/core/search-rerank-execution.ts`). Suspected cause of
    `rerank-3` scoring below the earlier hook measurement. Unconfirmed.

### Structure

14. **Two Voyage clients.** Embedding uses the `voyageai` SDK, reranking uses
    raw `fetch`. Two timeout policies, two retry policies, two error
    taxonomies.
15. **The runtime profile fuses unrelated choices.**
    `assertExecutionPolicyAllowsRuntime` (`packages/mcp/src/config.ts:177-193`)
    forces Potion ⇔ offline and offline ⇒ LanceDB. Automatic workspace
    indexing (`provider-runtime.ts:355`, `shared-runtime.ts:286,476`) and the
    index maintenance coordinator that rebuilds an incompatible index
    (`provider-runtime.ts:335`) are keyed on `executionProfile === "offline"`.
    None of these depends on the embedder being local. The CLI repeats the
    coupling: `--reranker lateon` is rejected with `--runtime voyage`
    (`packages/cli/src/args.ts`, `install-preflight.ts`).

### Not traced

- Why the shared-runtime host is offline-only, and whether anything in it
  assumes a local embedder.
- Whether a failed Voyage index run leaves partial state behind.
- Whether OpenAI and Gemini embeddings are used by anyone. They share the
  `connected` profile and are affected by Phase 3.

## Baseline

Measured 2026-10-13 on `9297b1db`, isolated state root, LanceDB,
`voyage-code-3` at 1024 dimensions, the 28-question set
(`evals/real-repo-quality/cases.json`: React 9, Polars 9, FlatBuffers 10), one
run per arm. Harness: `evals/real-repo-quality/run.mjs`.

### Indexing failed before a one-line patch

On `9297b1db` the FlatBuffers index failed twice after about 305 s with
"VoyageAI embedding request was rejected (HTTP 400)". The request log shows
51 accepted batches of about 399k characters, then one of 399,258 characters
answered with:

```json
{"detail":"Request to model 'voyage-code-3' failed. The max allowed tokens per submitted batch is 120000. Your batch has 128010 tokens after truncation. Please lower the number of tokens in the batch.","error_code":"TOO_MANY_TOKENS_IN_BATCH"}
```

This confirms findings 4 and 5. The `length / 4` estimate put that batch at
100k tokens; it was 128k (3.1 characters per token). The overflow regex did
not match the provider's wording, so the existing split-and-retry never ran.

Patch (committed in `861820e2`): `isExplicitVoyageBatchLimitError`
also accepts `error_code: "TOO_MANY_TOKENS_IN_BATCH"`; one regression test
uses the recorded body. All numbers below include this patch. The estimate is
unchanged, so over-limit batches still cost one rejected request each.

### Indexing

| Repository | Files / size | Wall | In Voyage requests | Tokens | Requests | Rejected, then split | Chars sent |
|---|---|---|---|---|---|---|---|
| FlatBuffers `b8431fbc` | 1947 / 13.6 MB | 385 s | 308 s (80%) | 6.81M | 70 | 2 | 26.0M |
| Polars `74dd736d` | 3464 / 30.4 MB | 501 s | 360 s (72%) | 12.02M | 123 | 2 | 46.8M |
| React `7c6ac13e` | 7252 / 40.6 MB | 1019 s | 847 s (83%) | 16.41M | 188 | 4 | 70.6M |

- Requests are sequential, about 100k tokens and 4 to 5 s each: roughly
  20k tokens/s. The documented tier-1 limit for `voyage-code-3` is 3M tokens
  and 2000 requests per minute (50k tokens/s).
- Characters sent are 1.5 to 1.9 times the repository size. Not traced.
- Peak RSS of the harness process tree: 2.25 GB (FlatBuffers alone), 3.81 GB
  (React then Polars).
- 35.2M tokens in total; $6.34 at $0.18 per million, inside the free
  allowance here.
- One run per repository, so these are single measurements, not medians.

### Search quality and time

Hit counts are of 28. Time is per search, on the indexes above. The LateOn
row is Task 9 of the [reranker selection plan](reranker-selection-plan.md).
These captures predate the `5f96827c` rubric change and `0a2aa66c`, so the LateOn row re-measures
at 13/21/23 with MRR 0.5545 at HEAD `fb125738`.

| Embedder | Reranker | Hit@1 | Hit@5 | Hit@10 | MRR | Median | Mean | p90 |
|---|---|---|---|---|---|---|---|---|
| Potion | none | 7 | 20 | 21 | 0.398 | 0.28 s | 0.75 s | 1.73 s |
| Potion | LateOn (Task 9) | 13 | 19 | 21 | 0.556 | 2.40 s | | |
| Potion | `rerank-3-lite` (Task 9) | 18 | 24 | 24 | 0.738 | 1.04 s | | |
| Potion | `rerank-2.5` (Task 9) | 19 | 24 | 24 | 0.759 | 1.25 s | | |
| Voyage | none | 13 | 22 | 23 | 0.586 | 1.11 s | 1.47 s | 3.13 s |
| Voyage | `rerank-3-lite` | 21 | 24 | 25 | 0.792 | 1.95 s | 2.30 s | 4.20 s |
| Voyage | `rerank-2.5` | 21 | 23 | 25 | 0.795 | 1.91 s | 2.27 s | 3.71 s |

- Voyage embeddings alone match Potion with LateOn on hit@1 and beat it on
  hit@5, hit@10 and MRR.
- Voyage embeddings with a Voyage reranker are the best arms measured.
- The price is latency: a search makes one remote request for the query
  embedding and a second for reranking. The Voyage rerank arms used 294,508
  rerank tokens for 28 searches (about 10.5k per search).
- Voyage embeddings with LateOn was not measured. Neither was Voyage
  embeddings with `rerank-3`.
- `rerank-2.5` is out of scope since 2026-10-14; its two rows are history.

## Decisions

Proposed answers; each needs confirmation at review.

| # | Decision | Proposal | Alternative |
|---|---|---|---|
| D1 | One Voyage HTTP client, dropping the `voyageai` SDK | Yes. One owner for timeouts, retries, errors, signals | Keep the SDK for embeddings and only add signals and deadlines |
| D2 | Which Voyage embedding models are accepted | A short verified list, starting with `voyage-code-3`; unknown names are rejected with the list | Pass any name through, as the reranker does |
| D3 | Automatic indexing with a paid embedder | On, same as Potion; `satori embeddings status` shows tokens spent | One confirmation per repository before the first paid index |
| D4 | What replaces the offline/connected profile | Embedder and reranker are independent selections; network need is derived from them; lifecycle features key off the local store | Keep the profile and add exceptions for Voyage |
| D5 | OpenAI and Gemini embeddings | Keep working, no new features | Remove, as with Ollama |

## Architecture

```text
core/provider/voyage-client      one fetch client: deadline, AbortSignal,
                                 Retry-After backoff with jitter, one error type
        ▲                 ▲
core/embedding/voyage     core/reranker/voyage      thin adapters, no HTTP
        ▲                 ▲
mcp/config                selections: embedder, reranker (independent)
                          derived: networkPolicy = remote if either is remote
mcp/server                auto-index, maintenance, shared runtime:
                          gated on local store + autoIndexWorkspace
cli/runtime-selection     `embeddings use|status`, next to `reranker use|status`
```

Ownership:

- **Voyage client** owns transport policy only. It knows nothing about
  batching, documents or scores.
- **Embedder adapter** owns the model table (per-document tokens, per-batch
  tokens, allowed dimensions) and returns the batch policy. The indexing
  pipeline stays the single owner of batching and enforces both limits.
- **Config** owns the selections and the derived network policy. `Context`
  gains nothing.
- **CLI `runtime-selection`** owns writing the launcher environment for both
  switches. The API key is never written to the launcher.

Deadlines: query embedding and rerank get short per-attempt deadlines suited
to an interactive search; indexing keeps a long one. The exact values are set
from the baseline, not guessed.

## Phases

Each phase is independently shippable and ends with its own verification.
Order matters: the embedder must be trustworthy before Phase 3 makes it run
without being asked.

### Phase 1: one Voyage client

- Add the client with deterministic fault injection (injected `fetch` and
  clock): timeout, 429 with and without `Retry-After`, 5xx, network error,
  abort mid-request, abort during backoff.
- Move the reranker onto it with no change in results. Equivalence test:
  recorded response in, same `RerankResult[]` and same failure kinds out.
- Move the embedder onto it. Remove the `voyageai` dependency.
- Thread an `AbortSignal` and a query deadline through `embedQuery` from the
  search service.

### Phase 2: strict embedder

- Model table with per-document and per-batch limits; reject unknown models
  and unsupported dimensions at config load.
- The pipeline checks each chunk against the per-document limit and names the
  file and chunk on failure.
- Replace the `length / 4` estimate with a ratio calibrated from the baseline
  (`providerTokens` over `submittedBytes`), with headroom. Keep the
  split-on-rejection path, keyed on status code rather than message text.
- Remove `outputDtype`, `setModel`, `getClient`, `updateDimensionForModel`,
  the legacy model table, and the silent 128,000-character truncation for
  Voyage.
- Reject duplicate or missing reranker indices.

### Phase 3: selections replace the profile

- Config resolves `embedder` and `reranker` independently and derives the
  network policy. `assertExecutionPolicyAllowsRuntime` is reduced to the
  constraints that are real (for example LateOn needs its model path).
- Auto-index, the maintenance coordinator and the shared runtime are gated on
  the local store and `autoIndexWorkspace`.
- CLI install accepts any embedder with any reranker.
- First trace the two "not traced" items that affect this phase (shared
  runtime, partial state on failure). If the shared runtime assumes a local
  embedder, report that as a blocker rather than working around it.

### Phase 4: in-place switch

- `satori embeddings use voyage|potion [--model <m>] [--dimension <n>]
  [--no-verify]` and `satori embeddings status`, mirroring
  `satori reranker use|status`.
- Verification before writing: for Voyage, one small embedding request with
  the selected model and dimension; for Potion, the existing model check.
- The switch changes the fingerprint; the existing background rebuild
  re-indexes tracked repositories. Status reports "re-indexing" until done.
- Docs: README, `docs/REFERENCE.md`, `packages/cli/README.md`.

### Phase 5: reranker failover

Requested 2026-10-13. Today a failed Voyage rerank returns the candidates
unreranked with a `RERANKER_FAILED` warning.

- The selected Voyage reranker is first. On a model-scoped failure (HTTP 429,
  quota exhausted, model unavailable) the next Voyage reranker is tried, in a
  fixed order starting from the selection, for example `rerank-3-lite`,
  then `rerank-3`. The example used to end with `rerank-2.5`, which is out
  of scope since 2026-10-14; whether it stays in the chain is part of the
  open order question below.
- When no Voyage reranker remains, or the failure is account-wide (401, 403,
  network, timeout), the search reranks with LateOn.
- Unreranked results are returned only when LateOn is not installed, or the
  user selected `none`. The response always names the reranker that produced
  the order and why the selected one was skipped.
- A failed model is skipped for a cooldown (honouring `Retry-After`), so each
  search does not pay for the same failure again. One owner holds this state.
- The whole chain shares one rerank deadline.
- Added 2026-10-14: definition fusion follows the reranker that produced the
  order, not the configured one. Today the rule reads the configured
  reranker (`search-rerank-execution.ts:548`), so a search that fails over
  from `rerank-3-lite` to LateOn would skip the fusion that LateOn's order is
  measured with (13 at rank 1 with it on the 28 questions), and any model
  outside `rerank-3` and `rerank-3-lite` gets fusion applied. The failover
  owner reports which reranker ran; the fusion rule reads that.

Decided 2026-10-13: failover is driven by provider errors only. Satori does
not count tokens or track an allowance.

Known limit: Voyage documents 200M free tokens per model and "subsequent
usage is priced per token", with no documented error when the allowance
ends. With a payment method on file, an exhausted model is expected to bill
rather than fail, and this design will not notice. Staying free is then the
user's choice of model or account setup, not Satori's.

Open for review: the Voyage order; the cooldown length; whether LateOn must
be installed for a Voyage-reranker install.

### Phase 6: indexing time

Baseline and levers are in [Baseline](#baseline). Each change is measured on
the three baseline repositories, one at a time.

- Bounded concurrent embedding requests, within the account's token and
  request rate limits, with backoff on 429.
- Token-accurate batching, so no batch is rejected and re-sent.
- Trace why the characters sent exceed the repository size, and remove
  duplicate embedding work if any is found.

## Acceptance

- **No quality regression.** After Phases 1 and 2, the 28-question results for
  every Voyage arm in the baseline are unchanged (same ranks). After Phase 3,
  the Potion arms are unchanged. The reference is the baseline table only
  while retrieval is as it was at `9297b1db`. If a retrieval or fusion change
  has shipped since (see [Update](#update-2026-10-14)), re-run the baseline
  arms at the commit the phase starts from and compare against that.
- **Failover and fusion** (added 2026-10-14 with the Phase 5 requirement). A
  search that fails over to LateOn gets the same order as a search with
  LateOn selected, on the same candidates.
- **Indexing.** The three baseline repositories index with Voyage without a
  manual retry. Index wall time and provider request count are no worse than
  baseline; rejected-and-split requests drop to zero or are explained.
- **Indexing time.** Median index wall time on the three baseline
  repositories improves on baseline; the target is set from the Phase 6
  profile, with stored vectors and the 28-question ranks unchanged.
- **Failover.** With the selected reranker returning 429, the next Voyage
  reranker orders the results; with every Voyage request failing, LateOn
  does; the response names which. Proven by fault injection.
- **Search.** With the provider unreachable, a search returns an error within
  the query deadline. Proven by a fault-injection test, not a sleep.
- **Parity.** A Voyage-embedding install auto-indexes a workspace root,
  rebuilds an incompatible index, and reranks with LateOn, Voyage or none.
- **Switch.** `embeddings use` followed by `embeddings status` shows the new
  selection; a search succeeds after the rebuild; switching back restores
  Potion results.
- **Code.** `pnpm run check` passes; no profile branch remains for behaviour
  that does not depend on the profile; removed surface has no remaining
  callers.

## Risks

- **Cost.** Automatic indexing spends Voyage tokens. Mitigation: D3, and the
  token count in status.
- **Privacy boundary.** With Voyage embeddings, source text leaves the
  machine at index time, not only at query time. The switch command says so.
- **Profile removal is wide.** `executionProfile` is read in four MCP files
  and several CLI ones. Mitigation: Phase 3 is its own phase with the Potion
  arms as the equivalence check.
- **Rate limits differ by account tier.** Backoff is tested with injected
  responses; real limits are only exercised by the baseline repositories.

## Out of scope

- Milvus, and any other vector store.
- New embedding providers; changes to OpenAI and Gemini beyond D5.
- Changing the reranker document projection (finding 13). It is measured
  separately first.
- Concurrent embedding batches (finding 9) outside Phase 6. Phase 6 measures
  them as one lever, with its own measurement.
- Removing Potion.
