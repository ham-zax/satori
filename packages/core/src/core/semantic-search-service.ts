import * as crypto from 'crypto';
import type {
    Embedding,
    EmbeddingVector,
} from '../embedding';
import type {
    SemanticSearchCandidateTrace,
    SemanticSearchCandidateTraceOccurrence,
    SemanticSearchDiagnosticRetrieval,
    SemanticSearchCandidateTraceOptions,
    SemanticSearchCandidateTraceStage,
    SemanticSearchCandidateTraceStageName,
    SemanticSearchExecutionResult,
    SemanticSearchRequest,
    SemanticSearchResult,
} from '../types';
import type {
    RetrievalMode,
    ScorePolicy,
    VectorCandidate,
    VectorDatabase,
    VectorFilter,
} from '../vectordb';
import { validateVectorFilter } from '../vectordb/filters';
import { compareContractStrings } from '../utils/compare-contract-strings';
import {
    fuseVectorCandidatesWithRrf,
    orderVectorCandidateArm,
    vectorCandidateOwnerId,
    VECTOR_CANDIDATE_RRF_K_V1,
} from './vector-candidate-fusion';

const MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE = 160;

export type MutationGenerationObservation = Readonly<{
    generation: number;
    mutationActive: boolean;
}>;

export type MutationGenerationObserver = (
    canonicalRoot: string,
) => MutationGenerationObservation;

type SearchGenerationReceipt = Readonly<{
    collectionName: string;
}>;

type SemanticSearchAuthority<Receipt extends SearchGenerationReceipt> = Readonly<{
    proveVectorGeneration: (codebasePath: string) => Promise<Receipt | null>;
    revalidateProvenVectorGeneration: (
        codebasePath: string,
        receipt: Receipt,
    ) => Promise<Receipt | null>;
    isPreparedReceiptBoundToCurrentAuthority: (
        codebasePath: string,
        receipt: Receipt,
    ) => boolean;
}>;

type EmbeddingAccess = Readonly<{
    getEmbedding: () => Embedding;
    assertEmbeddingIdentityCurrent: () => void;
}>;

type SemanticSearchServiceConfig<Receipt extends SearchGenerationReceipt> = Readonly<{
    getVectorDatabase: () => VectorDatabase;
    embeddingAccess: EmbeddingAccess;
    authority: SemanticSearchAuthority<Receipt>;
    isHybridEnabled: () => boolean;
    canonicalizeCodebasePath: (codebasePath: string) => string;
    mutationGenerationObserver?: MutationGenerationObserver;
}>;

function buildSemanticSearchTraceStage(
    stage: SemanticSearchCandidateTraceStageName,
    candidates: readonly VectorCandidate[],
    maxEntries: number,
): SemanticSearchCandidateTraceStage {
    const ordered = stage === 'raw_dense'
        || stage === 'raw_lexical'
        || stage === 'raw_lexical_fallback'
        || stage === 'diagnostic_dense'
        || stage === 'diagnostic_lexical'
        ? orderVectorCandidateArm(candidates)
        : [...candidates];
    const occurrences: SemanticSearchCandidateTraceOccurrence[] = ordered
        .slice(0, maxEntries)
        .map((candidate, index) => ({
            candidateId: candidate.document.id,
            ownerId: vectorCandidateOwnerId(candidate),
            evidenceOccurrenceId: JSON.stringify([candidate.document.id, stage, index + 1]),
            relativePath: candidate.document.relativePath,
            startLine: candidate.document.startLine,
            endLine: candidate.document.endLine,
            language: typeof candidate.document.metadata.language === 'string'
                ? candidate.document.metadata.language
                : 'unknown',
            rank: index + 1,
            score: candidate.score,
        }));
    return {
        stage,
        totalOccurrences: ordered.length,
        uniqueCandidates: new Set(ordered.map((candidate) => candidate.document.id)).size,
        omittedOccurrences: Math.max(0, ordered.length - occurrences.length),
        candidates: occurrences,
    };
}

function buildSemanticSearchCandidateTrace(input: {
    productDense?: readonly VectorCandidate[];
    productLexical?: readonly VectorCandidate[];
    diagnosticDense?: readonly VectorCandidate[];
    diagnosticLexical?: readonly VectorCandidate[];
    diagnosticLexicalFallback?: readonly VectorCandidate[];
    diagnosticRetrievals: readonly SemanticSearchDiagnosticRetrieval[];
    result: readonly VectorCandidate[];
    hybrid: boolean;
    maxEntries: number;
    productCandidateLimit: number;
    queryEmbeddingSha256: string | null;
    lexicalRequests: SemanticSearchCandidateTrace['lexicalRequests'];
}): SemanticSearchCandidateTrace {
    const stages: SemanticSearchCandidateTraceStage[] = [];
    if (input.productDense) {
        stages.push(buildSemanticSearchTraceStage('raw_dense', input.productDense, input.maxEntries));
    }
    if (input.productLexical) {
        stages.push(buildSemanticSearchTraceStage('raw_lexical', input.productLexical, input.maxEntries));
    }
    if (input.diagnosticDense) {
        stages.push(buildSemanticSearchTraceStage(
            'diagnostic_dense',
            input.diagnosticDense,
            input.maxEntries,
        ));
    }
    if (input.diagnosticLexical) {
        stages.push(buildSemanticSearchTraceStage(
            'diagnostic_lexical',
            input.diagnosticLexical,
            input.maxEntries,
        ));
    }
    if (input.diagnosticLexicalFallback) {
        stages.push(buildSemanticSearchTraceStage(
            'raw_lexical_fallback',
            input.diagnosticLexicalFallback,
            input.maxEntries,
        ));
    }
    stages.push(buildSemanticSearchTraceStage(
        input.hybrid ? 'core_fusion' : 'core_result',
        input.result,
        input.maxEntries,
    ));

    const resultIds = new Set(input.result.map((candidate) => candidate.document.id));
    const removedIds = [...new Set([
        ...(input.productDense ?? []).map((candidate) => candidate.document.id),
        ...(input.productLexical ?? []).map((candidate) => candidate.document.id),
    ])]
        .filter((candidateId) => !resultIds.has(candidateId))
        .sort(compareContractStrings);
    const removals = removedIds.slice(0, input.maxEntries).map((candidateId) => ({
        candidateId,
        afterStage: 'core_fusion' as const,
        reason: 'core_fusion_limit' as const,
    }));
    return {
        schemaVersion: 'semantic_search_candidate_trace_v1',
        maxEntriesPerStage: input.maxEntries,
        productCandidateLimit: input.productCandidateLimit,
        queryEmbeddingSha256: input.queryEmbeddingSha256,
        lexicalRequests: input.lexicalRequests,
        diagnosticRetrievals: [...input.diagnosticRetrievals],
        stages,
        removals,
        omittedRemovals: Math.max(0, removedIds.length - removals.length),
    };
}

function hashSemanticSearchQueryEmbedding(vector: readonly number[]): string {
    if (!vector.every(Number.isFinite)) {
        throw new Error('Query embedding contains a non-finite value.');
    }
    return crypto.createHash('sha256').update(JSON.stringify(vector), 'utf8').digest('hex');
}

function hashSemanticSearchLexicalQuery(query: string): string {
    return crypto.createHash('sha256').update(query, 'utf8').digest('hex');
}

type DiagnosticRetrievalOutcome = Readonly<{
    retrieval: SemanticSearchDiagnosticRetrieval;
    candidates?: readonly VectorCandidate[];
}>;

async function retrieveDiagnosticCandidates(input: {
    arm: SemanticSearchDiagnosticRetrieval["arm"];
    requestedLimit: number;
    retrieve: () => Promise<VectorCandidate[]>;
}): Promise<DiagnosticRetrievalOutcome> {
    try {
        return {
            retrieval: {
                arm: input.arm,
                requestedLimit: input.requestedLimit,
                status: 'available',
            },
            candidates: await input.retrieve(),
        };
    } catch {
        return {
            retrieval: {
                arm: input.arm,
                requestedLimit: input.requestedLimit,
                status: 'unavailable',
                failureReason: 'backend_request_failed',
            },
        };
    }
}

function resolveLexicalMatchCapabilities(vectorDatabase: VectorDatabase): {
    supportedModes: readonly ('all_terms' | 'any_terms')[];
    defaultMode: 'all_terms' | 'any_terms' | 'provider_sparse';
} {
    const backend = vectorDatabase.getBackendInfo?.();
    // Missing declarations resolve conservatively: no standardized modes and
    // provider-defined sparse semantics, so older/custom backends keep their
    // existing implicit behavior.
    const supportedModes = backend?.lexicalMatchModes ?? [];
    const defaultMode = backend?.defaultLexicalMatchMode ?? 'provider_sparse';
    if (defaultMode !== 'provider_sparse' && !supportedModes.includes(defaultMode)) {
        throw new Error(
            `Backend declares default lexical mode '${defaultMode}' without listing it as supported.`,
        );
    }
    return { supportedModes, defaultMode };
}

/**
 * Raised when a request demands a standardized lexical match mode the active
 * vector backend does not declare. Callers must not silently degrade to
 * provider-defined sparse behavior.
 */
export class LexicalRetrievalModeUnsupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LexicalRetrievalModeUnsupportedError';
    }
}

function normalizeBreadcrumbs(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const normalized = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 2);
    return normalized.length > 0 ? normalized : undefined;
}

function toSemanticSearchResult(
    result: VectorCandidate,
    backendScoreKind: 'dense_similarity' | 'lexical_rank' | 'rrf_fusion',
): SemanticSearchResult {
    return {
        candidateId: result.document.id,
        content: result.document.content,
        relativePath: result.document.relativePath,
        startLine: result.document.startLine,
        endLine: result.document.endLine,
        startByte: typeof result.document.metadata.startByte === 'number'
            ? result.document.metadata.startByte
            : undefined,
        endByte: typeof result.document.metadata.endByte === 'number'
            ? result.document.metadata.endByte
            : undefined,
        language: result.document.metadata.language || 'unknown',
        score: result.score,
        breadcrumbs: normalizeBreadcrumbs(result.document.metadata.breadcrumbs),
        indexedAt: typeof result.document.metadata.indexedAt === 'string'
            ? result.document.metadata.indexedAt
            : undefined,
        symbolId: typeof result.document.metadata.symbolId === 'string'
            ? result.document.metadata.symbolId
            : undefined,
        symbolLabel: typeof result.document.metadata.symbolLabel === 'string'
            ? result.document.metadata.symbolLabel
            : undefined,
        symbolKind: typeof result.document.metadata.symbolKind === 'string'
            ? result.document.metadata.symbolKind
            : undefined,
        ownerSymbolKey: typeof result.document.metadata.ownerSymbolKey === 'string'
            ? result.document.metadata.ownerSymbolKey
            : undefined,
        ownerSymbolInstanceId: typeof result.document.metadata.ownerSymbolInstanceId === 'string'
            ? result.document.metadata.ownerSymbolInstanceId
            : undefined,
        backendScore: result.score,
        backendScoreKind,
    };
}

export class SemanticSearchService<Receipt extends SearchGenerationReceipt> {
    private readonly getVectorDatabase: () => VectorDatabase;
    private readonly embeddingAccess: EmbeddingAccess;
    private readonly authority: SemanticSearchAuthority<Receipt>;
    private readonly isHybridEnabled: () => boolean;
    private readonly canonicalizeCodebasePath: (codebasePath: string) => string;
    private readonly mutationGenerationObserver?: MutationGenerationObserver;

    constructor(config: SemanticSearchServiceConfig<Receipt>) {
        this.getVectorDatabase = config.getVectorDatabase;
        this.embeddingAccess = config.embeddingAccess;
        this.authority = config.authority;
        this.isHybridEnabled = config.isHybridEnabled;
        this.canonicalizeCodebasePath = config.canonicalizeCodebasePath;
        this.mutationGenerationObserver = config.mutationGenerationObserver;
    }

    async search(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter,
    ): Promise<SemanticSearchResult[]> {
        return this.searchWithReceipt(
            undefined,
            requestOrCodebasePath,
            query,
            topK,
            threshold,
            filter,
        );
    }

    async searchInProvenGeneration(
        receipt: Receipt,
        request: SemanticSearchRequest,
    ): Promise<SemanticSearchResult[]> {
        return this.searchWithReceipt(receipt, request, undefined, 5, 0.5, undefined, true);
    }

    async searchWithCandidateTraceInProvenGeneration(
        receipt: Receipt,
        request: SemanticSearchRequest,
        maxEntriesPerStage: number,
        options: SemanticSearchCandidateTraceOptions = {},
    ): Promise<SemanticSearchExecutionResult> {
        this.assertCandidateTraceOptions(maxEntriesPerStage, options);
        let candidateTrace: SemanticSearchCandidateTrace | undefined;
        let diagnosticCandidateArms: SemanticSearchExecutionResult['diagnosticCandidateArms'];
        const results = await this.searchWithReceipt(
            receipt,
            request,
            undefined,
            5,
            0.5,
            undefined,
            true,
            (trace) => {
                candidateTrace = trace;
            },
            maxEntriesPerStage,
            options,
            (arms) => {
                diagnosticCandidateArms = arms;
            },
        );
        if (!candidateTrace) {
            throw new Error('Candidate trace was not produced for the semantic search.');
        }
        return {
            results,
            candidateTrace,
            ...(diagnosticCandidateArms ? { diagnosticCandidateArms } : {}),
        };
    }

    private assertCandidateTraceOptions(
        maxEntriesPerStage: number,
        options: SemanticSearchCandidateTraceOptions,
    ): void {
        if (
            !Number.isSafeInteger(maxEntriesPerStage)
            || maxEntriesPerStage < 1
            || maxEntriesPerStage > MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE
        ) {
            throw new Error(
                `Candidate trace maxEntriesPerStage must be an integer from 1 through ${MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE}.`,
            );
        }
        if (
            options.diagnosticCandidateLimit !== undefined
            && (
                !Number.isSafeInteger(options.diagnosticCandidateLimit)
                || options.diagnosticCandidateLimit < 1
                || options.diagnosticCandidateLimit > maxEntriesPerStage
            )
        ) {
            throw new Error(
                `Diagnostic candidate limit must be an integer from 1 through maxEntriesPerStage (${maxEntriesPerStage}).`,
            );
        }
        if (
            options.lexicalFallbackTerms !== undefined
            && (
                options.captureLexicalFallback !== true
                || options.lexicalFallbackTerms.length < 1
                || options.lexicalFallbackTerms.length > 8
                || options.lexicalFallbackTerms.some((term) => (
                    typeof term !== 'string'
                    || term.length === 0
                    || term !== term.trim()
                ))
            )
        ) {
            throw new Error(
                'Lexical fallback terms require fallback capture and 1 through 8 non-empty canonical terms.',
            );
        }
    }

    private async searchWithReceipt(
        receipt: Receipt | undefined,
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter,
        requestBoundReceipt = false,
        candidateTraceConsumer?: (trace: SemanticSearchCandidateTrace) => void,
        candidateTraceMaxEntries = MAX_SEMANTIC_SEARCH_TRACE_ENTRIES_PER_STAGE,
        candidateTraceOptions: SemanticSearchCandidateTraceOptions = {},
        diagnosticCandidateArmsConsumer?: (
            arms: NonNullable<SemanticSearchExecutionResult['diagnosticCandidateArms']>,
        ) => void,
    ): Promise<SemanticSearchResult[]> {
        const request = this.normalizeRequest(
            requestOrCodebasePath,
            query,
            topK,
            threshold,
            filter,
        );
        const resolvedRequest = this.resolveRequest(request);
        const codebasePath = resolvedRequest.codebasePath;
        const diagnosticCandidateRetrievalLimit = candidateTraceConsumer
            ? Math.max(
                resolvedRequest.topK,
                candidateTraceOptions.diagnosticCandidateLimit ?? resolvedRequest.topK,
            )
            : resolvedRequest.topK;
        const vectorDatabase = this.getVectorDatabase();
        const hybridCollection = this.isHybridEnabled();
        const isSparseOnly = resolvedRequest.retrievalMode === 'lexical' && hybridCollection;
        const isHybrid = resolvedRequest.retrievalMode === 'hybrid' && hybridCollection;
        const lexicalCapabilities = resolveLexicalMatchCapabilities(vectorDatabase);
        const requestedMatchMode = resolvedRequest.lexicalMatchMode;
        if (requestedMatchMode && !lexicalCapabilities.supportedModes.includes(requestedMatchMode)) {
            const backend = vectorDatabase.getBackendInfo?.();
            throw new LexicalRetrievalModeUnsupportedError(
                `Lexical match mode '${requestedMatchMode}' is not supported by the ${backend?.provider ?? 'unknown'} backend.`,
            );
        }
        // Effective mode drives the primary request, candidate traces, and
        // diagnostic fallback eligibility -- never the backend-derived value.
        const effectivePrimaryMatchMode = requestedMatchMode
            ?? lexicalCapabilities.defaultMode;
        const captureLexicalFallback = candidateTraceOptions.captureLexicalFallback === true
            && effectivePrimaryMatchMode === 'all_terms'
            && (isSparseOnly || isHybrid);
        const lexicalFallbackTerms = candidateTraceOptions.lexicalFallbackTerms;
        const lexicalFallbackQuery = lexicalFallbackTerms?.join(' ') ?? resolvedRequest.query;
        const monitorMutableGeneration =
            !requestBoundReceipt
            && (isHybrid || captureLexicalFallback);
        const initialMutationObservation = monitorMutableGeneration
            ? this.observeMutationGeneration(codebasePath)
            : null;
        if (initialMutationObservation?.mutationActive) {
            throw new Error('Index generation changed during hybrid retrieval.');
        }
        const searchType = isSparseOnly
            ? 'sparse search'
            : isHybrid
                ? 'hybrid search'
                : 'semantic search';
        const requestId = crypto.randomUUID();
        console.log(
            `[Context] 🔍 Executing ${searchType}: query_length=${resolvedRequest.query.length}, request_id=${requestId}, root=${codebasePath}`,
        );

        const revalidatedReceipt = receipt
            ? requestBoundReceipt
                ? this.authority.isPreparedReceiptBoundToCurrentAuthority(codebasePath, receipt)
                    ? receipt
                    : null
                : await this.authority.revalidateProvenVectorGeneration(codebasePath, receipt)
            : await this.authority.proveVectorGeneration(codebasePath);
        console.log(`[Context] 🔍 Using collection: ${revalidatedReceipt?.collectionName ?? null}`);

        if (process.env.SATORI_TASK7_DEBUG === '1') {
            console.error(
                '[TASK7-DEBUG][semantic-search-receipt] '
                + JSON.stringify({
                    root: codebasePath,
                    requestBoundReceipt,
                    retrievalMode: resolvedRequest.retrievalMode,
                    collectionName: revalidatedReceipt?.collectionName ?? null,
                    authorityMode: requestBoundReceipt
                        ? 'pinned_publication'
                        : 'mutable_current_publication',
                    mutationObserverEnabled: monitorMutableGeneration,
                }),
            );
        }

        if (!revalidatedReceipt) {
            console.log(
                `[Context] ⚠️  No proven collection exists for '${codebasePath}'. Please index the codebase first.`,
            );
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                ...(isSparseOnly ? { productLexical: [] } : { productDense: [] }),
                ...(isHybrid ? { productLexical: [] } : {}),
                diagnosticRetrievals: [],
                result: [],
                hybrid: isHybrid,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: null,
                lexicalRequests: [],
            }));
            return [];
        }

        const collectionName = revalidatedReceipt.collectionName;
        const assertCandidateReadAuthorityUnchanged = async (
            errorMessage: string,
        ): Promise<void> => {
            if (requestBoundReceipt) {
                return;
            }
            const finalMutationObservation = initialMutationObservation
                ? this.observeMutationGeneration(codebasePath)
                : null;
            const sameGenerationReceipt = requestBoundReceipt && initialMutationObservation
                ? this.authority.isPreparedReceiptBoundToCurrentAuthority(
                    codebasePath,
                    revalidatedReceipt,
                )
                    ? revalidatedReceipt
                    : null
                : await this.authority.revalidateProvenVectorGeneration(
                    codebasePath,
                    revalidatedReceipt,
                );
            if (
                !sameGenerationReceipt
                || (initialMutationObservation && (
                    !finalMutationObservation
                    || finalMutationObservation.mutationActive
                    || finalMutationObservation.generation !== initialMutationObservation.generation
                ))
            ) {
                throw new Error(errorMessage);
            }
        };

        if (isSparseOnly) {
            const productSearchResults = await vectorDatabase.retrieveLexical(collectionName, {
                query: resolvedRequest.query,
                limit: resolvedRequest.topK,
                filter: resolvedRequest.filter,
                ...(effectivePrimaryMatchMode !== 'provider_sparse'
                    ? { matchMode: effectivePrimaryMatchMode }
                    : {}),
            });
            await assertCandidateReadAuthorityUnchanged(
                'Index generation changed during lexical retrieval.',
            );
            const productResults = productSearchResults.slice(0, resolvedRequest.topK);
            const diagnosticRequests: Array<Promise<DiagnosticRetrievalOutcome>> = [];
            if (diagnosticCandidateRetrievalLimit > resolvedRequest.topK) {
                diagnosticRequests.push(retrieveDiagnosticCandidates({
                    arm: 'precise_lexical',
                    requestedLimit: diagnosticCandidateRetrievalLimit,
                    retrieve: () => vectorDatabase.retrieveLexical(collectionName, {
                        query: resolvedRequest.query,
                        limit: diagnosticCandidateRetrievalLimit,
                        filter: resolvedRequest.filter,
                        ...(effectivePrimaryMatchMode !== 'provider_sparse'
                            ? { matchMode: effectivePrimaryMatchMode }
                            : {}),
                    }),
                }));
            }
            if (captureLexicalFallback) {
                diagnosticRequests.push(retrieveDiagnosticCandidates({
                    arm: 'fallback_lexical',
                    requestedLimit: diagnosticCandidateRetrievalLimit,
                    retrieve: () => vectorDatabase.retrieveLexical(collectionName, {
                        query: lexicalFallbackQuery,
                        limit: diagnosticCandidateRetrievalLimit,
                        filter: resolvedRequest.filter,
                        matchMode: 'any_terms',
                    }),
                }));
            }
            const diagnosticOutcomes = await Promise.all(diagnosticRequests);
            if (diagnosticOutcomes.length > 0) {
                await assertCandidateReadAuthorityUnchanged(
                    'Index generation changed during diagnostic lexical retrieval.',
                );
            }
            const diagnosticLexical = diagnosticOutcomes.find(
                (outcome) => outcome.retrieval.arm === 'precise_lexical',
            )?.candidates;
            const diagnosticLexicalFallback = diagnosticOutcomes.find(
                (outcome) => outcome.retrieval.arm === 'fallback_lexical',
            )?.candidates;
            diagnosticCandidateArmsConsumer?.({
                ...(
                    diagnosticCandidateRetrievalLimit > resolvedRequest.topK
                        ? diagnosticLexical
                            ? {
                                preciseLexical: diagnosticLexical.map((result) => (
                                    toSemanticSearchResult(result, 'lexical_rank')
                                )),
                            }
                            : {}
                        : {
                            preciseLexical: productSearchResults.map((result) => (
                                toSemanticSearchResult(result, 'lexical_rank')
                            )),
                        }
                ),
                ...(diagnosticLexicalFallback
                    ? {
                        fallbackLexical: diagnosticLexicalFallback.map((result) => (
                            toSemanticSearchResult(result, 'lexical_rank')
                        )),
                    }
                    : {}),
            });
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                productLexical: productSearchResults.slice(0, resolvedRequest.topK),
                ...(diagnosticLexical ? { diagnosticLexical } : {}),
                ...(diagnosticLexicalFallback ? { diagnosticLexicalFallback } : {}),
                diagnosticRetrievals: diagnosticOutcomes.map((outcome) => outcome.retrieval),
                result: productResults,
                hybrid: false,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: null,
                lexicalRequests: [{
                    role: 'primary',
                    querySha256: hashSemanticSearchLexicalQuery(resolvedRequest.query),
                    matchMode: effectivePrimaryMatchMode,
                }, ...(captureLexicalFallback ? [{
                    role: 'fallback_or' as const,
                    querySha256: hashSemanticSearchLexicalQuery(lexicalFallbackQuery),
                    matchMode: 'any_terms' as const,
                    ...(lexicalFallbackTerms ? { terms: [...lexicalFallbackTerms] } : {}),
                }] : [])],
            }));
            return productResults.map((result) => (
                toSemanticSearchResult(result, 'lexical_rank')
            ));
        }

        if (isHybrid) {
            console.log(
                `[Context] 🔍 Generating query embedding: query_length=${resolvedRequest.query.length}, request_id=${requestId}`,
            );
        }
        const embedding = this.embeddingAccess.getEmbedding();
        this.embeddingAccess.assertEmbeddingIdentityCurrent();
        const queryEmbedding: EmbeddingVector = await embedding.embedQuery(resolvedRequest.query);
        this.embeddingAccess.assertEmbeddingIdentityCurrent();

        if (isHybrid) {
            console.log(
                `[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`,
            );
            console.log(
                `[Context] 🔍 Dense candidate request: vector_dim=${queryEmbedding.vector.length}, limit=${resolvedRequest.topK}`,
            );
            console.log(
                `[Context] 🔍 Lexical candidate request: query_length=${resolvedRequest.query.length}, request_id=${requestId}, limit=${resolvedRequest.topK}`,
            );
            console.log('[Context] 🔍 Executing hybrid search with RRF reranking...');
            const [productDenseCandidates, productLexicalCandidates] = await Promise.all([
                vectorDatabase.retrieveDense(collectionName, {
                    vector: queryEmbedding.vector,
                    limit: resolvedRequest.topK,
                    filter: resolvedRequest.filter,
                }),
                vectorDatabase.retrieveLexical(collectionName, {
                    query: resolvedRequest.query,
                    limit: resolvedRequest.topK,
                    filter: resolvedRequest.filter,
                    ...(effectivePrimaryMatchMode !== 'provider_sparse'
                        ? { matchMode: effectivePrimaryMatchMode }
                        : {}),
                }),
            ]);
            await assertCandidateReadAuthorityUnchanged(
                'Index generation changed during hybrid retrieval.',
            );
            const searchResults = fuseVectorCandidatesWithRrf({
                dense: productDenseCandidates.slice(0, resolvedRequest.topK),
                lexical: productLexicalCandidates.slice(0, resolvedRequest.topK),
                k: VECTOR_CANDIDATE_RRF_K_V1,
                limit: resolvedRequest.topK,
            });

            const diagnosticRequests: Array<Promise<DiagnosticRetrievalOutcome>> = [];
            if (diagnosticCandidateRetrievalLimit > resolvedRequest.topK) {
                diagnosticRequests.push(
                    retrieveDiagnosticCandidates({
                        arm: 'dense',
                        requestedLimit: diagnosticCandidateRetrievalLimit,
                        retrieve: () => vectorDatabase.retrieveDense(collectionName, {
                            vector: queryEmbedding.vector,
                            limit: diagnosticCandidateRetrievalLimit,
                            filter: resolvedRequest.filter,
                        }),
                    }),
                    retrieveDiagnosticCandidates({
                        arm: 'precise_lexical',
                        requestedLimit: diagnosticCandidateRetrievalLimit,
                        retrieve: () => vectorDatabase.retrieveLexical(collectionName, {
                            query: resolvedRequest.query,
                            limit: diagnosticCandidateRetrievalLimit,
                            filter: resolvedRequest.filter,
                            ...(effectivePrimaryMatchMode !== 'provider_sparse'
                                ? { matchMode: effectivePrimaryMatchMode }
                                : {}),
                        }),
                    }),
                );
            }
            if (captureLexicalFallback) {
                diagnosticRequests.push(retrieveDiagnosticCandidates({
                    arm: 'fallback_lexical',
                    requestedLimit: diagnosticCandidateRetrievalLimit,
                    retrieve: () => vectorDatabase.retrieveLexical(collectionName, {
                        query: lexicalFallbackQuery,
                        limit: diagnosticCandidateRetrievalLimit,
                        filter: resolvedRequest.filter,
                        matchMode: 'any_terms',
                    }),
                }));
            }
            const diagnosticOutcomes = await Promise.all(diagnosticRequests);
            if (diagnosticOutcomes.length > 0) {
                await assertCandidateReadAuthorityUnchanged(
                    'Index generation changed during hybrid diagnostic retrieval.',
                );
            }
            const diagnosticDense = diagnosticOutcomes.find(
                (outcome) => outcome.retrieval.arm === 'dense',
            )?.candidates;
            const diagnosticLexical = diagnosticOutcomes.find(
                (outcome) => outcome.retrieval.arm === 'precise_lexical',
            )?.candidates;
            const diagnosticLexicalFallback = diagnosticOutcomes.find(
                (outcome) => outcome.retrieval.arm === 'fallback_lexical',
            )?.candidates;
            diagnosticCandidateArmsConsumer?.({
                ...(
                    diagnosticCandidateRetrievalLimit > resolvedRequest.topK
                        ? {
                            ...(diagnosticDense
                                ? {
                                    dense: diagnosticDense.map((result) => (
                                        toSemanticSearchResult(result, 'dense_similarity')
                                    )),
                                }
                                : {}),
                            ...(diagnosticLexical
                                ? {
                                    preciseLexical: diagnosticLexical.map((result) => (
                                        toSemanticSearchResult(result, 'lexical_rank')
                                    )),
                                }
                                : {}),
                        }
                        : {
                            dense: productDenseCandidates.map((result) => (
                                toSemanticSearchResult(result, 'dense_similarity')
                            )),
                            preciseLexical: productLexicalCandidates.map((result) => (
                                toSemanticSearchResult(result, 'lexical_rank')
                            )),
                        }
                ),
                ...(diagnosticLexicalFallback
                    ? {
                        fallbackLexical: diagnosticLexicalFallback.map((result) => (
                            toSemanticSearchResult(result, 'lexical_rank')
                        )),
                    }
                    : {}),
            });
            candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
                productDense: productDenseCandidates.slice(0, resolvedRequest.topK),
                productLexical: productLexicalCandidates.slice(0, resolvedRequest.topK),
                ...(diagnosticDense ? { diagnosticDense } : {}),
                ...(diagnosticLexical ? { diagnosticLexical } : {}),
                ...(diagnosticLexicalFallback ? { diagnosticLexicalFallback } : {}),
                diagnosticRetrievals: diagnosticOutcomes.map((outcome) => outcome.retrieval),
                result: searchResults,
                hybrid: true,
                maxEntries: candidateTraceMaxEntries,
                productCandidateLimit: resolvedRequest.topK,
                queryEmbeddingSha256: hashSemanticSearchQueryEmbedding(queryEmbedding.vector),
                lexicalRequests: [{
                    role: 'primary',
                    querySha256: hashSemanticSearchLexicalQuery(resolvedRequest.query),
                    matchMode: effectivePrimaryMatchMode,
                }, ...(captureLexicalFallback ? [{
                    role: 'fallback_or' as const,
                    querySha256: hashSemanticSearchLexicalQuery(lexicalFallbackQuery),
                    matchMode: 'any_terms' as const,
                    ...(lexicalFallbackTerms ? { terms: [...lexicalFallbackTerms] } : {}),
                }] : [])],
            }));
            console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);
            const results = searchResults.map((result) => (
                toSemanticSearchResult(result, 'rrf_fusion')
            ));
            console.log(`[Context] ✅ Found ${results.length} relevant hybrid results`);
            if (results.length > 0) {
                console.log(
                    `[Context] 🔍 Top result score: ${results[0].score}, path: ${results[0].relativePath}`,
                );
            }
            return results;
        }

        const denseThreshold = resolvedRequest.scorePolicy.kind === 'dense_similarity_min'
            ? resolvedRequest.scorePolicy.min
            : undefined;
        const productSearchResults = await vectorDatabase.retrieveDense(collectionName, {
            vector: queryEmbedding.vector,
            limit: resolvedRequest.topK,
            minimumScore: denseThreshold,
            filter: resolvedRequest.filter,
        });
        await assertCandidateReadAuthorityUnchanged(
            'Index generation changed during dense retrieval.',
        );
        const productResults = productSearchResults.slice(0, resolvedRequest.topK);
        const diagnosticOutcome = diagnosticCandidateRetrievalLimit > resolvedRequest.topK
            ? await retrieveDiagnosticCandidates({
                arm: 'dense',
                requestedLimit: diagnosticCandidateRetrievalLimit,
                retrieve: () => vectorDatabase.retrieveDense(collectionName, {
                    vector: queryEmbedding.vector,
                    limit: diagnosticCandidateRetrievalLimit,
                    minimumScore: denseThreshold,
                    filter: resolvedRequest.filter,
                }),
            })
            : undefined;
        if (diagnosticOutcome) {
            await assertCandidateReadAuthorityUnchanged(
                'Index generation changed during diagnostic dense retrieval.',
            );
        }
        const diagnosticDense = diagnosticOutcome?.candidates;
        diagnosticCandidateArmsConsumer?.(
            diagnosticOutcome
                ? diagnosticDense
                    ? {
                        dense: diagnosticDense.map((result) => (
                            toSemanticSearchResult(result, 'dense_similarity')
                        )),
                    }
                    : {}
                : {
                    dense: productSearchResults.map((result) => (
                        toSemanticSearchResult(result, 'dense_similarity')
                    )),
                },
        );
        candidateTraceConsumer?.(buildSemanticSearchCandidateTrace({
            productDense: productSearchResults.slice(0, resolvedRequest.topK),
            ...(diagnosticDense ? { diagnosticDense } : {}),
            diagnosticRetrievals: diagnosticOutcome ? [diagnosticOutcome.retrieval] : [],
            result: productResults,
            hybrid: false,
            maxEntries: candidateTraceMaxEntries,
            productCandidateLimit: resolvedRequest.topK,
            queryEmbeddingSha256: hashSemanticSearchQueryEmbedding(queryEmbedding.vector),
            lexicalRequests: [],
        }));
        const results = productResults.map((result) => (
            toSemanticSearchResult(result, 'dense_similarity')
        ));
        console.log(`[Context] ✅ Found ${results.length} relevant results`);
        return results;
    }

    private observeMutationGeneration(
        codebasePath: string,
    ): MutationGenerationObservation | null {
        if (!this.mutationGenerationObserver) return null;
        const observation = this.mutationGenerationObserver(
            this.canonicalizeCodebasePath(codebasePath),
        );
        if (
            !Number.isSafeInteger(observation.generation)
            || observation.generation < 0
            || typeof observation.mutationActive !== 'boolean'
        ) {
            throw new Error('Mutation generation observer returned an invalid observation.');
        }
        return {
            generation: observation.generation,
            mutationActive: observation.mutationActive,
        };
    }

    private normalizeRequest(
        requestOrCodebasePath: SemanticSearchRequest | string,
        query?: string,
        topK: number = 5,
        threshold: number = 0.5,
        filter?: VectorFilter,
    ): SemanticSearchRequest {
        if (typeof requestOrCodebasePath !== 'string') return requestOrCodebasePath;
        return {
            codebasePath: requestOrCodebasePath,
            query: query ?? '',
            topK,
            filter,
            ...(threshold > 0
                ? {
                    retrievalMode: 'dense',
                    scorePolicy: { kind: 'dense_similarity_min', min: threshold } as const,
                }
                : {
                    scorePolicy: { kind: 'topk_only' } as const,
                }),
        };
    }

    private resolveRequest(request: SemanticSearchRequest): Omit<
        Required<SemanticSearchRequest>,
        'filter' | 'lexicalMatchMode'
    > & { filter?: VectorFilter; lexicalMatchMode?: 'all_terms' | 'any_terms'; retrievalMode: RetrievalMode; scorePolicy: ScorePolicy } {
        const hybridEnabled = this.isHybridEnabled();
        const retrievalMode = request.retrievalMode ?? (hybridEnabled ? 'hybrid' : 'dense');
        const scorePolicy = request.scorePolicy ?? (retrievalMode === 'dense'
            ? { kind: 'dense_similarity_min', min: 0.5 }
            : { kind: 'topk_only' });

        if (
            request.retrievalMode !== undefined
            && retrievalMode !== 'dense'
            && !hybridEnabled
        ) {
            throw new Error(
                `${retrievalMode} retrieval requires hybrid search support, but HYBRID_MODE is disabled.`,
            );
        }
        if (retrievalMode !== 'dense' && scorePolicy.kind === 'dense_similarity_min') {
            throw new Error(
                `Dense similarity threshold score policy is invalid for ${retrievalMode} retrieval.`,
            );
        }
        if (retrievalMode === 'dense' && request.lexicalMatchMode !== undefined) {
            throw new Error(
                'lexicalMatchMode is invalid for dense retrieval; it applies only to lexical or hybrid retrieval.',
            );
        }
        return {
            codebasePath: request.codebasePath,
            query: request.query,
            topK: request.topK ?? 5,
            retrievalMode,
            lexicalMatchMode: request.lexicalMatchMode,
            filter: request.filter === undefined
                ? undefined
                : validateVectorFilter(request.filter),
            scorePolicy,
        };
    }
}
