# Satori Search Query Intent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent exact identifier queries from being lost in Satori search by separating dense, lexical, and hybrid score semantics and adding intent-aware ranking with exact-match preservation.

**Architecture:** Keep the existing six-tool MCP surface unchanged. The core package becomes responsible for explicit retrieval modes, score-policy contracts, and returned score-kind metadata, while the MCP package classifies query intent, applies lexical-aware ranking, and constrains reranker behavior so exact symbol and path matches cannot be buried. No graph database dependency is added to the primary search path.

**Tech Stack:** TypeScript, Node 20, pnpm, Milvus/Zilliz adapters, MCP SDK, existing Satori test suite

---

## Assumptions

- The existing hotfix that removes hybrid thresholding remains in place as the safety baseline.
- The target behavior is based on failures observed while searching `/home/hamza/repo/tradingview_ratio`.
- Graph sidecars remain optional navigation infrastructure, not a dependency for main search recall.
- Backward compatibility of the six MCP tools is mandatory.

## Spec Reference

- Design: `docs/superpowers/specs/2026-03-16-satori-search-query-intent-design.md`
- Architecture reference: `docs/ARCHITECTURE.md`

## Chunk 1: Make Score Semantics Explicit in Core

### Task 1: Replace the generic threshold parameter with typed search request options

**Files:**
- Modify: `packages/core/src/vectordb/types.ts`
- Modify: `packages/core/src/core/context.ts`
- Test: `packages/mcp/src/core/index-completion-marker-context.test.ts`

- [ ] **Step 1: Write failing tests for score-policy behavior**

Add tests covering:
- dense search still supports a minimum similarity gate
- lexical and hybrid search do not accept dense similarity gating
- invalid score-policy and retrieval-mode combinations are rejected
- score-kind metadata is returned for downstream consumers

- [ ] **Step 2: Define typed retrieval and score-policy contracts**

Add explicit request types in `packages/core/src/vectordb/types.ts`, for example:

```ts
type RetrievalMode = "dense" | "lexical" | "hybrid";
type ScorePolicy =
  | { kind: "dense_similarity_min"; min: number }
  | { kind: "topk_only" };
```

- [ ] **Step 3: Refactor `Context.semanticSearch` into an explicit request-based API**

Change `packages/core/src/core/context.ts` so callers pass a structured request instead of `(query, topK, threshold, filterExpr)`. Keep a thin compatibility wrapper only if required during migration.

- [ ] **Step 4: Update hybrid branch to reject dense-threshold semantics**

Ensure the lexical and hybrid branches can only run with `scorePolicy.kind === "topk_only"` and that dense-only threshold semantics stay confined to the dense branch.

- [ ] **Step 5: Return backend score-kind metadata**

Add a returned candidate field such as:

```ts
backendScoreKind: "dense_similarity" | "lexical_rank" | "rrf_fusion"
```

so MCP can distinguish calibrated scores from ordering-only backend scores.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/index-completion-marker-context.test.ts
```

Expected: PASS with explicit score-policy coverage.

- [ ] **Step 7: Commit the core contract change**

```bash
git add packages/core/src/vectordb/types.ts packages/core/src/core/context.ts packages/mcp/src/core/index-completion-marker-context.test.ts
git commit -m "refactor(search): make retrieval score policy explicit"
```

## Chunk 2: Introduce Deterministic Query Intent Classification

### Task 2: Add a classifier for identifier-like vs semantic queries

**Files:**
- Modify: `packages/mcp/src/core/handlers.ts`
- Test: `packages/mcp/src/core/handlers.scope.test.ts`

- [ ] **Step 1: Write failing tests for query intent classification**

Add tests proving that:
- `hurst` is classified as `identifier`
- `HurstGateState` is classified as `identifier`
- `path:config hurst_gate` becomes `mixed`
- natural language queries such as `where is the regime gate logic` remain `semantic`
- ambiguous mixed queries keep the hybrid retrieval path rather than hard-routing to a single lane

- [ ] **Step 2: Add a deterministic classifier**

Implement a small helper in `packages/mcp/src/core/handlers.ts` based on:
- token count
- symbol casing
- path-like patterns
- identifier punctuation such as `_`, `.`, `/`

Do not use model inference.

- [ ] **Step 3: Expose intent in debug payload**

Update the search debug structure so it reports the chosen intent class, chosen retrieval strategy, and whether the result was treated as ambiguous/mixed.

- [ ] **Step 4: Run focused MCP handler tests**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.scope.test.ts
```

Expected: PASS with intent classification coverage.

- [ ] **Step 5: Commit the classifier**

```bash
git add packages/mcp/src/core/handlers.ts packages/mcp/src/core/handlers.scope.test.ts
git commit -m "feat(search): classify identifier and semantic query intent"
```

## Chunk 3: Route Identifier Queries Through the Correct Retrieval Policy

### Task 3: Stop passing naked dense thresholds from MCP into lexical and hybrid retrieval

**Files:**
- Modify: `packages/mcp/src/core/handlers.ts`
- Test: `packages/mcp/src/core/handlers.scope.test.ts`

- [ ] **Step 1: Write failing tests for request construction**

Add tests that prove identifier and mixed intents build retrieval requests with:
- `retrievalMode: "lexical"` or `retrievalMode: "hybrid"` depending on confidence
- `scorePolicy: { kind: "topk_only" }`

And that dense-only thresholds are used only for explicit dense mode.

- [ ] **Step 2: Build typed search requests in the MCP handler**

Replace calls such as:

```ts
this.context.semanticSearch(effectiveRoot, pass.query, candidateLimit, 0.3)
```

with a structured request object that carries retrieval mode, score policy, and backend score semantics.

- [ ] **Step 3: Preserve current semantic query behavior**

Semantic queries should continue using the existing hybrid passes and reranker policy unless the new typed API requires a small refactor. Mixed queries should default to hybrid retrieval with intent-aware ranking rather than brittle hard routing.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.scope.test.ts src/core/index-completion-marker-context.test.ts
```

Expected: PASS with no regression in current grouped/raw search behavior.

- [ ] **Step 5: Commit the retrieval-policy routing**

```bash
git add packages/mcp/src/core/handlers.ts packages/mcp/src/core/handlers.scope.test.ts packages/mcp/src/core/index-completion-marker-context.test.ts
git commit -m "refactor(search): route hybrid queries with explicit score policy"
```

## Chunk 4: Add Lexical-Aware Ranking for Identifier Queries

### Task 4: Boost exact symbol, file, and content matches after candidate recall

**Files:**
- Modify: `packages/mcp/src/core/handlers.ts`
- Test: `packages/mcp/src/core/handlers.scope.test.ts`

- [ ] **Step 1: Write failing ranking tests**

Add tests proving that for `identifier` or `mixed` queries:
- exact `symbolLabel` matches outrank semantic neighbors
- exact `relativePath` token matches outrank unrelated chunks
- exact content token matches rescue short identifier queries such as `hurst`
- exact-match candidates remain in a protected top band even when the semantic reranker is active for mixed queries
- common identifiers such as `state` do not produce substring-heavy junk at the top

- [ ] **Step 2: Add lexical score helpers**

Implement deterministic lexical boosts using this priority order:
1. exact symbol match
2. exact path segment or filename match
3. exact token-in-content match
4. symbol prefix match
5. path prefix match
6. substring match
7. semantic-only relevance

Normalize by:
- splitting snake case, camel case, and path separators into lexical tokens
- treating case-insensitive equality as the default exact check
- preserving exact-case equality as an additional positive signal
- respecting token boundaries so substring-only matches do not dominate

- [ ] **Step 3: Fuse lexical boosts after candidate retrieval**

Apply the lexical score in MCP after core retrieval returns candidates and before final grouping. Keep current tie-break rules deterministic.

- [ ] **Step 4: Verify on known regression examples**

Add regression coverage for:
- `hurst`
- `HurstGateState`
- `check_hurst_gate`
- `hurst regime gate`
- `where is HurstGateState used`

- [ ] **Step 5: Add reranker policy constraints**

Define and implement:
- semantic intent: reranker enabled normally
- identifier intent: reranker disabled or restricted to lexical-band-only reordering
- mixed intent: reranker allowed, but exact symbol/path matches stay pinned in a protected top band

- [ ] **Step 6: Run focused search tests**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/handlers.scope.test.ts
```

Expected: PASS with lexical-priority coverage.

- [ ] **Step 7: Commit lexical rescue ranking**

```bash
git add packages/mcp/src/core/handlers.ts packages/mcp/src/core/handlers.scope.test.ts
git commit -m "feat(search): add lexical boosts for identifier queries"
```

## Chunk 5: Document the Search Model Clearly

### Task 5: Update docs so score semantics and query intent are explicit

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `packages/mcp/README.md`
- Modify: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

- [ ] **Step 1: Document retrieval-mode separation**

Explain that dense thresholds apply only to dense similarity search and never to hybrid rank-fusion scores.

- [ ] **Step 2: Document query intent behavior**

Describe:
- `semantic`
- `identifier`
- `mixed`

and how they affect retrieval and ranking.

- [ ] **Step 3: Document debug output additions**

Record any new debug fields such as intent class, retrieval mode, score-policy kind, backend score kind, lexical boost application, and exact-match preservation decisions.

- [ ] **Step 4: Run docs and test verification**

Run:

```bash
pnpm --filter @zokizuan/satori-mcp test -- src/core/search.eval.test.ts
pnpm -C packages/mcp docs:check
```

Expected: PASS with docs consistent and the search evaluation harness reflecting the new identifier and mixed-query guarantees.

- [ ] **Step 5: Commit documentation updates**

```bash
git add docs/ARCHITECTURE.md packages/mcp/README.md docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md
git commit -m "docs(search): document query intent and score semantics"
```

## Success Criteria

- [ ] Identifier-like zero-result rate is measurably lower on the tracked evaluation set.
- [ ] Exact symbol and filename queries place a matching result in the top result band at a high rate.
- [ ] Mixed queries preserve both exact lexical matches and semantic neighbors.
- [ ] Semantic-query quality does not regress on the current search evaluation fixtures.
- [ ] Search latency remains within an agreed delta from the current implementation.
- [ ] Debug output is sufficient to explain intent choice, retrieval mode, score semantics, reranker policy, and final ranking.

Measurement baseline:

- [ ] Extend `packages/mcp/src/core/search.eval.test.ts` with identifier and mixed-query fixtures from the `hurst` failure family so rollout uses the existing deterministic evaluation harness instead of a parallel benchmark.

## Execution Notes

- Keep each chunk isolated and reviewable.
- Do not bundle unrelated search refactors.
- Preserve the six-tool MCP contract throughout.
- Prefer typed APIs over comments wherever possible.
- The current hotfix is a baseline safeguard, not the final architecture.
- Treat query intent as a ranking and retrieval hint, not a brittle hard router, except for obvious edge cases.
