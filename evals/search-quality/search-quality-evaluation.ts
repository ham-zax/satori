import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from '../../packages/core/src/index.js';
import { ToolHandlers } from '../../packages/mcp/src/core/handlers.js';
import { CapabilityResolver } from '../../packages/mcp/src/core/capabilities.js';
import type { IndexFingerprint } from '../../packages/mcp/src/config.js';

const FIXED_NOW = '2026-01-01T01:00:00.000Z';
const FIXED_INDEXED_AT = '2026-01-01T00:30:00.000Z';
const REQUIRED_LIMITS = [1, 3, 5, 10, 20] as const;

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
};

type SearchScope = 'runtime' | 'mixed' | 'docs';
type CandidateRole =
    | 'entrypoint'
    | 'owner'
    | 'orchestrator'
    | 'retrieval'
    | 'ranking'
    | 'selection'
    | 'finalization'
    | 'caller'
    | 'configuration'
    | 'test'
    | 'documentation'
    | 'generated'
    | 'fixture';

type FixtureFile = {
    path: string;
    sha256: string;
};

type FixtureCandidate = {
    id: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string;
    kind: 'file' | 'function' | 'interface' | 'constant';
    role: CandidateRole;
    family: string;
    ownerCandidateId?: string;
};

type ProviderRows = {
    primary: string[];
    expanded?: string[];
    sparse?: string[];
    rerank?: string[];
};

type FixtureWorkload = {
    id: string;
    query: string;
    scope: SearchScope;
    expectedOwners: string[];
    requiredRoles: CandidateRole[];
    providerRows: ProviderRows;
    budgets: {
        maxToolCalls: number;
        maxResponseBytes: number;
    };
};

type FixtureManifest = {
    schemaVersion: 1;
    fixtureId: string;
    files: FixtureFile[];
    candidates: FixtureCandidate[];
    workloads: FixtureWorkload[];
};

type SearchFixtureResult = {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    backendScore: number;
    backendScoreKind: 'lexical_rank' | 'rrf_fusion';
    indexedAt: string;
    symbolId?: string;
    symbolLabel?: string;
    symbolKey?: string;
    symbolInstanceId?: string;
    symbolKind?: string;
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
};

type SearchPayloadResult = {
    file?: string;
    symbolLabel?: string;
    displayLabel?: string;
    target?: {
        file?: string;
        symbolId?: string;
        span?: { startLine?: number; endLine?: number };
    };
};

type SearchPayload = {
    status?: string;
    results?: SearchPayloadResult[];
    warnings?: Array<string | { code?: string }>;
    hints?: {
        debugSearch?: {
            route?: { kind?: string; reason?: string };
            queryIntent?: { classification?: string; reasons?: string[] };
            retrieval?: { mode?: string };
            semanticExpansion?: {
                attempted?: boolean;
                reason?: string;
                primaryScopedCandidateCount?: number;
            };
            passesUsed?: string[];
        };
    };
};

type ProviderMetrics = {
    semanticSearchCalls: number;
    primaryPassCalls: number;
    expandedPassCalls: number;
    embeddingCallsByCurrentContract: number;
    denseQueriesByCurrentContract: number;
    sparseQueriesByCurrentContract: number;
    nonGatingVectorQueriesByCurrentContract: number;
    rerankCalls: number;
    rerankerCandidates: number;
    rerankerInputBytes: number;
    rerankedCandidateIds: string[];
};

export type SearchQualityWorkloadResult = {
    workloadId: string;
    limit: number;
    status: string;
    ownerRank: number | null;
    reciprocalRank: number;
    roleCoverage: number;
    rolesPresent: CandidateRole[];
    duplicateFamilyRate: number;
    resultIds: string[];
    responseBytes: number;
    estimatedResponseTokens: number;
    toolCalls: number;
    ownerAvailableInInitialSearch: boolean;
    provider: ProviderMetrics;
    routeObservation: {
        selectedRoute: string | null;
        routeReason: string | null;
        queryIntent: string | null;
        retrievalMode: string | null;
        semanticExpansionAttempted: boolean;
        semanticExpansionReason: string | null;
        primaryScopedCandidateCount: number | null;
        passesUsed: string[];
    };
    warningCodes: string[];
    budgetChecks: {
        toolCalls: boolean;
        responseBytes: boolean;
    };
};

export type SearchQualityEvaluationArtifact = {
    schemaVersion: 2;
    fixtureId: string;
    fixtureManifestSha256: string;
    repository: {
        head: string;
        tree: string;
        diffSha256: string;
        diffCachedSha256: string;
        workingTreeContentSha256: string;
    };
    providerContract: 'hybrid_v3_sparse_routes';
    limits: number[];
    workloadCount: number;
    results: SearchQualityWorkloadResult[];
    summary: {
        ownerAtOneRate: number;
        ownerAtThreeRate: number;
        macroReciprocalRank: number;
        meanRoleCoverage: number;
        meanDuplicateFamilyRate: number;
        totalSemanticSearchCalls: number;
        totalEmbeddingCallsByCurrentContract: number;
        totalDenseQueriesByCurrentContract: number;
        totalSparseQueriesByCurrentContract: number;
        totalNonGatingVectorQueriesByCurrentContract: number;
        totalRerankCalls: number;
        totalRerankerInputBytes: number;
        totalResponseBytes: number;
    };
};

type EvaluationContext = ConstructorParameters<typeof ToolHandlers>[0];
type EvaluationSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type EvaluationSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type EvaluationCallGraphManager = NonNullable<ConstructorParameters<typeof ToolHandlers>[6]>;
type EvaluationReranker = NonNullable<ConstructorParameters<typeof ToolHandlers>[7]>;

type HandlerOverrides = {
    validateCompletionProof: () => Promise<{
        outcome: 'valid';
        navigationStatus: 'valid';
        generationReceipt: {
            navigation: { navigationSealHash: string };
        };
    }>;
};

type EvaluationEnvironment = {
    repoPath: string;
    manifest: FixtureManifest;
    handlers: ToolHandlers;
    setWorkload: (workload: FixtureWorkload) => void;
    resetMetrics: () => void;
    readMetrics: () => ProviderMetrics;
    candidateById: Map<string, FixtureCandidate>;
    candidateIdBySymbolInstanceId: Map<string, string>;
    dispose: () => void;
};

function sha256(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function readManifest(fixtureRoot: string): { manifest: FixtureManifest; digest: string } {
    const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
    const raw = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(raw.toString('utf8')) as FixtureManifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.fixtureId, 'satori-search-quality-v1');
    return { manifest, digest: sha256(raw) };
}

function verifyFixtureFiles(fixtureRoot: string, manifest: FixtureManifest): void {
    const declaredPaths = new Set(manifest.files.map((file) => file.path));
    for (const file of manifest.files) {
        const absolutePath = path.join(fixtureRoot, file.path);
        assert.equal(fs.existsSync(absolutePath), true, `fixture file missing: ${file.path}`);
        assert.equal(sha256(fs.readFileSync(absolutePath)), file.sha256, `fixture hash mismatch: ${file.path}`);
    }
    for (const candidate of manifest.candidates) {
        assert.equal(declaredPaths.has(candidate.file), true, `candidate file is not hash-bound: ${candidate.id}`);
    }
}

function readCandidateContent(repoPath: string, candidate: FixtureCandidate): string {
    const content = fs.readFileSync(path.join(repoPath, candidate.file), 'utf8');
    return content.split(/\r?\n/).slice(candidate.startLine - 1, candidate.endLine).join('\n');
}

function getLanguage(relativePath: string): string {
    if (relativePath.endsWith('.ts')) {
        return 'typescript';
    }
    if (relativePath.endsWith('.md')) {
        return 'markdown';
    }
    if (relativePath.endsWith('.json')) {
        return 'json';
    }
    return 'text';
}

async function buildNavigationSidecars(input: {
    repoPath: string;
    manifest: FixtureManifest;
}): Promise<{
    symbolByCandidateId: Map<string, SymbolRecord>;
    manifestHash: string;
}> {
    const symbolByCandidateId = new Map<string, SymbolRecord>();
    const symbols: SymbolRecord[] = [];
    const manifestFiles: SymbolRegistryManifest['files'] = [];
    const candidatesByFile = new Map<string, FixtureCandidate[]>();
    for (const candidate of input.manifest.candidates) {
        if (candidate.kind === 'file') {
            continue;
        }
        const existing = candidatesByFile.get(candidate.file) ?? [];
        candidatesByFile.set(candidate.file, [...existing, candidate]);
    }

    for (const [relativePath, fileCandidates] of candidatesByFile) {
        const content = fs.readFileSync(path.join(input.repoPath, relativePath), 'utf8');
        const fileHash = sha256(content);
        const language = getLanguage(relativePath);
        const records = buildSymbolRecordsForFile({
            relativePath,
            language,
            content,
            fileHash,
            extractorVersion: 'search-quality-v1',
            chunks: fileCandidates.map((candidate) => ({
                content: readCandidateContent(input.repoPath, candidate),
                metadata: {
                    startLine: candidate.startLine,
                    endLine: candidate.endLine,
                    language,
                    filePath: relativePath,
                    symbolLabel: `${candidate.kind} ${candidate.symbol}`,
                    breadcrumbs: [`${candidate.kind} ${candidate.symbol}`],
                },
            })),
            extractedSymbols: fileCandidates.map((candidate) => ({
                kind: candidate.kind,
                name: candidate.symbol,
                label: `${candidate.kind} ${candidate.symbol}`,
                qualifiedName: candidate.symbol,
                parentQualifiedNamePath: [],
                span: {
                    startLine: candidate.startLine,
                    endLine: candidate.endLine,
                },
            })),
        });
        symbols.push(...records);
        manifestFiles.push({
            path: relativePath,
            hash: fileHash,
            language,
            symbolCount: records.length,
        });
        for (const candidate of fileCandidates) {
            const record = records.find((item) => (
                item.name === candidate.symbol
                && item.span.startLine === candidate.startLine
                && item.span.endLine === candidate.endLine
            ));
            assert.ok(record, `symbol record missing for candidate: ${candidate.id}`);
            symbolByCandidateId.set(candidate.id, record);
        }
    }

    const sidecarManifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: input.repoPath,
        rootFingerprint: 'search-quality-v1-root',
        indexPolicyHash: 'search-quality-v1-policy',
        languageRouterVersion: 'search-quality-v1-router',
        extractorVersion: 'search-quality-v1',
        relationshipVersion: 'search-quality-v1-relationships',
        builtAt: FIXED_INDEXED_AT,
        files: manifestFiles.sort((left, right) => left.path.localeCompare(right.path)),
    };
    const writeResult = await writeSymbolRegistrySidecar({
        registry: buildSymbolRegistry({ manifest: sidecarManifest, symbols }),
    });
    const checkpointWriter = symbolByCandidateId.get('checkpoint.writeSourceCheckpoint');
    const checkpointCaller = symbolByCandidateId.get('checkpoint.refreshCheckpoint');
    assert.ok(checkpointWriter, 'checkpoint writer symbol missing from evaluation fixture');
    assert.ok(checkpointCaller, 'checkpoint caller symbol missing from evaluation fixture');
    await writeRelationshipSidecar({
        normalizedRootPath: input.repoPath,
        symbolRegistryManifestHash: writeResult.manifestHash,
        relationshipVersion: sidecarManifest.relationshipVersion,
        builtAt: sidecarManifest.builtAt,
        files: sidecarManifest.files,
        records: [{
            sourceKey: checkpointCaller.symbolKey,
            sourceInstanceId: checkpointCaller.symbolInstanceId,
            targetKey: checkpointWriter.symbolKey,
            targetInstanceId: checkpointWriter.symbolInstanceId,
            type: 'CALLS',
            file: checkpointCaller.file,
            span: { startLine: 4, endLine: 4 },
            confidence: 'high',
        }],
        analysisByFile: new Map(sidecarManifest.files.map((file) => [file.path, {
            moduleBindings: [],
            callSites: [],
        }])),
    });
    return { symbolByCandidateId, manifestHash: writeResult.manifestHash };
}

function createEmptyProviderMetrics(): ProviderMetrics {
    return {
        semanticSearchCalls: 0,
        primaryPassCalls: 0,
        expandedPassCalls: 0,
        embeddingCallsByCurrentContract: 0,
        denseQueriesByCurrentContract: 0,
        sparseQueriesByCurrentContract: 0,
        nonGatingVectorQueriesByCurrentContract: 0,
        rerankCalls: 0,
        rerankerCandidates: 0,
        rerankerInputBytes: 0,
        rerankedCandidateIds: [],
    };
}

function cloneProviderMetrics(metrics: ProviderMetrics): ProviderMetrics {
    return {
        ...metrics,
        rerankedCandidateIds: [...metrics.rerankedCandidateIds],
    };
}

function identifyCandidateFromRerankDocument(
    document: string,
    candidates: readonly FixtureCandidate[],
): string | null {
    const [relativePath = '', , symbolLabel = ''] = document.split('\n', 4);
    const matches = candidates.filter((candidate) => candidate.file === relativePath);
    const exactLabel = matches.find((candidate) => symbolLabel === candidate.symbol);
    if (exactLabel) return exactLabel.id;
    const containingLabel = matches
        .filter((candidate) => symbolLabel.includes(candidate.symbol))
        .sort((left, right) => right.symbol.length - left.symbol.length)[0];
    return containingLabel?.id ?? (matches.length === 1 ? matches[0].id : null);
}

async function createEvaluationEnvironment(workspaceRoot: string): Promise<EvaluationEnvironment> {
    const fixtureRoot = path.join(workspaceRoot, 'fixtures/search-quality/v1');
    const { manifest } = readManifest(fixtureRoot);
    verifyFixtureFiles(fixtureRoot, manifest);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-search-quality-'));
    const repoPath = path.join(tempRoot, 'repo');
    const stateRoot = path.join(tempRoot, 'state');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    for (const file of manifest.files) {
        const source = path.join(fixtureRoot, file.path);
        const target = path.join(repoPath, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }

    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = stateRoot;
    const { symbolByCandidateId } = await buildNavigationSidecars({ repoPath, manifest });
    const candidateById = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));
    const candidateIdBySymbolInstanceId = new Map<string, string>();
    for (const [candidateId, record] of symbolByCandidateId) {
        candidateIdBySymbolInstanceId.set(record.symbolInstanceId, candidateId);
    }

    let activeWorkload = manifest.workloads[0];
    let metrics = createEmptyProviderMetrics();
    const toSearchResult = (
        candidateId: string,
        rank: number,
        backendScoreKind: SearchFixtureResult['backendScoreKind'],
    ): SearchFixtureResult => {
        const candidate = candidateById.get(candidateId);
        assert.ok(candidate, `unknown provider candidate: ${candidateId}`);
        const record = symbolByCandidateId.get(candidateId);
        const ownerRecord = candidate.ownerCandidateId
            ? symbolByCandidateId.get(candidate.ownerCandidateId)
            : record;
        if (candidate.ownerCandidateId) {
            assert.ok(ownerRecord, `unknown owner candidate: ${candidate.ownerCandidateId}`);
        }
        return {
            content: readCandidateContent(repoPath, candidate),
            relativePath: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            language: getLanguage(candidate.file),
            score: Math.max(0.01, 1 - (rank * 0.01)),
            backendScore: Math.max(0.01, 1 - (rank * 0.01)),
            backendScoreKind,
            indexedAt: FIXED_INDEXED_AT,
            ...(record ? {
                symbolId: record.symbolInstanceId,
                symbolLabel: record.label,
                symbolKey: record.symbolKey,
                symbolInstanceId: record.symbolInstanceId,
                symbolKind: record.kind,
                ownerSymbolKey: ownerRecord?.symbolKey ?? record.symbolKey,
                ownerSymbolInstanceId: ownerRecord?.symbolInstanceId ?? record.symbolInstanceId,
            } : {}),
        };
    };

    const runSemanticSearch = (request: { query?: string; retrievalMode?: string; topK?: number }): SearchFixtureResult[] => {
        const query = request.query ?? '';
        const isExpanded = query.includes('\nimplementation runtime source entrypoint');
        const isSparseOnly = request.retrievalMode === 'lexical';
        metrics.semanticSearchCalls += 1;
        if (!isSparseOnly) {
            metrics.embeddingCallsByCurrentContract += 1;
            metrics.denseQueriesByCurrentContract += 1;
        }
        if (request.retrievalMode !== 'dense') {
            metrics.sparseQueriesByCurrentContract += 1;
        }
        if (isExpanded) {
            metrics.expandedPassCalls += 1;
        } else {
            metrics.primaryPassCalls += 1;
        }
        const rowIds = isSparseOnly
            ? (activeWorkload.providerRows.sparse ?? activeWorkload.providerRows.primary)
            : isExpanded
                ? (activeWorkload.providerRows.expanded ?? activeWorkload.providerRows.primary)
                : activeWorkload.providerRows.primary;
        const backendScoreKind = isSparseOnly ? 'lexical_rank' : 'rrf_fusion';
        return rowIds
            .slice(0, request.topK ?? rowIds.length)
            .map((candidateId, rank) => toSearchResult(candidateId, rank, backendScoreKind));
    };

    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getTrackedRelativePaths: () => manifest.files.map((file) => file.path),
        semanticSearch: async (request: { query?: string; retrievalMode?: string; topK?: number }) => runSemanticSearch(request),
        semanticSearchInProvenGeneration: async (
            _receipt: unknown,
            request: { query?: string; retrievalMode?: string; topK?: number },
        ) => runSemanticSearch(request),
    } as unknown as EvaluationContext;

    const snapshotManager = {
        getAllCodebases: () => [],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
    } as unknown as EvaluationSnapshotManager;

    const syncManager = {
        ensureFreshness: async () => ({
            mode: 'skipped_recent',
            changed: false,
            checkedAt: FIXED_NOW,
            thresholdMs: 180_000,
        }),
    } as unknown as EvaluationSyncManager;

    const capabilities = new CapabilityResolver({
        name: 'search-quality-evaluation',
        version: '1.0.0',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        voyageKey: 'hermetic-test-key',
    });

    const sidecarNodes = [...symbolByCandidateId.values()].map((record) => ({
        symbolId: record.symbolInstanceId,
        symbolLabel: record.label,
        file: record.relativePath,
        language: record.language,
        span: {
            startLine: record.span.startLine,
            endLine: record.span.endLine,
        },
    }));
    const callGraphManager = {
        loadSidecar: () => ({
            formatVersion: 'v3',
            codebasePath: repoPath,
            builtAt: FIXED_INDEXED_AT,
            fingerprint: RUNTIME_FINGERPRINT,
            nodes: sidecarNodes,
            edges: [],
            notes: [],
        }),
    } as unknown as EvaluationCallGraphManager;

    const reranker = {
        rerank: async (_query: string, documents: string[]) => {
            metrics.rerankCalls += 1;
            metrics.rerankerCandidates += documents.length;
            metrics.rerankerInputBytes += documents.reduce(
                (total, document) => total + Buffer.byteLength(document, 'utf8'),
                0,
            );
            const configuredOrder = activeWorkload.providerRows.rerank;
            const candidateIds = documents.map((document) => (
                identifyCandidateFromRerankDocument(document, manifest.candidates)
            ));
            metrics.rerankedCandidateIds.push(...candidateIds.filter(
                (candidateId): candidateId is string => candidateId !== null,
            ));
            const rankByCandidateId = new Map(
                (configuredOrder ?? candidateIds.filter((value): value is string => value !== null))
                    .map((candidateId, index) => [candidateId, index]),
            );
            return candidateIds
                .map((candidateId, index) => ({
                    index,
                    relevanceScore: candidateId === null
                        ? 0
                        : 1 - ((rankByCandidateId.get(candidateId) ?? candidateIds.length) * 0.01),
                    configuredRank: candidateId === null
                        ? Number.MAX_SAFE_INTEGER
                        : (rankByCandidateId.get(candidateId) ?? Number.MAX_SAFE_INTEGER),
                }))
                .sort((left, right) => left.configuredRank - right.configuredRank || left.index - right.index)
                .map(({ index, relevanceScore }) => ({ index, relevanceScore }));
        },
    } as unknown as EvaluationReranker;

    const handlers = new ToolHandlers(
        context,
        snapshotManager,
        syncManager,
        RUNTIME_FINGERPRINT,
        capabilities,
        () => Date.parse(FIXED_NOW),
        callGraphManager,
        reranker,
    );
    (handlers as unknown as HandlerOverrides).validateCompletionProof = async () => ({
        outcome: 'valid',
        navigationStatus: 'valid',
        generationReceipt: {
            navigation: { navigationSealHash: 'a'.repeat(64) },
        },
    });

    return {
        repoPath,
        manifest,
        handlers,
        setWorkload: (workload) => {
            activeWorkload = workload;
        },
        resetMetrics: () => {
            metrics = createEmptyProviderMetrics();
        },
        readMetrics: () => cloneProviderMetrics(metrics),
        candidateById,
        candidateIdBySymbolInstanceId,
        dispose: () => {
            if (previousStateRoot === undefined) {
                delete process.env.SATORI_STATE_ROOT;
            } else {
                process.env.SATORI_STATE_ROOT = previousStateRoot;
            }
            fs.rmSync(tempRoot, { recursive: true, force: true });
        },
    };
}

function identifyPayloadResult(
    result: SearchPayloadResult,
    manifest: FixtureManifest,
    candidateIdBySymbolInstanceId: ReadonlyMap<string, string>,
): string | null {
    const symbolId = result.target?.symbolId;
    if (symbolId) {
        const byInstance = candidateIdBySymbolInstanceId.get(symbolId);
        if (byInstance) {
            return byInstance;
        }
    }
    const relativePath = result.target?.file ?? result.file;
    if (!relativePath) {
        return null;
    }
    const matches = manifest.candidates.filter((candidate) => candidate.file === relativePath);
    const label = `${result.displayLabel ?? ''} ${result.symbolLabel ?? ''}`;
    const exact = matches.find((candidate) => label.includes(candidate.symbol));
    if (exact) {
        return exact.id;
    }
    const span = result.target?.span;
    const bySpan = matches.find((candidate) => (
        candidate.startLine === span?.startLine
        && candidate.endLine === span?.endLine
    ));
    return bySpan?.id ?? (matches.length === 1 ? matches[0].id : null);
}

function collectWarningCodes(payload: SearchPayload): string[] {
    return (payload.warnings ?? [])
        .map((warning) => typeof warning === 'string' ? warning : warning.code)
        .filter((code): code is string => typeof code === 'string')
        .sort();
}

function measureModelVisibleResponseBytes(payload: SearchPayload): number {
    const projection = structuredClone(payload) as SearchPayload & {
        requestId?: string;
        hints?: SearchPayload['hints'] & {
            debugSummary?: unknown;
            debugFreshness?: unknown;
        };
    };
    delete projection.requestId;
    if (projection.hints) {
        delete projection.hints.debugSearch;
        delete projection.hints.debugSummary;
        delete projection.hints.debugFreshness;
    }
    for (const result of projection.results ?? []) {
        delete (result as SearchPayloadResult & { debug?: unknown }).debug;
    }
    return Buffer.byteLength(JSON.stringify(projection), 'utf8');
}

function roundMetric(value: number): number {
    return Number(value.toFixed(6));
}

function summarizeResults(results: SearchQualityWorkloadResult[]): SearchQualityEvaluationArtifact['summary'] {
    const count = Math.max(1, results.length);
    return {
        ownerAtOneRate: roundMetric(results.filter((result) => result.ownerRank === 1).length / count),
        ownerAtThreeRate: roundMetric(results.filter((result) => result.ownerRank !== null && result.ownerRank <= 3).length / count),
        macroReciprocalRank: roundMetric(results.reduce((total, result) => total + result.reciprocalRank, 0) / count),
        meanRoleCoverage: roundMetric(results.reduce((total, result) => total + result.roleCoverage, 0) / count),
        meanDuplicateFamilyRate: roundMetric(results.reduce((total, result) => total + result.duplicateFamilyRate, 0) / count),
        totalSemanticSearchCalls: results.reduce((total, result) => total + result.provider.semanticSearchCalls, 0),
        totalEmbeddingCallsByCurrentContract: results.reduce((total, result) => total + result.provider.embeddingCallsByCurrentContract, 0),
        totalDenseQueriesByCurrentContract: results.reduce((total, result) => total + result.provider.denseQueriesByCurrentContract, 0),
        totalSparseQueriesByCurrentContract: results.reduce((total, result) => total + result.provider.sparseQueriesByCurrentContract, 0),
        totalNonGatingVectorQueriesByCurrentContract: results.reduce((total, result) => total + result.provider.nonGatingVectorQueriesByCurrentContract, 0),
        totalRerankCalls: results.reduce((total, result) => total + result.provider.rerankCalls, 0),
        totalRerankerInputBytes: results.reduce((total, result) => total + result.provider.rerankerInputBytes, 0),
        totalResponseBytes: results.reduce((total, result) => total + result.responseBytes, 0),
    };
}

function gitValue(workspaceRoot: string, args: string[]): string {
    const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function getRepositoryIdentity(
    workspaceRoot: string,
    excludedRelativePaths: readonly string[],
): SearchQualityEvaluationArtifact['repository'] {
    const pathspec = excludedRelativePaths.length === 0
        ? []
        : [
            '--',
            '.',
            ...excludedRelativePaths.map((relativePath) => (
                `:(exclude,literal)${relativePath.replace(/\\/g, '/')}`
            )),
        ];
    const unstaged = gitValue(workspaceRoot, ['diff', '--binary', ...pathspec]);
    const staged = gitValue(workspaceRoot, ['diff', '--cached', '--binary', ...pathspec]);
    const files = gitValue(workspaceRoot, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        ...pathspec,
    ])
        .split('\n')
        .filter((relativePath) => relativePath.length > 0)
        .sort();
    const workingTreeContent = files.map((relativePath) => {
        const absolutePath = path.join(workspaceRoot, relativePath);
        return `${relativePath}\0${sha256(fs.readFileSync(absolutePath))}`;
    }).join('\n');
    return {
        head: gitValue(workspaceRoot, ['rev-parse', 'HEAD']),
        tree: gitValue(workspaceRoot, ['write-tree']),
        diffSha256: sha256(unstaged),
        diffCachedSha256: sha256(staged),
        workingTreeContentSha256: sha256(workingTreeContent),
    };
}

async function withSearchLogsSuppressed<T>(run: () => Promise<T>): Promise<T> {
    const originalLog = console.log;
    const originalInfo = console.info;
    console.log = () => undefined;
    console.info = () => undefined;
    try {
        return await run();
    } finally {
        console.log = originalLog;
        console.info = originalInfo;
    }
}

export async function runSearchQualityEvaluation(
    workspaceRoot: string,
    options?: { excludeRepositoryPaths?: readonly string[] },
): Promise<SearchQualityEvaluationArtifact> {
    const fixtureRoot = path.join(workspaceRoot, 'fixtures/search-quality/v1');
    const { manifest, digest } = readManifest(fixtureRoot);
    verifyFixtureFiles(fixtureRoot, manifest);
    const environment = await createEvaluationEnvironment(workspaceRoot);
    const results: SearchQualityWorkloadResult[] = [];
    try {
        for (const workload of manifest.workloads) {
            for (const limit of REQUIRED_LIMITS) {
                environment.setWorkload(workload);
                environment.resetMetrics();
                const response = await withSearchLogsSuppressed(
                    () => environment.handlers.handleSearchCode({
                        path: environment.repoPath,
                        query: workload.query,
                        scope: workload.scope,
                        resultMode: 'grouped',
                        groupBy: 'symbol',
                        limit,
                        debugMode: 'full',
                    }),
                );
                const responseText = response.content[0]?.text ?? '{}';
                const payload = JSON.parse(responseText) as SearchPayload;
                const resultIds = (payload.results ?? [])
                    .map((result) => identifyPayloadResult(
                        result,
                        manifest,
                        environment.candidateIdBySymbolInstanceId,
                    ))
                    .filter((candidateId): candidateId is string => candidateId !== null);
                const ownerIndex = resultIds.findIndex((candidateId) => workload.expectedOwners.includes(candidateId));
                const ownerRank = ownerIndex >= 0 ? ownerIndex + 1 : null;
                const rolesPresent = Array.from(new Set(resultIds
                    .map((candidateId) => environment.candidateById.get(candidateId)?.role)
                    .filter((role): role is CandidateRole => role !== undefined)));
                const coveredRoles = workload.requiredRoles.filter((role) => rolesPresent.includes(role));
                const families = resultIds
                    .map((candidateId) => environment.candidateById.get(candidateId)?.family)
                    .filter((family): family is string => family !== undefined);
                const duplicateCount = families.length - new Set(families).size;
                const responseBytes = measureModelVisibleResponseBytes(payload);
                results.push({
                    workloadId: workload.id,
                    limit,
                    status: payload.status ?? 'unknown',
                    ownerRank,
                    reciprocalRank: ownerRank === null ? 0 : roundMetric(1 / ownerRank),
                    roleCoverage: workload.requiredRoles.length === 0
                        ? 1
                        : roundMetric(coveredRoles.length / workload.requiredRoles.length),
                    rolesPresent,
                    duplicateFamilyRate: families.length === 0
                        ? 0
                        : roundMetric(duplicateCount / families.length),
                    resultIds,
                    responseBytes,
                    estimatedResponseTokens: Math.ceil(responseBytes / 4),
                    toolCalls: 1,
                    ownerAvailableInInitialSearch: ownerRank !== null,
                    provider: environment.readMetrics(),
                    routeObservation: {
                        selectedRoute: payload.hints?.debugSearch?.route?.kind ?? null,
                        routeReason: payload.hints?.debugSearch?.route?.reason ?? null,
                        queryIntent: payload.hints?.debugSearch?.queryIntent?.classification ?? null,
                        retrievalMode: payload.hints?.debugSearch?.retrieval?.mode ?? null,
                        semanticExpansionAttempted: payload.hints?.debugSearch?.semanticExpansion?.attempted === true,
                        semanticExpansionReason: payload.hints?.debugSearch?.semanticExpansion?.reason ?? null,
                        primaryScopedCandidateCount: typeof payload.hints?.debugSearch?.semanticExpansion?.primaryScopedCandidateCount === 'number'
                            ? payload.hints.debugSearch.semanticExpansion.primaryScopedCandidateCount
                            : null,
                        passesUsed: [...(payload.hints?.debugSearch?.passesUsed ?? [])].sort(),
                    },
                    warningCodes: collectWarningCodes(payload),
                    budgetChecks: {
                        toolCalls: 1 <= workload.budgets.maxToolCalls,
                        responseBytes: responseBytes <= workload.budgets.maxResponseBytes,
                    },
                });
            }
        }
    } finally {
        environment.dispose();
    }

    return {
        schemaVersion: 2,
        fixtureId: manifest.fixtureId,
        fixtureManifestSha256: digest,
        repository: getRepositoryIdentity(
            workspaceRoot,
            options?.excludeRepositoryPaths ?? [],
        ),
        providerContract: 'hybrid_v3_sparse_routes',
        limits: [...REQUIRED_LIMITS],
        workloadCount: manifest.workloads.length,
        results,
        summary: summarizeResults(results),
    };
}
