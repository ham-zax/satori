#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
    JsonRpcStdioSession,
    recorderNodeMetadata,
} from "../../scripts/satori-useful-context-record.mjs";
import { getSatoriRuntimeIdentity } from "../../scripts/satori-runtime-identity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function fileIdentity(file) {
    const bytes = fs.readFileSync(file);
    return {
        file: path.basename(file),
        bytes: bytes.length,
        sha256: sha256(bytes),
    };
}

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

export function parseArgs(argv) {
    const options = {
        taskFile: null,
        outDir: null,
        sourceRoot: null,
        runtimeRoot: null,
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${arg}.`);
            return argv[index];
        };
        if (arg === "--task") options.taskFile = path.resolve(next());
        else if (arg === "--out-dir") options.outDir = path.resolve(next());
        else if (arg === "--source-root") options.sourceRoot = path.resolve(next());
        else if (arg === "--runtime-root") options.runtimeRoot = path.resolve(next());
        else if (arg === "--startup-timeout-ms") options.startupTimeoutMs = positiveInteger(next(), arg);
        else if (arg === "--call-timeout-ms") options.callTimeoutMs = positiveInteger(next(), arg);
        else if (arg === "--close-timeout-ms") options.closeTimeoutMs = positiveInteger(next(), arg);
        else throw new Error(`Unknown option: ${arg}`);
    }
    for (const [key, value] of Object.entries({
        "--task": options.taskFile,
        "--out-dir": options.outDir,
        "--source-root": options.sourceRoot,
        "--runtime-root": options.runtimeRoot,
    })) {
        if (!value) throw new Error(`${key} is required.`);
    }
    return options;
}

function pathIsInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateTaskManifest(value, sourceRoot) {
    if (!isRecord(value)
        || value.schemaVersion !== 1
        || value.kind !== "satori_phase3_disclosure_mechanical_pilot"
        || value.sealed !== false
        || value.qualificationEvidence !== false
        || typeof value.baseGitRevision !== "string"
        || !/^[a-f0-9]{40}$/.test(value.baseGitRevision)
        || !isRecord(value.task)
        || typeof value.task.id !== "string"
        || typeof value.task.query !== "string"
        || !isRecord(value.task.expectedEvidence)
        || typeof value.task.expectedEvidence.file !== "string"
        || typeof value.task.expectedEvidence.symbolId !== "string"
        || !isRecord(value.search)
        || !isRecord(value.currentDisclosure)
        || !isRecord(value.smallerDisclosure)) {
        throw new Error("Disclosure pilot task manifest is invalid.");
    }
    const limit = positiveInteger(value.search.limit, "search.limit");
    const smallerLimit = positiveInteger(value.smallerDisclosure.disclosureLimit, "smaller disclosureLimit");
    if (smallerLimit >= limit || value.currentDisclosure.disclosureLimit !== null) {
        throw new Error("Pilot must compare the current unbounded initial disclosure with one smaller disclosureLimit.");
    }
    const canonicalSource = fs.realpathSync(sourceRoot);
    const taskPath = fs.realpathSync(value.__file);
    if (pathIsInside(canonicalSource, taskPath)) {
        throw new Error("Disclosure pilot authority must remain outside the indexed source corpus.");
    }
    return structuredClone(value);
}

function gitOutput(root, args) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed for '${root}'.`);
    return result.stdout;
}

function sourceIdentity(root) {
    const canonicalRoot = fs.realpathSync(root);
    const status = gitOutput(canonicalRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return {
        canonicalRoot,
        gitRevision: gitOutput(canonicalRoot, ["rev-parse", "HEAD"]).trim().toLowerCase(),
        gitTree: gitOutput(canonicalRoot, ["rev-parse", "HEAD^{tree}"]).trim().toLowerCase(),
        dirty: status.length > 0,
        statusSha256: sha256(status),
    };
}

function runtimeIdentity(runtimeRoot, runtimeEntry, runtimeGuard) {
    return {
        sourceRevision: gitOutput(runtimeRoot, ["rev-parse", "HEAD"]).trim().toLowerCase(),
        sourceTree: gitOutput(runtimeRoot, ["rev-parse", "HEAD^{tree}"]).trim().toLowerCase(),
        runtime: getSatoriRuntimeIdentity(runtimeRoot),
        executable: fileIdentity(runtimeEntry),
        guard: fileIdentity(runtimeGuard),
        node: recorderNodeMetadata(),
    };
}

function responseText(result) {
    const text = result?.content?.find?.((item) => item?.type === "text")?.text;
    if (typeof text !== "string") throw new Error("Tool response has no serialized JSON text.");
    return text;
}

export function decodeSerializedToolResponse(result) {
    const text = responseText(result);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error("Tool response text is not valid JSON.");
    }
}

function resultIdentity(result) {
    const target = result?.target;
    if (!isRecord(target) || typeof target.file !== "string" || target.file.length === 0) {
        throw new Error("Grouped result has no canonical target.");
    }
    const span = isRecord(target.span) ? target.span : {};
    return [
        target.file,
        typeof target.symbolId === "string" ? target.symbolId : null,
        Number.isSafeInteger(span.startLine) ? span.startLine : null,
        Number.isSafeInteger(span.endLine) ? span.endLine : null,
    ];
}

function continuationRequest(payload, pageLimit) {
    const continuation = payload?.continuation;
    if (!isRecord(continuation)) return null;
    if (typeof continuation.handle !== "string" || !Number.isSafeInteger(continuation.nextOffset)) {
        throw new Error("Search continuation authority is incomplete.");
    }
    return {
        handle: continuation.handle,
        expectedOffset: continuation.nextOffset,
        limit: pageLimit,
    };
}

function traceSnapshot(traceFile) {
    const content = fs.readFileSync(traceFile, "utf8");
    if (content.length === 0) return [];
    return content.trimEnd().split("\n").map((line) => JSON.parse(line));
}

function traceDelta(before, after) {
    if (after.length < before.length) throw new Error("Pilot operation trace was truncated.");
    return after.slice(before.length);
}

export function summarizeOperations(events) {
    const counts = {};
    let documentEmbeddingItems = 0;
    let rerankerCandidates = 0;
    let rerankerDocumentUtf8Bytes = 0;
    for (const event of events) {
        counts[event.operation] = (counts[event.operation] ?? 0) + 1;
        if (event.operation === "document_embedding") documentEmbeddingItems += event.itemCount ?? 0;
        if (event.operation === "reranker") {
            rerankerCandidates += event.candidateCount ?? 0;
            rerankerDocumentUtf8Bytes += event.documentUtf8Bytes ?? 0;
        }
    }
    return {
        counts,
        documentEmbeddingItems,
        rerankerCandidates,
        rerankerDocumentUtf8Bytes,
    };
}

export async function collectDisclosureVariant(input) {
    const beforeSearch = traceSnapshot(input.traceFile);
    const searchResult = await input.session.callTool("search_codebase", input.searchArgs);
    const searchText = responseText(searchResult);
    const initial = decodeSerializedToolResponse(searchResult);
    if (initial?.status !== "ok" || !Array.isArray(initial.results)) {
        throw new Error(`Search variant '${input.name}' did not return grouped results.`);
    }
    const afterSearch = traceSnapshot(input.traceFile);
    const pages = [{ payload: initial, text: searchText, kind: "initial" }];
    let request = continuationRequest(initial, input.continuationLimit);
    let exactRetry = null;
    while (request) {
        const beforePage = traceSnapshot(input.traceFile);
        const pageResult = await input.session.callTool("continue_search", request);
        const pageText = responseText(pageResult);
        const page = decodeSerializedToolResponse(pageResult);
        if (page?.status !== "ok" || !Array.isArray(page.results)) {
            const classification = typeof page?.code === "string" ? ` (${page.code})` : "";
            throw new Error(`Continuation for '${input.name}' failed${classification}.`);
        }
        const afterPage = traceSnapshot(input.traceFile);
        const pageOperations = traceDelta(beforePage, afterPage);
        if (pageOperations.some((event) => [
            "query_embedding",
            "document_embedding",
            "dense_retrieval",
            "lexical_retrieval",
            "reranker",
            "reindex",
        ].includes(event.operation) || event.operation.startsWith("storage_mutation:"))) {
            throw new Error(`Continuation for '${input.name}' performed forbidden provider or mutation work.`);
        }
        if (!exactRetry && input.requireExactRetry) {
            const retryBefore = traceSnapshot(input.traceFile);
            const retryResult = await input.session.callTool("continue_search", request);
            const retryText = responseText(retryResult);
            const retryAfter = traceSnapshot(input.traceFile);
            if (retryText !== pageText) throw new Error("Exact continuation retry changed serialized bytes.");
            const retryOperations = traceDelta(retryBefore, retryAfter);
            if (retryOperations.some((event) => [
                "query_embedding",
                "document_embedding",
                "dense_retrieval",
                "lexical_retrieval",
                "reranker",
                "reindex",
            ].includes(event.operation) || event.operation.startsWith("storage_mutation:"))) {
                throw new Error("Exact continuation retry performed forbidden provider or mutation work.");
            }
            exactRetry = {
                identicalSerializedPage: true,
                expectedOffset: request.expectedOffset,
                responseSha256: sha256(pageText),
                operations: summarizeOperations(retryOperations),
            };
        }
        pages.push({ payload: page, text: pageText, kind: "continuation", operations: summarizeOperations(pageOperations) });
        request = continuationRequest(page, input.continuationLimit);
    }

    const results = pages.flatMap((page) => page.payload.results);
    const identities = results.map(resultIdentity);
    const unique = new Set(identities.map(canonicalJson));
    if (unique.size !== identities.length) throw new Error(`Disclosure variant '${input.name}' repeated a grouped result.`);
    const expectedIndex = results.findIndex((result) => (
        result?.target?.file === input.expected.file
        && result?.target?.symbolId === input.expected.symbolId
    ));
    const initialExpectedIndex = initial.results.findIndex((result) => (
        result?.target?.file === input.expected.file
        && result?.target?.symbolId === input.expected.symbolId
    ));
    return {
        name: input.name,
        initialResponseBytes: Buffer.byteLength(searchText, "utf8"),
        initialResultCount: initial.results.length,
        totalResultCount: results.length,
        continuationPageCount: pages.length - 1,
        expectedEvidence: {
            reached: expectedIndex >= 0,
            rank: expectedIndex >= 0 ? expectedIndex + 1 : null,
            presentInitially: initialExpectedIndex >= 0,
        },
        groupIdentityDigest: sha256(canonicalJson(identities)),
        rankedResultSetDigest: sha256(canonicalJson(results)),
        identities,
        searchOperations: summarizeOperations(traceDelta(beforeSearch, afterSearch)),
        continuationOperations: summarizeOperations(
            pages.slice(1).flatMap((page) => page.operations
                ? Object.entries(page.operations.counts).flatMap(([operation, count]) => (
                    Array.from({ length: count }, () => ({ operation }))
                ))
                : []),
        ),
        exactRetry,
        freshnessDecision: initial.freshnessDecision ?? null,
        freshnessSummary: initial.freshnessSummary ?? null,
        searchDiagnostics: isRecord(searchResult.meta?.searchDiagnostics)
            ? structuredClone(searchResult.meta.searchDiagnostics)
            : null,
    };
}

export function compareVariants(current, smaller) {
    if (current.groupIdentityDigest !== smaller.groupIdentityDigest
        || current.rankedResultSetDigest !== smaller.rankedResultSetDigest) {
        throw new Error("Disclosure variants did not expose the same frozen ranked result set.");
    }
    if (smaller.initialResponseBytes >= current.initialResponseBytes) {
        throw new Error("Smaller disclosure did not reduce the initial serialized response size.");
    }
    if (!smaller.expectedEvidence.reached || smaller.expectedEvidence.presentInitially) {
        throw new Error("Pilot expected evidence was not deferred and recovered through continuation.");
    }
    if (smaller.continuationPageCount < 1 || !smaller.exactRetry?.identicalSerializedPage) {
        throw new Error("Smaller disclosure did not exercise deterministic continuation and retry.");
    }
    return {
        sameGroupIdentityOrder: true,
        sameRankedResultSet: true,
        initialResponseByteDifference: smaller.initialResponseBytes - current.initialResponseBytes,
        initialResponseByteReduction: current.initialResponseBytes - smaller.initialResponseBytes,
    };
}

function publicationAuthority(payload, expectedRoot) {
    const operation = payload?.operation;
    const publication = payload?.publication;
    if (!isRecord(operation)
        || operation.phase !== "completed"
        || operation.canonicalRoot !== expectedRoot
        || !Number.isSafeInteger(operation.generation)
        || !isRecord(operation.runtimeFingerprint)
        || !isRecord(publication)
        || typeof publication.collectionName !== "string"
        || typeof publication.markerRunId !== "string"
        || typeof publication.indexPolicyHash !== "string"
        || typeof publication.policyDocumentDigest !== "string") {
        throw new Error("Compatible completed publication proof is unavailable.");
    }
    return {
        canonicalRoot: operation.canonicalRoot,
        generation: operation.generation,
        runtimeFingerprint: structuredClone(operation.runtimeFingerprint),
        publication: {
            collectionName: publication.collectionName,
            markerRunId: publication.markerRunId,
            indexPolicyHash: publication.indexPolicyHash,
            policyDocumentDigest: publication.policyDocumentDigest,
        },
    };
}

function readTaskFile(taskFile, sourceRoot) {
    const raw = JSON.parse(fs.readFileSync(taskFile, "utf8"));
    return validateTaskManifest({ ...raw, __file: taskFile }, sourceRoot);
}

function safeWriteNew(file, value) {
    fs.writeFileSync(file, value, { encoding: "utf8", flag: "wx" });
}

export async function runPilot(options) {
    const sourceBefore = sourceIdentity(options.sourceRoot);
    if (sourceBefore.dirty) throw new Error("Pilot source corpus must be clean.");
    const taskManifest = readTaskFile(options.taskFile, options.sourceRoot);
    const runtimeEntry = path.join(options.runtimeRoot, "packages", "mcp", "dist", "index.js");
    const runtimeGuard = path.join(HERE, "published-index-runtime.mjs");
    const runtime = runtimeIdentity(options.runtimeRoot, runtimeEntry, runtimeGuard);
    if (runtime.sourceRevision !== taskManifest.baseGitRevision) {
        throw new Error("Pilot runtime revision does not match the task manifest base revision.");
    }
    const outDir = path.resolve(options.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    if (pathIsInside(sourceBefore.canonicalRoot, fs.realpathSync(outDir))) {
        throw new Error("Pilot evidence directory must remain outside the indexed source corpus.");
    }

    const traceFile = path.join(outDir, "provider-operations.jsonl");
    const resultFile = path.join(outDir, "pilot-result.json");
    const taskEvidenceFile = path.join(outDir, "pilot-task.json");
    if (fs.existsSync(traceFile) || fs.existsSync(resultFile)) {
        throw new Error("Pilot output already exists; refusing to overwrite evidence.");
    }
    safeWriteNew(traceFile, "");
    if (path.resolve(options.taskFile) !== taskEvidenceFile) {
        safeWriteNew(taskEvidenceFile, fs.readFileSync(options.taskFile, "utf8"));
    }

    const childEnv = {
        ...process.env,
        HOME: process.env.SATORI_DISCLOSURE_PILOT_HOME,
        SATORI_RUNTIME_PROFILE: "connected",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: process.env.SATORI_DISCLOSURE_PILOT_LANCEDB_PATH,
        EMBEDDING_PROVIDER: "VoyageAI",
        EMBEDDING_MODEL: "voyage-code-3",
        EMBEDDING_OUTPUT_DIMENSION: "1024",
        MCP_ENABLE_WATCHER: "false",
        SATORI_DISCLOSURE_PILOT_TRACE: traceFile,
    };
    delete childEnv.MILVUS_ADDRESS;
    delete childEnv.MILVUS_TOKEN;
    if (!childEnv.HOME || !childEnv.LANCEDB_PATH || !childEnv.VOYAGEAI_API_KEY) {
        throw new Error("Pilot requires HOME, LANCEDB_PATH, and Voyage credentials through the bounded pilot environment.");
    }

    const session = new JsonRpcStdioSession({
        command: process.execPath,
        commandArgs: [runtimeGuard, runtimeEntry],
        cwd: sourceBefore.canonicalRoot,
        env: childEnv,
        startupTimeoutMs: options.startupTimeoutMs,
        callTimeoutMs: options.callTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
    });

    try {
        await session.start();
        const statusBeforeResult = await session.callTool("manage_index", {
            action: "status",
            path: sourceBefore.canonicalRoot,
            detail: "full",
        });
        const statusBefore = decodeSerializedToolResponse(statusBeforeResult);
        const publicationBefore = publicationAuthority(statusBefore, sourceBefore.canonicalRoot);
        if (publicationBefore.runtimeFingerprint.vectorStoreProvider !== "LanceDB"
            || publicationBefore.runtimeFingerprint.embeddingProvider !== "VoyageAI"
            || publicationBefore.runtimeFingerprint.embeddingModel !== "voyage-code-3"
            || publicationBefore.runtimeFingerprint.embeddingDimension !== 1024) {
            throw new Error("Existing publication is not the required LanceDB/Voyage 1024-dimensional runtime.");
        }

        const commonSearch = {
            path: sourceBefore.canonicalRoot,
            query: taskManifest.task.query,
            scope: taskManifest.search.scope,
            resultMode: "grouped",
            groupBy: taskManifest.search.groupBy,
            rankingMode: taskManifest.search.rankingMode,
            limit: taskManifest.search.limit,
        };
        const expected = taskManifest.task.expectedEvidence;
        const current = await collectDisclosureVariant({
            name: "current",
            session,
            traceFile,
            searchArgs: commonSearch,
            continuationLimit: taskManifest.continuation.limit,
            expected,
            requireExactRetry: false,
        });
        const smaller = await collectDisclosureVariant({
            name: "smaller",
            session,
            traceFile,
            searchArgs: {
                ...commonSearch,
                disclosureLimit: taskManifest.smallerDisclosure.disclosureLimit,
            },
            continuationLimit: taskManifest.continuation.limit,
            expected,
            requireExactRetry: true,
        });
        const comparison = compareVariants(current, smaller);

        const statusAfterResult = await session.callTool("manage_index", {
            action: "status",
            path: sourceBefore.canonicalRoot,
            detail: "full",
        });
        const publicationAfter = publicationAuthority(
            decodeSerializedToolResponse(statusAfterResult),
            sourceBefore.canonicalRoot,
        );
        if (canonicalJson(publicationBefore) !== canonicalJson(publicationAfter)) {
            throw new Error("Publication receipt changed during disclosure pilot.");
        }
        const sourceAfter = sourceIdentity(options.sourceRoot);
        if (canonicalJson(sourceBefore) !== canonicalJson(sourceAfter)) {
            throw new Error("Source authority changed during disclosure pilot.");
        }

        const operations = traceSnapshot(traceFile);
        const operationSummary = summarizeOperations(operations);
        const forbidden = Object.entries(operationSummary.counts).filter(([operation, count]) => (
            count > 0 && (operation === "reindex" || operation.startsWith("storage_mutation:"))
        ));
        if (forbidden.length > 0) throw new Error("Pilot attempted synchronization, reindexing, or storage mutation.");

        const relevantTools = session.tools.filter((tool) => [
            "manage_index",
            "search_codebase",
            "continue_search",
        ].includes(tool.name));
        const harnessFiles = [
            fileIdentity(fileURLToPath(import.meta.url)),
            fileIdentity(runtimeGuard),
        ];
        const result = {
            schemaVersion: 1,
            kind: "satori_phase3_disclosure_mechanical_pilot_result",
            sealed: false,
            qualificationEvidence: false,
            baseGitRevision: taskManifest.baseGitRevision,
            taskManifest: {
                taskCount: 1,
                sha256: sha256(fs.readFileSync(options.taskFile)),
                authorityOutsideIndexedCorpus: true,
            },
            harness: {
                files: harnessFiles,
                sha256: sha256(canonicalJson(harnessFiles)),
            },
            runtime,
            serverInfo: session.serverInfo,
            toolSchemas: relevantTools,
            toolSchemasSha256: sha256(canonicalJson(relevantTools)),
            sourceAuthority: { before: sourceBefore, after: sourceAfter },
            backendIdentity: {
                vectorStoreProvider: publicationBefore.runtimeFingerprint.vectorStoreProvider,
                embeddingProvider: publicationBefore.runtimeFingerprint.embeddingProvider,
                embeddingModel: publicationBefore.runtimeFingerprint.embeddingModel,
                embeddingDimension: publicationBefore.runtimeFingerprint.embeddingDimension,
            },
            publicationReceipt: { before: publicationBefore, after: publicationAfter },
            policy: {
                search: taskManifest.search,
                currentDisclosure: taskManifest.currentDisclosure,
                smallerDisclosure: taskManifest.smallerDisclosure,
                continuation: taskManifest.continuation,
            },
            variants: { current, smaller },
            comparison,
            providerOperations: operationSummary,
            resultSetDigest: current.rankedResultSetDigest,
            decision: "mechanics_passed_no_product_selection",
        };
        safeWriteNew(resultFile, `${JSON.stringify(result, null, 2)}\n`);
        const checksums = [traceFile, resultFile, taskEvidenceFile].map((file) => (
            `${sha256(fs.readFileSync(file))}  ${path.basename(file)}`
        )).join("\n");
        safeWriteNew(path.join(outDir, "OUTPUT-CHECKSUMS.sha256"), `${checksums}\n`);
        return result;
    } finally {
        await session.close().catch(() => undefined);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await runPilot(options);
    process.stdout.write(`${JSON.stringify({
        status: "ok",
        decision: result.decision,
        resultSetDigest: result.resultSetDigest,
        currentInitialBytes: result.variants.current.initialResponseBytes,
        smallerInitialBytes: result.variants.smaller.initialResponseBytes,
    })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
