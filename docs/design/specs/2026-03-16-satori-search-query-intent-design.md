# Satori Search Query Intent Design

## Summary

This design addresses a search failure observed while using Satori against `/home/hamza/repo/tradingview_ratio`, where identifier-like queries such as `hurst` returned zero candidates even though the term existed in indexed files.

The root cause is not stale indexing and not missing content. The failure is architectural: Satori currently routes both semantic queries and exact identifier queries through the same `semanticSearch` abstraction, then applies a score threshold that only makes sense for dense vector similarity. In hybrid mode, Milvus returns rank-fusion scores that are much smaller and not directly comparable to dense similarity scores, so valid hits can be dropped before MCP ranking, grouping, and reranking ever run.

The recommended solution is to split query intent from score semantics without making Satori graph-dependent. Graph systems like Codebase Memory and GitNexus avoid this class of failure by separating exact symbol discovery from semantic exploration. Satori should adopt the same boundary while preserving its current six-tool MCP surface and vector-backed architecture.

## Problem Statement

### Observed Behavior

- `search_codebase(query="hurst", ...)` produced zero candidates.
- `read_file` worked when given the exact file path.
- External search baselines (`rg`, Codebase Memory, GitNexus) found the term immediately.
- Satori debug output showed `candidatesIn: 0`, which means the failure happened before reranking.

### Root Cause

The current flow is:

1. `search_codebase` in `packages/mcp` calls `Context.semanticSearch(..., threshold=0.3)`.
2. `Context.semanticSearch` in `packages/core` routes the request into either dense search or hybrid dense+sparse search.
3. In hybrid mode, the Milvus adapters return fused RRF scores.
4. The adapters then filter results using `result.score >= threshold`.

That threshold is reasonable for dense cosine similarity but incorrect for hybrid rank-fusion scores.

For identifier-like queries:

- Dense embeddings often do not score highly because short tokens such as `hurst` carry little semantic context.
- Sparse/BM25 retrieval is the useful lane.
- RRF fusion scores are usually small, even for strong matches.
- Applying a dense-style threshold to those scores drops valid results.

### Why `hurst` Was “Low Score”

The hit was likely only strong in the sparse/BM25 lane. With RRF at `k=100`, a top-ranked hit can still have a score around `0.01` to `0.02`. That is expected for fused rank scores. It is not evidence that the hit is weak. The mistake was treating that fused score like a dense similarity score.

The deeper failure is not only “hybrid thresholding is wrong.” It is that Satori currently lacks a distinct lexical retrieval contract for exact identifier and filename-style queries.

## Goals

- Preserve exact identifier recall for symbol-like queries such as `hurst`, `HurstGateState`, `hurst_gate.py`, and `check_hurst_gate`.
- Preserve semantic search quality for natural-language queries.
- Preserve or improve ranking quality for mixed queries that combine identifiers with prose.
- Keep the MCP public surface unchanged.
- Avoid introducing a graph database dependency into the hot search path.
- Make score handling explicit enough that dense and hybrid paths cannot silently share incompatible semantics again.

## Non-Goals

- Replacing Milvus or hybrid search.
- Requiring graph indexing for normal Satori search.
- Rewriting grouping, navigation, or call graph features.
- Expanding the six-tool MCP contract.

## Options Considered

### Option A: Minimal Patch Only

Remove thresholding from hybrid search and leave everything else as-is.

Pros:
- Smallest change.
- Fixes the immediate `hurst` failure.
- Low release risk.

Cons:
- The shared abstraction remains misleading.
- Future callers can still misuse score semantics.
- Identifier-like queries still do not get intentional handling.

### Option B: Explicit Retrieval Modes, Score Semantics, and Intent-Aware Ranking

Split dense, lexical, and hybrid score semantics in the core API, then classify queries as semantic vs identifier-like in the MCP handler and let that classification influence ranking policy.

Pros:
- Fixes the current bug class, not just one code path.
- Keeps architecture aligned with existing MCP/core boundaries.
- Lets Satori handle exact identifiers better without becoming graph-based.

Cons:
- More code movement than the minimal patch.
- Requires coordinated test updates across core and MCP.

### Option C: Graph-First Search

Introduce graph-backed symbol discovery as the primary search path.

Pros:
- Strong exact identifier behavior.
- Better structural navigation.

Cons:
- Larger architectural shift.
- Adds operational and indexing complexity.
- Not necessary to solve the current problem.

### Recommendation

Choose Option B.

It captures the useful lesson from Codebase Memory and GitNexus, which is not “be graph-based,” but “do not force exact identifier discovery through semantic scoring.” It also fits Satori’s current architecture, where the MCP layer owns ranking policy and the core layer owns retrieval execution.

## Proposed Architecture

### 1. Make Retrieval Mode Explicit

Replace the generic `semanticSearch(codebasePath, query, topK, threshold, filterExpr)` contract with a typed request model that makes retrieval mode and score policy explicit.

Proposed shape:

```ts
type RetrievalMode = "dense" | "lexical" | "hybrid";

type ScorePolicy =
  | { kind: "dense_similarity_min"; min: number }
  | { kind: "topk_only" };

interface SearchRequest {
  codebasePath: string;
  query: string;
  topK: number;
  retrievalMode: RetrievalMode;
  filterExpr?: string;
  scorePolicy: ScorePolicy;
}
```

This preserves dense thresholds where they are valid and prevents lexical or hybrid callers from accidentally inheriting them. `lexical` is a first-class logical mode even if the first implementation still uses the current sparse/hybrid backend under the hood.

### 2. Make Score Semantics Explicit Across Layers

Core should return candidate score metadata so MCP never has to guess what a backend score means.

Proposed shape:

```ts
type BackendScoreKind = "dense_similarity" | "lexical_rank" | "rrf_fusion";

interface SearchCandidate {
  ...
  backendScore: number;
  backendScoreKind: BackendScoreKind;
}
```

MCP should treat many backend scores as ordering-only unless the score kind explicitly says they are calibrated for thresholding.

### 3. Add Query Intent Classification in MCP

Introduce a lightweight, deterministic query classifier in `packages/mcp/src/core/handlers.ts`.

Suggested intents:

- `semantic`
- `identifier`
- `mixed`

Signals for `identifier`:

- Short token counts
- Snake case, camel case, or file-like strings
- Symbol-like capitalization
- Path fragments
- Queries dominated by alphanumeric identifiers rather than prose

This classifier does not need ML. It should be deterministic and debug-visible.

The classifier should act as a ranking and retrieval hint, not a brittle hard router. Only obvious edge cases should fully select one retrieval mode. Mixed queries should default to hybrid retrieval with intent-aware ranking.

### 4. Route Identifier Queries to Lexical-First Retrieval

Identifier queries should be treated as lexical-first retrieval requests, implemented initially using the current sparse/hybrid backend without dense-style score gating.

This preserves implementation flexibility. The logical contract is lexical-first even if the first backend implementation still uses Milvus hybrid search.

### 5. Add Lexical-Aware MCP Ranking With Exact-Match Preservation

After candidates are returned, MCP should boost identifier matches using fields it already has:

- `symbolLabel`
- `relativePath`
- `content`

This mirrors the strength of Codebase Memory and GitNexus for exact symbol discovery without requiring a graph index in the main search path.

Recommended priority order:

1. exact symbol match
2. exact path-segment or filename match
3. exact token-in-content match
4. symbol prefix match
5. path prefix match
6. substring match
7. semantic-only relevance

Normalization rules:

- compare case-insensitively by default, while preserving exact-case as a stronger signal
- split snake case, camel case, and path separators into lexical tokens
- preserve token boundaries so short common identifiers do not dominate by substring alone

Invariant:

- exact symbol or path matches should outrank semantically related but non-exact chunks unless the query form clearly asks for semantic exploration.

### 6. Define Reranker Policy Explicitly

The semantic reranker cannot be allowed to bury exact lexical hits.

Recommended policy:

- `semantic` intent: reranker enabled normally
- `identifier` intent: reranker disabled, or restricted to reorder only within a lexical band after exact-match preservation
- `mixed` intent: reranker allowed, but exact lexical matches are pinned into a protected top band

Exact-match preservation rule:

- if an exact symbol or path match exists, it cannot fall below the protected rank band because of semantic reranking.

### 7. Keep Semantic Queries on the Existing Path

Natural-language requests such as “where is the regime gate logic” should continue using the existing hybrid dense+sparse passes plus reranker policy.

The key change is not to reduce semantic behavior. It is to stop exact-identifier searches from being treated as purely semantic retrieval problems.

## Data Flow

### Current

`search_codebase` -> `semanticSearch(..., threshold=0.3)` -> hybrid Milvus -> adapter score filter -> MCP grouping/reranking

### Proposed

`search_codebase`
-> classify query intent
-> build typed search request
-> core retrieval with explicit score policy
-> candidate list returned with score-kind metadata
-> MCP lexical-aware fusion and grouping
-> reranker only where policy allows

## Error Handling

- Unknown or unsupported score policies should fail closed in core.
- Debug payload should expose:
  - classified query intent
  - retrieval mode
  - score policy kind
  - backend score kind
  - whether lexical boosts were applied
- Hybrid paths should not silently reintroduce thresholding.
- Low-confidence or mixed-intent cases should be visible in debug output.
- If an exact lexical match existed but was demoted by later ranking, that should be inspectable in debug output.

## Testing Strategy

### Core Tests

- Dense search still honors dense similarity thresholds.
- Lexical and hybrid search reject dense-threshold semantics.
- Hybrid search ignores dense thresholds and returns valid low-score fused results.
- Typed score policy rejects invalid combinations.
- Candidate metadata includes the correct backend score kind.

### MCP Tests

- Identifier-like queries such as `hurst` and `HurstGateState` return candidates.
- Semantic queries preserve current grouped behavior.
- Mixed queries preserve both lexical exact matches and semantically related candidates.
- Debug output shows chosen query intent, retrieval mode, score policy, and score kind.
- Lexical-aware ranking prefers exact identifier matches over merely semantically related chunks.
- Reranker policy preserves exact matches for identifier and mixed queries.
- Short common identifiers such as `state` do not flood top results with low-value substring matches.

## Rollout Plan

### Phase 1

- Keep the current hotfix: remove hybrid thresholding.
- Add regression coverage for low fused-score exact hits.
- Extend the existing `packages/mcp/src/core/search.eval.test.ts` matrix with identifier and mixed-query fixtures so recall and ranking regressions are measured in the same deterministic harness Satori already uses.
- Add sampled debug traces and counters for identifier-like zero-result searches.

### Phase 2

- Introduce typed retrieval and score policy in core.
- Return score-kind metadata from core.
- Update MCP handlers to stop passing raw naked thresholds.

### Phase 3

- Add deterministic query intent classification and lexical-aware ranking.
- Add explicit reranker constraints and exact-match preservation.
- Document the behavior in architecture and search docs.

## Success Criteria

- Zero-result rate for identifier-like queries decreases materially from the current baseline.
- Exact symbol and filename queries return a matching candidate in the top result band at a high rate.
- Mixed queries preserve both exact-match usefulness and semantic recall.
- Semantic query relevance does not regress on the current evaluation set.
- Search latency remains within an acceptable delta from the current hybrid path.
- Debug payloads expose intent, retrieval mode, score semantics, and ranking decisions clearly enough to diagnose regressions.

Operational note:

- Measure the regression set through the existing `packages/mcp/src/core/search.eval.test.ts` harness first. If runtime telemetry is added later, it should validate the same identifier and mixed-query examples rather than define a second competing benchmark.

## Why This Is the Elegant Fix

This approach solves the actual abstraction problem.

It does not overcorrect by making Satori graph-first.
It does not leave the bug class open by relying only on a tactical patch.
It borrows the right lesson from graph-based systems: exact discovery and semantic exploration should be separate concerns, even when they eventually feed the same ranking pipeline.
