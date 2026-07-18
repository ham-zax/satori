#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const entryArg = process.argv[2];
const traceFile = process.env.SATORI_DISCLOSURE_PILOT_TRACE;

if (typeof entryArg !== "string" || entryArg.length === 0) {
    throw new Error("The exact MCP dist entry path is required.");
}
if (typeof traceFile !== "string" || !path.isAbsolute(traceFile)) {
    throw new Error("SATORI_DISCLOSURE_PILOT_TRACE must be an absolute path.");
}

const entryPath = path.resolve(entryArg);
let sequence = 0;

function record(operation, details = {}) {
    fs.appendFileSync(traceFile, `${JSON.stringify({
        sequence: sequence += 1,
        operation,
        ...details,
    })}\n`, "utf8");
}

function wrapAsync(prototype, method, operation, details = () => ({})) {
    const original = prototype[method];
    if (typeof original !== "function") {
        throw new Error(`Pilot runtime cannot instrument '${method}'.`);
    }
    prototype[method] = async function instrumentedOperation(...args) {
        record(operation, details(args));
        return original.apply(this, args);
    };
}

function blockAsync(prototype, method, operation) {
    if (typeof prototype[method] !== "function") {
        throw new Error(`Pilot runtime cannot guard '${method}'.`);
    }
    prototype[method] = async function blockedMutation() {
        record(operation);
        throw new Error(`Disclosure pilot blocked unexpected operation '${operation}'.`);
    };
}

const requireFromRuntime = createRequire(entryPath);
const coreEntry = requireFromRuntime.resolve("@zokizuan/satori-core");
const lanceEntry = requireFromRuntime.resolve("@zokizuan/satori-core/lancedb");
const syncEntry = path.join(path.dirname(entryPath), "core", "sync.js");
const resultSetCacheEntry = path.join(path.dirname(entryPath), "core", "search-result-set-cache.js");
const [
    { Context, VoyageAIEmbedding, VoyageAIReranker },
    { LanceDbVectorDatabase },
    { SyncManager },
    { SearchResultSetCache },
] = await Promise.all([
    import(pathToFileURL(coreEntry).href),
    import(pathToFileURL(lanceEntry).href),
    import(pathToFileURL(syncEntry).href),
    import(pathToFileURL(resultSetCacheEntry).href),
]);

const originalStore = SearchResultSetCache.prototype.store;
const originalLookup = SearchResultSetCache.prototype.lookup;
SearchResultSetCache.prototype.store = function instrumentedStore(input) {
    const result = originalStore.call(this, input);
    record("result_set_store", {
        handleSha256: crypto.createHash("sha256").update(result.handle, "utf8").digest("hex"),
        nextOffset: input.nextOffset,
    });
    return result;
};
SearchResultSetCache.prototype.lookup = function instrumentedLookup(handle, nowMs) {
    const result = originalLookup.call(this, handle, nowMs);
    record("result_set_lookup", {
        handleSha256: crypto.createHash("sha256").update(handle, "utf8").digest("hex"),
        status: result.status,
    });
    return result;
};

wrapAsync(VoyageAIEmbedding.prototype, "embedQuery", "query_embedding");
wrapAsync(VoyageAIEmbedding.prototype, "embedDocuments", "document_embedding", ([texts]) => ({
    itemCount: Array.isArray(texts) ? texts.length : 0,
}));
wrapAsync(VoyageAIReranker.prototype, "rerank", "reranker", ([, documents]) => ({
    candidateCount: Array.isArray(documents) ? documents.length : 0,
    documentUtf8Bytes: Array.isArray(documents)
        ? documents.reduce((total, document) => total + Buffer.byteLength(String(document), "utf8"), 0)
        : 0,
}));

wrapAsync(LanceDbVectorDatabase.prototype, "retrieveDense", "dense_retrieval");
wrapAsync(LanceDbVectorDatabase.prototype, "retrieveLexical", "lexical_retrieval");
for (const method of ["hasCollection", "listCollections", "listCollectionDetails", "getControl", "queryDocuments"]) {
    wrapAsync(LanceDbVectorDatabase.prototype, method, `storage_read:${method}`);
}
for (const method of [
    "createCollection",
    "createHybridCollection",
    "finalizeCollectionForSearch",
    "dropCollection",
    "writeDocuments",
    "insertControl",
    "deleteControl",
    "deleteDocuments",
]) {
    blockAsync(LanceDbVectorDatabase.prototype, method, `storage_mutation:${method}`);
}
blockAsync(Context.prototype, "reindexByChange", "reindex");

if (typeof SyncManager.prototype.ensureFreshness !== "function") {
    throw new Error("Pilot runtime cannot guard SyncManager.ensureFreshness.");
}
SyncManager.prototype.ensureFreshness = async function noSyncFreshness(_codebasePath, thresholdMs = 60_000) {
    record("freshness_check");
    const checkedAtMs = Date.now();
    return {
        mode: "skipped_recent",
        checkedAt: new Date(checkedAtMs).toISOString(),
        thresholdMs,
    };
};

for (const method of ["startBackgroundSync", "startWatcherMode"]) {
    if (typeof SyncManager.prototype[method] !== "function") {
        throw new Error(`Pilot runtime cannot disable '${method}'.`);
    }
    SyncManager.prototype[method] = function disabledLifecycleOwner() {
        record(`lifecycle_disabled:${method}`);
    };
}

record("runtime_ready");
process.argv = [process.argv[0], entryPath, ...process.argv.slice(3)];
await import(pathToFileURL(entryPath).href);
