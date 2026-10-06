import type {
    RerankResult,
} from "@satori-code/core";
import {
    RerankerRequestError,
    type RerankerFailureKind,
} from "@satori-code/core";
import {
    SEARCH_RERANK_DOC_MAX_CHARS,
    SEARCH_RERANK_DOC_MAX_LINES,
    SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
} from "./search-constants.js";
import type {
    SearchCandidateSurvivalDebug,
    SearchCandidateSurvivalOccurrence,
    SearchRerankProjectionSummary,
    SearchRerankerOperationalReason,
} from "./search-types.js";
import { allowsDefinitionDiscovery, fuseDefinitionDiscovery } from "./search-definition-discovery.js";
import type { SearchOrderAuthority } from "./search-order-policy.js";
import {
    appendSearchCandidateRemoval,
    appendSearchCandidateStage,
    searchCandidateIdentity,
} from "./search-candidate-survival.js";
import { WARNING_CODES, type WarningCode } from "./warnings.js";
import {
    preferImplementationCandidates,
} from "./search-ranking-policy.js";
import type { SearchQueryPlan, SearchResultLike } from "./search-lexical-scoring.js";
import { splitIdentifierComponents } from "./search-symbol-metadata-bm25.js";
import {
    selectRerankCandidates,
    selectRerankInputWithinUtf8Budget,
    shouldCallRerankerForProjectedCandidateCount,
    type RerankBudgetReason,
} from "./search-rerank-policy.js";
import {
    applyNativeRerankToSelectedSlots,
    validateNativeRerankResults,
} from "./search-native-rerank.js";
import { resolveRerankBoundary, type RerankBoundaryDecision } from "./search-rerank-boundary.js";
import { extractIdentifierFromSymbolLabel } from "./search-response-helpers.js";
import type {
    SearchRerankProjectionFailureReason,
    SearchRerankProjectionResult,
    SearchRerankStructuralContextStatus,
} from "./search-rerank-projection-result.js";
import { resolveSearchFlags } from "./search-flags.js";
import { resolveSearchAltTerms } from "./search-expansion-terms.js";
import type {
    SearchCandidate,
    SearchDiagnostics,
    SearchExecutionHost,
    SearchExecutionInput,
} from "./search-execution.js";

export type RerankPhaseResult = {
    exactMatchPinningApplied: boolean;
    rerankerAttempted: boolean;
    rerankerApplied: boolean;
    orderAuthority: SearchOrderAuthority;
    skippedByExactPin: boolean;
    rerankerFailurePhase?: 'document_projection' | 'api_call' | 'parse_results';
    rerankerOperationalReason?: SearchRerankerOperationalReason;
    rerankerCandidatesIn: number;
    rerankerCandidatesReranked: number;
    rerankerFamilyCount: number;
    rerankerSupplementalCandidates: number;
    rerankerCandidatePoolCount: number;
    rerankerCandidateBudget: number;
    rerankerBudgetReason?: RerankBudgetReason;
    rerankerByteBudgetOmittedCandidates: number;
    warnings: WarningCode[];
    projection?: SearchRerankProjectionSummary;
    rerankerFailureKind?: RerankerFailureKind;
};

type RerankFailurePhase = 'document_projection' | 'api_call' | 'parse_results';

export type RerankInputStats = {
    rerankerFamilyCount: number;
    rerankerSupplementalCandidates: number;
    rerankerCandidatePoolCount: number;
    rerankerCandidateBudget: number;
    rerankerBudgetReason: RerankBudgetReason | undefined;
};

export type BuildRerankInputResult = RerankInputStats & {
    rerankerByteBudgetOmittedCandidates: number;
    warnings: WarningCode[];
    projection: SearchRerankProjectionSummary | undefined;
    /** Null when fewer than two safe documents remain: keep retrieval order. */
    ready: {
        rerankSlice: SearchCandidate[];
        rerankDocuments: string[];
        byteBudgetOmittedCandidates: SearchCandidate[];
        byteSelectionInputBytes: number;
        rerankInputMetadata: ReadonlyMap<
            string,
            NonNullable<SearchCandidateSurvivalOccurrence["rerankInput"]>
        > | undefined;
    } | null;
};

// Internal control flow: carries the failure phase plus whatever stats,
// warnings and projection the phase had recorded to the orchestrator catch,
// which counts the failure exactly once.
export class RerankPhaseFailure extends Error {
    readonly phase: RerankFailurePhase | undefined;
    readonly operationalReason?: SearchRerankerOperationalReason;
    stats?: RerankInputStats;
    byteBudgetOmittedCandidates?: number;
    warnings?: WarningCode[];
    projection?: SearchRerankProjectionSummary;
    constructor(
        phase: RerankFailurePhase | undefined,
        message: string,
        options?: {
            cause?: unknown;
            operationalReason?: SearchRerankerOperationalReason;
            stats?: RerankInputStats;
            byteBudgetOmittedCandidates?: number;
            warnings?: WarningCode[];
            projection?: SearchRerankProjectionSummary;
        },
    ) {
        super(message, options ? { cause: options.cause } : undefined);
        this.phase = phase;
        this.operationalReason = options?.operationalReason;
        this.stats = options?.stats;
        this.byteBudgetOmittedCandidates = options?.byteBudgetOmittedCandidates;
        this.warnings = options?.warnings;
        this.projection = options?.projection;
    }
}

const LATEON_OPERATIONAL_REASONS = new Set<SearchRerankerOperationalReason>([
    "lateon_not_ready",
    "lateon_execution_timeout",
    "lateon_cancelled",
    "lateon_invalid_output",
    "lateon_worker_failure",
]);

function resolveLateOnOperationalReason(error: unknown): SearchRerankerOperationalReason | undefined {
    if (!error || typeof error !== "object" || !("reason" in error)) return undefined;
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string"
        && LATEON_OPERATIONAL_REASONS.has(reason as SearchRerankerOperationalReason)
        ? reason as SearchRerankerOperationalReason
        : undefined;
}

function assignAuthoritativeRanks(candidates: SearchCandidate[]): void {
    for (let index = 0; index < candidates.length; index += 1) {
        candidates[index]!.authoritativeRank = index + 1;
    }
}

/**
 * Plain rerank document for providers that do not receive the publication-bound
 * canonical projection (native rerankers). This is an unversioned provider
 * document, not a document projection: no projection policy or identity
 * attaches to it.
 */
function buildNativeProviderRerankDocument(result: SearchResultLike): string {
    const relativePath = typeof result?.relativePath === "string"
        ? result.relativePath
        : "";
    const language = typeof result?.language === "string"
        ? result.language
        : "unknown";
    const symbolLabel = typeof result?.symbolLabel === "string"
        ? result.symbolLabel
        : "";
    const content = typeof result?.content === "string" ? result.content : "";
    const contentLines = content.split(/\r?\n/).slice(0, SEARCH_RERANK_DOC_MAX_LINES);
    let normalizedContent = contentLines.join("\n");
    if (normalizedContent.length > SEARCH_RERANK_DOC_MAX_CHARS) {
        normalizedContent = normalizedContent.slice(0, SEARCH_RERANK_DOC_MAX_CHARS);
    }
    return `${relativePath}\n${language}\n${symbolLabel}\n${normalizedContent}`;
}

export async function buildRerankInput(args: {
    input: SearchExecutionInput;
    host: SearchExecutionHost;
    scored: SearchCandidate[];
    rerankBoundary: RerankBoundaryDecision;
    candidateSurvival?: SearchCandidateSurvivalDebug;
}): Promise<BuildRerankInputResult> {
    const { input, host, scored, rerankBoundary, candidateSurvival } = args;
    const rerankInputCandidates = rerankBoundary.kind === "rerank"
        ? scored.slice(rerankBoundary.startIndex)
        : [];
    const selection = selectRerankCandidates({
        candidates: rerankInputCandidates,
        preferredCandidates: rerankInputCandidates.filter((candidate) => (
            candidate.retrievalPasses.includes("file_symbols")
        )),
        requestedLimit: input.retrievalPolicy.rerankerResultLimit,
        providerMaximumDocuments: host.reranker?.getMaxDocuments?.(),
    });
    const stats: RerankInputStats = {
        rerankerFamilyCount: selection.familyCount,
        rerankerSupplementalCandidates: selection.supplementalCandidateCount,
        rerankerCandidatePoolCount: selection.candidatePoolCount,
        rerankerCandidateBudget: selection.budget,
        rerankerBudgetReason: selection.budgetReason,
    };
    const warnings: WarningCode[] = [];
    let projection: SearchRerankProjectionSummary | undefined;
    let rerankerByteBudgetOmittedCandidates = 0;
    try {
        const providerBoundedSelection = selection.selected;
        let rerankSlice: SearchCandidate[];
        let rerankDocuments: string[];
        let byteBudgetOmittedCandidatesList: SearchCandidate[];
        let byteSelectionInputBytes = 0;
        let rerankInputMetadataMap: ReadonlyMap<
            string,
            NonNullable<SearchCandidateSurvivalOccurrence["rerankInput"]>
        > | undefined;
        if (host.buildRerankDocument) {
            const buildProjection = host.buildRerankDocument;
            const projectionRows = await Promise.all(providerBoundedSelection.map(async (candidate) => ({
                candidate,
                projection: await buildProjection(input.semanticQuery, candidate.result),
            })));
            const failureCounts: Partial<Record<SearchRerankProjectionFailureReason, number>> = {};
            let firstFailure: SearchRerankProjectionSummary["firstFailure"];
            const structuralContextStatuses = new Set<SearchRerankStructuralContextStatus>();
            const failedCandidateIds: string[] = [];
            const projectableRows: Array<{
                candidate: SearchCandidate;
                projection: Extract<SearchRerankProjectionResult, { ok: true }>;
            }> = [];
            for (const row of projectionRows) {
                if (
                    row.projection.ok
                    && typeof row.projection.document === "string"
                    && row.projection.document.length > 0
                ) {
                    projectableRows.push({ candidate: row.candidate, projection: row.projection });
                    if (row.projection.structuralContextStatus !== undefined) {
                        structuralContextStatuses.add(row.projection.structuralContextStatus);
                    }
                    continue;
                }
                const reason: SearchRerankProjectionFailureReason = row.projection.ok
                    ? "projection_contract_failed"
                    : row.projection.reason;
                const failedCandidateId = row.projection.ok
                    ? searchCandidateIdentity(row.candidate.result).candidateId
                    : row.projection.candidateId;
                failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;
                failedCandidateIds.push(failedCandidateId);
                if (!firstFailure) {
                    firstFailure = { candidateId: failedCandidateId, reason };
                }
            }
            if (candidateSurvival) {
                for (const failedCandidateId of failedCandidateIds) {
                    appendSearchCandidateRemoval(candidateSurvival, {
                        candidateId: failedCandidateId,
                        afterStage: "mcp_ranked",
                        reason: "reranker_document_projection_failed",
                    });
                }
            }
            const structuralContextStatus: SearchRerankStructuralContextStatus | undefined
                = structuralContextStatuses.has("incompatible")
                    ? "incompatible"
                    : structuralContextStatuses.has("unavailable")
                        ? "unavailable"
                        : structuralContextStatuses.has("available")
                            ? "available"
                            : undefined;
            projection = {
                requestedCandidates: providerBoundedSelection.length,
                projectedCandidates: projectableRows.length,
                skippedCandidates: providerBoundedSelection.length - projectableRows.length,
                failureCounts,
                ...(firstFailure ? { firstFailure } : {}),
                ...(structuralContextStatus ? { structuralContextStatus } : {}),
            };
            if (structuralContextStatus === "incompatible") {
                warnings.push(WARNING_CODES.RERANKER_CONTEXT_DEGRADED);
            }
            if (!shouldCallRerankerForProjectedCandidateCount(projectableRows.length)) {
                // Fewer than two safe documents remain: skip the provider
                // and preserve retrieval order without counting a
                // provider failure.
                warnings.push(WARNING_CODES.RERANKER_SKIPPED_INPUT);
                if (candidateSurvival) {
                    for (const row of projectableRows) {
                        appendSearchCandidateRemoval(candidateSurvival, {
                            candidateId: searchCandidateIdentity(row.candidate.result).candidateId,
                            afterStage: "mcp_ranked",
                            reason: "reranker_input_insufficient",
                        });
                    }
                }
                return { ...stats, rerankerByteBudgetOmittedCandidates, warnings, projection, ready: null };
            }
            if (projectableRows.length < providerBoundedSelection.length) {
                warnings.push(WARNING_CODES.RERANKER_INPUT_DEGRADED);
            }
            const projectableCandidates = projectableRows.map((row) => row.candidate);
            const byteSelection = selectRerankInputWithinUtf8Budget({
                candidates: projectableCandidates,
                documents: projectableRows.map((row) => row.projection.document),
                maxInputBytes: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
            });
            rerankSlice = [...byteSelection.candidates];
            rerankDocuments = [...byteSelection.documents];
            byteBudgetOmittedCandidatesList = projectableCandidates.slice(byteSelection.candidates.length);
            byteSelectionInputBytes = byteSelection.inputBytes;
            rerankerByteBudgetOmittedCandidates = byteSelection.omittedCandidateCount;
            rerankInputMetadataMap = new Map(
                rerankSlice.map((candidate, index) => {
                    const row = projectableRows[index]!;
                    return [
                        searchCandidateIdentity(candidate.result).candidateId,
                        {
                            documentUtf8Bytes: row.projection.utf8Bytes,
                            documentSha256: row.projection.sha256,
                            candidateRole: row.projection.candidateRole,
                            answerFocus: input.answerFocus,
                            projectionIdentity: row.projection.projectionIdentity,
                            queryProjectionIdentity: input.rerankQueryProjectionIdentity,
                        },
                    ] as const;
                }),
            );
        } else {
            let selectedDocuments: string[];
            try {
                selectedDocuments = await Promise.all(providerBoundedSelection.map(async (candidate) => {
                    const document = buildNativeProviderRerankDocument(candidate.result);
                    if (typeof document !== "string" || document.length === 0) {
                        throw new Error("reranker_document_projection_unavailable");
                    }
                    return document;
                }));
            } catch {
                throw new RerankPhaseFailure(
                    "document_projection",
                    "reranker_document_projection_failed",
                    { stats },
                );
            }
            const byteSelection = selectRerankInputWithinUtf8Budget({
                candidates: providerBoundedSelection,
                documents: selectedDocuments,
                maxInputBytes: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
            });
            rerankSlice = [...byteSelection.candidates];
            rerankDocuments = [...byteSelection.documents];
            byteBudgetOmittedCandidatesList = providerBoundedSelection.slice(byteSelection.candidates.length);
            byteSelectionInputBytes = byteSelection.inputBytes;
            rerankerByteBudgetOmittedCandidates = byteSelection.omittedCandidateCount;
        }
        return {
            ...stats,
            rerankerByteBudgetOmittedCandidates,
            warnings,
            projection,
            ready: {
                rerankSlice,
                rerankDocuments,
                byteBudgetOmittedCandidates: byteBudgetOmittedCandidatesList,
                byteSelectionInputBytes,
                rerankInputMetadata: rerankInputMetadataMap,
            },
        };
    } catch (error) {
        if (error instanceof RerankPhaseFailure) throw error;
        throw new RerankPhaseFailure(undefined, "reranker_rerank_input_failed", {
            cause: error,
            stats,
            byteBudgetOmittedCandidates: rerankerByteBudgetOmittedCandidates,
            warnings,
            projection,
        });
    }
}

export async function invokeReranker(args: {
    host: SearchExecutionHost;
    rerankQuery: string;
    signal?: AbortSignal;
    rerankSlice: SearchCandidate[];
    rerankDocuments: string[];
    byteSelectionInputBytes: number;
    searchDiagnostics: SearchDiagnostics;
}): Promise<RerankResult[]> {
    const { host, rerankQuery, signal, rerankSlice, rerankDocuments, byteSelectionInputBytes, searchDiagnostics } = args;
    searchDiagnostics.rerankerCalls += 1;
    searchDiagnostics.rerankerCandidates += rerankDocuments.length;
    searchDiagnostics.rerankerInputBytes += byteSelectionInputBytes;
    let rerankResults: RerankResult[];
    let rerankerExecutionDiagnosticsObserved = false;
    try {
        rerankResults = await host.measureSearchPhase(
            'rerank',
            () => host.reranker!.rerank(rerankQuery, rerankDocuments, {
                topK: rerankSlice.length,
                truncation: true,
                ...(signal ? { signal } : {}),
                returnDocuments: false,
                identities: rerankSlice.map((candidate) => (
                    searchCandidateIdentity(candidate.result).candidateId
                )),
                // Execution telemetry fires on success and terminal
                // failure alike, so retries hidden by a later success
                // are still counted. Max-based so repeated reports
                // never lose a higher count.
                onExecutionDiagnostics: (diagnostics) => {
                    rerankerExecutionDiagnosticsObserved = true;
                    searchDiagnostics.rerankerExecutionDiagnostics = diagnostics;
                    searchDiagnostics.rerankerRetries = Math.max(
                        searchDiagnostics.rerankerRetries,
                        diagnostics.retries,
                    );
                    searchDiagnostics.rerankerTimeouts = Math.max(
                        searchDiagnostics.rerankerTimeouts,
                        diagnostics.timeouts,
                    );
                },
            }),
        );
    } catch (error) {
        const operationalReason = resolveLateOnOperationalReason(error);
        if (error instanceof RerankerRequestError) {
            searchDiagnostics.rerankerFailureKind = error.kind;
            if (!rerankerExecutionDiagnosticsObserved) {
                // Fallback for rerankers that throw RerankerRequestError
                // without reporting execution diagnostics: the terminal
                // error still carries attempt counts.
                searchDiagnostics.rerankerRetries = Math.max(
                    searchDiagnostics.rerankerRetries,
                    Math.max(0, error.attempts - 1),
                );
                if (error.kind === 'timeout') {
                    searchDiagnostics.rerankerTimeouts = Math.max(
                        searchDiagnostics.rerankerTimeouts,
                        1,
                    );
                }
            }
        }
        throw new RerankPhaseFailure('api_call', 'reranker_api_call_failed', { cause: error, operationalReason });
    }
    return rerankResults;
}

/**
 * Worst rank a strong first-stage owner may hold after reranking when the
 * first_stage_owner_floor flag is on. The floor never promotes above rank 3,
 * so it cannot steal rank 1 from a reranker-preferred owner.
 */
const FIRST_STAGE_OWNER_FLOOR_RANK = 3;

/** Minimum fraction of identifier sub-tokens covered by whole query terms. */
const STRONG_OWNER_QUERY_COVERAGE = 0.5;

/**
 * A strong first-stage owner declares a symbol whose identifier sub-tokens
 * are at least half covered by the query's whole lexical terms. File and
 * symbol-less candidates declare no identifier and are never strong.
 */
function isStrongFirstStageOwner(candidate: SearchCandidate, queryPlan: SearchQueryPlan): boolean {
    const identifier = extractIdentifierFromSymbolLabel(candidate.result.symbolLabel);
    if (!identifier) return false;
    const components = new Set(
        splitIdentifierComponents(identifier)
            .map((part) => part.toLowerCase())
            .filter((part) => part.length > 0),
    );
    if (components.size === 0) return false;
    const queryTerms = new Set(
        queryPlan.lexicalTerms
            .filter((term) => term.kind === "whole")
            .map((term) => term.value.toLowerCase()),
    );
    let covered = 0;
    for (const part of components) {
        if (queryTerms.has(part)) covered += 1;
    }
    return covered / components.size >= STRONG_OWNER_QUERY_COVERAGE;
}

export function applyRerankOrder(args: {
    input: SearchExecutionInput;
    host: SearchExecutionHost;
    scored: SearchCandidate[];
    rerankSlice: SearchCandidate[];
    rerankResults: RerankResult[];
    candidateSurvival?: SearchCandidateSurvivalDebug;
}): { rerankerApplied: boolean; orderAuthority: SearchOrderAuthority } {
    const { input, host, scored, rerankSlice, rerankResults, candidateSurvival } = args;
    let rerankerApplied: boolean;
    let orderAuthority: SearchOrderAuthority;
    try {
        if (!Array.isArray(rerankResults)) {
            throw new Error("reranker_result_malformed");
        }

        const selectedCandidateIds = rerankSlice.map((candidate) => (
            searchCandidateIdentity(candidate.result).candidateId
        ));
        const validatedItems = validateNativeRerankResults({
            candidateIds: selectedCandidateIds,
            results: rerankResults,
        });
        const executionFlags = resolveSearchFlags(input.flags);
        let itemsForPolicy = [...validatedItems];
        let definitionFusionApplied = false;
        if (allowsDefinitionDiscovery({
            enabled: executionFlags.definition_discovery === true,
            queryPlan: input.queryPlan,
            answerFocus: input.answerFocus,
            scope: input.scope,
            hasPathConstraint: input.parsedOperators.path.length > 0 || input.requestedSubdirectory != null,
            hasMustConstraint: input.parsedOperators.must.length > 0,
        }) && host.definitionMetadata) {
            const definitionAltTerms = executionFlags.definition_alt_terms
                ? (input.resolvedAltTerms ?? resolveSearchAltTerms(input.alt_terms)).termsEmitted : [];
            const fusion = fuseDefinitionDiscovery({
                items: validatedItems,
                query: [input.semanticQuery, ...definitionAltTerms].join(" "),
                metadata: index => host.definitionMetadata!(rerankSlice[index]!.result),
            });
            itemsForPolicy = fusion.items;
            definitionFusionApplied = fusion.applied;
        }
        if (executionFlags.rerank_blend && !definitionFusionApplied) {
            // originalIndex indexes rerankSlice, not the full fused pool,
            // so these are ranks WITHIN the rerank window. The blend
            // therefore weighs the provider rank against the candidate's
            // position in the slice the provider was handed, not its
            // position in the pool it was drawn from.
            itemsForPolicy.sort((a, b) => {
                const aSliceRank = a.originalIndex + 1;
                const bSliceRank = b.originalIndex + 1;
                const aBlend = 0.5 * a.providerRank + 0.5 * aSliceRank;
                const bBlend = 0.5 * b.providerRank + 0.5 * bSliceRank;
                if (aBlend !== bBlend) return aBlend - bBlend;
                return a.providerRank - b.providerRank;
            });
        }
        const effectiveRerankItems = preferImplementationCandidates({
            candidates: itemsForPolicy,
            relativePath: (item) => rerankSlice[item.originalIndex]!.result.relativePath,
            answerFocus: input.answerFocus,
            queryPlan: input.queryPlan,
            hasPathConstraint: input.parsedOperators.path.length > 0
                || input.requestedSubdirectory != null,
            neutralPrefersImplementation: executionFlags.neutral_owner_preference === true,
        });
        const reordered = applyNativeRerankToSelectedSlots({
            allCandidates: scored,
            selectedCandidateIds,
            orderedItems: effectiveRerankItems,
            identify: (candidate) => searchCandidateIdentity(candidate.result).candidateId,
        });
        // scored is still in first-stage order here: a pinned top candidate
        // kept its slot above, otherwise the top may have been buried by the
        // provider order. The floor only lifts a strong owner back to rank 3,
        // preserving the relative order of every other candidate.
        if (executionFlags.first_stage_owner_floor === true && scored.length > 0) {
            const firstStageTop = scored[0]!;
            const floorIndex = FIRST_STAGE_OWNER_FLOOR_RANK - 1;
            const topId = searchCandidateIdentity(firstStageTop.result).candidateId;
            const currentIndex = reordered.findIndex((candidate) => (
                searchCandidateIdentity(candidate.result).candidateId === topId
            ));
            if (
                currentIndex > floorIndex
                && isStrongFirstStageOwner(firstStageTop, input.queryPlan)
            ) {
                const [held] = reordered.splice(currentIndex, 1);
                reordered.splice(floorIndex, 0, held!);
            }
        }
        for (const item of validatedItems) {
            const candidate = rerankSlice[item.originalIndex]!;
            candidate.rerankerRank = item.providerRank;
            candidate.rerankerScore = item.relevanceScore;
            candidate.rerankAdjusted = true;
        }
        scored.splice(0, scored.length, ...reordered);
        orderAuthority = definitionFusionApplied ? "definition_fusion_order" : "reranker_order";
        rerankerApplied = validatedItems.length > 0;
        if (candidateSurvival) {
            appendSearchCandidateStage(
                candidateSurvival,
                "reranker_output",
                effectiveRerankItems.map((item) => rerankSlice[item.originalIndex]!),
            );
        }
    } catch (error) {
        if (error instanceof RerankPhaseFailure) throw error;
        throw new RerankPhaseFailure('parse_results', 'reranker_parse_failed', { cause: error });
    }
    return { rerankerApplied, orderAuthority };
}

export async function rerankSearchCandidates(
    input: SearchExecutionInput,
    host: SearchExecutionHost,
    searchDiagnostics: SearchDiagnostics,
    scored: SearchCandidate[],
    initialExactMatchPinningApplied: boolean,
    candidateSurvival?: SearchCandidateSurvivalDebug,
): Promise<RerankPhaseResult> {
    const rerankDecision = host.searchQuerySupport.resolveRerankDecision(input.scope, input.queryPlan);
    let exactMatchPinningApplied = initialExactMatchPinningApplied;
    let rerankerApplied = false;
    let rerankerAttempted = false;
    let orderAuthority: SearchOrderAuthority = "retrieval_order";
    let failurePhase: RerankFailurePhase | undefined;
    let rerankerOperationalReason: SearchRerankerOperationalReason | undefined;
    const lateOnProvider = (() => {
        try {
            return host.reranker?.getIdentity().provider === "lateon";
        } catch {
            return false;
        }
    })();
    const rerankerCandidatesIn = scored.length;
    let rerankerCandidatesReranked = 0;
    let rerankerFamilyCount = 0;
    let rerankerSupplementalCandidates = 0;
    let rerankerCandidatePoolCount = 0;
    let rerankerCandidateBudget = 0;
    let rerankerBudgetReason: RerankBudgetReason | undefined;
    let rerankerByteBudgetOmittedCandidates = 0;
    const phaseWarnings: WarningCode[] = [];
    let projectionSummary: SearchRerankProjectionSummary | undefined;
    // When the caller's identifier-shaped alt_terms name the symbol declared by
    // the first-stage #1 candidate, that candidate is the exact owner: pin it
    // ahead of the rerank slice. The match is whole-identifier and
    // case-sensitive, so a partial or case-differing term does not pin.
    // Automatic repository vocabulary resolves through the same field but is
    // not caller intent, so it must not pin the top candidate out of the
    // rerank slice.
    const callerAltTerms = (input.resolvedAltTerms ?? resolveSearchAltTerms(input.alt_terms)).termsEmitted;
    const pinEligible = input.repositoryVocabulary === undefined;
    const topOwnerIdentifier = scored.length > 0
        ? extractIdentifierFromSymbolLabel(scored[0]!.result.symbolLabel)
        : undefined;
    const rerankBoundary = resolveRerankBoundary({
        candidates: scored,
        exactMatchPinningEnabled: rerankDecision.exactMatchPinningEnabled,
        mustTokenCount: input.parsedOperators.must.length,
        altTermsNameTopOwner: pinEligible && topOwnerIdentifier !== undefined && callerAltTerms.includes(topOwnerIdentifier),
    });
    const skippedByExactPin = rerankBoundary.kind === "skip";
    const publicationOnlyStaleRead = input.freshnessMode === "served_previous_generation";
    if (rerankDecision.enabled && scored.length > 0 && host.reranker && !skippedByExactPin && !publicationOnlyStaleRead) {
        try {
            const build = await buildRerankInput({ input, host, scored, rerankBoundary, candidateSurvival });
            rerankerFamilyCount = build.rerankerFamilyCount;
            rerankerSupplementalCandidates = build.rerankerSupplementalCandidates;
            rerankerCandidatePoolCount = build.rerankerCandidatePoolCount;
            rerankerCandidateBudget = build.rerankerCandidateBudget;
            rerankerBudgetReason = build.rerankerBudgetReason;
            rerankerByteBudgetOmittedCandidates = build.rerankerByteBudgetOmittedCandidates;
            phaseWarnings.push(...build.warnings);
            projectionSummary = build.projection;
            if (build.ready === null) {
                return {
                    exactMatchPinningApplied,
                    rerankerAttempted,
                    rerankerApplied,
                    orderAuthority,
                    skippedByExactPin,
                    rerankerCandidatesIn,
                    rerankerCandidatesReranked,
                    rerankerFamilyCount,
                    rerankerSupplementalCandidates,
                    rerankerCandidatePoolCount,
                    rerankerCandidateBudget,
                    rerankerBudgetReason,
                    rerankerByteBudgetOmittedCandidates,
                    warnings: phaseWarnings,
                    projection: projectionSummary,
                };
            }
            const { rerankSlice, rerankDocuments } = build.ready;
            input.signal?.throwIfAborted();
            const rerankCount = rerankSlice.length;
            rerankerCandidatesReranked = rerankCount;
            if (candidateSurvival) {
                appendSearchCandidateStage(
                    candidateSurvival,
                    "reranker_input",
                    rerankSlice,
                    undefined,
                    build.ready.rerankInputMetadata,
                );
                for (const candidate of build.ready.byteBudgetOmittedCandidates) {
                    appendSearchCandidateRemoval(candidateSurvival, {
                        candidateId: searchCandidateIdentity(candidate.result).candidateId,
                        afterStage: "mcp_ranked",
                        reason: "reranker_input_byte_budget",
                    });
                }
            }
            if (rerankCount === 0) {
                return {
                    exactMatchPinningApplied,
                    rerankerAttempted,
                    rerankerApplied,
                    orderAuthority,
                    skippedByExactPin,
                    rerankerCandidatesIn,
                    rerankerCandidatesReranked,
                    rerankerFamilyCount,
                    rerankerSupplementalCandidates,
                    rerankerCandidatePoolCount,
                    rerankerCandidateBudget,
                    rerankerBudgetReason,
                    rerankerByteBudgetOmittedCandidates,
                    warnings: phaseWarnings,
                    ...(projectionSummary ? { projection: projectionSummary } : {}),
                };
            }
            rerankerAttempted = true;
            const rerankResults = await invokeReranker({
                host,
                rerankQuery: input.rerankQuery,
                signal: input.signal,
                rerankSlice,
                rerankDocuments,
                byteSelectionInputBytes: build.ready.byteSelectionInputBytes,
                searchDiagnostics,
            });
            const applied = applyRerankOrder({
                input,
                host,
                scored,
                rerankSlice,
                rerankResults,
                candidateSurvival,
            });
            rerankerApplied = applied.rerankerApplied;
            orderAuthority = applied.orderAuthority;
            if (rerankerApplied && lateOnProvider) {
                rerankerOperationalReason = "lateon_applied";
            }
        } catch (error) {
            // Cancellation is not a reranker failure: reject instead of
            // publishing the retrieval-order fallback.
            input.signal?.throwIfAborted();
            if (error instanceof RerankPhaseFailure) {
                failurePhase = error.phase;
                if (error.operationalReason !== undefined) {
                    rerankerOperationalReason = error.operationalReason;
                }
                if (error.stats) {
                    rerankerFamilyCount = error.stats.rerankerFamilyCount;
                    rerankerSupplementalCandidates = error.stats.rerankerSupplementalCandidates;
                    rerankerCandidatePoolCount = error.stats.rerankerCandidatePoolCount;
                    rerankerCandidateBudget = error.stats.rerankerCandidateBudget;
                    rerankerBudgetReason = error.stats.rerankerBudgetReason;
                }
                if (error.byteBudgetOmittedCandidates !== undefined) {
                    rerankerByteBudgetOmittedCandidates = error.byteBudgetOmittedCandidates;
                }
                if (error.warnings) {
                    phaseWarnings.push(...error.warnings);
                }
                if (error.projection !== undefined) {
                    projectionSummary = error.projection;
                }
            }
            failurePhase ??= 'parse_results';
            // Every terminal reranker failure -- api_call, document
            // projection, parse/invalid results -- counts exactly once here.
            searchDiagnostics.rerankerFailures += 1;
        }
    }

    assignAuthoritativeRanks(scored);
    return {
        exactMatchPinningApplied,
        rerankerAttempted,
        rerankerApplied,
        orderAuthority,
        skippedByExactPin,
        rerankerFailurePhase: failurePhase,
        rerankerOperationalReason,
        rerankerCandidatesIn,
        rerankerCandidatesReranked,
        rerankerFamilyCount,
        rerankerSupplementalCandidates,
        rerankerCandidatePoolCount,
        rerankerCandidateBudget,
        rerankerBudgetReason,
        rerankerByteBudgetOmittedCandidates,
        rerankerFailureKind: searchDiagnostics.rerankerFailureKind,
        warnings: failurePhase
            ? [...phaseWarnings, WARNING_CODES.RERANKER_FAILED]
            : phaseWarnings,
        ...(projectionSummary ? { projection: projectionSummary } : {}),
    };
}
