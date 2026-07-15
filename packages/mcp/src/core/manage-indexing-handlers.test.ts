import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
    FileSynchronizer,
    IndexPolicyPublicationError,
    SynchronizerCheckpointPublicationError,
} from "@zokizuan/satori-core";
import { ManageIndexingHandlers } from "./manage-indexing-handlers.js";
import type {
    IndexFingerprint,
    IndexOperationPhase,
    IndexOperationReceipt,
} from "../config.js";
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from "./mutation-lease.js";

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: "VoyageAI",
    embeddingModel: "voyage-code-3",
    embeddingDimension: 1024,
    vectorStoreProvider: "Milvus",
    schemaVersion: "hybrid_v3",
    parserVersion: "parser-v1",
    extractorVersion: "extractor-v1",
    relationshipVersion: "relationships-v1",
};

const DEFAULT_INDEX_SOURCE = "export const value = 1;\n";

function sourceHashes(sources: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
    return new Map(Object.entries(sources).map(([relativePath, content]) => [
        relativePath,
        crypto.createHash("sha256").update(content).digest("hex"),
    ]));
}

function completedIndexResult(
    sources: Readonly<Record<string, string>> = { "index.ts": DEFAULT_INDEX_SOURCE },
    options: { totalChunks?: number } = {},
) {
    return {
        indexedFiles: Object.keys(sources).length,
        totalChunks: options.totalChunks ?? Object.keys(sources).length,
        status: "completed" as const,
        indexedFileHashes: sourceHashes(sources),
    };
}

function partialIndexResult(totalChunks: number) {
    return {
        indexedFiles: 1,
        totalChunks,
        status: "limit_reached" as const,
        indexedFileHashes: sourceHashes({ "index.ts": DEFAULT_INDEX_SOURCE }),
    };
}

function buildMarker(codebasePath: string, overrides: Record<string, unknown> = {}) {
    return {
        kind: 'satori_index_completion_v3' as const,
        codebasePath,
        fingerprint: RUNTIME_FINGERPRINT,
        indexedFiles: 3,
        totalChunks: 9,
        completedAt: new Date(0).toISOString(),
        runId: 'test-run',
        indexPolicyHash: 'a'.repeat(64),
        indexStatus: 'completed' as const,
        navigation: { status: 'not_bound' as const },
        ...overrides,
    };
}

const REPAIR_PROOF = {
    collection: { status: "matched", basis: "selected_snapshot_collection" },
    snapshot: { status: "matched", basis: "verified_snapshot_fingerprint" },
    marker: { status: "missing", basis: "completion_marker_missing" },
    fingerprint: { status: "matched", basis: "verified_snapshot_fingerprint" },
    payload: { status: "matched", expectedCount: 2, observedCount: 2, missingCount: 0 },
    staleRemoteChunks: { status: "matched", extraCount: 0 },
    navigation: { status: "matched", basis: "navigation_sidecars_rebuilt" },
} as const;

type StartBackgroundIndexing = {
    startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        writeCollectionName?: string,
        mutationLease?: RootMutationLease,
        previousIndexedInfo?: Record<string, unknown>,
        policyUpdate?: { customExtensions?: string[]; customIgnorePatterns?: string[] },
    ): Promise<void>;
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-manage-indexing-"));
    const repoPath = path.join(tempDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.ts"), DEFAULT_INDEX_SOURCE);
    return fn(repoPath).finally(async () => {
        await FileSynchronizer.deleteSnapshot(repoPath);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function resolveCollectionName(codebasePath: string): string {
    const digest = crypto.createHash("md5").update(path.resolve(codebasePath)).digest("hex").slice(0, 8);
    return `hybrid_code_chunks_${digest}`;
}

type RepairResult = {
    status: "ok" | "blocked" | "requires_reindex";
    reason?: "needs_create" | "requires_reindex";
    message: string;
    missingCount?: number;
    warnings?: string[];
    indexedFiles?: number;
    totalChunks?: number;
    trackedRelativePaths?: string[];
    collectionName?: string;
    proof?: Record<string, { status: string; [key: string]: unknown }>;
};

type RepairOptionsLike = {
    onProofUpdate?: (proof: Record<string, { status: string; [key: string]: unknown }>) => void;
    assertMutationCurrent?: () => void;
    publishMutation?: (publish: () => void) => void;
};

function createRepairReceiptHarness(
    repoPath: string,
    options: {
        withLease?: boolean;
        failAcceptedSave?: boolean;
        repairIndex?: (repairOptions?: RepairOptionsLike) => Promise<RepairResult>;
        touchWatchedCodebase?: () => Promise<void>;
    } = {},
) {
    const events: string[] = [];
    const persisted: Array<{ phase: IndexOperationPhase; indexed: boolean }> = [];
    let receipt: IndexOperationReceipt | undefined;
    let indexed = false;
    let compatibilitySaveCalls = 0;
    let repairCalls = 0;
    let failedAcceptedSave = false;
    const coordinator = options.withLease === false
        ? undefined
        : new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "repair-receipt-leases"),
            ownerId: "repair-receipt-owner",
        });

    const handler = new ManageIndexingHandlers({
        context: {
            repairIndex: async (_codebasePath: string, repairOptions?: RepairOptionsLike) => {
                repairCalls += 1;
                events.push("repair");
                return options.repairIndex
                    ? options.repairIndex(repairOptions)
                    : {
                        status: "ok" as const,
                        message: "repaired",
                        indexedFiles: 1,
                        totalChunks: 2,
                        warnings: [],
                        trackedRelativePaths: ["src/repaired.ts"],
                        collectionName: "repair-collection",
                        proof: REPAIR_PROOF,
                    };
            },
        },
        snapshotManager: {
            startOperation: (lease: RootMutationLease) => {
                events.push("start:accepted");
                receipt = {
                    id: lease.operationId,
                    action: lease.action,
                    canonicalRoot: lease.canonicalRoot,
                    generation: lease.generation,
                    acceptedAt: lease.acquiredAt,
                    phase: "accepted",
                    lastDurableTransitionAt: lease.acquiredAt,
                    runtimeFingerprint: RUNTIME_FINGERPRINT,
                    writer: {
                        ownerId: lease.ownerId,
                        pid: lease.pid,
                        satoriVersion: "test",
                    },
                };
                return receipt;
            },
            transitionOperation: (_lease: RootMutationLease, phase: IndexOperationPhase) => {
                assert.ok(receipt);
                events.push(`transition:${phase}`);
                receipt = {
                    ...receipt,
                    phase,
                    lastDurableTransitionAt: new Date().toISOString(),
                };
                return receipt;
            },
            saveCodebaseSnapshot: () => {
                assert.ok(receipt);
                events.push(`save:${receipt.phase}`);
                if (options.failAcceptedSave && receipt.phase === "accepted" && !failedAcceptedSave) {
                    failedAcceptedSave = true;
                    return false;
                }
                persisted.push({ phase: receipt.phase, indexed });
                return true;
            },
            setCodebaseIndexed: () => {
                events.push("set:indexed");
                indexed = true;
            },
            setCodebaseIndexManifest: () => events.push("set:manifest"),
        },
        syncManager: {},
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        manageResponse: (action: string, responsePath: string, status: string, message: string, responseOptions?: Record<string, unknown>) => ({
            content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message, ...responseOptions }) }],
        }),
        buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
        recoverStaleIndexingStateIfNeeded: async () => {
            events.push("recover-stale-indexing");
        },
        getSnapshotIndexingCodebases: () => [],
        getSnapshotCodebaseInfo: () => ({
            status: "indexed",
            collectionName: "repair-collection",
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: "verified",
        }),
        buildManageActionBlockedMessage: () => "blocked",
        buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
        buildReindexHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "reindex", path: codebasePath } }),
        buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
        getManageRetryAfterMs: () => 2000,
        buildIndexingMetadata: () => undefined,
        buildManageRequiresReindexHints: () => ({}),
        manageVectorBackendResponse: (
            action: string,
            responsePath: string,
            diagnostic: { code: string; message: string },
            _humanText?: string,
            operation?: IndexOperationReceipt,
            repairProof?: Record<string, unknown>,
        ) => ({
            content: [{
                type: "text",
                text: JSON.stringify({
                    action,
                    path: responsePath,
                    status: "error",
                    code: diagnostic.code,
                    message: diagnostic.message,
                    operation,
                    repairProof,
                }),
            }],
        }),
        getContextTrackedRelativePaths: () => [],
        setIndexingStats: () => undefined,
        rebuildCallGraphForIndex: async () => events.push("rebuild:call-graph"),
        touchWatchedCodebase: options.touchWatchedCodebase
            ?? (async () => { events.push("touch:watch"); }),
        saveSnapshotIfSupported: () => {
            compatibilitySaveCalls += 1;
            events.push("save:compatibility");
        },
        mutationLeaseCoordinator: coordinator,
    } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

    return {
        coordinator,
        events,
        get compatibilitySaveCalls() {
            return compatibilitySaveCalls;
        },
        get persisted() {
            return persisted;
        },
        get repairCalls() {
            return repairCalls;
        },
        handler,
    };
}

function createFailedIndexingHarness(
    existingCollections: Set<string>,
    options: {
        mutationLeaseCoordinator?: MutationLeaseCoordinator;
        indexCodebase?: (
            codebasePath: string,
            progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
            forceReindex?: boolean,
            mutationOptions?: {
                assertMutationCurrent?: () => void;
                publishMutation?: (publish: () => void) => void;
            },
        ) => Promise<{
            indexedFiles: number;
            totalChunks: number;
            status: "completed" | "limit_reached";
            indexedFileHashes: ReadonlyMap<string, string>;
        }>;
        beforeHasCollection?: (collectionName: string) => void;
        touchWatchedCodebase?: () => Promise<void>;
        rebuildCallGraphForIndex?: () => Promise<void>;
        publishNavigationCandidate?: (candidate: { generationId: string }) => Promise<void>;
        pruneIndexedCollectionFamily?: (keepCollectionName: string) => Promise<string[]>;
        previousIndexedInfo?: Record<string, unknown>;
        initialCustomExtensions?: string[];
        initialCustomIgnorePatterns?: string[];
        failPolicyPublicationAfterCommit?: boolean;
        omitPolicyPublicationDocumentDigest?: boolean;
        policyPublicationDocumentDigest?: string;
        legacyRollback?: boolean;
        proveVectorGenerationError?: Error;
        recordCurrentIgnoreControlSignature?: () => Promise<void>;
    } = {},
) {
    const droppedCollections: string[] = [];
    const failedSnapshots: Array<{ path: string; errorMessage: string; progress?: number }> = [];
    const publicationEvents: string[] = [];
    const authorityEvents: string[] = [];
    const clearedExpectedDocumentDigests: Array<string | undefined> = [];
    let publishedCustomExtensions = [...(options.initialCustomExtensions ?? [])];
    let publishedCustomIgnorePatterns = [...(options.initialCustomIgnorePatterns ?? [])];
    let standardPolicyResolutionCalls = 0;
    let reindexPolicyResolutionCalls = 0;
    let writeCollectionOverride: string | null = null;
    let indexedSnapshots = 0;
    let registeredSynchronizers = 0;
    let completionMarkerClearCalls = 0;
    let publishedPolicyCollection: string | null = null;
    let publishedPolicyHash: string | null = null;
    let publishedPolicyDocumentDigest: string | null = null;
    let publishedMarker: ReturnType<typeof buildMarker> | null = null;
    let publishedMarkerCollection: string | null = null;
    let navigationPublished = false;
    const publishedSnapshots: Array<{ status: string; collectionName?: string }> = [];

    const vectorStore = {
        hasCollection: async (collectionName: string) => {
            options.beforeHasCollection?.(collectionName);
            return existingCollections.has(collectionName);
        },
        dropCollection: async (collectionName: string) => {
            droppedCollections.push(collectionName);
            existingCollections.delete(collectionName);
        },
    };

    const context = {
        getVectorStore: () => vectorStore,
        indexCompletionMarkersEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
        loadResolvedIgnorePatterns: async () => undefined,
        resolveIndexPolicyForCodebase: async (_root: string, update: { customExtensions?: string[]; customIgnorePatterns?: string[] } = {}) => {
            standardPolicyResolutionCalls += 1;
            return {
                canonicalRoot: path.resolve(_root),
                profile: 'default',
                customExtensions: update.customExtensions ?? publishedCustomExtensions,
                customIgnorePatterns: update.customIgnorePatterns ?? publishedCustomIgnorePatterns,
                supportedExtensions: ['.ts', ...(update.customExtensions ?? publishedCustomExtensions)],
                effectiveIgnorePatterns: update.customIgnorePatterns ?? publishedCustomIgnorePatterns,
                policyHash: crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex'),
            };
        },
        resolveIndexPolicyForReindex: async (_root: string, update: { customExtensions?: string[]; customIgnorePatterns?: string[] } = {}) => {
            reindexPolicyResolutionCalls += 1;
            return {
                canonicalRoot: path.resolve(_root),
                profile: 'default',
                customExtensions: update.customExtensions ?? [],
                customIgnorePatterns: update.customIgnorePatterns ?? [],
                supportedExtensions: ['.ts', ...(update.customExtensions ?? [])],
                effectiveIgnorePatterns: update.customIgnorePatterns ?? [],
                policyHash: crypto.createHash('sha256').update(JSON.stringify(update)).digest('hex'),
            };
        },
        publishResolvedIndexPolicy: (
            policy: { canonicalRoot: string; policyHash: string; customExtensions: string[]; customIgnorePatterns: string[] },
            binding: {
                collectionName: string;
                navigation:
                    | { status: 'not_bound' }
                    | { status: 'sealed'; generationId: string; sealHash: string };
            },
            publishMutation?: (publish: () => void) => void,
        ) => {
            const receipt = {
                status: 'committed' as const,
                operation: 'publish' as const,
                canonicalRoot: policy.canonicalRoot,
                ...(options.omitPolicyPublicationDocumentDigest
                    ? {}
                    : { documentDigest: options.policyPublicationDocumentDigest ?? 'a'.repeat(64) }),
                policyHash: policy.policyHash,
                collectionName: binding.collectionName,
                navigation: { ...binding.navigation },
            };
            const publish = () => {
                publishedCustomExtensions = [...policy.customExtensions];
                publishedCustomIgnorePatterns = [...policy.customIgnorePatterns];
                publishedPolicyCollection = binding.collectionName;
                publishedPolicyHash = policy.policyHash;
                publishedPolicyDocumentDigest = receipt.documentDigest ?? null;
                publicationEvents.push('policy:publish');
            };
            if (publishMutation) {
                publishMutation(publish);
            } else {
                publish();
            }
            if (options.failPolicyPublicationAfterCommit) {
                throw new IndexPolicyPublicationError(
                    'policy committed before acknowledgement failed',
                    receipt,
                    new Error('publication wrapper rejected receipt'),
                );
            }
            return receipt;
        },
        clearPublishedIndexPolicy: (
            _canonicalRoot: string,
            publishMutation: (publish: () => void) => void,
            expectedDocumentDigest?: string,
        ) => {
            clearedExpectedDocumentDigests.push(expectedDocumentDigest);
            publishMutation(() => {
                publishedCustomExtensions = [];
                publishedCustomIgnorePatterns = [];
                publicationEvents.push('policy:clear');
            });
        },
        captureDurableIndexAuthority: () => {
            authorityEvents.push('capture');
            return {
                canonicalRoot: '/test/repo',
                policyDocument: { content: '{"legacyPolicy":true}', digest: 'b'.repeat(64) },
                navigationPointer: { content: '{"legacyPointer":true}', digest: 'c'.repeat(64) },
                testPolicy: {
                    customExtensions: [...publishedCustomExtensions],
                    customIgnorePatterns: [...publishedCustomIgnorePatterns],
                },
            };
        },
        restoreDurableIndexAuthority: async (snapshot: { testPolicy?: { customExtensions: string[]; customIgnorePatterns: string[] } }) => {
            authorityEvents.push('restore');
            publishedCustomExtensions = [...(snapshot.testPolicy?.customExtensions ?? [])];
            publishedCustomIgnorePatterns = [...(snapshot.testPolicy?.customIgnorePatterns ?? [])];
        },
        getCurrentNavigationGeneration: async () => null,
        restoreNavigationGeneration: async () => {
            publicationEvents.push('navigation:restore');
        },
        registerSynchronizer: () => {
            registeredSynchronizers += 1;
        },
        getEmbeddingEngine: () => ({
            getProvider: () => "VoyageAI",
            getDimension: () => 1024,
        }),
        indexCodebase: async (...args: Parameters<NonNullable<typeof options.indexCodebase>>) => {
            // The production Context full-rebuild owner creates the staged
            // collection. Keep failure-cleanup fixtures faithful without
            // reintroducing the removed background-worker pre-create.
            if (writeCollectionOverride) {
                existingCollections.add(writeCollectionOverride);
            }
            const result = options.indexCodebase
                ? await options.indexCodebase(...args)
                : await Promise.reject(new Error("boom after staged collection create"));
            return result.status === "completed"
                ? {
                    ...result,
                    navigationCandidate: {
                        rootPath: "/tmp/navigation",
                        normalizedRootPath: args[0],
                        manifestHash: "manifest-hash",
                        relationshipManifestHash: "relationship-manifest-hash",
                        generationId: "candidate-generation",
                        fileShardCount: 1,
                        symbolCount: 1,
                        relationshipCount: 0,
                        relationshipFileShardCount: 1,
                    },
                }
                : result;
        },
        publishCompletedIndexMarker: async (_path: string, _files: number, _chunks: number, _collection: string, status: string, _guard?: unknown, _candidate?: unknown, policyHash?: string, runId?: string) => {
            publishedMarkerCollection = _collection;
            publishedMarker = buildMarker("repo", {
                indexedFiles: _files,
                totalChunks: _chunks,
                indexStatus: status,
                indexPolicyHash: policyHash ?? 'a'.repeat(64),
                runId: runId ?? 'run_candidate',
                navigation: status === "completed"
                    ? {
                        status: "sealed",
                        generationId: "candidate-generation",
                        symbolRegistryManifestHash: "manifest-hash",
                        relationshipManifestHash: "relationship-manifest-hash",
                        sealHash: "navigation-seal-hash",
                    }
                    : { status: "not_bound" },
            });
            publicationEvents.push(`marker:${status}`);
        },
        publishNavigationCandidate: async (candidate: { generationId: string }) => {
            publicationEvents.push(`navigation:publish:${candidate.generationId}`);
            await options.publishNavigationCandidate?.(candidate);
            navigationPublished = true;
        },
        discardNavigationCandidate: async (candidate: { generationId: string }) => {
            publicationEvents.push(`navigation:discard:${candidate.generationId}`);
        },
        getCompletionProofCollectionName: async () => (
            typeof options.previousIndexedInfo?.collectionName === "string"
                ? options.previousIndexedInfo.collectionName
                : null
        ),
        getActiveIndexedCollectionName: async () => (
            typeof options.previousIndexedInfo?.collectionName === "string"
                ? options.previousIndexedInfo.collectionName
                : null
        ),
        getIndexCompletionMarker: async () => options.previousIndexedInfo
            ? buildMarker("repo", {
                indexedFiles: Number(options.previousIndexedInfo.indexedFiles ?? 0),
                totalChunks: Number(options.previousIndexedInfo.totalChunks ?? 0),
                indexStatus: options.previousIndexedInfo.indexStatus === "limit_reached" ? "limit_reached" : "completed",
            })
            : null,
        resolveProvenGeneration: async (root: string) => {
            if (options.legacyRollback) return null;
            if (!options.previousIndexedInfo || typeof options.previousIndexedInfo.collectionName !== 'string') return null;
            return {
                collectionName: options.previousIndexedInfo.collectionName,
                marker: buildMarker('repo', {
                    indexedFiles: Number(options.previousIndexedInfo.indexedFiles ?? 0),
                    totalChunks: Number(options.previousIndexedInfo.totalChunks ?? 0),
                    indexStatus: options.previousIndexedInfo.indexStatus === 'limit_reached' ? 'limit_reached' as const : 'completed' as const,
                }),
                navigation: null,
                policy: {
                    canonicalRoot: path.resolve(root),
                    profile: 'default' as const,
                    customExtensions: [...publishedCustomExtensions],
                    customIgnorePatterns: [...publishedCustomIgnorePatterns],
                    fileBasedIgnorePatterns: [],
                    supportedExtensions: ['.ts', ...publishedCustomExtensions],
                    effectiveIgnorePatterns: [...publishedCustomIgnorePatterns],
                    policyHash: 'policy-hash',
                },
            };
        },
        proveVectorGeneration: async (root: string) => {
            if (
                publishedMarker
                && publishedMarkerCollection
                && publishedPolicyCollection === publishedMarkerCollection
                && publishedPolicyHash === publishedMarker.indexPolicyHash
            ) {
                return {
                    collectionName: publishedMarkerCollection,
                    marker: publishedMarker,
                    policyDocumentDigest: publishedPolicyDocumentDigest ?? 'a'.repeat(64),
                    policy: {
                        canonicalRoot: path.resolve(root),
                        profile: 'default' as const,
                        customExtensions: [...publishedCustomExtensions],
                        customIgnorePatterns: [...publishedCustomIgnorePatterns],
                        fileBasedIgnorePatterns: [],
                        supportedExtensions: ['.ts', ...publishedCustomExtensions],
                        effectiveIgnorePatterns: [...publishedCustomIgnorePatterns],
                        policyHash: publishedPolicyHash,
                    },
                };
            }
            if (options.proveVectorGenerationError) throw options.proveVectorGenerationError;
            if (!options.previousIndexedInfo || typeof options.previousIndexedInfo.collectionName !== 'string') return null;
            return {
                collectionName: options.previousIndexedInfo.collectionName,
                marker: buildMarker('repo', {
                    indexedFiles: Number(options.previousIndexedInfo.indexedFiles ?? 0),
                    totalChunks: Number(options.previousIndexedInfo.totalChunks ?? 0),
                    indexStatus: 'completed' as const,
                }),
                policy: {
                    canonicalRoot: path.resolve(root),
                    profile: 'default' as const,
                    customExtensions: [...publishedCustomExtensions],
                    customIgnorePatterns: [...publishedCustomIgnorePatterns],
                    fileBasedIgnorePatterns: [],
                    supportedExtensions: ['.ts', ...publishedCustomExtensions],
                    effectiveIgnorePatterns: [...publishedCustomIgnorePatterns],
                    policyHash: 'policy-hash',
                },
            };
        },
        proveIndexedGeneration: async (root: string) => {
            if (!navigationPublished) return null;
            return context.proveVectorGeneration(root);
        },
    };

    const host = {
        context,
        snapshotManager: {
            setCodebaseIndexing: () => undefined,
            setCodebaseIndexFailed: (codebasePath: string, errorMessage: string, progress?: number) => {
                failedSnapshots.push({ path: codebasePath, errorMessage, progress });
            },
            setCodebaseIndexed: (_path: string, stats: { status: string }, _fingerprint?: unknown, _source?: unknown, collectionName?: string) => {
                indexedSnapshots += 1;
                publishedSnapshots.push({ status: stats.status, collectionName });
            },
            setCodebaseIndexManifest: () => undefined,
            setCodebaseCallGraphSidecar: () => undefined,
        },
        syncManager: {
            recordCurrentIgnoreControlSignature: options.recordCurrentIgnoreControlSignature
                ?? (async () => undefined),
        },
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        resolveCollectionName,
        setWriteCollectionOverride: (_codebasePath: string, collectionName: string | null) => {
            writeCollectionOverride = collectionName;
        },
        loadIndexProfileForCodebase: () => ({ profile: "default" }),
        getContextActiveIgnorePatterns: () => [],
        getContextIndexedExtensions: () => [".ts"],
        canonicalizeCodebasePath: (codebasePath: string) => path.resolve(codebasePath),
        getSnapshotCodebaseInfo: () => options.previousIndexedInfo,
        pruneIndexedCollectionFamily: async (_codebasePath: string, keepCollectionName: string) =>
            options.pruneIndexedCollectionFamily?.(keepCollectionName) ?? [],
        pruneUnprovenStagedCollectionFamily: async () => [],
        getContextTrackedRelativePaths: () => [],
        setIndexingStats: () => undefined,
        rebuildCallGraphForIndex: options.rebuildCallGraphForIndex ?? (async () => undefined),
        touchWatchedCodebase: options.touchWatchedCodebase ?? (async () => undefined),
        saveSnapshotIfSupported: () => undefined,
        clearIndexCompletionMarker: async () => {
            completionMarkerClearCalls += 1;
        },
        getSnapshotIndexingProgress: () => 42,
        buildCollectionLimitMessage: async () => "collection limit",
        mutationLeaseCoordinator: options.mutationLeaseCoordinator,
    };

    return {
        droppedCollections,
        failedSnapshots,
        get indexedSnapshots() {
            return indexedSnapshots;
        },
        get registeredSynchronizers() {
            return registeredSynchronizers;
        },
        get completionMarkerClearCalls() {
            return completionMarkerClearCalls;
        },
        get publishedMarker() {
            return publishedMarker;
        },
        get reindexPolicyResolutionCalls() {
            return reindexPolicyResolutionCalls;
        },
        get standardPolicyResolutionCalls() {
            return standardPolicyResolutionCalls;
        },
        publishedSnapshots,
        publicationEvents,
        authorityEvents,
        clearedExpectedDocumentDigests,
        get publishedCustomExtensions() {
            return publishedCustomExtensions;
        },
        get publishedCustomIgnorePatterns() {
            return publishedCustomIgnorePatterns;
        },
        handler: new ManageIndexingHandlers(host as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]) as unknown as StartBackgroundIndexing,
    };
}

function createIndexLaunchHarness(
    repoPath: string,
    options: {
        canonicalizeCodebasePath?: (codebasePath: string) => string;
        startBackgroundIndexing?: (codebasePath: string, lease?: RootMutationLease) => Promise<void> | void;
        touchWatchedCodebase?: (codebasePath: string) => Promise<void>;
        assertIndexMutationCapabilities?: (coordinator: MutationLeaseCoordinator) => void;
        initialIndexed?: boolean;
    } = {},
) {
    const coordinator = new MutationLeaseCoordinator({
        stateDir: path.join(path.dirname(repoPath), "launch-leases"),
        ownerId: "launch-owner",
    });
    let lifecycle: "not_found" | "indexing" | "indexed" | "indexfailed" = options.initialIndexed ? "indexed" : "not_found";
    let failedCalls = 0;
    let saveCalls = 0;
    let canonicalizeCalls = 0;
    const launchedRoots: string[] = [];
    const failedRoots: string[] = [];
    const ownerCheckedRoots: string[] = [];
    const preflightRoots: string[] = [];
    const handler = new ManageIndexingHandlers({
        context: {
            getVectorStore: () => ({ checkCollectionLimit: async () => true }),
            resolveProvenGeneration: async () => options.initialIndexed ? {
                collectionName: resolveCollectionName(repoPath),
                marker: buildMarker(repoPath, {
                    indexedFiles: 3,
                    totalChunks: 9,
                    indexStatus: 'completed',
                }),
                navigation: null,
            } : null,
            proveVectorGeneration: async () => options.initialIndexed ? {
                collectionName: resolveCollectionName(repoPath),
                marker: buildMarker(repoPath, {
                    indexedFiles: 3,
                    totalChunks: 9,
                    indexStatus: 'completed',
                }),
            } : null,
            getActiveIndexedCollectionName: async () => options.initialIndexed ? resolveCollectionName(repoPath) : null,
            getIndexCompletionMarker: async () => options.initialIndexed ? buildMarker(repoPath, {
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: 'completed',
            }) : null,
        },
        snapshotManager: {
            setCodebaseIndexing: () => { lifecycle = "indexing"; },
            setCodebaseIndexFailed: (codebasePath: string) => {
                lifecycle = "indexfailed";
                failedCalls += 1;
                failedRoots.push(codebasePath);
            },
            setCodebaseIndexed: () => { lifecycle = "indexed"; },
            saveCodebaseSnapshot: () => {
                saveCalls += 1;
                return true;
            },
        },
        syncManager: {},
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        startBackgroundIndexing: (codebasePath: string, _force: boolean, _collection?: string, lease?: RootMutationLease) => {
            launchedRoots.push(codebasePath);
            return options.startBackgroundIndexing?.(codebasePath, lease);
        },
        manageResponse: (action: string, responsePath: string, status: string, message: string, responseOptions?: Record<string, unknown>) => ({
            content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message, ...responseOptions }) }],
        }),
        buildRuntimeOwnerConflictResponseIfBlocked: async (_action: string, codebasePath: string) => {
            ownerCheckedRoots.push(codebasePath);
            return null;
        },
        recoverStaleIndexingStateIfNeeded: async () => undefined,
        getSnapshotIndexingCodebases: () => lifecycle === "indexing" ? [repoPath] : [],
        getSnapshotCodebaseInfo: () => lifecycle === "not_found" ? undefined : lifecycle === "indexed" || (options.initialIndexed && lifecycle === "indexing") ? {
            status: lifecycle,
            indexedFiles: 3,
            totalChunks: 9,
            indexStatus: 'completed',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified',
            collectionName: resolveCollectionName(repoPath),
        } : { status: lifecycle },
        getSnapshotIndexedCodebases: () => lifecycle === "indexed" ? [repoPath] : [],
        buildManageActionBlockedMessage: () => "blocked",
        buildCreateHint: () => ({}),
        buildReindexHint: () => ({}),
        buildStatusHint: () => ({}),
        getManageRetryAfterMs: () => 2000,
        buildIndexingMetadata: () => undefined,
        buildReindexInstruction: () => "reindex",
        buildManageRequiresReindexHints: () => ({}),
        validateCompletionProof: async () => ({ outcome: "stale_local", reason: "missing_marker_doc" }),
        recoverIndexedSnapshotFromCompletionProof: async () => false,
        isZillizBackend: () => false,
        resolveCollectionName,
        dropZillizCollectionForCreate: async () => ({ status: "unmapped" }),
        resolveStagedCollectionName: (codebasePath: string, generationId: string) => `${resolveCollectionName(codebasePath)}__gen_${generationId}`,
        buildCollectionLimitMessage: async () => "collection limit",
        manageVectorBackendResponse: () => ({ content: [{ type: "text", text: "backend error" }] }),
        saveSnapshotIfSupported: () => {
            saveCalls += 1;
        },
        touchWatchedCodebase: options.touchWatchedCodebase ?? (async () => undefined),
        setWriteCollectionOverride: () => undefined,
        loadIndexProfileForCodebase: () => ({ profile: "default" }),
        getContextActiveIgnorePatterns: () => [],
        getContextIndexedExtensions: () => [".ts"],
        canonicalizeCodebasePath: (codebasePath: string) => {
            canonicalizeCalls += 1;
            return options.canonicalizeCodebasePath?.(codebasePath) ?? fs.realpathSync(codebasePath);
        },
        pruneIndexedCollectionFamily: async () => [],
        pruneUnprovenStagedCollectionFamily: async () => [],
        getContextTrackedRelativePaths: () => [],
        setIndexingStats: () => undefined,
        rebuildCallGraphForIndex: async () => undefined,
        getSnapshotIndexingProgress: () => 0,
        clearIndexCompletionMarker: async () => undefined,
        evaluateReindexPreflight: (codebasePath: string) => {
            preflightRoots.push(codebasePath);
            return { outcome: "unknown", warnings: [] };
        },
        assertIndexMutationCapabilities: () => options.assertIndexMutationCapabilities?.(coordinator),
        mutationLeaseCoordinator: coordinator,
    } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

    return {
        coordinator,
        handler,
        launchedRoots,
        get canonicalizeCalls() {
            return canonicalizeCalls;
        },
        get failedCalls() {
            return failedCalls;
        },
        failedRoots,
        get lifecycle() {
            return lifecycle;
        },
        ownerCheckedRoots,
        preflightRoots,
        get saveCalls() {
            return saveCalls;
        },
    };
}

test("background worker leaves lease release to its launcher", async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), "lease-state");
        const currentProcess = { pid: 101, processStartTime: "start-101" };
        const coordinator = new MutationLeaseCoordinator({
            stateDir,
            ownerId: "owner-a",
            currentProcess,
            processInspector: {
                inspect: (pid) => pid === currentProcess.pid ? currentProcess : null,
            },
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let finishIndexing!: (value: ReturnType<typeof completedIndexResult>) => void;
        const indexing = new Promise<ReturnType<typeof completedIndexResult>>((resolve) => {
            finishIndexing = resolve;
        });
        let signalIndexStarted!: () => void;
        const indexStarted = new Promise<void>((resolve) => {
            signalIndexStarted = resolve;
        });
        let indexPublicationRan = false;
        const { handler } = createFailedIndexingHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: (_path, _progress, _force, mutationOptions) => {
                assert.equal(typeof mutationOptions?.assertMutationCurrent, "function");
                assert.equal(typeof mutationOptions?.publishMutation, "function");
                mutationOptions?.publishMutation?.(() => {
                    indexPublicationRan = true;
                });
                signalIndexStarted();
                return indexing;
            },
        });

        const background = handler.startBackgroundIndexing(repoPath, false, undefined, acquired.lease);
        await indexStarted;
        assert.equal(coordinator.isCurrent(acquired.lease), true);
        assert.equal(indexPublicationRan, true);

        finishIndexing(completedIndexResult());
        await background;
        assert.equal(coordinator.isCurrent(acquired.lease), true);
        coordinator.release(acquired.lease);
    });
});

test("handleIndexCodebase launcher releases an injected worker lease exactly once", async () => {
    await withTempRepo(async (repoPath) => {
        let finishWorker!: () => void;
        const worker = new Promise<void>((resolve) => { finishWorker = resolve; });
        const harness = createIndexLaunchHarness(repoPath, {
            startBackgroundIndexing: () => worker,
        });
        const originalRelease = harness.coordinator.release.bind(harness.coordinator);
        let releaseCalls = 0;
        harness.coordinator.release = (lease) => {
            releaseCalls += 1;
            return originalRelease(lease);
        };

        const response = await harness.handler.handleIndexCodebase({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);
        const activeLease = harness.coordinator.getActiveLease(repoPath);
        assert.equal(payload.status, "ok");
        assert.ok(activeLease);
        assert.equal(releaseCalls, 0);

        finishWorker();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(harness.coordinator.getActiveLease(repoPath), undefined);
        assert.equal(releaseCalls, 1);
    });
});

test("handleIndexCodebase launcher publishes failed lifecycle when an injected worker rejects", async () => {
    await withTempRepo(async (repoPath) => {
        let rejectWorker!: (error: Error) => void;
        const worker = new Promise<void>((_resolve, reject) => { rejectWorker = reject; });
        const harness = createIndexLaunchHarness(repoPath, {
            startBackgroundIndexing: () => worker,
        });

        const response = await harness.handler.handleIndexCodebase({ path: repoPath });
        assert.equal(JSON.parse(response.content[0].text).status, "ok");

        rejectWorker(new Error("injected worker failed"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(harness.lifecycle, "indexfailed");
        assert.equal(harness.failedCalls, 1);
        assert.equal(harness.saveCalls, 2);
        assert.equal(harness.coordinator.getActiveLease(repoPath), undefined);
    });
});

test("handleIndexCodebase validates mutation capabilities before acquiring a lease", async () => {
    await withTempRepo(async (repoPath) => {
        let capabilityChecks = 0;
        let leaseWasActiveDuringCapabilityCheck = false;
        const harness = createIndexLaunchHarness(repoPath, {
            assertIndexMutationCapabilities: (coordinator) => {
                capabilityChecks += 1;
                leaseWasActiveDuringCapabilityCheck = coordinator.getActiveLease(repoPath) !== undefined;
                throw new Error("mutation capabilities unavailable");
            },
        });

        const response = await harness.handler.handleIndexCodebase({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "error");
        assert.match(payload.message, /mutation capabilities unavailable/i);
        assert.equal(capabilityChecks, 1);
        assert.equal(leaseWasActiveDuringCapabilityCheck, false);
        assert.equal(harness.lifecycle, "not_found");
        assert.equal(harness.saveCalls, 0);
        assert.deepEqual(harness.launchedRoots, []);
        assert.equal(harness.coordinator.getActiveLease(repoPath), undefined);
    });
});

test("handleIndexCodebase foreground failure after indexing publication becomes indexfailed", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createIndexLaunchHarness(repoPath, {
            touchWatchedCodebase: async () => {
                throw new Error("watcher setup failed");
            },
        });

        const response = await harness.handler.handleIndexCodebase({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "error");
        assert.match(payload.message, /watcher setup failed/i);
        assert.equal(harness.lifecycle, "indexfailed");
        assert.equal(harness.failedCalls, 1);
        assert.equal(harness.saveCalls, 2);
        assert.equal(harness.launchedRoots.length, 0);
        assert.equal(harness.coordinator.getActiveLease(repoPath), undefined);
    });
});

test("handleIndexCodebase restores a live proven generation when force-reindex launch fails", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createIndexLaunchHarness(repoPath, {
            initialIndexed: true,
            touchWatchedCodebase: async () => {
                throw new Error("watcher setup failed");
            },
        });

        const response = await harness.handler.handleIndexCodebase({ path: repoPath, force: true });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "error");
        assert.equal(harness.lifecycle, "indexed");
        assert.equal(harness.failedCalls, 0);
        assert.equal(harness.launchedRoots.length, 0);
    });
});

test("handleIndexCodebase keeps the canonical root when foreground publication fails", async () => {
    await withTempRepo(async (repoPath) => {
        const aliasPath = path.join(path.dirname(repoPath), "repo-failure-alias");
        fs.symlinkSync(repoPath, aliasPath, "dir");
        const harness = createIndexLaunchHarness(repoPath, {
            canonicalizeCodebasePath: (candidate) => fs.realpathSync(candidate),
            touchWatchedCodebase: async () => {
                throw new Error("watcher setup failed");
            },
        });

        const response = await harness.handler.handleIndexCodebase({ path: aliasPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "error");
        assert.equal(payload.path, repoPath);
        assert.deepEqual(harness.failedRoots, [repoPath]);
        assert.equal(harness.canonicalizeCalls, 1);
    });
});

test("handleIndexCodebase canonicalizes the root once before lifecycle and launch", async () => {
    await withTempRepo(async (repoPath) => {
        const aliasPath = path.join(path.dirname(repoPath), "repo-alias");
        fs.symlinkSync(repoPath, aliasPath, "dir");
        const harness = createIndexLaunchHarness(repoPath, {
            canonicalizeCodebasePath: (candidate) => fs.realpathSync(candidate),
        });

        const response = await harness.handler.handleIndexCodebase({ path: aliasPath });
        const payload = JSON.parse(response.content[0].text);
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(payload.status, "ok");
        assert.equal(payload.path, repoPath);
        assert.deepEqual(harness.launchedRoots, [repoPath]);
        assert.equal(harness.canonicalizeCalls, 1);
    });
});

test("handleReindexCodebase canonicalizes once before ownership, preflight, and launch", async () => {
    await withTempRepo(async (repoPath) => {
        const aliasPath = path.join(path.dirname(repoPath), "repo-reindex-alias");
        fs.symlinkSync(repoPath, aliasPath, "dir");
        const harness = createIndexLaunchHarness(repoPath, {
            canonicalizeCodebasePath: (candidate) => fs.realpathSync(candidate),
        });

        const response = await harness.handler.handleReindexCodebase({ path: aliasPath });
        const payload = JSON.parse(response.content[0].text);
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(payload.status, "ok");
        assert.equal(payload.path, repoPath);
        assert.equal(harness.canonicalizeCalls, 1);
        assert.deepEqual(harness.preflightRoots, [repoPath]);
        assert.ok(harness.ownerCheckedRoots.length > 0);
        assert.ok(harness.ownerCheckedRoots.every((candidate) => candidate === repoPath));
        assert.deepEqual(harness.launchedRoots, [repoPath]);
    });
});

test("background indexing treats watcher touch as best effort after proof", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createFailedIndexingHarness(new Set(), {
            indexCodebase: async () => completedIndexResult(),
            touchWatchedCodebase: async () => {
                throw new Error("watcher touch failed");
            },
        });

        await harness.handler.startBackgroundIndexing(repoPath, false);

        assert.equal(harness.indexedSnapshots, 1);
        assert.equal(harness.failedSnapshots.length, 0);
        assert.deepEqual(harness.publicationEvents, [
            "marker:completed",
            "policy:publish",
            "navigation:publish:candidate-generation",
        ]);
    });
});

test("background reindex publishes an exact post-index source checkpoint with the new authority", async () => {
    await withTempRepo(async (repoPath) => {
        const sourcePath = path.join(repoPath, "index.ts");
        const staleSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await staleSynchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(repoPath);
        const staleSnapshot = fs.readFileSync(snapshotPath, "utf8");
        fs.writeFileSync(sourcePath, "export const value = 2;\n", "utf8");

        const harness = createFailedIndexingHarness(new Set(), {
            indexCodebase: async () => completedIndexResult({ "index.ts": "export const value = 2;\n" }),
        });
        await harness.handler.startBackgroundIndexing(repoPath, true);

        const candidateCollection = resolveCollectionName(repoPath);
        const candidateSnapshotPath = FileSynchronizer.getSnapshotPathForGeneration(repoPath, candidateCollection);
        assert.equal(fs.readFileSync(snapshotPath, "utf8"), staleSnapshot);
        assert.equal(fs.existsSync(candidateSnapshotPath), true);
        const verifier = new FileSynchronizer(repoPath, [], [".ts"], {
            checkpointIdentity: candidateCollection,
            checkpointAuthority: {
                collectionName: candidateCollection,
                markerRunId: harness.publishedMarker?.runId ?? 'missing-run-id',
                indexPolicyHash: harness.publishedMarker?.indexPolicyHash ?? 'a'.repeat(64),
            },
        });
        await verifier.initialize(undefined, undefined, { requireExistingCheckpoint: true });
        const firstFreshnessCheck = await verifier.prepareChanges({ forceFullHash: true });
        assert.deepEqual(firstFreshnessCheck.changes.added, []);
        assert.deepEqual(firstFreshnessCheck.changes.removed, []);
        assert.deepEqual(firstFreshnessCheck.changes.modified, []);
        assert.equal(harness.indexedSnapshots, 1);
    });
});

test("background reindex rejects an ABA source mismatch between indexed bytes and checkpoint", async () => {
    await withTempRepo(async (repoPath) => {
        const sourcePath = path.join(repoPath, "index.ts");
        const baselineSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await baselineSynchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(repoPath);
        const baselineSnapshot = fs.readFileSync(snapshotPath, "utf8");
        const harness = createFailedIndexingHarness(new Set(), {
            indexCodebase: async () => {
                const indexedContent = "export const value = 2;\n";
                fs.writeFileSync(sourcePath, indexedContent, "utf8");
                const indexedHash = crypto.createHash("sha256").update(indexedContent).digest("hex");
                fs.writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
                return {
                    indexedFiles: 1,
                    totalChunks: 1,
                    status: "completed",
                    indexedFileHashes: new Map([["index.ts", indexedHash]]),
                };
            },
        });

        await harness.handler.startBackgroundIndexing(repoPath, true);

        assert.equal(fs.readFileSync(snapshotPath, "utf8"), baselineSnapshot);
        assert.equal(harness.indexedSnapshots, 0);
        assert.equal(harness.failedSnapshots.length, 1);
        assert.deepEqual(harness.publicationEvents, ["navigation:discard:candidate-generation"]);
    });
});

test("background reindex does not publish authority when checkpoint acknowledgement fails after commit", async () => {
    await withTempRepo(async (repoPath) => {
        const sourcePath = path.join(repoPath, "index.ts");
        const baselineSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await baselineSynchronizer.initialize();
        fs.writeFileSync(sourcePath, "export const value = 2;\n", "utf8");

        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "checkpoint-commit-ack-leases"),
            ownerId: "checkpoint-commit-ack-owner",
        });
        const acquired = coordinator.acquire(repoPath, "reindex");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const originalPrepareChanges = FileSynchronizer.prototype.prepareChanges;
        FileSynchronizer.prototype.prepareChanges = async function prepareWithFailedAcknowledgement(options) {
            const prepared = await originalPrepareChanges.call(this, options);
            return {
                ...prepared,
                commit: async (...args) => {
                    const receipt = await prepared.commit(...args);
                    throw new SynchronizerCheckpointPublicationError(
                        "checkpoint acknowledgement failed",
                        receipt,
                        new Error("checkpoint acknowledgement failed"),
                    );
                },
            };
        };

        const existingCollections = new Set<string>();
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult({ "index.ts": "export const value = 2;\n" }),
        });
        const candidateCollection = `${resolveCollectionName(repoPath)}__gen_checkpoint_ack`;

        try {
            await harness.handler.startBackgroundIndexing(
                repoPath,
                true,
                candidateCollection,
                acquired.lease,
            );
        } finally {
            FileSynchronizer.prototype.prepareChanges = originalPrepareChanges;
            coordinator.release(acquired.lease);
        }

        assert.equal(harness.authorityEvents.includes("restore"), false);
        assert.equal(harness.registeredSynchronizers, 0);
        assert.deepEqual(harness.publishedSnapshots, []);
        assert.equal(harness.failedSnapshots.length, 1);
        assert.deepEqual(harness.publicationEvents, ["navigation:discard:candidate-generation"]);
        assert.equal(
            fs.existsSync(FileSynchronizer.getSnapshotPathForGeneration(repoPath, candidateCollection)),
            false,
        );
    });
});

test("limit_reached indexing publishes no synchronizer checkpoint or ignore signature", async () => {
    await withTempRepo(async (repoPath) => {
        let ignoreSignatureWrites = 0;
        const harness = createFailedIndexingHarness(new Set(), {
            indexCodebase: async () => partialIndexResult(2),
            recordCurrentIgnoreControlSignature: async () => {
                ignoreSignatureWrites += 1;
            },
        });

        await harness.handler.startBackgroundIndexing(repoPath, false);

        assert.equal(harness.indexedSnapshots, 1);
        assert.equal(harness.registeredSynchronizers, 0);
        assert.equal(ignoreSignatureWrites, 0);
        assert.equal(fs.existsSync(FileSynchronizer.getSnapshotPathForCodebase(repoPath)), false);
        assert.deepEqual(harness.publicationEvents, ["policy:publish", "marker:limit_reached"]);
    });
});

test("background reindex leaves the prior source checkpoint unchanged when authority publication fails", async () => {
    await withTempRepo(async (repoPath) => {
        const sourcePath = path.join(repoPath, "index.ts");
        const staleSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await staleSynchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(repoPath);
        const staleSnapshot = fs.readFileSync(snapshotPath, "utf8");
        fs.writeFileSync(sourcePath, "export const value = 2;\n", "utf8");

        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "checkpoint-publication-failure-leases"),
            ownerId: "checkpoint-publication-failure-owner",
        });
        const acquired = coordinator.acquire(repoPath, "reindex");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const harness = createFailedIndexingHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult({ "index.ts": "export const value = 2;\n" }),
            publishNavigationCandidate: async () => {
                throw new Error("navigation pointer publication failed");
            },
        });

        const candidateCollection = `${resolveCollectionName(repoPath)}__gen_candidate`;
        try {
            await harness.handler.startBackgroundIndexing(
                repoPath,
                true,
                candidateCollection,
                acquired.lease,
            );
        } finally {
            coordinator.release(acquired.lease);
        }

        assert.equal(fs.readFileSync(snapshotPath, "utf8"), staleSnapshot);
        const verifier = new FileSynchronizer(repoPath, [], [".ts"]);
        await verifier.initialize();
        const pending = await verifier.prepareChanges();
        assert.deepEqual(pending.changes.modified, ["index.ts"]);
        assert.equal(harness.indexedSnapshots, 0);
        assert.equal(
            fs.existsSync(FileSynchronizer.getSnapshotPathForGeneration(repoPath, candidateCollection)),
            false,
        );
    });
});

test("background reindex retains committed authority when lifecycle acknowledgement fails", async () => {
    await withTempRepo(async (repoPath) => {
        const sourcePath = path.join(repoPath, "index.ts");
        const staleSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await staleSynchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(repoPath);
        fs.writeFileSync(sourcePath, "export const value = 2;\n", "utf8");

        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "checkpoint-acknowledgement-leases"),
            ownerId: "checkpoint-acknowledgement-owner",
        });
        const acquired = coordinator.acquire(repoPath, "reindex");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        let checkpointObserved = false;
        const existingCollections = new Set<string>();
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult({ "index.ts": "export const value = 2;\n" }),
            recordCurrentIgnoreControlSignature: async () => {
                const verifier = new FileSynchronizer(repoPath, [], [".ts"], {
                    checkpointIdentity: candidateCollection,
                    checkpointAuthority: {
                        collectionName: candidateCollection,
                        markerRunId: harness.publishedMarker?.runId ?? 'missing-run-id',
                        indexPolicyHash: harness.publishedMarker?.indexPolicyHash ?? 'a'.repeat(64),
                    },
                });
                await verifier.initialize(undefined, undefined, { requireExistingCheckpoint: true });
                const pending = await verifier.prepareChanges({ forceFullHash: true });
                checkpointObserved = pending.changes.modified.length === 0;
                throw new Error("ignore-control acknowledgement failed");
            },
        });
        const candidateCollection = `${resolveCollectionName(repoPath)}__gen_candidate`;

        try {
            await harness.handler.startBackgroundIndexing(
                repoPath,
                true,
                candidateCollection,
                acquired.lease,
            );
        } finally {
            coordinator.release(acquired.lease);
        }

        assert.equal(checkpointObserved, true);
        assert.equal(existingCollections.has(candidateCollection), true);
        assert.equal(harness.authorityEvents.includes("restore"), false);
        assert.equal(harness.publicationEvents.includes("navigation:discard:candidate-generation"), false);
        assert.deepEqual(harness.publishedSnapshots, [{ status: "completed", collectionName: candidateCollection }]);
        assert.equal(fs.existsSync(snapshotPath), true);
        assert.equal(
            fs.existsSync(FileSynchronizer.getSnapshotPathForGeneration(repoPath, candidateCollection)),
            true,
        );
    });
});

test("background indexing resolves create policy normally and force reindex policy without persisted authority", async () => {
    await withTempRepo(async (repoPath) => {
        const createHarness = createFailedIndexingHarness(new Set(), {
            indexCodebase: async () => completedIndexResult(),
        });

        await createHarness.handler.startBackgroundIndexing(repoPath, false);

        assert.equal(createHarness.standardPolicyResolutionCalls, 1);
        assert.equal(createHarness.reindexPolicyResolutionCalls, 0);

        const reindexHarness = createFailedIndexingHarness(new Set(), {
            indexCodebase: async () => completedIndexResult(),
        });

        await reindexHarness.handler.startBackgroundIndexing(repoPath, true);

        assert.equal(reindexHarness.standardPolicyResolutionCalls, 0);
        assert.equal(reindexHarness.reindexPolicyResolutionCalls, 1);
    });
});

test("force reindex continues when retired authority prevents optional previous-generation proof", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createFailedIndexingHarness(new Set([resolveCollectionName(repoPath)]), {
            previousIndexedInfo: {
                status: "indexed",
                indexStatus: "completed",
                fingerprintSource: "verified",
                indexFingerprint: RUNTIME_FINGERPRINT,
                collectionName: resolveCollectionName(repoPath),
                indexedFiles: 1,
                totalChunks: 1,
            },
            proveVectorGenerationError: new Error("index policy v2 requires reindex"),
            indexCodebase: async () => completedIndexResult(),
        });

        await harness.handler.startBackgroundIndexing(repoPath, true);

        assert.equal(harness.indexedSnapshots, 1);
        assert.equal(harness.failedSnapshots.length, 0);
        assert.equal(harness.reindexPolicyResolutionCalls, 1);
    });
});

test("background indexing publishes partial custom-policy updates without erasing omitted fields", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createFailedIndexingHarness(new Set(), {
            initialCustomExtensions: ['.foo'],
            initialCustomIgnorePatterns: ['private/**'],
            indexCodebase: async () => completedIndexResult(),
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            false,
            undefined,
            undefined,
            undefined,
            { customIgnorePatterns: ['generated/**'] },
        );

        assert.deepEqual(harness.publishedCustomExtensions, ['.foo']);
        assert.deepEqual(harness.publishedCustomIgnorePatterns, ['generated/**']);
    });
});

test("background indexing preserves the previous proven collection when navigation publication fails", async () => {
    await withTempRepo(async (repoPath) => {
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_candidate`;
        const existingCollections = new Set([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            initialCustomExtensions: ['.foo'],
            initialCustomIgnorePatterns: ['private/**'],
            indexCodebase: async () => completedIndexResult(),
            previousIndexedInfo: {
                status: "indexing",
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            rebuildCallGraphForIndex: async () => {
                throw new Error("navigation publication failed");
            },
            pruneIndexedCollectionFamily: async (keepCollectionName) => {
                const dropped: string[] = [];
                for (const collectionName of Array.from(existingCollections)) {
                    if (collectionName !== keepCollectionName) {
                        existingCollections.delete(collectionName);
                        harness.droppedCollections.push(collectionName);
                        dropped.push(collectionName);
                    }
                }
                return dropped;
            },
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            true,
            stagedCollection,
            undefined,
            undefined,
            { customIgnorePatterns: ['generated/**'] },
        );

        assert.equal(existingCollections.has(previousCollection), true);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.deepEqual(harness.droppedCollections, [stagedCollection]);
        assert.deepEqual(harness.publishedSnapshots, [{ status: "completed", collectionName: previousCollection }]);
        assert.deepEqual(harness.failedSnapshots, []);
        assert.deepEqual(harness.publicationEvents, ["navigation:discard:candidate-generation"]);
    });
});

test("background indexing restores the sealed previous policy when navigation pointer publication fails", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'sealed-rollback-lease-state'),
            ownerId: 'sealed-rollback-owner',
        });
        const acquired = coordinator.acquire(repoPath, 'reindex');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_candidate`;
        const existingCollections = new Set([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            initialCustomExtensions: ['.foo'],
            initialCustomIgnorePatterns: ['private/**'],
            indexCodebase: async () => completedIndexResult(),
            previousIndexedInfo: {
                status: "indexing",
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            publishNavigationCandidate: async () => {
                throw new Error("navigation pointer publication failed");
            },
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            true,
            stagedCollection,
            acquired.lease,
            undefined,
            { customIgnorePatterns: ['generated/**'] },
        );

        assert.equal(existingCollections.has(previousCollection), true);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.deepEqual(harness.publishedCustomExtensions, ['.foo']);
        assert.deepEqual(harness.publishedCustomIgnorePatterns, ['private/**']);
        assert.deepEqual(harness.publicationEvents, [
            'marker:completed',
            'policy:publish',
            'navigation:publish:candidate-generation',
            'navigation:discard:candidate-generation',
        ]);
        assert.deepEqual(harness.authorityEvents, ['capture', 'capture', 'restore']);
        assert.deepEqual(harness.publishedSnapshots, [{ status: 'completed', collectionName: previousCollection }]);
        assert.deepEqual(harness.failedSnapshots, []);
    });
});

test("background indexing restores captured absent authority when first navigation publication fails", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "initial-policy-rollback-leases"),
            ownerId: "initial-policy-rollback-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const collectionName = `${resolveCollectionName(repoPath)}__gen_initial`;
        const existingCollections = new Set<string>();
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult(),
            publishNavigationCandidate: async () => {
                throw new Error("initial navigation pointer publication failed");
            },
        });

        try {
            await harness.handler.startBackgroundIndexing(
                repoPath,
                false,
                collectionName,
                acquired.lease,
                undefined,
                { customIgnorePatterns: ['generated/**'] },
            );
        } finally {
            coordinator.release(acquired.lease);
        }

        assert.equal(existingCollections.has(collectionName), false);
        assert.deepEqual(harness.publishedCustomExtensions, []);
        assert.deepEqual(harness.publishedCustomIgnorePatterns, []);
        assert.deepEqual(harness.clearedExpectedDocumentDigests, []);
        assert.deepEqual(harness.publicationEvents, [
            'marker:completed',
            'policy:publish',
            'navigation:publish:candidate-generation',
            'navigation:discard:candidate-generation',
        ]);
        assert.deepEqual(harness.authorityEvents, ['capture', 'capture', 'restore']);
    });
});

test("background indexing restores captured authority when a committed policy receipt lacks its digest", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "missing-policy-digest-leases"),
            ownerId: "missing-policy-digest-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const collectionName = `${resolveCollectionName(repoPath)}__gen_initial`;
        const existingCollections = new Set<string>();
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            omitPolicyPublicationDocumentDigest: true,
            indexCodebase: async () => completedIndexResult(),
            publishNavigationCandidate: async () => {
                throw new Error("initial navigation pointer publication failed");
            },
        });

        try {
            await harness.handler.startBackgroundIndexing(
                repoPath,
                false,
                collectionName,
                acquired.lease,
                undefined,
                { customIgnorePatterns: ['generated/**'] },
            );
        } finally {
            coordinator.release(acquired.lease);
        }

        assert.equal(existingCollections.has(collectionName), false);
        assert.deepEqual(harness.publishedCustomIgnorePatterns, []);
        assert.deepEqual(harness.clearedExpectedDocumentDigests, []);
        assert.deepEqual(harness.publicationEvents, [
            'marker:completed',
            'policy:publish',
            'navigation:publish:candidate-generation',
            'navigation:discard:candidate-generation',
        ]);
        assert.deepEqual(harness.authorityEvents, ['capture', 'capture', 'restore']);
        assert.equal(harness.failedSnapshots.length, 1);
    });
});

test("background indexing restores captured authority for every malformed policy receipt digest", async (t) => {
    const invalidDigests = [
        "",
        "abc",
        "A".repeat(64),
        "g".repeat(64),
        ` ${"a".repeat(64)} `,
    ];
    for (const invalidDigest of invalidDigests) {
        await t.test(JSON.stringify(invalidDigest), async () => {
            await withTempRepo(async (repoPath) => {
                const coordinator = new MutationLeaseCoordinator({
                    stateDir: path.join(path.dirname(repoPath), `invalid-policy-digest-${invalidDigest.length}`),
                    ownerId: `invalid-policy-digest-owner-${invalidDigest.length}`,
                });
                const acquired = coordinator.acquire(repoPath, "create");
                assert.equal(acquired.acquired, true);
                if (!acquired.acquired) return;
                const collectionName = `${resolveCollectionName(repoPath)}__gen_initial`;
                const existingCollections = new Set<string>();
                const harness = createFailedIndexingHarness(existingCollections, {
                    mutationLeaseCoordinator: coordinator,
                    policyPublicationDocumentDigest: invalidDigest,
                    indexCodebase: async () => completedIndexResult(),
                    publishNavigationCandidate: async () => {
                        throw new Error("initial navigation pointer publication failed");
                    },
                });

                try {
                    await harness.handler.startBackgroundIndexing(
                        repoPath,
                        false,
                        collectionName,
                        acquired.lease,
                        undefined,
                        { customIgnorePatterns: ["generated/**"] },
                    );
                } finally {
                    coordinator.release(acquired.lease);
                }

                assert.equal(existingCollections.has(collectionName), false);
                assert.deepEqual(harness.clearedExpectedDocumentDigests, []);
                assert.equal(harness.publicationEvents.includes("navigation:discard:candidate-generation"), true);
                assert.deepEqual(harness.authorityEvents, ['capture', 'capture', 'restore']);
            });
        });
    }
});

test("background indexing restores an existing generation when policy commits before acknowledgement fails", async () => {
    await withTempRepo(async (repoPath) => {
        const baselineSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await baselineSynchronizer.initialize();
        const checkpointPath = FileSynchronizer.getSnapshotPathForCodebase(repoPath);
        const checkpointBefore = fs.readFileSync(checkpointPath, "utf8");
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'ack-existing-rollback-lease-state'),
            ownerId: 'ack-existing-rollback-owner',
        });
        const acquired = coordinator.acquire(repoPath, 'reindex');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_candidate`;
        const existingCollections = new Set([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            initialCustomIgnorePatterns: ['private/**'],
            indexCodebase: async () => completedIndexResult(),
            previousIndexedInfo: {
                status: "indexing",
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            failPolicyPublicationAfterCommit: true,
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            true,
            stagedCollection,
            acquired.lease,
            undefined,
            { customIgnorePatterns: ['generated/**'] },
        );

        assert.equal(existingCollections.has(previousCollection), true);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.deepEqual(harness.droppedCollections, [stagedCollection]);
        assert.deepEqual(harness.publicationEvents, ['marker:completed', 'policy:publish', 'navigation:discard:candidate-generation']);
        assert.deepEqual(harness.authorityEvents, ['capture', 'capture', 'restore']);
        assert.deepEqual(harness.failedSnapshots, []);
        assert.deepEqual(harness.publishedSnapshots, [{ status: 'completed', collectionName: previousCollection }]);
        assert.equal(fs.readFileSync(checkpointPath, "utf8"), checkpointBefore);
    });
});

test("background indexing restores absent authority when initial policy commits before acknowledgement fails", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'ack-initial-rollback-lease-state'),
            ownerId: 'ack-initial-rollback-owner',
        });
        const acquired = coordinator.acquire(repoPath, 'create');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_initial`;
        const existingCollections = new Set<string>();
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult(),
            failPolicyPublicationAfterCommit: true,
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            false,
            stagedCollection,
            acquired.lease,
            undefined,
            { customIgnorePatterns: ['generated/**'] },
        );

        assert.equal(existingCollections.has(stagedCollection), false);
        assert.deepEqual(harness.droppedCollections, [stagedCollection]);
        assert.deepEqual(harness.publicationEvents, ['marker:completed', 'policy:publish', 'navigation:discard:candidate-generation']);
        assert.deepEqual(harness.authorityEvents, ['capture', 'capture', 'restore']);
        assert.equal(harness.failedSnapshots.length, 1);
        assert.equal(fs.existsSync(FileSynchronizer.getSnapshotPathForCodebase(repoPath)), false);
    });
});

test("background indexing does not replace a previous complete generation with limit_reached", async () => {
    await withTempRepo(async (repoPath) => {
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_partial`;
        const existingCollections = new Set([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            initialCustomExtensions: ['.foo'],
            initialCustomIgnorePatterns: ['private/**'],
            indexCodebase: async () => partialIndexResult(2),
            previousIndexedInfo: {
                status: "indexing",
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            pruneIndexedCollectionFamily: async (keepCollectionName) => {
                const dropped: string[] = [];
                for (const collectionName of Array.from(existingCollections)) {
                    if (collectionName !== keepCollectionName) {
                        existingCollections.delete(collectionName);
                        harness.droppedCollections.push(collectionName);
                        dropped.push(collectionName);
                    }
                }
                return dropped;
            },
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            true,
            stagedCollection,
            undefined,
            undefined,
            { customIgnorePatterns: ['generated/**'] },
        );

        assert.equal(existingCollections.has(previousCollection), true);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.deepEqual(harness.publishedSnapshots, [{ status: "completed", collectionName: previousCollection }]);
        assert.deepEqual(harness.publicationEvents, []);
        assert.deepEqual(harness.publishedCustomExtensions, ['.foo']);
        assert.deepEqual(harness.publishedCustomIgnorePatterns, ['private/**']);
    });
});

test("background indexing preserves a complete generation after it transitions through sync_completed", async () => {
    await withTempRepo(async (repoPath) => {
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_partial_after_sync`;
        const existingCollections = new Set([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            indexCodebase: async () => partialIndexResult(2),
            previousIndexedInfo: {
                status: "sync_completed",
                added: 1,
                removed: 0,
                modified: 1,
                totalChanges: 2,
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            pruneIndexedCollectionFamily: async (keepCollectionName) => {
                const dropped: string[] = [];
                for (const collectionName of Array.from(existingCollections)) {
                    if (collectionName !== keepCollectionName) {
                        existingCollections.delete(collectionName);
                        harness.droppedCollections.push(collectionName);
                        dropped.push(collectionName);
                    }
                }
                return dropped;
            },
        });

        await harness.handler.startBackgroundIndexing(repoPath, true, stagedCollection);

        assert.equal(existingCollections.has(previousCollection), true);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.deepEqual(harness.droppedCollections, [stagedCollection]);
        assert.deepEqual(harness.publishedSnapshots, [{ status: "completed", collectionName: previousCollection }]);
        assert.deepEqual(harness.publicationEvents, []);
    });
});

test("startBackgroundIndexing deletes failed staged collection", async () => {
    await withTempRepo(async (repoPath) => {
        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_run_failed`;
        const existingCollections = new Set<string>([stagedCollection]);
        const harness = createFailedIndexingHarness(existingCollections);

        await harness.handler.startBackgroundIndexing(repoPath, false, stagedCollection);

        assert.deepEqual(harness.droppedCollections, [stagedCollection]);
        assert.equal(existingCollections.has(stagedCollection), false);
        assert.equal(harness.failedSnapshots.length, 1);
        assert.match(harness.failedSnapshots[0].errorMessage, /boom after staged collection create/);
        assert.equal(harness.completionMarkerClearCalls, 0);
    });
});

test("startBackgroundIndexing keeps stable collection after non-staged failure", async () => {
    await withTempRepo(async (repoPath) => {
        const stableCollection = resolveCollectionName(repoPath);
        const existingCollections = new Set<string>([stableCollection]);
        const { handler, droppedCollections, failedSnapshots } = createFailedIndexingHarness(existingCollections);

        await handler.startBackgroundIndexing(repoPath, false);

        assert.deepEqual(droppedCollections, []);
        assert.equal(existingCollections.has(stableCollection), true);
        assert.equal(failedSnapshots.length, 1);
    });
});

test("startBackgroundIndexing restores captured legacy authority after candidate publication fails", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "legacy-rollback-lease-state"),
            ownerId: "legacy-rollback-owner",
        });
        const acquired = coordinator.acquire(repoPath, "reindex");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_legacy_rollback`;
        const existingCollections = new Set<string>([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            legacyRollback: true,
            previousIndexedInfo: {
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            indexCodebase: async () => completedIndexResult(undefined, { totalChunks: 12 }),
            publishNavigationCandidate: async () => {
                throw new Error("failure after candidate authority publication");
            },
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            true,
            stagedCollection,
            acquired.lease,
        );

        assert.equal(existingCollections.has(previousCollection), true);
        assert.deepEqual(harness.publishedSnapshots, [{ status: "completed", collectionName: previousCollection }]);
        assert.deepEqual(harness.publicationEvents, [
            "marker:completed",
            "policy:publish",
            "navigation:publish:candidate-generation",
            "navigation:discard:candidate-generation",
        ]);
        assert.deepEqual(harness.authorityEvents, ["capture", "capture", "restore"]);
    });
});

test("startBackgroundIndexing refuses durable authority rollback without a mutation fence", async () => {
    await withTempRepo(async (repoPath) => {
        const previousCollection = resolveCollectionName(repoPath);
        const stagedCollection = `${previousCollection}__gen_unfenced_rollback`;
        const existingCollections = new Set<string>([previousCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            previousIndexedInfo: {
                indexedFiles: 3,
                totalChunks: 9,
                indexStatus: "completed",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
                collectionName: previousCollection,
            },
            indexCodebase: async () => completedIndexResult(undefined, { totalChunks: 12 }),
            publishNavigationCandidate: async () => {
                throw new Error("failure after candidate authority publication");
            },
        });

        await harness.handler.startBackgroundIndexing(repoPath, true, stagedCollection);

        assert.deepEqual(harness.authorityEvents, ["capture", "capture"]);
    });
});

test("startBackgroundIndexing does not clean or publish failure after lease loss during cleanup", async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), "lease-state");
        const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: "owner-a" });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_run_failed`;
        const existingCollections = new Set<string>([stagedCollection]);
        let released = false;
        const { handler, droppedCollections, failedSnapshots } = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            beforeHasCollection: () => {
                if (!released) {
                    released = true;
                    coordinator.release(acquired.lease);
                }
            },
        });

        await handler.startBackgroundIndexing(repoPath, false, stagedCollection, acquired.lease);

        assert.deepEqual(droppedCollections, []);
        assert.equal(existingCollections.has(stagedCollection), true);
        assert.deepEqual(failedSnapshots, []);
    });
});

test("background indexing never restores captured authority after lease loss following candidate publication", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'rollback-lease-loss-state'),
            ownerId: 'rollback-owner-a',
        });
        const acquired = coordinator.acquire(repoPath, 'create');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_lease_loss`;
        const existingCollections = new Set<string>([stagedCollection]);
        const harness = createFailedIndexingHarness(existingCollections, {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult(),
            publishNavigationCandidate: async () => {
                coordinator.release(acquired.lease);
                throw new Error('candidate publication lost its mutation lease');
            },
        });

        await harness.handler.startBackgroundIndexing(
            repoPath,
            false,
            stagedCollection,
            acquired.lease,
        );

        assert.deepEqual(harness.authorityEvents, ['capture', 'capture']);
        assert.equal(existingCollections.has(stagedCollection), true);
        assert.deepEqual(harness.failedSnapshots, []);
    });
});

test("handleRepairIndex saves the manifest paths verified by repair", async () => {
    await withTempRepo(async (repoPath) => {
        let manifestPaths: string[] | null = null;
        let repairOptions: Record<string, unknown> | undefined;
        const handler = new ManageIndexingHandlers({
            context: {
                repairIndex: async (_codebasePath: string, options?: Record<string, unknown>) => {
                    repairOptions = options;
                    return {
                        status: "ok",
                        message: "repaired",
                        indexedFiles: 1,
                        totalChunks: 2,
                        warnings: [],
                        trackedRelativePaths: ["src/repaired.ts"],
                    };
                },
            },
            snapshotManager: {
                setCodebaseIndexed: () => undefined,
                setCodebaseIndexManifest: (_codebasePath: string, paths: string[]) => {
                    manifestPaths = paths;
                },
            },
            syncManager: {},
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            manageResponse: (action: string, responsePath: string, status: string, message: string, options?: Record<string, unknown>) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message, ...options }) }],
            }),
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            recoverStaleIndexingStateIfNeeded: async () => undefined,
            getSnapshotIndexingCodebases: () => [],
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                lastUpdated: new Date(0).toISOString(),
                collectionName: "snapshot-selected-collection",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
            }),
            getSnapshotIndexedCodebases: () => [],
            buildManageActionBlockedMessage: () => "blocked",
            buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
            buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            buildReindexInstruction: () => "reindex",
            buildManageRequiresReindexHints: () => ({}),
            validateCompletionProof: async () => ({ outcome: "missing_collection" }),
            recoverIndexedSnapshotFromCompletionProof: () => false,
            isZillizBackend: () => false,
            resolveCollectionName,
            dropZillizCollectionForCreate: async () => ({}),
            resolveStagedCollectionName: (codebasePath: string, generationId: string) => `${resolveCollectionName(codebasePath)}__gen_${generationId}`,
            buildCollectionLimitMessage: async () => "collection limit",
            manageVectorBackendResponse: (action: string, responsePath: string) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status: "error" }) }],
            }),
            saveSnapshotIfSupported: () => undefined,
            touchWatchedCodebase: async () => undefined,
            setWriteCollectionOverride: () => undefined,
            loadIndexProfileForCodebase: () => ({ profile: "default" }),
            getContextActiveIgnorePatterns: () => [],
            getContextIndexedExtensions: () => [".ts"],
            canonicalizeCodebasePath: (codebasePath: string) => path.resolve(codebasePath),
            pruneIndexedCollectionFamily: async () => [],
            pruneUnprovenStagedCollectionFamily: async () => [],
            getContextTrackedRelativePaths: () => ["stale/from-context.ts"],
            setIndexingStats: () => undefined,
            rebuildCallGraphForIndex: async () => undefined,
            getSnapshotIndexingProgress: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
            evaluateReindexPreflight: () => ({ allowed: true }),
        } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

        const response = await handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "ok");
        assert.deepEqual(manifestPaths, ["src/repaired.ts"]);
        assert.equal(typeof repairOptions?.onProofUpdate, "function");
        const proofOptions = { ...(repairOptions || {}) };
        delete proofOptions.onProofUpdate;
        assert.deepEqual(proofOptions, {
            snapshotEvidence: {
                status: "verified",
                basis: "verified_snapshot_fingerprint",
                fingerprint: RUNTIME_FINGERPRINT,
            },
            preferredCollectionName: "snapshot-selected-collection",
        });
    });
});

test("handleRepairIndex recovers abandoned indexing before the indexing gate", async () => {
    await withTempRepo(async (repoPath) => {
        let recoverCalls = 0;
        let indexingProbeCalls = 0;
        let stillIndexing = true;
        const handler = new ManageIndexingHandlers({
            context: {
                repairIndex: async () => ({
                    status: "ok",
                    message: "repaired",
                    indexedFiles: 1,
                    totalChunks: 2,
                    warnings: [],
                    trackedRelativePaths: ["src/repaired.ts"],
                    proof: {
                        collection: { status: "matched" },
                        snapshot: { status: "matched" },
                        marker: { status: "matched" },
                        fingerprint: { status: "matched" },
                        payload: { status: "matched" },
                        staleRemoteChunks: { status: "matched" },
                        navigation: { status: "not_checked" },
                    },
                }),
            },
            snapshotManager: {
                setCodebaseIndexed: () => undefined,
                setCodebaseIndexManifest: () => undefined,
            },
            syncManager: {},
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            manageResponse: (action: string, responsePath: string, status: string, message: string, options?: Record<string, unknown>) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message, ...options }) }],
            }),
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            recoverStaleIndexingStateIfNeeded: async () => {
                recoverCalls += 1;
                stillIndexing = false;
            },
            getSnapshotIndexingCodebases: () => {
                indexingProbeCalls += 1;
                return stillIndexing ? [repoPath] : [];
            },
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                collectionName: "snapshot-selected-collection",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
            }),
            buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            buildManageActionBlockedMessage: () => "blocked-by-indexing",
            buildReindexInstruction: () => "reindex",
            buildManageRequiresReindexHints: () => ({}),
            buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
            getContextTrackedRelativePaths: () => [],
            setIndexingStats: () => undefined,
            rebuildCallGraphForIndex: async () => undefined,
            touchWatchedCodebase: async () => undefined,
            saveSnapshotIfSupported: () => undefined,
            getSnapshotIndexingProgress: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
        } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

        const response = await handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(recoverCalls, 1);
        assert.ok(indexingProbeCalls >= 1);
        assert.equal(payload.status, "ok");
        assert.notEqual(payload.reason, "indexing");
    });
});

test("handleRepairIndex does not publish success after lease loss during call-graph rebuild", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "lease-state"),
            ownerId: "owner-a",
        });
        let indexedCalls = 0;
        let saveCalls = 0;
        const handler = new ManageIndexingHandlers({
            context: {
                repairIndex: async () => ({
                    status: "ok",
                    message: "repaired",
                    indexedFiles: 1,
                    totalChunks: 2,
                    warnings: [],
                    trackedRelativePaths: ["src/repaired.ts"],
                }),
            },
            snapshotManager: {
                setCodebaseIndexed: () => { indexedCalls += 1; },
                setCodebaseIndexManifest: () => undefined,
            },
            syncManager: {},
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            manageResponse: (action: string, responsePath: string, status: string, message: string) => ({
                content: [{ type: "text", text: JSON.stringify({ action, path: responsePath, status, message }) }],
            }),
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            recoverStaleIndexingStateIfNeeded: async () => undefined,
            getSnapshotIndexingCodebases: () => [],
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                collectionName: "snapshot-selected-collection",
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: "verified",
            }),
            buildStatusHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "status", path: codebasePath } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            buildReindexInstruction: () => "reindex",
            buildManageRequiresReindexHints: () => ({}),
            buildCreateHint: (codebasePath: string) => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
            getContextTrackedRelativePaths: () => [],
            setIndexingStats: () => undefined,
            rebuildCallGraphForIndex: async (_codebasePath: string, assertMutationCurrent?: () => void) => {
                const lease = coordinator.getActiveLease(repoPath);
                assert.ok(lease);
                coordinator.release(lease);
                assertMutationCurrent?.();
            },
            touchWatchedCodebase: async () => undefined,
            saveSnapshotIfSupported: () => { saveCalls += 1; },
            getSnapshotIndexingProgress: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
            mutationLeaseCoordinator: coordinator,
        } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);

        const response = await handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, "error");
        assert.match(payload.message, /mutation lease .* is no longer current/i);
        assert.equal(indexedCalls, 0);
        assert.equal(saveCalls, 0);
    });
});

test("handleRepairIndex durably accepts before repair and commits completed receipt with lifecycle", async () => {
    await withTempRepo(async (repoPath) => {
        let repairPublicationRan = false;
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async (repairOptions) => {
                assert.equal(typeof repairOptions?.assertMutationCurrent, "function");
                assert.equal(typeof repairOptions?.publishMutation, "function");
                repairOptions?.publishMutation?.(() => {
                    repairPublicationRan = true;
                });
                return {
                    status: "ok",
                    message: "repaired",
                    indexedFiles: 1,
                    totalChunks: 2,
                    warnings: [],
                    trackedRelativePaths: ["src/repaired.ts"],
                    collectionName: "repair-collection",
                    proof: REPAIR_PROOF,
                };
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "ok");
        assert.equal(payload.operation?.phase, "completed");
        assert.deepEqual(
            harness.persisted.map((entry) => entry.phase),
            ["accepted", "proving", "publishing", "completed"],
        );
        assert.equal(harness.persisted.at(-1)?.indexed, true);
        assert.equal(repairPublicationRan, true);
        assert.ok(harness.events.indexOf("save:accepted") < harness.events.indexOf("repair"));
        assert.ok(harness.events.indexOf("save:proving") < harness.events.indexOf("repair"));
        assert.ok(harness.events.indexOf("set:indexed") < harness.events.indexOf("save:completed"));
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex refuses repair side effects when accepted receipt is not durable", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, { failAcceptedSave: true });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(harness.repairCalls, 0);
        assert.deepEqual(harness.persisted.map((entry) => entry.phase), ["failed"]);
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex publishes blocked receipt when proof requires reindex", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async () => ({
                status: "requires_reindex",
                reason: "requires_reindex",
                message: "fingerprint mismatch",
                proof: {
                    ...REPAIR_PROOF,
                    marker: { status: "failed", basis: "completion_marker_fingerprint_mismatch" },
                    fingerprint: { status: "failed", basis: "completion_marker_fingerprint_mismatch" },
                    payload: { status: "not_checked" },
                    staleRemoteChunks: { status: "not_checked" },
                    navigation: { status: "not_checked" },
                },
            }),
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
            repairProof?: typeof REPAIR_PROOF;
            hints?: Record<string, unknown>;
        };

        assert.equal(payload.status, "requires_reindex");
        assert.equal(payload.operation?.phase, "blocked");
        assert.equal(payload.repairProof?.marker.status, "failed");
        assert.deepEqual(payload.hints?.nextAction, {
            tool: "manage_index",
            args: { action: "reindex", path: repoPath },
        });
        assert.equal(harness.persisted.at(-1)?.phase, "blocked");
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex publishes failed receipt when repair throws", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async () => {
                throw new Error("repair exploded");
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(harness.persisted.at(-1)?.phase, "failed");
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex preserves partial proof when the vector backend fails", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            repairIndex: async (repairOptions) => {
                repairOptions?.onProofUpdate?.({
                    ...REPAIR_PROOF,
                    payload: { status: "not_checked" },
                    staleRemoteChunks: { status: "not_checked" },
                    navigation: { status: "not_checked" },
                });
                throw new Error("milvus connection closed during repair proof");
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            code?: string;
            repairProof?: typeof REPAIR_PROOF;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "error");
        assert.equal(payload.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
        assert.equal(payload.operation?.phase, "failed");
        assert.equal(payload.repairProof?.collection.status, "matched");
        assert.equal(payload.repairProof?.navigation.status, "not_checked");
        assert.equal(harness.coordinator?.getActiveLease(repoPath), undefined);
    });
});

test("handleRepairIndex treats watcher touch as best effort after navigation proof", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, {
            touchWatchedCodebase: async () => {
                throw new Error("watcher touch failed");
            },
        });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            message: string;
            repairProof?: typeof REPAIR_PROOF;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "ok");
        assert.equal(payload.operation?.phase, "completed");
        assert.equal(payload.repairProof?.navigation.status, "matched");
        assert.equal(payload.repairProof?.navigation.basis, "navigation_and_call_graph_rebuilt");
    });
});

test("handleRepairIndex without lease capability does not fabricate a receipt", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createRepairReceiptHarness(repoPath, { withLease: false });

        const response = await harness.handler.handleRepairIndex({ path: repoPath });
        const payload = JSON.parse(response.content[0].text) as {
            status: string;
            operation?: IndexOperationReceipt;
        };

        assert.equal(payload.status, "ok");
        assert.equal(payload.operation, undefined);
        assert.deepEqual(harness.persisted, []);
        assert.equal(harness.compatibilitySaveCalls, 1);
    });
});
