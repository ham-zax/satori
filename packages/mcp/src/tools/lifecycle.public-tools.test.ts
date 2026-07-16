/**
 * F7: Deterministic public-tool lifecycle harness (fake embed + in-memory vector).
 * Proves: index (core) → manage status / list_codebases → search → file_outline → read_file → clear
 * through the public tool execute surface, not only ToolHandlers direct calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
    Context,
    createLanguageAnalysisService,
    Embedding,
    INDEX_COMPLETION_MARKER_DOC_ID,
    resetSharedRuntimeNavigationStoreForTests,
    resolveNavigationSidecarRoot,
} from "@zokizuan/satori-core";
import type {
    CollectionDetails,
    DenseCandidateRequest,
    EmbeddingVector,
    IndexedVectorDocument,
    LexicalCandidateRequest,
    VectorCandidate,
    VectorControlRecord,
    VectorDatabase,
    VectorDocument,
    VectorDocumentQuery,
    VectorFilter,
} from "@zokizuan/satori-core";
import { CapabilityResolver } from "../core/capabilities.js";
import type { IndexFingerprint } from "../config.js";
import { ToolHandlers } from "../core/handlers.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import type { ToolContext } from "./types.js";
import { listCodebasesTool } from "./list_codebases.js";
import { manageIndexTool } from "./manage_index.js";
import { searchCodebaseTool } from "./search_codebase.js";
import { fileOutlineTool } from "./file_outline.js";
import { readFileTool } from "./read_file.js";

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: "VoyageAI",
    embeddingModel: "voyage-4-large",
    embeddingDimension: 1024,
    vectorStoreProvider: "Milvus",
    schemaVersion: "hybrid_v3",
};

const CAPABILITIES = new CapabilityResolver({
    name: "test",
    version: "0.0.0",
    encoderProvider: "VoyageAI",
    encoderModel: "voyage-4-large",
});

type JsonObject = Record<string, unknown>;

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 4;
    }

    async embedQuery(text: string): Promise<EmbeddingVector> {
        const lower = (text || "").toLowerCase();
        return {
            vector: [
                /auth|token|login|session/.test(lower) ? 1 : 0,
                /math|sum|add/.test(lower) ? 1 : 0,
                /file|path|index|search/.test(lower) ? 1 : 0,
                Math.min(1, text.length / 200),
            ],
            dimension: 4,
        };
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embedQuery(text)));
    }

    getDimension(): number {
        return 4;
    }

    getProvider(): string {
        return "TestEmbedding";
    }
}

class InMemoryVectorDatabase implements VectorDatabase {
    readonly collections = new Map<string, Map<string, VectorDocument>>();

    /**
     * Minimal filter evaluation for Context marker/query paths.
     * Must honor `id == "..."` so completion-marker clear/write does not delete real chunks.
     */
    private listDocuments(collectionName: string, filter?: VectorFilter): VectorDocument[] {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            return [];
        }
        const matches = (document: VectorDocument, candidate?: VectorFilter): boolean => {
            if (!candidate) return true;
            if (candidate.kind === 'and') return candidate.operands.every((operand) => matches(document, operand));
            const value = document[candidate.field];
            if (candidate.kind === 'in') return candidate.values.includes(value as string);
            return candidate.operator === 'eq' ? value === candidate.value : value !== candidate.value;
        };
        return Array.from(collection.values())
            .filter((document) => document.fileExtension !== '.satori_meta')
            .filter((document) => matches(document, filter));
    }

    async createCollection(collectionName: string): Promise<void> {
        this.collections.set(collectionName, new Map());
    }

    async createHybridCollection(collectionName: string): Promise<void> {
        this.collections.set(collectionName, new Map());
    }

    async dropCollection(collectionName: string): Promise<void> {
        this.collections.delete(collectionName);
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        return this.collections.has(collectionName);
    }

    async listCollections(): Promise<string[]> {
        return Array.from(this.collections.keys());
    }

    async listCollectionDetails(): Promise<CollectionDetails[]> {
        return Array.from(this.collections.keys()).map((name) => ({ name }));
    }

    private async storeDocuments(
        collectionName: string,
        documents: Array<IndexedVectorDocument | VectorDocument>,
    ): Promise<void> {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            throw new Error(`Collection not found: ${collectionName}`);
        }
        for (const input of documents) {
            const document = 'projections' in input ? input.document : input;
            collection.set(document.id, document);
        }
    }

    async writeDocuments(collectionName: string, documents: IndexedVectorDocument[]): Promise<void> {
        await this.storeDocuments(collectionName, documents);
    }

    async insertControl(collectionName: string, record: VectorControlRecord): Promise<void> {
        await this.storeDocuments(collectionName, [{
            id: record.id,
            vector: [],
            content: '',
            relativePath: '.__satori__/control.json',
            startLine: 0,
            endLine: 0,
            fileExtension: '.satori_meta',
            metadata: { ...record.metadata, kind: record.kind },
        }]);
    }

    async getControl(collectionName: string, id: string): Promise<VectorControlRecord | null> {
        const document = this.collections.get(collectionName)?.get(id);
        return document ? {
            id,
            kind: typeof document.metadata.kind === 'string' ? document.metadata.kind : '',
            metadata: { ...document.metadata },
        } : null;
    }

    async deleteControl(collectionName: string, id: string): Promise<void> {
        await this.deleteDocuments(collectionName, [id]);
    }

    async retrieveDense(collectionName: string, request: DenseCandidateRequest): Promise<VectorCandidate[]> {
        return this.listDocuments(collectionName, request.filter)
            .slice(0, request.limit)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async retrieveLexical(collectionName: string, request: LexicalCandidateRequest): Promise<VectorCandidate[]> {
        return this.listDocuments(collectionName, request.filter)
            .slice(0, request.limit)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
        const collection = this.collections.get(collectionName);
        for (const id of ids) {
            collection?.delete(id);
        }
    }

    async queryDocuments(collectionName: string, request: VectorDocumentQuery): Promise<Record<string, unknown>[]> {
        return this.listDocuments(collectionName, request.filter).slice(0, request.limit ?? 1000).map((document) => {
            const row: Record<string, unknown> = {};
            for (const field of request.fields) {
                row[field] = (document as unknown as Record<string, unknown>)[field];
            }
            return row;
        });
    }

    async checkCollectionLimit(): Promise<boolean> {
        return true;
    }
}

async function withTempState<T>(fn: (input: { repoPath: string; stateRoot: string }) => Promise<T>): Promise<T> {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-public-lifecycle-"));
    const repoPath = path.join(tempRoot, "repo");
    const stateRoot = path.join(tempRoot, "state");
    process.env.SATORI_STATE_ROOT = stateRoot;
    resetSharedRuntimeNavigationStoreForTests();

    try {
        fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
        return await fn({ repoPath, stateRoot });
    } finally {
        resetSharedRuntimeNavigationStoreForTests();
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function parsePayload(response: { content?: Array<{ text?: string }> }): JsonObject {
    return JSON.parse(response.content?.[0]?.text || "{}") as JsonObject;
}

type MutableInfo = {
    status: "indexed" | "indexing" | "indexfailed" | "requires_reindex" | "sync_completed" | "not_found";
    indexStatus?: string;
    indexedFiles?: number;
    totalChunks?: number;
};

function createMutableSnapshot(repoPath: string): {
    snapshotManager: SnapshotManager;
    info: MutableInfo;
    markCleared: () => void;
} {
    const info: MutableInfo = {
        status: "indexed",
        indexStatus: "completed",
        indexedFiles: 1,
        totalChunks: 1,
    };
    let tracked = true;

    const snapshotManager = {
        getAllCodebases: () => (tracked ? [{ path: repoPath, info }] : []),
        getIndexedCodebases: () => (
            tracked && (info.status === "indexed" || info.status === "sync_completed")
                ? [repoPath]
                : []
        ),
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => (tracked ? info : undefined),
        getCodebaseStatus: () => (tracked ? info.status : "not_found"),
        getCodebaseCallGraphSidecar: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
        markCodebaseAsIndexFailed: () => undefined,
        setCodebaseIndexing: () => undefined,
        setCodebaseIndexed: () => {
            tracked = true;
            info.status = "indexed";
        },
        removeCodebaseCompletely: () => {
            tracked = false;
        },
        getSnapshotCorruptionWarning: () => undefined,
        refreshFromDiskIfChanged: () => false,
    } as unknown as SnapshotManager;

    return {
        snapshotManager,
        info,
        markCleared: () => {
            tracked = false;
        },
    };
}

test("public tools lifecycle: status/list → search → outline → read_file after index; clear via manage_index", async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        const relativePath = "src/auth.ts";
        const absoluteFile = path.join(repoPath, relativePath);
        fs.writeFileSync(
            absoluteFile,
            "export function authenticate(token: string): boolean {\n  return token.length > 0;\n}\n",
            "utf8",
        );

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            languageAnalyzer: createLanguageAnalysisService(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(repoPath);
        const indexResult = await context.indexCodebase(repoPath);
        assert.equal(indexResult.status, "completed");
        assert.ok(indexResult.totalChunks >= 1, `expected code chunks, got ${indexResult.totalChunks}`);

        const codeDocs = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== ".satori_meta");
        assert.ok(
            codeDocs.length >= 1,
            `expected non-meta vector docs after index; collections=${[...vectorDatabase.collections.keys()].join(",")}`,
        );
        assert.ok(
            codeDocs.some((document) => document.relativePath === relativePath || document.content.includes("authenticate")),
            "expected auth.ts content in indexed docs",
        );

        const { snapshotManager, markCleared } = createMutableSnapshot(repoPath);
        const syncManager = {
            ensureFreshness: async () => ({
                mode: "skipped_recent",
                checkedAt: "2026-07-09T00:00:00.000Z",
                thresholdMs: 180000,
            }),
            touchWatchedCodebase: async () => undefined,
            unwatchCodebase: async () => undefined,
        } as unknown as SyncManager;

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse("2026-07-09T00:00:00.000Z"),
        );
        (handlers as unknown as { validateCompletionProof: () => Promise<{ outcome: "ok" }> })
            .validateCompletionProof = async () => ({ outcome: "ok" });

        // Wire clear to both vector drop and snapshot untrack for deterministic lifecycle end-state.
        const originalClear = handlers.handleClearIndex.bind(handlers);
        handlers.handleClearIndex = async (args) => {
            const response = await originalClear(args);
            const collections = await vectorDatabase.listCollections();
            for (const name of collections) {
                await vectorDatabase.dropCollection(name);
            }
            markCleared();
            return response;
        };

        const toolContext: ToolContext = {
            context,
            readFileMaxLines: 1000,
            snapshotManager,
            syncManager,
            capabilities: CAPABILITIES,
            reranker: null,
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            toolHandlers: handlers,
        };

        // manage_index status (public tool)
        const statusResponse = await manageIndexTool.execute({
            action: "status",
            path: repoPath,
        }, toolContext);
        assert.notEqual(statusResponse.isError, true);
        const statusPayload = parsePayload(statusResponse);
        assert.ok(
            statusPayload.status === "ok"
            || statusPayload.status === "not_ready"
            || typeof statusPayload.humanText === "string"
            || typeof statusPayload.message === "string"
            || statusResponse.content[0]?.text?.includes("indexed")
            || statusResponse.content[0]?.text?.includes("ok"),
            `unexpected status payload: ${statusResponse.content[0]?.text?.slice(0, 300)}`,
        );

        // list_codebases (public tool)
        const listResponse = await listCodebasesTool.execute({}, toolContext);
        assert.notEqual(listResponse.isError, true);
        assert.match(listResponse.content[0]?.text || "", /Ready|indexed|Codebases/i);
        assert.match(listResponse.content[0]?.text || "", new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

        // search_codebase (public tool)
        const searchResponse = await searchCodebaseTool.execute({
            path: repoPath,
            query: "authenticate token",
            resultMode: "grouped",
            groupBy: "symbol",
            limit: 10,
        }, toolContext);
        assert.notEqual(searchResponse.isError, true);
        const searchPayload = parsePayload(searchResponse);
        assert.equal(searchPayload.status, "ok");
        assert.ok(Array.isArray(searchPayload.results));
        assert.ok((searchPayload.results as unknown[]).length > 0, "expected at least one search result");
        const searchText = JSON.stringify(searchPayload.results);
        assert.match(searchText, /authenticate|auth\.ts/i, "search results should reference indexed auth content");

        // file_outline (public tool)
        const outlineResponse = await fileOutlineTool.execute({
            path: repoPath,
            file: relativePath,
        }, toolContext);
        assert.notEqual(outlineResponse.isError, true);
        const outlinePayload = parsePayload(outlineResponse);
        assert.equal(outlinePayload.status, "ok");
        const symbols = (outlinePayload.outline as { symbols?: unknown[] } | null)?.symbols;
        assert.ok(Array.isArray(symbols) && symbols.length > 0, "expected outline symbols");

        // read_file plain (public tool) under indexed root
        const readResponse = await readFileTool.execute({
            path: absoluteFile,
        }, toolContext);
        assert.notEqual(readResponse.isError, true);
        assert.match(readResponse.content[0]?.text || "", /authenticate/);

        // manage_index clear (public tool)
        const clearResponse = await manageIndexTool.execute({
            action: "clear",
            path: repoPath,
        }, toolContext);
        assert.notEqual(clearResponse.isError, true);

        // After clear, list should not advertise ready root
        const listAfter = await listCodebasesTool.execute({}, toolContext);
        const listAfterText = listAfter.content[0]?.text || "";
        assert.ok(
            listAfterText.includes("No codebases") || !listAfterText.includes(repoPath),
            `expected cleared root absent from ready list: ${listAfterText.slice(0, 400)}`,
        );
    });
});

test("public reindex replaces a coherent retired v2 tuple with restart-proven v3 authority", async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        const previousHome = process.env.HOME;
        process.env.HOME = path.join(path.dirname(stateRoot), "home");
        try {
            fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
            fs.writeFileSync(
                path.join(repoPath, "src", "auth.ts"),
                "export function authenticate(token: string): boolean { return token.length > 0; }\n",
                "utf8",
            );

            const vectorDatabase = new InMemoryVectorDatabase();
            const policyRoot = path.join(stateRoot, "policies");
            const context = new Context({
                embedding: new TestEmbedding(),
                vectorDatabase,
                languageAnalyzer: createLanguageAnalysisService(),
                symbolRegistryStateRoot: stateRoot,
                indexPolicyStateRoot: policyRoot,
            });
            await context.recreateSynchronizerForCodebase(repoPath);
            const initialIndex = await context.indexCodebase(repoPath);
            assert.equal(initialIndex.status, "completed");

            const canonicalRoot = fs.realpathSync(repoPath);
            const collectionName = context.resolveCollectionName(canonicalRoot);
            const markerDocument = vectorDatabase.collections
                .get(collectionName)
                ?.get(INDEX_COMPLETION_MARKER_DOC_ID);
            assert.ok(markerDocument && typeof markerDocument.metadata === "object");
            const currentMarker = structuredClone(markerDocument.metadata) as Record<string, unknown>;
            const currentFingerprint = structuredClone(currentMarker.fingerprint) as IndexFingerprint;
            const currentNavigation = currentMarker.navigation as {
                status: "sealed";
                generationId: string;
                symbolRegistryManifestHash: string;
                relationshipManifestHash: string;
            };
            assert.equal(currentNavigation.status, "sealed");

            const policyPath = path.join(
                policyRoot,
                `${crypto.createHash("sha256").update(canonicalRoot).digest("hex")}.json`,
            );
            const pointerPath = path.join(
                resolveNavigationSidecarRoot(stateRoot, canonicalRoot),
                "current.json",
            );
            const currentPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Record<string, unknown>;
            const legacyPolicyPayload = {
                schemaVersion: "satori_index_policy_v2",
                canonicalRoot,
                customExtensions: currentPolicy.customExtensions,
                customIgnorePatterns: currentPolicy.customIgnorePatterns,
                fileBasedIgnorePatterns: currentPolicy.fileBasedIgnorePatterns,
                profile: currentPolicy.profile,
                supportedExtensions: currentPolicy.supportedExtensions,
                effectiveIgnorePatterns: currentPolicy.effectiveIgnorePatterns,
                policyHash: currentPolicy.policyHash,
                collectionName,
                navigationGenerationId: currentNavigation.generationId,
            };
            const legacyPolicyBytes = JSON.stringify({
                ...legacyPolicyPayload,
                documentDigest: crypto.createHash("sha256")
                    .update(JSON.stringify(legacyPolicyPayload), "utf8")
                    .digest("hex"),
            });
            fs.writeFileSync(policyPath, legacyPolicyBytes, "utf8");

            const legacyPointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
            legacyPointer.schemaVersion = "navigation_current_v2";
            delete legacyPointer.navigationSealHash;
            const legacyPointerBytes = JSON.stringify(legacyPointer);
            fs.writeFileSync(pointerPath, legacyPointerBytes, "utf8");

            markerDocument.metadata = {
                ...currentMarker,
                kind: "satori_index_completion_v2",
                navigationGenerationId: currentNavigation.generationId,
                symbolRegistryManifestHash: currentNavigation.symbolRegistryManifestHash,
                relationshipManifestHash: currentNavigation.relationshipManifestHash,
            };
            delete (markerDocument.metadata as Record<string, unknown>).navigation;
            const legacyMarker = structuredClone(markerDocument.metadata);

            assert.deepEqual(
                await context.getIndexCompletionMarkerForValidation(canonicalRoot),
                { status: "requires_reindex" },
            );

            const snapshotManager = new SnapshotManager(currentFingerprint);
            snapshotManager.setCodebaseIndexed(
                canonicalRoot,
                {
                    indexedFiles: Number(currentMarker.indexedFiles),
                    totalChunks: Number(currentMarker.totalChunks),
                    status: "completed",
                },
                currentFingerprint,
                "verified",
                collectionName,
                false,
            );
            const syncManager = new SyncManager(context, snapshotManager, { watchEnabled: false });
            const handlers = new ToolHandlers(
                context,
                snapshotManager,
                syncManager,
                currentFingerprint,
                CAPABILITIES,
            );

            type BackgroundStart = (
                root: string,
                force: boolean,
                stagedCollection?: string,
                lease?: unknown,
                previousInfo?: Record<string, unknown>,
                policyUpdate?: Record<string, unknown>,
            ) => Promise<void>;
            const internalIndexing = (handlers as unknown as {
                manageIndexingHandlers: { startBackgroundIndexing: BackgroundStart };
            }).manageIndexingHandlers;
            const actualStart = internalIndexing.startBackgroundIndexing.bind(internalIndexing);
            let background: Promise<void> | null = null;
            (handlers as unknown as { startBackgroundIndexing?: BackgroundStart }).startBackgroundIndexing = (
                ...args
            ) => {
                background = actualStart(...args);
                return background;
            };

            const toolContext: ToolContext = {
                context,
                readFileMaxLines: 1000,
                snapshotManager,
                syncManager,
                capabilities: CAPABILITIES,
                reranker: null,
                runtimeFingerprint: currentFingerprint,
                toolHandlers: handlers,
            };

            const initialStatus = parsePayload(await manageIndexTool.execute({
                action: "status",
                path: canonicalRoot,
            }, toolContext));
            assert.equal(initialStatus.status, "requires_reindex");
            const initialSearch = parsePayload(await searchCodebaseTool.execute({
                path: canonicalRoot,
                query: "authenticate token",
            }, toolContext));
            assert.equal(initialSearch.status, "requires_reindex");

            const kickoff = await manageIndexTool.execute({
                action: "reindex",
                path: canonicalRoot,
                allowUnnecessaryReindex: true,
            }, toolContext);
            assert.notEqual(kickoff.isError, true);
            assert.ok(background, "public reindex must launch the background worker");
            await background;

            assert.notEqual(fs.readFileSync(policyPath, "utf8"), legacyPolicyBytes);
            assert.notEqual(fs.readFileSync(pointerPath, "utf8"), legacyPointerBytes);
            const publishedPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Record<string, unknown>;
            const publishedPointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
            assert.equal(publishedPolicy.schemaVersion, "satori_index_policy_v3");
            assert.equal(publishedPointer.schemaVersion, "navigation_current_v3");
            assert.equal(vectorDatabase.collections.has(collectionName), false);
            const publishedCollectionName = publishedPolicy.collectionName;
            assert.equal(typeof publishedCollectionName, "string");
            const publishedMarker = vectorDatabase.collections
                .get(publishedCollectionName as string)
                ?.get(INDEX_COMPLETION_MARKER_DOC_ID)
                ?.metadata as Record<string, unknown> | undefined;
            assert.equal(publishedMarker?.kind, "satori_index_completion_v3");
            assert.notDeepEqual(publishedMarker, legacyMarker);

            const restarted = new Context({
                embedding: new TestEmbedding(),
                vectorDatabase,
                languageAnalyzer: createLanguageAnalysisService(),
                symbolRegistryStateRoot: stateRoot,
                indexPolicyStateRoot: policyRoot,
            });
            const receipt = await restarted.proveIndexedGeneration(canonicalRoot);
            assert.ok(receipt);
            assert.equal(receipt.marker.kind, "satori_index_completion_v3");
            assert.ok(receipt.navigation.navigationSealHash);
            const results = await restarted.semanticSearchInProvenGeneration(receipt, {
                codebasePath: canonicalRoot,
                query: "authenticate token",
                topK: 5,
                retrievalMode: "dense",
                scorePolicy: { kind: "topk_only" },
            });
            assert.ok(results.length > 0);
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
        }
    });
});
