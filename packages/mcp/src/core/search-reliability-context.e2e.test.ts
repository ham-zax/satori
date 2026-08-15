import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    POTION_DIMENSION,
    PotionEmbedding,
    restoreVerifiedOwnerExecutableBit,
    RerankerRequestError,
    type Reranker,
    type RerankResult,
} from "@zokizuan/satori-core";
import type { IndexFingerprint } from "../config.js";
import { DEFAULT_MANAGE_RETRY_AFTER_MS } from "../config.js";
import type { CapabilityResolver } from "./capabilities.js";
import {
    RuntimeOwnerRegistry,
    buildRuntimeOwnerIdentity,
} from "./runtime-owner.js";
import { resolveRuntimeOwnerStateDir } from "./runtime-state-root.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
} from "./search-execution.js";
import { runSearchFrontDoor, type SearchFrontDoorHost } from "./search-frontdoor.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import {
    buildSearchRerankQuery,
    SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
} from "./search-rerank-query.js";
import { resolveSearchCandidateRole } from "./search-candidate-role.js";
import { resolveSearchPolicy } from "./search-policy.js";
import { searchRerankCandidateId } from "./search-rerank-projection.js";
import type { SearchRerankProjectionResult } from "./search-rerank-projection-result.js";
import type { SearchResponseEnvelope } from "./search-types.js";
import { SEARCH_RESPONSE_FORMAT_VERSION } from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import type { TrackedRootReadinessState } from "./tracked-root-readiness.js";

type FixtureCandidate = {
    candidateId: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
    score: number;
    symbolLabel: string;
};

function candidate(candidateId: string, relativePath: string, score: number): FixtureCandidate {
    return {
        candidateId,
        relativePath,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: "export function implementation() { return true; }",
        score,
        symbolLabel: "function implementation()",
    };
}

function buildSupport(reranker: Reranker | null): SearchQuerySupport {
    return new SearchQuerySupport({
        normalizeSearchPath: (value) => value,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => [],
        classifyPathCategory: () => "srcRuntime",
        shouldIncludeCategoryInScope: () => true,
        getSyncWatchDebounceMs: () => 0,
        capabilities: {
            hasReranker: () => reranker !== null,
            getDefaultRerankEnabled: () => reranker !== null,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker,
        gitignoreForceReloadEveryN: 25,
    });
}

function buildInput(query: string): SearchExecutionInput {
    const parsedOperators = parseSearchOperators(query);
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    return {
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit: 4,
        debugMode: "none",
        semanticQuery: parsedOperators.semanticQuery,
        answerFocus,
        rerankQuery: buildSearchRerankQuery({
            semanticQuery: parsedOperators.semanticQuery,
            answerFocus,
        }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        parsedOperators,
        queryPlan,
        exactRegistryEligible: false,
        exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: "synced",
        observedChangedFilesState: { available: false, files: new Set() },
        dirtyFilesNotFreshened: false,
        retrievalPolicy: resolveSearchPolicy({ resultLimit: 4, hasMustOperators: false }),
    };
}

function v3Projection(result: FixtureCandidate): SearchRerankProjectionResult {
    const candidateRole = resolveSearchCandidateRole({
        relativePath: result.relativePath,
        language: result.language,
    });
    const document = JSON.stringify({
        repository_relative_path: result.relativePath,
        candidate_role: candidateRole,
        query_relevant_source_excerpt: result.content,
    });
    return {
        ok: true,
        document,
        utf8Bytes: Buffer.byteLength(document, "utf8"),
        sha256: crypto.createHash("sha256").update(document, "utf8").digest("hex"),
        candidateRole,
        projectionIdentity: "search_rerank_document_v3",
    };
}

function buildHost(
    results: FixtureCandidate[],
    reranker: Reranker | null,
    buildRerankDocument?: SearchExecutionHost["buildRerankDocument"],
): SearchExecutionHost {
    return {
        searchQuerySupport: buildSupport(reranker),
        semanticSearch: async () => results,
        reranker,
        buildRerankDocument: buildRerankDocument
            ?? (async (_query, result) => v3Projection(result as FixtureCandidate)),
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
}

function buildDiagnostics(): SearchDiagnostics {
    return {
        queryLength: 0,
        limitRequested: 4,
        resultsBeforeFilter: 0,
        resultsAfterFilter: 0,
        excludedByIgnore: 0,
        excludedBySubdirectory: 0,
        filterPass: "expanded",
        freshnessMode: undefined,
        searchPassCount: 0,
        searchPassSuccessCount: 0,
        searchPassFailureCount: 0,
        rerankerAttempted: false,
        rerankerUsed: false,
        semanticSearchAttempts: 0,
        embeddingCallsByCurrentContract: 0,
        denseQueriesByCurrentContract: 0,
        sparseQueriesByCurrentContract: 0,
        rerankerCalls: 0,
        rerankerCandidates: 0,
        rerankerInputBytes: 0,
        rerankerFailures: 0,
        rerankerRetries: 0,
        rerankerTimeouts: 0,
        candidatesWithSemanticEvidence: 0,
        candidatesWithLexicalEvidence: 0,
        candidatesWithCurrentSourceEvidence: 0,
        semanticExpansionAttempted: false,
    };
}

test("Scenario A: exact question and factual roles reach the provider without numeric preference", async () => {
    const question = "how does Shariah compliance checking block trades";
    const captured: { query?: string; documents?: string[]; identities?: string[] } = {};
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (query, documents, options) => {
            captured.query = query;
            captured.documents = [...documents];
            captured.identities = [...(options?.identities ?? [])];
            return (options?.identities ?? []).map((_identity, index) => ({
                index,
                relevanceScore: 1 - index / 10,
            })) satisfies RerankResult[];
        },
    };
    const results = [
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ];
    const input = buildInput(question);
    assert.equal(input.answerFocus, "implementation");
    const outcome = await runSearchExecution(input, buildHost(results, reranker), buildDiagnostics());

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const query = captured.query ?? "";
    assert.ok(query.includes("Requested answer type:"));
    assert.ok(query.includes("production implementation, control flow, and integration path"));
    assert.equal(query.split(question).length - 1, 1, "question appears exactly once");
    assert.equal(/multiplier|weight|boost|preference\s*\d/i.test(query), false);
    assert.equal(/\d\.\d+/.test(query), false);
    const documents = captured.documents ?? [];
    assert.ok(documents[0]!.includes('"candidate_role":"implementation"'));
    assert.ok(documents[1]!.includes('"candidate_role":"test"'));
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["impl", "test"],
    );
});

test("Scenario B: test-seeking query publishes tests focus while provider order stays final", async () => {
    const question = "find tests that prove Shariah trade rejection";
    const captured: { query?: string } = {};
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (query, _documents, options) => {
            captured.query = query;
            // Provider publishes the reverse of retrieval order; that order is final.
            const identities = options?.identities ?? [];
            return identities.map((_identity, index) => ({
                index: identities.length - index - 1,
                relevanceScore: 1 - index / 10,
            })) satisfies RerankResult[];
        },
    };
    const results = [
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ];
    const input = buildInput(question);
    assert.equal(input.answerFocus, "tests");
    const outcome = await runSearchExecution(input, buildHost(results, reranker), buildDiagnostics());

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.ok((captured.query ?? "").includes("Requested answer type:"));
    assert.ok((captured.query ?? "").includes("tests that directly verify the requested behavior"));
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["test", "impl"],
    );
});

test("Scenario C: one failed projection degrades input and keeps the failed candidate in place", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (_query, documents, options) => {
            providerCandidateIds.push([...(options?.identities ?? [])]);
            // Provider reverses the admitted slots.
            return documents.map((_document, index) => ({
                index: documents.length - index - 1,
                relevanceScore: index / Math.max(1, documents.length),
            })) satisfies RerankResult[];
        },
    };
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
        candidate("d", "src/d.ts", 0.6),
    ];
    const outcome = await runSearchExecution(
        buildInput("how does Shariah compliance checking block trades"),
        buildHost(results, reranker, async (_query, result) => (
            (result as FixtureCandidate).relativePath === "src/c.ts"
                ? {
                    ok: false,
                    candidateId: searchRerankCandidateId(result),
                    reason: "source_hash_mismatch",
                }
                : v3Projection(result as FixtureCandidate)
        )),
        buildDiagnostics(),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["a", "b", "d"]]);
    assert.ok(outcome.searchWarnings.includes("RERANKER_INPUT_DEGRADED"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.equal(outcome.rerankerProjection?.requestedCandidates, 4);
    assert.equal(outcome.rerankerProjection?.projectedCandidates, 3);
    assert.deepEqual(outcome.rerankerProjection?.failureCounts, { source_hash_mismatch: 1 });
    // Failed candidate stays at its retrieval slot; admitted slots follow provider order.
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["d", "b", "c", "a"],
    );
});

test("Scenario D: universal projection failure skips the provider and keeps retrieval order", async () => {
    let providerCalls = 0;
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async () => {
            providerCalls += 1;
            return [];
        },
    };
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await runSearchExecution(
        buildInput("how does Shariah compliance checking block trades"),
        buildHost(results, reranker, async (_query, result) => ({
            ok: false,
            candidateId: searchRerankCandidateId(result),
            reason: "source_hash_mismatch",
        })),
        buildDiagnostics(),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.rerankerAttempted, false);
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.orderAuthority, "retrieval_order");
    assert.ok(outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

test("Scenario E: provider timeout freezes retrieval order and reports qualified lateness", async () => {
    const effectiveScoreDeadlineMs = 2000;
    const observedWallMs = 2450;
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (_query, _documents, options) => {
            options?.onExecutionDiagnostics?.({
                attempts: 1,
                retries: 0,
                timeouts: 1,
                effectiveScoreDeadlineMs,
                observedWallMs,
                deadlineLatenessMs: observedWallMs - effectiveScoreDeadlineMs,
            });
            throw new RerankerRequestError("timeout", null, 1, "reranker request timed out");
        },
    };
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await runSearchExecution(
        buildInput("how does Shariah compliance checking block trades"),
        buildHost(results, reranker),
        buildDiagnostics(),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.orderAuthority, "retrieval_order");
    assert.equal(outcome.rerankerFailurePhase, "api_call");
    assert.equal(outcome.rerankerFailureKind, "timeout");
    assert.ok(outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.deepEqual(outcome.rerankerExecutionDiagnostics, {
        attempts: 1,
        retries: 0,
        timeouts: 1,
        effectiveScoreDeadlineMs,
        observedWallMs,
        deadlineLatenessMs: 450,
    });
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

const LANCEDB_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: "Potion",
    embeddingModel: "pinned-potion",
    embeddingDimension: 256,
    vectorStoreProvider: "LanceDB",
    schemaVersion: "hybrid_v3",
};

function ownerIdentity(satoriVersion: string, lanceDbPath: string) {
    return buildRuntimeOwnerIdentity({
        satoriVersion,
        runtimeFingerprint: LANCEDB_FINGERPRINT,
        configSource: "env",
        configSummary: {
            executionProfile: "offline",
            networkPolicy: "local-only",
            embeddingProvider: "Potion",
            embeddingModel: "pinned-potion",
            embeddingDimension: 256,
            vectorStoreProvider: "LanceDB",
            schemaVersion: "hybrid_v3",
            lanceDbPath,
        },
    });
}

function liveProcess(pid: number) {
    return {
        pid,
        ppid: 10,
        cmd: `/usr/bin/node /tmp/satori-${pid}.js`,
        cwd: `/tmp/repo-${pid}`,
        processStartTime: `start-${pid}`,
    };
}

test("Scenario F: state-root isolation scopes mutation ownership to the backend authority", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-e2e-home-"));
    const alphaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-e2e-alpha-"));
    const betaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-e2e-beta-"));
    try {
        const alphaDir = resolveRuntimeOwnerStateDir({
            stateRoot: alphaRoot,
            vectorStoreProvider: "LanceDB",
            homeDir,
        });
        const betaDir = resolveRuntimeOwnerStateDir({
            stateRoot: betaRoot,
            vectorStoreProvider: "LanceDB",
            homeDir,
        });
        assert.notEqual(alphaDir, betaDir);
        assert.equal(alphaDir, path.join(alphaRoot, "runtime-owner"));

        const alphaRuntime = new RuntimeOwnerRegistry({
            stateDir: alphaDir,
            identity: ownerIdentity("6.8.2", path.join(alphaRoot, "lancedb")),
            currentProcess: liveProcess(101),
            processInspector: { inspect: (pid) => (pid === 101 ? liveProcess(101) : null) },
        });
        const betaRuntime = new RuntimeOwnerRegistry({
            stateDir: betaDir,
            identity: ownerIdentity("6.8.2", path.join(betaRoot, "lancedb")),
            currentProcess: liveProcess(202),
            processInspector: { inspect: (pid) => (pid === 202 ? liveProcess(202) : null) },
        });

        // Different state roots: each local runtime mutates freely.
        alphaRuntime.registerCurrentOwner();
        assert.equal(alphaRuntime.checkMutation("sync", alphaRoot).blocked, false);
        betaRuntime.registerCurrentOwner();
        assert.equal(betaRuntime.checkMutation("sync", betaRoot).blocked, false);

        // Same state root, incompatible identities: mutation conflicts.
        const intruder = new RuntimeOwnerRegistry({
            stateDir: alphaDir,
            identity: ownerIdentity("6.9.0", path.join(alphaRoot, "lancedb")),
            currentProcess: liveProcess(303),
            processInspector: {
                inspect: (pid) => (
                    pid === 101 ? liveProcess(101) : pid === 303 ? liveProcess(303) : null
                ),
            },
        });
        const blocked = intruder.checkMutation("reindex", alphaRoot);
        assert.equal(blocked.blocked, true);
        assert.equal(blocked.reason, "runtime_owner_conflict");
        assert.equal(blocked.conflictingOwners?.length, 1);
        assert.ok(blocked.message?.includes("Registry:"));
        assert.ok(blocked.message?.includes("Lock:"));
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(alphaRoot, { recursive: true, force: true });
        fs.rmSync(betaRoot, { recursive: true, force: true });
    }
});

test("Scenario G: cold-start joins a same-root sync once; reindex stays bounded not_ready", async () => {
    const codebasePath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-e2e-coldstart-"));
    try {
        let phase: "indexing-sync" | "ready" = "indexing-sync";
        let syncJoins = 0;
        const readyState = (): TrackedRootReadinessState => ({
            state: "ready",
            root: { path: codebasePath, info: {} as never },
            navigationAuthorityMode: "canonical_v4",
            navigationStatus: "valid",
            preparedObservation: "observation-1",
        });
        const host: SearchFrontDoorHost = {
            trackedRootReadiness: {
                buildIndexFailedSearchPayload: () => {
                    throw new Error("unexpected index_failed state");
                },
                buildMissingLocalCollectionSearchPayload: () => {
                    throw new Error("unexpected missing_collection state");
                },
            },
            prepareInitialTrackedRootRead: async () => (
                phase === "indexing-sync"
                    ? {
                        state: "indexing",
                        codebasePath,
                        operation: { action: "sync", phase: "vector", generation: 2 },
                        searchableGenerationAvailable: true,
                    } satisfies TrackedRootReadinessState
                    : readyState()
            ),
            waitForSearchableSync: async () => {
                syncJoins += 1;
                phase = "ready";
                return true;
            },
            preparePostFreshnessTrackedRootRead: async () => readyState(),
            getPreparedReadObservation: () => "observation-1",
            ensureSearchFreshness: async () => ({
                mode: "skipped_recent",
                checkedAt: new Date(0).toISOString(),
                thresholdMs: 5000,
            }) satisfies FreshnessDecision,
            noteFreshnessMode: () => {},
            buildInvalidSearchRequestPayload: () => {
                throw new Error("unexpected invalid request payload");
            },
            buildRequiresReindexPayload: () => {
                throw new Error("unexpected requires_reindex payload");
            },
            buildNotReadySearchPayload: () => ({
                formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
                status: "not_ready",
                reason: "not_ready",
                path: codebasePath,
                message: "Indexing is in progress.",
                results: [],
            }) as unknown as SearchResponseEnvelope,
            buildFreshnessBlockedSearchPayload: () => null,
            buildManageIndexRecommendedAction: () => {
                throw new Error("unexpected recommended action");
            },
            buildCreateHint: () => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
            buildSyncHint: () => ({ tool: "manage_index", args: { action: "sync", path: codebasePath } }),
            buildRepairHint: () => ({ tool: "manage_index", args: { action: "repair", path: codebasePath } }),
            buildStaleLocalHint: () => ({}),
            buildStaleLocalMessage: () => "",
            canSyncStaleLocal: () => false,
            withProofDebugHint: (payload) => payload,
            isPartialIndexNavigationUnavailable: () => false,
            partialIndexWarnings: [],
        };

        const frontDoorInput = {
            path: codebasePath,
            query: "how does veto work",
            scope: "runtime" as const,
            groupBy: "file" as const,
            resultMode: "raw" as const,
            limit: 3,
        };

        // A transient same-root sync is joined exactly once, then search proceeds.
        const joined = await runSearchFrontDoor(frontDoorInput, host);
        assert.equal(joined.kind, "ready");
        assert.equal(syncJoins, 1);
        if (joined.kind !== "ready") return;
        assert.equal(joined.effectiveRoot, codebasePath);

        // A reindex never joins search; it stays not_ready with the bounded retry.
        phase = "indexing-sync";
        syncJoins = 0;
        host.prepareInitialTrackedRootRead = async () => ({
            state: "indexing",
            codebasePath,
            operation: { action: "reindex", phase: "vector", generation: 3 },
            searchableGenerationAvailable: true,
        });
        const blocked = await runSearchFrontDoor(frontDoorInput, host);
        assert.equal(blocked.kind, "blocked");
        assert.equal(syncJoins, 0);
        if (blocked.kind !== "blocked") return;
        assert.equal(blocked.payload.status, "not_ready");
        assert.equal(blocked.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.equal(DEFAULT_MANAGE_RETRY_AFTER_MS, 2000);
        assert.equal(blocked.payload.indexingOperation?.action, "reindex");
    } finally {
        fs.rmSync(codebasePath, { recursive: true, force: true });
    }
});

const PACKED_WORKER = String.raw`#!/usr/bin/env node
const readline = require('node:readline');

process.stdout.write(JSON.stringify({
  ready: true,
  modelLoadedOnce: true,
  retainedTokenLimit: 4096,
  networkBlocked: true,
}) + '\n');

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.op === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\n', () => process.exit(0));
    return;
  }
  const angle = (Buffer.byteLength(request.text, 'utf8') % 100) / 100;
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    retainedTokenCount: 1,
    vector: [Math.cos(angle), Math.sin(angle), ...Array(254).fill(0)],
  }) + '\n');
});
`;

test("Scenario H: a 0644 helper fails closed before execution and succeeds after install chmod", async () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-e2e-packed-"));
    try {
        const helperPath = path.join(installRoot, "satori-potion");
        const modelPath = path.join(installRoot, "model");
        fs.mkdirSync(modelPath);
        fs.writeFileSync(helperPath, PACKED_WORKER);
        fs.chmodSync(helperPath, 0o644);
        const helperSha256 = crypto.createHash("sha256").update(PACKED_WORKER, "utf8").digest("hex");

        // Checksum mismatch must never chmod the helper.
        await assert.rejects(
            restoreVerifiedOwnerExecutableBit({
                filePath: helperPath,
                expectedSha256: "0".repeat(64),
                label: "helper",
            }),
            /checksum|unavailable/i,
        );
        assert.equal(fs.statSync(helperPath).mode & 0o777, 0o644);

        // Verified bytes restore only the owner execute bit.
        await restoreVerifiedOwnerExecutableBit({
            filePath: helperPath,
            expectedSha256: helperSha256,
            label: "helper",
        });
        assert.equal(fs.statSync(helperPath).mode & 0o777, 0o744);

        type LocalPotionConstructor = new (config: {
            helperPath: string;
            modelPath: string;
            requestTimeoutMs: number;
            startupTimeoutMs: number;
            maxBatchItems: number;
        }) => PotionEmbedding;
        const LocalPotion = PotionEmbedding as unknown as LocalPotionConstructor;
        const embedding = new LocalPotion({
            helperPath,
            modelPath,
            requestTimeoutMs: 5000,
            startupTimeoutMs: 5000,
            maxBatchItems: 4,
        });
        await (embedding as unknown as { start(): Promise<void> }).start();
        try {
            const result = await embedding.embedQuery("how does Shariah compliance checking block trades");
            assert.equal(result.vector.length, POTION_DIMENSION);
            assert.ok(result.vector.every(Number.isFinite));
        } finally {
            await embedding.close();
        }
    } finally {
        fs.rmSync(installRoot, { recursive: true, force: true });
    }
});
