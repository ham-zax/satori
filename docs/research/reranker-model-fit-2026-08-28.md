# Reranker model fit for Satori

Date: 2026-08-28

Follow-up: the completed and incomplete Satori-specific runs are consolidated
in [Satori reranker benchmark results](./reranker-benchmark-results-2026-08-29.md).

## Conclusion

Two families justify a Satori-specific experiment:

1. `mixedbread-ai/mxbai-edge-colbert-v0-{17m,32m}` is the closest structural alternative to the current LateOn scorer. It produces token-level multi-vector representations and uses MaxSim late interaction; the 17M model projects to 48 dimensions and the 32M model to 64. Both publish ONNX artifacts and use Apache-2.0 licensing. The public evidence is general English retrieval, not code-owner ranking, so neither can be called an improvement without a frozen Satori A/B. ([17M card](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m), [32M card](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-32m))
2. `cross-encoder/ettin-reranker-{17m,32m}-v1` is the strongest small true-cross-encoder experiment. The family scores each query-document pair jointly, supports up to 8K tokens, is Apache-2.0, and publishes ONNX/OpenVINO exports. The 32M model is the sensible first quality/footprint point; the 17M sibling is the smallest feasibility point. Its published MTEB/NanoBEIR and H100 throughput results do not establish code-search quality or CPU latency in Satori. ([family release](https://huggingface.co/blog/ettin-reranker), [32M card](https://huggingface.co/cross-encoder/ettin-reranker-32m-v1))

Do not stack all candidates. First compare each shortlisted model as the sole reranking authority over the same frozen candidate set and projection. Only test a cascade after a replacement experiment shows a real, held-out quality gain.

## Candidate comparison

| Candidate | Actual role and contract | Evidence relevant to Satori | Fit decision |
| --- | --- | --- | --- |
| LightOn PW/LW 0.8B, 2B, 4B | Multimodal Qwen3.5 rerankers for text and page images. PW independently scores `Yes` versus `No`; LW generates permutations over four-document windows. The released sizes are about 0.85B, 2.2B, and 4.5B parameters, require recent Python Transformers/Sentence Transformers, and are Apache-2.0. | Satori currently projects text-only code evidence. The vision stack is unused overhead, and even 0.8B is far outside the current 17M local-reranker class. The cards report BEIR/ViDoRe, not code-owner ranking; PW-0.8B is explicitly presented as a cautionary operating point for visual reranking. | Not a default local candidate. Consider LW-2B only for a separately defined GPU/connected deep-rerank tier, or if Satori later ranks page images. ([family card](https://huggingface.co/lightonai/LightOn-rerank-PW-0.8B)) |
| Ettin reranker 17M/32M/68M/150M/400M/1B | English pointwise CrossEncoder family: one scalar relevance score per query-document pair, 8K context, Apache-2.0. Models are ModernBERT-based and the repositories include ONNX exports. | The scalar output matches Satori's provider-level `Reranker` contract. Cross-attention could judge the complete projected answer packet differently from LateOn's token-level MaxSim. Published quality is general MTEB/NanoBEIR; speed was measured on an H100, not Satori's CPU envelope. | Prototype 32M first, with 17M as the minimum-footprint control. Do not jump to 150M+ until a small model earns a Satori-specific quality delta. ([release and measurements](https://huggingface.co/blog/ettin-reranker)) |
| Jina reranker v3.5 | 0.6B multilingual listwise reranker, ranks many documents jointly in one pass, supports up to 131K tokens, and exposes a `query + documents -> relevance scores` interface. Local use requires custom model code; a hosted API is also offered. | The listwise contract is relevant to Satori's bounded candidate set and structured projections. However, the model is CC BY-NC 4.0, so it is unsuitable as an unrestricted bundled production default. Its reported BEIR/MIRACL/RTEB/Struct-IR results use a different first stage and do not prove code-search gains. | Optional non-commercial diagnostic or connected-provider experiment only, not the managed default. ([model card](https://huggingface.co/jinaai/jina-reranker-v3.5)) |
| Mixedbread Edge-ColBERT 17M/32M | English late-interaction multi-vector models with MaxSim scoring, 32K document support, Apache-2.0, and ONNX exports. The 17M model uses a 48-dimensional projection; the 32M model uses 64 dimensions. | This is the closest shape to Satori's current worker. The 32M card reports higher average BEIR than the 17M sibling, while their LongEmbed results are close. Neither card establishes code-specific owner ranking. | Highest-priority architecture-compatible A/B: 17M first for shape-compatible feasibility, then 32M for the capacity trade-off. ([17M card](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m), [32M card](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-32m)) |
| `all-MiniLM-L6-v2` | General sentence/paragraph embedding model producing one 384-dimensional vector. Inputs longer than 256 word pieces are truncated by default. | It is a first-stage dense retriever, not a query-document reranker. Replacing Potion would change vector compatibility and require a reindex. Its short general-text context is a poor match for Satori's projected code packets. | Exclude from the reranker track. A first-stage experiment would be a separate decision. ([model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)) |
| `potion-retrieval-32m-onnx` | ONNX export of a general English Model2Vec static embedding model. The original card reports MTEB Retrieval 35.06 versus 42.92 for all-MiniLM-L6-v2 and emphasizes speed/resource efficiency. It is MIT licensed. | It produces standalone text vectors, not joint query-document relevance scores. It is not the code-specific `potion-code-16M-v2` currently used by Satori. | Exclude from reranking. It could only be evaluated as a separate first-stage embedding model with a reindex and code-specific benchmark. ([ONNX card](https://huggingface.co/minishlab/potion-retrieval-32m-onnx), [base model card](https://huggingface.co/minishlab/potion-retrieval-32M)) |

## Satori integration facts

Satori's public `Reranker` port is model-agnostic at the outer boundary: it accepts one query plus a document list and returns indexed relevance scores. It also binds provider/model/profile identity, candidate capacity, query/document projection versions, cancellation, and execution diagnostics. ([local contract](../../packages/core/src/reranker/reranker.ts))

The managed implementation is not model-agnostic internally. The configured providers are currently `none`, `voyage`, or `lateon`; `LateOnReranker` loads a frozen profile, verifies model artifacts and runtime versions, and its worker performs model-specific token normalization and MaxSim scoring. Pointing `SATORI_LATEON_MODEL_PATH` at another repository is therefore invalid; every candidate needs a new explicit provider/profile and worker path. ([provider config](../../packages/mcp/src/config.ts), [LateOn owner](../../packages/mcp/src/server/lateon-reranker.ts), [worker](../../packages/mcp/src/server/lateon-reranker-worker.ts))

The current managed profile reranks at most 32 candidates, limits projected documents to 2,048 tokens, and caps the aggregate request at 65,792 tokens. It uses a pinned `lightonai/LateOn-Code-edge` revision with a 48-dimensional token projection. ([profile](../../packages/mcp/assets/lateon/runtime-profile-v4-d32.json))

Existing repository evidence is stronger than external model-card comparisons because it measures the actual Satori task shape. The historical D-L16 run improved macro MRR from 0.3602 to 0.4011 and owner@3 from 0.3722 to 0.4944. The later D32 tuning suite reported MRR 0.5046 versus 0.2900 baseline and owner@3 0.6389 versus 0.3611, but the repository explicitly records that D32 held-out quality remains unproven. ([D-L16 receipt](../evidence/lateon-runtime-profile-20260730/LATEON_RUNTIME_PROFILE_RECEIPT.md), )

## Recommended experiment

Run two isolated replacement tracks against the same frozen candidate pool and projection-v4 bytes:

1. Late-interaction track: current LateOn D32 versus Edge-ColBERT 17M, then 32M only if 17M is operationally viable.
2. Cross-encoder track: current LateOn D32 versus Ettin 32M, with Ettin 17M as a footprint control.

For each track, freeze model revision, tokenizer, projection, candidate depth, scoring/tie policy, and runtime settings. Measure at least owner-at-1/3/5, macro MRR, hard-negative exposure, exact-identifier cases, candidate survival, p50/p95 latency, model-load time, peak/retained RSS, deadline failures, cancellation, deterministic tie behavior, and fallback identity. Open held-out tasks only after the operational profile is frozen.

Test a cascade only after a sole-reranker experiment passes. A cascade can improve final ordering only among candidates that survive its admission cutoff; it cannot recover an owner removed by the earlier stage and it introduces a second ranking authority that must be explicitly coordinated and identified.

## Unknowns that require measurement

- None of the external cards reports Satori-style code-owner ranking with projection-v4 structural context.
- Public latency numbers are not comparable with Satori's Linux x64/WSL2 CPU runtime.
- Published ONNX artifacts make a prototype plausible but do not prove compatibility with Satori's pinned tokenizer/ONNX Runtime versions or output validation contract.
- General English benchmark gains may reverse on source code, configuration, generated contracts, or exact-identifier queries.
- The current D32 default itself lacks held-out quality proof, so candidate evaluation must include a true held-out gate rather than compare only against tuning tasks.
