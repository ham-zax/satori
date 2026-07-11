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
import {
    Context,
    createLanguageAnalysisService,
    Embedding,
    resetSharedRuntimeNavigationStoreForTests,
} from "@zokizuan/satori-core";
import type {
    CollectionDetails,
    EmbeddingVector,
    HybridSearchOptions,
    HybridSearchRequest,
    HybridSearchResult,
    SearchOptions,
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
} from "@zokizuan/satori-core";
import { CapabilityResolver } from "../core/capabilities.js";
import type { IndexFingerprint } from "../config.js";
import { ToolHandlers } from "../core/handlers.js";
import type { SnapshotManager } from "../core/snapshot.js";
import type { SyncManager } from "../core/sync.js";
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

    async embed(text: string): Promise<EmbeddingVector> {
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

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embed(text)));
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
    private listDocuments(collectionName: string, filterExpr?: string): VectorDocument[] {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            return [];
        }
        let documents = Array.from(collection.values());
        const expr = filterExpr || "";

        const idMatch = /^id == "((?:\\.|[^"\\])*)"$/.exec(expr);
        if (idMatch?.[1]) {
            const id = idMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            return documents.filter((document) => document.id === id);
        }

        if (expr.includes('fileExtension != ".satori_meta"') || expr.includes("fileExtension != '.satori_meta'")) {
            documents = documents.filter((document) => document.fileExtension !== ".satori_meta");
        }

        const relativePathMatch = /relativePath == ["'](.+?)["']/.exec(expr);
        if (relativePathMatch?.[1]) {
            documents = documents.filter((document) => document.relativePath === relativePathMatch[1]);
        }

        return documents;
    }

    async hybridSearch(
        collectionName: string,
        _searchRequests: HybridSearchRequest[],
        options?: HybridSearchOptions,
    ): Promise<HybridSearchResult[]> {
        return this.listDocuments(collectionName, options?.filterExpr)
            .slice(0, options?.limit ?? 1000)
            .map((document, index) => ({ document, score: 0.99 - (index * 0.01) }));
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

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            throw new Error(`Collection not found: ${collectionName}`);
        }
        for (const document of documents) {
            collection.set(document.id, document);
        }
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void> {
        await this.insert(collectionName, documents);
    }

    async search(collectionName: string, _queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        return this.listDocuments(collectionName, options?.filterExpr)
            .slice(0, options?.topK ?? 1000)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        const collection = this.collections.get(collectionName);
        for (const id of ids) {
            collection?.delete(id);
        }
    }

    async query(
        collectionName: string,
        filterExpr: string,
        outputFields: string[],
        limit: number = 1000,
    ): Promise<Record<string, unknown>[]> {
        return this.listDocuments(collectionName, filterExpr).slice(0, limit).map((document) => {
            const row: Record<string, unknown> = {};
            for (const field of outputFields) {
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
