import { SEARCH_RRF_K } from "./search-constants.js";
import { isNonProductionDistractor } from "./search-non-production-path.js";
import type { SearchCandidate } from "./search-execution.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";

// Multiplier applied to the RRF contribution of a result from a
// non-production path when path demotion is eligible for the request.
const NON_PRODUCTION_PATH_MULTIPLIER = 0.7;

// Chunk identity used to merge per-pass results into one candidate.
function chunkKeyForResult(result: SearchResultLike): string {
    return `${result.relativePath}:${result.startLine}:${result.endLine}:${result.language || "unknown"}`;
}

function normalizedPathForResult(relativePath: string): string {
    return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function backendScoreKindForResult(result: SearchResultLike): SearchCandidate["backendScoreKind"] {
    return typeof result.backendScoreKind === "string"
        ? result.backendScoreKind as SearchCandidate["backendScoreKind"]
        : "unknown";
}

function backendScoreForResult(result: SearchResultLike): number {
    return typeof result.backendScore === "number"
        ? result.backendScore
        : (typeof result.score === "number" ? result.score : 0);
}

// Candidate construction shared by fusion and file-symbol supplements.
export function createCandidate(
    result: SearchResultLike,
    fusionScore: number,
    retrievalPasses: string[],
): SearchCandidate {
    const backendScoreKind = backendScoreKindForResult(result);
    const backendScore = backendScoreForResult(result);
    return {
        result,
        baseScore: backendScore,
        backendScore,
        backendScoreKind,
        backendScoreKindsSeen: [backendScoreKind],
        fusionScore,
        lexicalScore: 0,
        finalScore: 0,
        pathCategory: "neutral",
        pathMultiplier: 1.0,
        changedFilesMultiplier: 1.0,
        agentFitMultiplier: 1,
        agentFitReason: "neutral",
        entrypointOwnerScoreBoost: 0,
        entrypointOwnerScoreReason: "not_applicable",
        passesMatchedMust: false,
        exactLexicalMatch: false,
        exactMatchPinned: false,
        rerankAdjusted: false,
        authoritativeRank: 0,
        retrievalPasses,
    };
}

// One retrieval pass fused into the per-attempt candidate map.
export type SearchCandidateFusionPass = {
    id: string;
    results: SearchResultLike[];
    weight?: number;
};

// Values the fusion loop reads from execution state. The sets are mutated
// in encounter order; the caller records the returned suppressions.
export type SearchCandidateFusionPolicy = {
    // `boolean | undefined` mirrors the flag lookup the closure read;
    // only truthiness is used.
    pathDemotionEligible: boolean | undefined;
    isTrueExpansionPass: boolean;
    dirtyFilesNotFreshened: boolean;
    // Dirty paths whose current source the overlay re-read; only these drop
    // indexed results.
    rereadDirtyPaths: ReadonlySet<string>;
    suppressedDirtyPaths: Set<string>;
    representedDirtyPaths: Set<string>;
    backendScoreKinds: Set<SearchCandidate["backendScoreKind"]>;
};

// Suppressed dirty-path results in encounter order, for the caller to trace.
export type SearchCandidateFusionOutcome = {
    suppressedDirtyResults: SearchResultLike[];
};

// Pure fusion of one pass: RRF plus dirty-suppression, no I/O or tracing.
export function fuseCandidateSets(
    byChunkKey: Map<string, SearchCandidate>,
    pass: SearchCandidateFusionPass,
    policy: SearchCandidateFusionPolicy,
): SearchCandidateFusionOutcome {
    const suppressedDirtyResults: SearchResultLike[] = [];
    const passWeight = pass.weight ?? 1;
    const results = pass.results;
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result || typeof result.relativePath !== "string") continue;
        const normalizedResultPath = normalizedPathForResult(result.relativePath);
        if (
            policy.dirtyFilesNotFreshened
            && pass.id !== "dirty_overlay"
            && policy.rereadDirtyPaths.has(normalizedResultPath)
        ) {
            policy.suppressedDirtyPaths.add(normalizedResultPath);
            suppressedDirtyResults.push(result);
            continue;
        }
        if (pass.id === "dirty_overlay") {
            policy.representedDirtyPaths.add(normalizedResultPath);
        }
        const key = chunkKeyForResult(result);
        const rank = i + 1;
        const pathMult = (policy.pathDemotionEligible && isNonProductionDistractor(result.relativePath))
            ? NON_PRODUCTION_PATH_MULTIPLIER
            : 1.0;
        const rrf = passWeight * (1 / (SEARCH_RRF_K + rank)) * pathMult;
        const existing = byChunkKey.get(key);
        if (!existing) {
            const backendScoreKind = backendScoreKindForResult(result);
            policy.backendScoreKinds.add(backendScoreKind);
            const candidate = createCandidate(result, rrf, [pass.id]);
            candidate.pathMultiplier = pathMult;
            byChunkKey.set(key, candidate);
        } else {
            const semanticPassDuplicate = (
                !policy.isTrueExpansionPass
                && (pass.id === "primary" || pass.id === "expanded")
                && existing.retrievalPasses.some((existingPassId) => (
                    existingPassId === "primary" || existingPassId === "expanded"
                ))
            );
            existing.fusionScore = semanticPassDuplicate
                ? Math.max(existing.fusionScore, rrf)
                : existing.fusionScore + rrf;
            if (pathMult < existing.pathMultiplier) {
                existing.pathMultiplier = pathMult;
            }
            const nextScore = typeof result.backendScore === "number"
                ? result.backendScore
                : (typeof result.score === "number" ? result.score : undefined);
            if (typeof nextScore === "number") {
                existing.baseScore = Math.max(existing.baseScore, nextScore);
                existing.backendScore = Math.max(existing.backendScore, nextScore);
            }
            if (typeof result.backendScoreKind === "string") {
                policy.backendScoreKinds.add(result.backendScoreKind as SearchCandidate["backendScoreKind"]);
                if (!existing.backendScoreKindsSeen.includes(result.backendScoreKind as SearchCandidate["backendScoreKind"])) {
                    existing.backendScoreKindsSeen.push(result.backendScoreKind as SearchCandidate["backendScoreKind"]);
                }
            }
            if (!existing.retrievalPasses.includes(pass.id)) {
                existing.retrievalPasses.push(pass.id);
            }
        }
    }
    return { suppressedDirtyResults };
}
