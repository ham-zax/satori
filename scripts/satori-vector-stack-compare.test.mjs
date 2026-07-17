import test from "node:test";
import assert from "node:assert/strict";
import { hashTaskSuite } from "./satori-useful-context-record.mjs";
import { compareVectorStacks, parseArgs } from "./satori-vector-stack-compare.mjs";
import { validateTaskSuite } from "./satori-useful-context.mjs";

const TASK_SUITE = {
    version: 1,
    name: "vector stack fixture",
    tasks: [
        {
            id: "lexical-owner",
            queryClass: "exact_identifier",
            comparisonClass: "lexical",
            language: "typescript",
            expected: { ownerFile: "src/owner.ts", ownerSymbol: "owner" },
            workload: {
                setup: [{ tool: "manage_index", args: { action: "status", path: "$REPO_ROOT" } }],
                invocations: [{ tool: "search_codebase", args: { path: "$REPO_ROOT", query: "owner" } }],
                phaseProtocol: { cold: "cold protocol", warm: "warm protocol" },
            },
        },
        {
            id: "hybrid-owner",
            queryClass: "owner_discovery",
            comparisonClass: "hybrid",
            language: "typescript",
            expected: { ownerFile: "src/owner.ts", ownerSymbol: "owner" },
            workload: {
                setup: [{ tool: "manage_index", args: { action: "status", path: "$REPO_ROOT" } }],
                invocations: [{ tool: "search_codebase", args: { path: "$REPO_ROOT", query: "where is ownership handled" } }],
                phaseProtocol: { cold: "cold protocol", warm: "warm protocol" },
            },
        },
    ],
};

function fingerprint(vectorStoreProvider, embeddingProvider) {
    const ollama = embeddingProvider === "Ollama";
    return {
        embeddingProvider,
        embeddingModel: ollama ? "nomic-embed-text:latest" : "voyage-code-3",
        embeddingDimension: ollama ? 768 : 1024,
        embeddingArtifactDigest: ollama ? "a".repeat(64) : null,
        embeddingNormalizationPolicy: "provider_output_v1",
        vectorStoreProvider,
        schemaVersion: "hybrid_v3",
        parserVersion: "parser_v1",
        extractorVersion: "extractor_v1",
        relationshipVersion: "relationship_v1",
        embeddingProjectionVersion: "embedding_projection_v1",
        lexicalProjectionVersion: "lexical_projection_v1",
    };
}

function qualificationRuntime() {
    const identity = {
        schemaVersion: 1,
        status: "bound",
        source: {
            gitRevision: "2".repeat(40),
            gitTree: "3".repeat(40),
        },
        recorder: { bytes: 100, sha256: "4".repeat(64) },
        commandArtifacts: [{
            index: 1,
            basename: "index.js",
            bytes: 200,
            sha256: "5".repeat(64),
        }],
        manifests: [
            "package.json",
            "pnpm-lock.yaml",
            "packages/core/package.json",
            "packages/mcp/package.json",
        ].map((relativePath, index) => ({
            relativePath,
            bytes: 300 + index,
            sha256: String(6 + index).repeat(64),
        })),
        runtime: {
            schemaVersion: 1,
            nodeVersion: process.version,
            roots: ["packages/core/dist", "packages/mcp/dist"].map((relativeRoot, index) => ({
                relativeRoot,
                fileCount: 10 + index,
                totalBytes: 1_000 + index,
                sha256: String(index + 1).repeat(64),
            })),
        },
    };
    identity.runtime.sha256 = hashTaskSuite(identity.runtime);
    return { ...identity, sha256: hashTaskSuite(identity) };
}

function observation(taskId, phase, sample, latencyMs, results, retrievalMode, generationReceipt) {
    return {
        taskId,
        phase,
        sample,
        generationReceipt: structuredClone(generationReceipt),
        status: "ok",
        latencyMs,
        contextBytes: 20,
        response: {
            status: "ok",
            hints: {
                debugSearch: {
                    route: { kind: retrievalMode === "lexical" ? "exact_identifier" : "ownership" },
                    retrieval: { mode: retrievalMode },
                    providerWork: {
                        semanticSearchAttempts: retrievalMode === "lexical" ? 0 : 1,
                        embeddingCallsByCurrentContract: retrievalMode === "lexical" ? 0 : 1,
                        denseQueriesByCurrentContract: retrievalMode === "lexical" ? 0 : 1,
                        sparseQueriesByCurrentContract: 1,
                        rerankerCalls: 0,
                        rerankerCandidates: 0,
                        rerankerInputBytes: 0,
                        candidatesWithSemanticEvidence: retrievalMode === "lexical" ? 0 : 1,
                        candidatesWithLexicalEvidence: 1,
                        candidatesWithCurrentSourceEvidence: 1,
                    },
                },
            },
        },
        results,
        toolCalls: 1,
        callsToSource: null,
        sourceReached: false,
        sourceMode: null,
    };
}

function observationSet(vectorStoreProvider, embeddingProvider, options = {}) {
    const normalizedSuite = validateTaskSuite(TASK_SUITE);
    const runtimeFingerprint = fingerprint(vectorStoreProvider, embeddingProvider);
    const generationReceipt = {
        canonicalRoot: "/repo",
        runtimeFingerprint,
        publication: {
            collectionName: "generation-1",
            markerRunId: "marker-run-1",
            indexPolicyHash: "a".repeat(64),
            policyDocumentDigest: "b".repeat(64),
        },
    };
    const owner = { file: "src/owner.ts", symbol: "owner" };
    const alternate = { file: "src/alternate.ts", symbol: "alternate" };
    const hybridResults = options.alternateHybrid ? [alternate, owner] : [owner, alternate];
    return {
        version: 2,
        warmSampleCount: 1,
        metadata: {
            repoRoot: "/repo",
            gitRevision: options.gitRevision ?? "1".repeat(40),
            taskSuiteSha256: hashTaskSuite(normalizedSuite),
            serverInfo: { name: "satori", version: "1.0.0" },
            node: { version: "v22.13.0", platform: "linux", arch: "x64" },
            qualificationRuntime: qualificationRuntime(),
            warmSampleCount: 1,
            armIndexProof: {
                id: "sync-arm",
                action: "sync",
                canonicalRoot: generationReceipt.canonicalRoot,
                generation: 1,
                phase: "completed",
                lastDurableTransitionAt: "2026-07-17T00:00:00.000Z",
                runtimeFingerprint,
                publication: structuredClone(generationReceipt.publication),
            },
            taskRuns: normalizedSuite.tasks.map((task, index) => ({
                taskId: task.id,
                syncStats: { added: 0, removed: 0, modified: 0 },
                indexProof: {
                    id: `sync-task-${index}`,
                    action: "sync",
                    canonicalRoot: "/repo",
                    generation: 1 + index,
                    phase: "completed",
                    lastDurableTransitionAt: `2026-07-17T00:00:0${index + 1}.000Z`,
                    runtimeFingerprint: index === 1 && options.secondFingerprint
                        ? options.secondFingerprint
                        : runtimeFingerprint,
                    publication: structuredClone(generationReceipt.publication),
                },
            })),
        },
        observations: [
            observation("lexical-owner", "cold", 0, 10, [owner], "lexical", generationReceipt),
            observation("lexical-owner", "warm", 1, 5, [owner], "lexical", generationReceipt),
            observation("hybrid-owner", "cold", 0, 20, hybridResults, "hybrid", generationReceipt),
            observation("hybrid-owner", "warm", 1, 8, hybridResults, "hybrid", generationReceipt),
        ],
    };
}

test("compares storage-only, embedding-only, and full-stack arms without conflating them", () => {
    const comparison = compareVectorStacks(TASK_SUITE, [
        { id: "milvus-voyage", sourceFile: "/tmp/milvus.json", observations: observationSet("Milvus", "VoyageAI") },
        { id: "lancedb-voyage", sourceFile: "/tmp/lancedb-voyage.json", observations: observationSet("LanceDB", "VoyageAI") },
        {
            id: "lancedb-ollama",
            sourceFile: "/tmp/lancedb-ollama.json",
            observations: observationSet("LanceDB", "Ollama", { alternateHybrid: true }),
        },
    ]);

    assert.equal(comparison.schemaVersion, "satori_vector_stack_comparison_v1");
    assert.deepEqual(comparison.comparisons.map((entry) => entry.changeKind), [
        "storage_only",
        "full_stack",
        "embedding_only",
    ]);
    assert.equal(comparison.comparisons[0].resultAgreement.meanJaccard, 1);
    assert.equal(comparison.comparisons[1].resultAgreement.exactOrderMatches, 2);
    assert.equal(comparison.comparisons[1].resultAgreementByClass.hybrid.topResultMatches, 0);
    assert.equal(
        comparison.arms[0].logicalProviderWork.totals.embeddingCallsByCurrentContract,
        2,
    );
    assert.deepEqual(comparison.arms[0].logicalProviderWork.retrievalModes, { hybrid: 2, lexical: 2 });
});

test("rejects mismatched corpus revisions before producing paired metrics", () => {
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "left", observations: observationSet("Milvus", "VoyageAI") },
        {
            id: "right",
            observations: observationSet("LanceDB", "VoyageAI", { gitRevision: "2".repeat(40) }),
        },
    ]), /different gitRevision/);
});

test("rejects missing or unequal qualification runtime artifacts", () => {
    const left = observationSet("Milvus", "VoyageAI");
    const missing = observationSet("LanceDB", "VoyageAI");
    delete missing.metadata.qualificationRuntime;
    assert.throws(
        () => compareVectorStacks(TASK_SUITE, [
            { id: "milvus", observations: left },
            { id: "lancedb", observations: missing },
        ]),
        /qualification runtime must be an object/,
    );

    const changed = observationSet("LanceDB", "VoyageAI");
    changed.metadata.qualificationRuntime.recorder.sha256 = "f".repeat(64);
    const { sha256: _oldDigest, ...unsignedIdentity } = changed.metadata.qualificationRuntime;
    changed.metadata.qualificationRuntime.sha256 = hashTaskSuite(unsignedIdentity);
    assert.throws(
        () => compareVectorStacks(TASK_SUITE, [
            { id: "milvus", observations: left },
            { id: "lancedb", observations: changed },
        ]),
        /different qualificationRuntime identity/,
    );
});

test("rejects an arm whose runtime fingerprint changes between task runs", () => {
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "left", observations: observationSet("Milvus", "VoyageAI") },
        {
            id: "right",
            observations: observationSet("LanceDB", "VoyageAI", {
                secondFingerprint: fingerprint("LanceDB", "Ollama"),
            }),
        },
    ]), /not bound to the arm-level generation proof/);
});

test("accepts different no-change sync operation receipts for one published generation", () => {
    const arm = observationSet("LanceDB", "VoyageAI");
    assert.notEqual(arm.metadata.taskRuns[0].indexProof.id, arm.metadata.taskRuns[1].indexProof.id);
    assert.notEqual(
        arm.metadata.taskRuns[0].indexProof.lastDurableTransitionAt,
        arm.metadata.taskRuns[1].indexProof.lastDurableTransitionAt,
    );

    assert.doesNotThrow(() => compareVectorStacks(TASK_SUITE, [
        { id: "left", observations: observationSet("Milvus", "VoyageAI") },
        { id: "right", observations: arm },
    ]));
});

test("rejects changed syncs and observations from another published generation", () => {
    const changed = observationSet("LanceDB", "VoyageAI");
    changed.metadata.taskRuns[0].syncStats.modified = 1;
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "baseline", observations: observationSet("Milvus", "VoyageAI") },
        { id: "changed", observations: changed },
    ]), /no-change syncStats\.modified=0/);

    // Mutation-lease generation may advance across no-change syncs; publication
    // identity is what freezes the searchable arm.
    const advancedLeaseGeneration = observationSet("LanceDB", "VoyageAI");
    advancedLeaseGeneration.metadata.taskRuns[1].indexProof.generation = 99;
    assert.doesNotThrow(() => compareVectorStacks(TASK_SUITE, [
        { id: "baseline", observations: observationSet("Milvus", "VoyageAI") },
        { id: "lease-advanced", observations: advancedLeaseGeneration },
    ]));

    const mixedPublication = observationSet("LanceDB", "VoyageAI");
    mixedPublication.observations[0].generationReceipt = {
        ...mixedPublication.observations[0].generationReceipt,
        publication: {
            ...mixedPublication.observations[0].generationReceipt.publication,
            markerRunId: "other-marker-run",
        },
    };
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "baseline", observations: observationSet("Milvus", "VoyageAI") },
        { id: "mixed", observations: mixedPublication },
    ]), /not bound to the arm-level generation/);
});

test("rejects a reused generation number with a different publication identity", () => {
    const republishedTask = observationSet("LanceDB", "VoyageAI");
    republishedTask.metadata.taskRuns[1].indexProof.publication.markerRunId = "replacement-marker-run";
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "baseline", observations: observationSet("Milvus", "VoyageAI") },
        { id: "republished", observations: republishedTask },
    ]), /not bound to the arm-level generation proof/);

    const republishedObservation = observationSet("LanceDB", "VoyageAI");
    republishedObservation.observations[0].generationReceipt.publication.markerRunId = "replacement-marker-run";
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "baseline", observations: observationSet("Milvus", "VoyageAI") },
        { id: "republished", observations: republishedObservation },
    ]), /not bound to the arm-level generation/);
});

test("rejects unknown publication identity fields", () => {
    const arm = observationSet("LanceDB", "VoyageAI");
    arm.metadata.armIndexProof.publication.futureIdentity = "unknown";
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "baseline", observations: observationSet("Milvus", "VoyageAI") },
        { id: "future", observations: arm },
    ]), /must contain exactly/);
});

test("fails closed when compatibility fields or measurement diagnostics are incomplete", () => {
    const unknownFingerprint = {
        ...fingerprint("LanceDB", "VoyageAI"),
        futureCompatibilityField: "unknown",
    };
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "left", observations: observationSet("Milvus", "VoyageAI") },
        {
            id: "right",
            observations: observationSet("LanceDB", "VoyageAI", {
                secondFingerprint: unknownFingerprint,
            }),
        },
    ]), /exactly the current fingerprint fields/);

    const missingDiagnostics = observationSet("LanceDB", "VoyageAI");
    delete missingDiagnostics.observations[0].response.hints.debugSearch.providerWork;
    assert.throws(() => compareVectorStacks(TASK_SUITE, [
        { id: "left", observations: observationSet("Milvus", "VoyageAI") },
        { id: "right", observations: missingDiagnostics },
    ]), /providerWork must be an object/);
});

test("classifies normalization drift as full-stack and keeps result tuples collision-free", () => {
    const changedNormalization = {
        ...fingerprint("LanceDB", "VoyageAI"),
        embeddingNormalizationPolicy: "different_policy",
    };
    const right = observationSet("LanceDB", "VoyageAI", {
        secondFingerprint: changedNormalization,
    });
    right.metadata.armIndexProof.runtimeFingerprint = changedNormalization;
    right.metadata.taskRuns[0].indexProof.runtimeFingerprint = changedNormalization;
    for (const observation of right.observations) {
        observation.generationReceipt.runtimeFingerprint = changedNormalization;
    }
    right.observations[0].results = [
        { file: "src/a#b", symbol: "owner" },
        { file: "src/a", symbol: "b#owner" },
    ];
    const left = structuredClone(right);
    left.metadata.armIndexProof.runtimeFingerprint = fingerprint("LanceDB", "VoyageAI");
    for (const run of left.metadata.taskRuns) {
        run.indexProof.runtimeFingerprint = fingerprint("LanceDB", "VoyageAI");
    }
    for (const observation of left.observations) {
        observation.generationReceipt.runtimeFingerprint = fingerprint("LanceDB", "VoyageAI");
    }
    left.observations[0].results = [{ file: "src/a#b", symbol: "owner" }];

    const comparison = compareVectorStacks(TASK_SUITE, [
        { id: "left", observations: left },
        { id: "right", observations: right },
    ]);
    assert.equal(comparison.comparisons[0].changeKind, "full_stack");
    assert.equal(comparison.comparisons[0].resultAgreement.meanJaccard < 1, true);
});

test("parses repeated named arms", () => {
    const parsed = parseArgs([
        "--tasks", "tasks.json",
        "--arm", "milvus-voyage=milvus.json",
        "--arm", "lancedb-ollama=offline.json",
        "--json",
    ]);
    assert.deepEqual(parsed.arms.map((arm) => arm.id), ["milvus-voyage", "lancedb-ollama"]);
    assert.equal(parsed.json, true);
});
