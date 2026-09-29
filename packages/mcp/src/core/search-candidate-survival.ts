import type {
    SemanticSearchCandidateTrace,
    SemanticSearchCandidateTraceOccurrence,
} from "@satori-code/core";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import type {
    SearchCandidateSurvivalDebug,
    SearchCandidateSurvivalOccurrence,
    SearchCandidateSurvivalRemoval,
    SearchCandidateSurvivalStageName,
    SearchGroupResult,
} from "./search-types.js";
import { SEARCH_MAX_DIAGNOSTIC_CANDIDATES } from "./search-constants.js";
import { isDeclarationSearchGroup } from "./search-group-ordering.js";

export const SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE = SEARCH_MAX_DIAGNOSTIC_CANDIDATES;
export const SEARCH_CANDIDATE_SURVIVAL_MAX_REMOVAL_ENTRIES =
    SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE * 2;

type CandidateIdentityInput = {
    candidateId?: unknown;
    relativePath: string;
    startLine?: number | null;
    endLine?: number | null;
    language?: string | null;
    ownerSymbolInstanceId?: unknown;
};

type TraceableCandidate = {
    result: SearchResultLike;
    fusionScore?: number;
    finalScore?: number;
};

export function searchCandidateIdentity(result: CandidateIdentityInput): {
    candidateId: string;
    candidateIdKind: "persisted" | "derived";
} {
    if (typeof result.candidateId === "string" && result.candidateId.length > 0) {
        return { candidateId: result.candidateId, candidateIdKind: "persisted" };
    }
    return {
        candidateId: `derived:${JSON.stringify([
            result.relativePath,
            result.startLine,
            result.endLine,
            result.language || "unknown",
        ])}`,
        candidateIdKind: "derived",
    };
}

function searchOwnerIdentity(result: CandidateIdentityInput): string {
    return typeof result.ownerSymbolInstanceId === "string" && result.ownerSymbolInstanceId.length > 0
        ? JSON.stringify(["symbol", result.relativePath, result.ownerSymbolInstanceId])
        : JSON.stringify(["file", result.relativePath]);
}

function candidateScoreForStage(
    candidate: TraceableCandidate,
    stage: SearchCandidateSurvivalStageName,
): number | undefined {
    if (stage === "mcp_fusion" && Number.isFinite(candidate.fusionScore)) {
        return candidate.fusionScore;
    }
    if (Number.isFinite(candidate.finalScore)) return candidate.finalScore;
    return Number.isFinite(candidate.result.score) ? candidate.result.score : undefined;
}

function buildCandidateOccurrence(input: {
    candidate: TraceableCandidate;
    stage: SearchCandidateSurvivalStageName;
    rank: number;
    passId?: string;
}): SearchCandidateSurvivalOccurrence {
    const { candidateId, candidateIdKind } = searchCandidateIdentity(input.candidate.result);
    const score = candidateScoreForStage(input.candidate, input.stage);
    return {
        candidateId,
        candidateIdKind,
        ownerId: searchOwnerIdentity(input.candidate.result),
        evidenceOccurrenceId: JSON.stringify([
            candidateId,
            input.stage,
            input.passId ?? null,
            input.rank,
        ]),
        relativePath: input.candidate.result.relativePath,
        startLine: input.candidate.result.startLine ?? null,
        endLine: input.candidate.result.endLine ?? null,
        language: input.candidate.result.language || "unknown",
        rank: input.rank,
        ...(score !== undefined ? { score } : {}),
        ...(input.passId ? { passId: input.passId } : {}),
    };
}

function appendStage(
    trace: SearchCandidateSurvivalDebug,
    input: {
        stage: SearchCandidateSurvivalStageName;
        occurrences: SearchCandidateSurvivalOccurrence[];
        totalOccurrences?: number;
        uniqueCandidates?: number;
        passId?: string;
        weight?: number;
    },
): void {
    const totalOccurrences = input.totalOccurrences ?? input.occurrences.length;
    const candidates = input.occurrences.slice(0, trace.maxEntriesPerStage);
    trace.stages.push({
        stage: input.stage,
        ...(input.passId ? { passId: input.passId } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        totalOccurrences,
        uniqueCandidates: input.uniqueCandidates
            ?? new Set(input.occurrences.map((candidate) => candidate.candidateId)).size,
        omittedOccurrences: Math.max(0, totalOccurrences - candidates.length),
        candidates,
    });
}

export function createSearchCandidateSurvivalTrace(): SearchCandidateSurvivalDebug {
    return {
        schemaVersion: "search_candidate_survival_v4",
        orderAuthority: "retrieval_then_validated_reranker",
        maxEntriesPerStage: SEARCH_CANDIDATE_SURVIVAL_MAX_ENTRIES_PER_STAGE,
        maxRemovalEntries: SEARCH_CANDIDATE_SURVIVAL_MAX_REMOVAL_ENTRIES,
        corePasses: [],
        queryEmbeddings: [],
        lexicalRequests: [],
        diagnosticRetrievals: [],
        stages: [],
        removals: [],
        omittedRemovals: 0,
    };
}

export function appendCoreCandidateTrace(
    trace: SearchCandidateSurvivalDebug,
    passId: string,
    coreTrace: SemanticSearchCandidateTrace,
): void {
    trace.corePasses.push({
        passId,
        productCandidateLimit: coreTrace.productCandidateLimit,
    });
    trace.queryEmbeddings.push({
        passId,
        sha256: coreTrace.queryEmbeddingSha256,
    });
    for (const lexicalRequest of coreTrace.lexicalRequests) {
        trace.lexicalRequests.push({
            passId,
            ...lexicalRequest,
        });
    }
    trace.diagnosticRetrievals ??= [];
    for (const diagnosticRetrieval of coreTrace.diagnosticRetrievals ?? []) {
        trace.diagnosticRetrievals.push({
            passId,
            ...diagnosticRetrieval,
        });
    }
    const mapOccurrence = (
        occurrence: SemanticSearchCandidateTraceOccurrence,
    ): SearchCandidateSurvivalOccurrence => ({
        ...occurrence,
        candidateIdKind: "persisted",
        passId,
        evidenceOccurrenceId: JSON.stringify([
            occurrence.candidateId,
            occurrence.evidenceOccurrenceId,
            passId,
        ]),
    });
    for (const stage of coreTrace.stages) {
        appendStage(trace, {
            stage: stage.stage,
            passId,
            totalOccurrences: stage.totalOccurrences,
            uniqueCandidates: stage.uniqueCandidates,
            occurrences: stage.candidates.map(mapOccurrence),
        });
    }
    for (const removal of coreTrace.removals) {
        appendSearchCandidateRemoval(trace, {
            candidateId: removal.candidateId,
            afterStage: removal.afterStage,
            reason: removal.reason,
            passId,
        });
    }
    trace.omittedRemovals += coreTrace.omittedRemovals;
}

export function appendSearchCandidateStage(
    trace: SearchCandidateSurvivalDebug,
    stage: SearchCandidateSurvivalStageName,
    candidates: readonly TraceableCandidate[],
    passId?: string,
    occurrenceMetadata?: ReadonlyMap<
        string,
        NonNullable<SearchCandidateSurvivalOccurrence["rerankInput"]>
    >,
): void {
    appendStage(trace, {
        stage,
        ...(passId ? { passId } : {}),
        totalOccurrences: candidates.length,
        occurrences: candidates.map((candidate, index) => {
            const occurrence = buildCandidateOccurrence({
                candidate,
                stage,
                rank: index + 1,
                ...(passId ? { passId } : {}),
            });
            const metadata = occurrenceMetadata?.get(occurrence.candidateId);
            return metadata ? { ...occurrence, rerankInput: metadata } : occurrence;
        }),
    });
}

export function appendSearchCandidatePass(
    trace: SearchCandidateSurvivalDebug,
    results: readonly SearchResultLike[],
    passId: string,
    weight: number,
): void {
    if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error("Candidate-survival pass weight must be a positive finite number.");
    }
    appendStage(trace, {
        stage: "mcp_pass",
        passId,
        weight,
        totalOccurrences: results.length,
        occurrences: results.map((result, index) => buildCandidateOccurrence({
            candidate: { result },
            stage: "mcp_pass",
            rank: index + 1,
            passId,
        })),
    });
}

export function appendGroupedCandidateStage(
    trace: SearchCandidateSurvivalDebug,
    stage: "grouped" | "disclosed",
    groups: readonly SearchGroupResult[],
): void {
    const occurrences = groups.flatMap((group, groupIndex) => {
        const ownerId = group.target.symbolId
            ? JSON.stringify(["symbol", group.target.file, group.target.symbolId])
            : JSON.stringify(["file", group.target.file]);
        return group.__candidateIds.map((candidateId, candidateIndex) => ({
            candidateId,
            candidateIdKind: candidateId.startsWith("registry:")
                ? "registry" as const
                : candidateId.startsWith("derived:")
                    ? "derived" as const
                    : "persisted" as const,
            ownerId,
            evidenceOccurrenceId: JSON.stringify([candidateId, stage, groupIndex + 1, candidateIndex + 1]),
            relativePath: group.target.file,
            startLine: group.target.span.startLine,
            endLine: group.target.span.endLine,
            language: group.language,
            rank: groupIndex + 1,
            groupReplay: {
                displayLabel: group.displayLabel,
                symbolKind: group.symbolKind ?? null,
                declarationLike: isDeclarationSearchGroup(group),
                exactLexicalMatch: group.__exactLexicalMatch,
                symbolKey: group.__symbolKey ?? null,
                symbolInstanceId: group.__symbolInstanceId ?? null,
            },
        }));
    });
    appendStage(trace, { stage, occurrences });
}

export function appendSearchCandidateRemoval(
    trace: SearchCandidateSurvivalDebug,
    removal: SearchCandidateSurvivalRemoval,
): void {
    if (trace.removals.some((existing) => (
        existing.candidateId === removal.candidateId
        && existing.afterStage === removal.afterStage
        && existing.reason === removal.reason
        && existing.passId === removal.passId
    ))) {
        return;
    }
    if (trace.removals.length >= trace.maxRemovalEntries) {
        trace.omittedRemovals += 1;
        return;
    }
    trace.removals.push(removal);
}
