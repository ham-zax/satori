import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    buildBuiltinEvidenceProfiles,
    classifyAnswerOutcome,
    evaluateErgonomicsGate,
    extractPiToolCalls,
    replayResultRecord,
    scoreEvidenceTrajectory,
} from "./ergonomics-scorer.mjs";
import { gradeRun } from "./run-opencode.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(
    fs.readFileSync(path.join(SCRIPT_DIR, "evaluator-tasks.json"), "utf8"),
);
const KNOWN_TASK = MANIFEST.tasks.find((task) => task.id === "known-exact-target");
const UNKNOWN_TASK = MANIFEST.tasks.find((task) => task.id === "unknown-freshness-reuse");

const KNOWN_OWNER_PART_1 = [
    "export async function runExactRegistryFastPath(",
    "    input: SearchExactFastPathInput,",
    "    host: SearchExactFastPathHost,",
    "): Promise<SearchExactFastPathOutcome> {",
    "    const eligible = isExactRegistryEligible(input, host);",
    "    if (!eligible) return { kind: \"continue\", exactRegistryFallbackForTrackedLexical: false };",
    '    if (input.navigationAuthority !== "valid") return { kind: "continue", exactRegistryFallbackForTrackedLexical: false };',
    "    const exactRegistryMatch = await findExactRegistryMatch({",
    "        registry: registryState.registry,",
    "        semanticQuery: exactLookupQuery,",
    "    });",
].join("\n");

const KNOWN_OWNER_PART_2 = [
    "    const debugRankingProvenance = {",
    "        semanticPassesUsed: [],",
    "        lexicalPassesUsed: [],",
    "        rerankApplied: false,",
    "    };",
    "    return { kind: \"handled\", finalized };",
    "}",
].join("\n");

const KNOWN_FULL_OWNER_BODY = `${KNOWN_OWNER_PART_1}\n${KNOWN_OWNER_PART_2}`;

const KNOWN_CALLER_EVIDENCE = [
    "142: export async function executeSearchAttempt(ctx) {",
    "148:     const fastPath = await runExactRegistryFastPath(fastPathInput, fastPathHost);",
    "149:     if (fastPath.kind === \"handled\") return fastPath.finalized;",
    "150: }",
].join("\n");

const KNOWN_CALLEE_EVIDENCE = [
    "88: export function findExactRegistryMatch(input: ExactRegistryLookupInput) {",
    "89:     return lookupNormalizedSymbol(input.registry, input.semanticQuery);",
    "90: }",
].join("\n");

const UNKNOWN_FULL_OWNER_BODY = [
    "export async function runSearchFrontDoor(",
    "    input: SearchFrontDoorContext,",
    "    host: SearchFrontDoorHost,",
    "): Promise<SearchFrontDoorOutcome> {",
    "    const servePreviousGeneration = (readable, operation) => {",
    '        if (operation?.action !== "sync") return null;',
    '        const freshnessDecision = { mode: "served_previous_generation" };',
    "        return readyResult(readable, absolutePath, freshnessDecision, host);",
    "    };",
    "    const blocked = buildBlockedReadinessPayload(state, searchContext, host);",
    "    if (blocked) return { kind: \"blocked\", payload: blocked };",
    "    const freshnessBlocked = host.buildFreshnessBlockedSearchPayload(initialRoot, freshnessDecision, searchContext);",
    '    if (freshnessBlocked && freshnessDecision.mode !== "skipped_requires_reindex") {',
    '        return { kind: "blocked", payload: freshnessBlocked };',
    "    }",
    '    const postFreshness = await host.preparePostFreshnessTrackedRootRead(absolutePath, "freshness_changed");',
    "    if (path.resolve(postFreshness.root.path) !== path.resolve(initialRoot)) {",
    '        throw new Error("Tracked root identity changed during search freshness validation.");',
    "    }",
    "    return readyResult(postFreshness, absolutePath, freshnessDecision, host);",
    "}",
].join("\n");

test("1. Signature-only preview fails firstSufficientEvidenceCall even with file and symbol", () => {
    const signatureOnlyPreview = [
        "packages/mcp/src/core/search-exact-fast-path.ts",
        "export async function runExactRegistryFastPath(",
        "    input: SearchExactFastPathInput,",
        "    host: SearchExactFastPathHost,",
        "): Promise<SearchExactFastPathOutcome>;",
    ].join("\n");

    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "satori_search_codebase",
                input: { path: "/repo", query: "runExactRegistryFastPath" },
                output: signatureOnlyPreview,
            },
            {
                index: 2,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-request-coordinator.ts", limit: 50 },
                output: KNOWN_CALLER_EVIDENCE,
            },
            {
                index: 3,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search/exact-registry.ts", limit: 50 },
                output: KNOWN_CALLEE_EVIDENCE,
            },
        ],
    });

    assert.equal(trajectory.sufficient, false);
    assert.equal(trajectory.firstSufficientEvidenceCall, null);
    assert.equal(trajectory.callsAfterSufficientEvidence, null);
    assert.ok(
        trajectory.missingRequirements.some((req) => req.id === "checks_eligibility"),
        "expected missing checks_eligibility from signature-only preview",
    );
    assert.ok(
        trajectory.missingRequirements.some((req) => req.id === "avoids_semantic_and_rerank"),
        "expected missing avoids_semantic_and_rerank from signature-only preview",
    );
});

test("2. Truncated body missing a required statement fails until a later call supplies the missing lines", () => {
    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", offset: 227, limit: 60 },
                output: KNOWN_OWNER_PART_1,
            },
            {
                index: 2,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-request-coordinator.ts", offset: 140, limit: 30 },
                output: KNOWN_CALLER_EVIDENCE,
            },
            {
                index: 3,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search/exact-registry.ts", offset: 85, limit: 20 },
                output: KNOWN_CALLEE_EVIDENCE,
            },
            {
                index: 4,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", offset: 470, limit: 30 },
                output: KNOWN_OWNER_PART_2,
            },
        ],
    });

    assert.equal(trajectory.perCallProgress[0].sufficient, false);
    assert.equal(trajectory.perCallProgress[2].sufficient, false);
    assert.deepEqual(
        trajectory.perCallProgress[2].newlySatisfied,
        ["relation:callee:findExactRegistryMatch"],
    );
    assert.equal(trajectory.sufficient, true);
    assert.equal(trajectory.firstSufficientEvidenceCall, 4);
    assert.equal(trajectory.callsAfterSufficientEvidence, 0);
    assert.deepEqual(
        trajectory.perCallProgress[3].newlySatisfied,
        ["statement:avoids_semantic_and_rerank"],
    );
});

test("3. Wrong-root copy fails even when relative path and full source body match", () => {
    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: UNKNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "satori_read_file",
                input: { path: "/other-repo/packages/mcp/src/core/search-frontdoor.ts" },
                output: UNKNOWN_FULL_OWNER_BODY,
            },
            {
                index: 2,
                tool: "grep",
                input: { path: "/other-repo", pattern: "runSearchFrontDoor" },
                output: [
                    "/other-repo/packages/mcp/src/core/search-request-coordinator.ts:190: async function executeSearchAttempt() {",
                    "/other-repo/packages/mcp/src/core/search-request-coordinator.ts:195: return runSearchFrontDoor(ctx, host);",
                ].join("\n"),
            },
            {
                index: 3,
                tool: "read",
                input: { filePath: "/other-repo/packages/mcp/src/core/search-frontdoor.ts", offset: 130, limit: 60 },
                output: "const p = buildBlockedReadinessPayload(state, searchContext, host);",
            },
        ],
    });

    assert.equal(trajectory.sufficient, false);
    assert.equal(trajectory.firstSufficientEvidenceCall, null);
    assert.equal(trajectory.deliveredRequirements.length, 0);
});

test("4. Plausible relation name without witnessed site fails while witnessed site passes", () => {
    const bareMentionTools = [
        {
            index: 1,
            tool: "satori_read_file",
            input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts" },
            output: KNOWN_FULL_OWNER_BODY,
        },
        {
            index: 2,
            tool: "grep",
            input: { path: "/repo" },
            output: "Candidate caller symbol executeSearchAttempt in packages/mcp/src/core/search-request-coordinator.ts",
        },
        {
            index: 3,
            tool: "satori_file_outline",
            input: { path: "/repo", file: "packages/mcp/src/core/search/exact-registry.ts" },
            output: JSON.stringify({
                file: "packages/mcp/src/core/search/exact-registry.ts",
                symbols: [{ name: "findExactRegistryMatch", kind: "function", startLine: 88, endLine: 112 }],
            }),
        },
    ];

    const failedTrajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: bareMentionTools,
    });

    assert.equal(failedTrajectory.sufficient, false);
    assert.equal(failedTrajectory.firstSufficientEvidenceCall, null);
    assert.deepEqual(
        failedTrajectory.missingRequirements.map((req) => req.id),
        ["caller:executeSearchAttempt", "callee:findExactRegistryMatch"],
    );

    const witnessedTools = [
        ...bareMentionTools,
        {
            index: 4,
            tool: "satori_call_graph",
            input: { path: "/repo", symbolRef: { file: "packages/mcp/src/core/search-exact-fast-path.ts", symbol: "runExactRegistryFastPath" } },
            output: JSON.stringify({
                edges: [
                    {
                        src: "executeSearchAttempt",
                        dst: "runExactRegistryFastPath",
                        file: "packages/mcp/src/core/search-request-coordinator.ts",
                        site: { file: "packages/mcp/src/core/search-request-coordinator.ts", line: 148, kind: "call" },
                    },
                    {
                        src: "runExactRegistryFastPath",
                        dst: "findExactRegistryMatch",
                        file: "packages/mcp/src/core/search/exact-registry.ts",
                        site: { file: "packages/mcp/src/core/search/exact-registry.ts", line: 88, kind: "call" },
                    },
                ],
            }),
        },
    ];

    const passedTrajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: witnessedTools,
    });

    assert.equal(passedTrajectory.sufficient, true);
    assert.equal(passedTrajectory.firstSufficientEvidenceCall, 4);
    assert.equal(passedTrajectory.callsAfterSufficientEvidence, 0);
});

test("5. Tool-agnostic parity: verified body via satori_search_codebase scores at same ordinal as satori_read_file and read", () => {
    const searchHydratedHitOutput = JSON.stringify({
        results: [
            {
                file: "packages/mcp/src/core/search-exact-fast-path.ts",
                symbol: "runExactRegistryFastPath",
                span: { startLine: 227, endLine: 660 },
                preview: KNOWN_FULL_OWNER_BODY,
            },
        ],
    });

    const viaSearch = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "satori_search_codebase",
                input: { path: "/repo", query: "runExactRegistryFastPath" },
                output: searchHydratedHitOutput,
            },
            {
                index: 2,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-request-coordinator.ts", limit: 40 },
                output: KNOWN_CALLER_EVIDENCE,
            },
            {
                index: 3,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search/exact-registry.ts", limit: 40 },
                output: KNOWN_CALLEE_EVIDENCE,
            },
        ],
    });

    const viaSatoriRead = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "satori_read_file",
                input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts" },
                output: KNOWN_FULL_OWNER_BODY,
            },
            {
                index: 2,
                tool: "satori_read_file",
                input: { path: "/repo/packages/mcp/src/core/search-request-coordinator.ts" },
                output: KNOWN_CALLER_EVIDENCE,
            },
            {
                index: 3,
                tool: "satori_read_file",
                input: { path: "/repo/packages/mcp/src/core/search/exact-registry.ts" },
                output: KNOWN_CALLEE_EVIDENCE,
            },
        ],
    });

    const viaNativeRead = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", limit: 200 },
                output: KNOWN_FULL_OWNER_BODY,
            },
            {
                index: 2,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-request-coordinator.ts", limit: 200 },
                output: KNOWN_CALLER_EVIDENCE,
            },
            {
                index: 3,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search/exact-registry.ts", limit: 200 },
                output: KNOWN_CALLEE_EVIDENCE,
            },
        ],
    });

    assert.equal(viaSearch.firstSufficientEvidenceCall, 3);
    assert.equal(viaSatoriRead.firstSufficientEvidenceCall, 3);
    assert.equal(viaNativeRead.firstSufficientEvidenceCall, 3);
    assert.equal(
        viaSearch.deliveredRequirements.find((r) => r.id === "avoids_semantic_and_rerank")?.satisfiedAtCall,
        1,
    );
    assert.equal(
        viaSatoriRead.deliveredRequirements.find((r) => r.id === "avoids_semantic_and_rerank")?.satisfiedAtCall,
        1,
    );
    assert.equal(
        viaNativeRead.deliveredRequirements.find((r) => r.id === "avoids_semantic_and_rerank")?.satisfiedAtCall,
        1,
    );
});

test("6. Post-sufficiency redundant verification calls are accurately counted in callsAfterSufficientEvidence", () => {
    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: UNKNOWN_TASK,
        coldStartPhases: {
            launchToToolsMs: 420,
            firstSearchMs: 110,
            firstPublicationMs: 890,
        },
        tools: [
            {
                index: 1,
                tool: "satori_search_codebase",
                input: { path: "/repo", query: UNKNOWN_TASK.satoriQuery },
                output: JSON.stringify({
                    results: [{
                        file: "packages/mcp/src/core/search-frontdoor.ts",
                        symbol: "runSearchFrontDoor",
                        preview: UNKNOWN_FULL_OWNER_BODY,
                    }],
                }),
            },
            {
                index: 2,
                tool: "satori_call_graph",
                input: { path: "/repo", symbolRef: { file: "packages/mcp/src/core/search-frontdoor.ts", symbol: "runSearchFrontDoor" } },
                output: JSON.stringify({
                    edges: [{
                        src: "executeSearchAttempt",
                        dst: "runSearchFrontDoor",
                        file: "packages/mcp/src/core/search-request-coordinator.ts",
                        site: { file: "packages/mcp/src/core/search-request-coordinator.ts", line: 195, kind: "call" },
                    }],
                }),
            },
            {
                index: 3,
                tool: "satori_read_file",
                input: { path: "/repo/packages/mcp/src/core/search-frontdoor.ts" },
                output: UNKNOWN_FULL_OWNER_BODY,
            },
            {
                index: 4,
                tool: "satori_file_outline",
                input: { path: "/repo", file: "packages/mcp/src/core/search-frontdoor.ts" },
                output: JSON.stringify({ file: "packages/mcp/src/core/search-frontdoor.ts", symbols: [] }),
            },
            {
                index: 5,
                tool: "satori_read_file",
                input: { path: "/repo/packages/mcp/src/core/search-request-coordinator.ts" },
                output: "195: return runSearchFrontDoor(ctx, host);",
            },
        ],
    });

    // Call 1 satisfies all 5 owner statements PLUS helper (buildBlockedReadinessPayload) AND second_readiness_proof (preparePostFreshnessTrackedRootRead).
    // Call 2 satisfies caller (executeSearchAttempt).
    // Calls 3, 4, 5 are redundant verification calls!
    assert.equal(trajectory.sufficient, true);
    assert.equal(trajectory.firstSufficientEvidenceCall, 2);
    assert.equal(trajectory.callsAfterSufficientEvidence, 3);
    assert.equal(trajectory.totalToolCalls, 5);
    assert.deepEqual(trajectory.coldStartPhases, {
        launchToToolsMs: 420,
        firstSearchMs: 110,
        firstPublicationMs: 890,
    });
});

test("7. Schema-only failure separation distinguishes stringified booleans from wrong code facts", () => {
    const stringifiedBooleanResult = {
        status: "success",
        answer: {
            ownerFile: "packages/mcp/src/core/search-frontdoor.ts",
            ownerSymbol: "runSearchFrontDoor",
            ownerSpan: { startLine: 207, endLine: 345 },
            relatedSymbols: [
                {
                    relation: "caller",
                    symbol: "executeSearchAttempt",
                    file: "packages/mcp/src/core/search-request-coordinator.ts",
                },
                {
                    relation: "helper",
                    symbol: "buildBlockedReadinessPayload",
                    file: "packages/mcp/src/core/search-frontdoor.ts",
                },
                {
                    relation: "second_readiness_proof",
                    symbol: "preparePostFreshnessTrackedRootRead",
                    file: "packages/mcp/src/core/search-frontdoor.ts",
                },
            ],
            taskFacts: {
                servesPreviousGenerationDuringSync: "true",
                freshnessBlockedStopsBeforeSecondProof: "true",
                requiresSecondReadinessAfterFreshness: "true",
                requiresStableRootIdentity: "true",
                secondProofSymbol: "preparePostFreshnessTrackedRootRead",
            },
        },
    };

    const strictGrade = gradeRun({
        agentResult: stringifiedBooleanResult,
        task: UNKNOWN_TASK,
        arm: "satori",
        mode: "natural",
        repoRoot: "/repo",
        tools: [
            {
                tool: "satori_search_codebase",
                input: {
                    path: "/repo",
                    query: UNKNOWN_TASK.satoriQuery,
                    scope: "runtime",
                    resultMode: "grouped",
                    groupBy: "symbol",
                    rankingMode: "default",
                    limit: 5,
                },
                output: "",
                visibleBytes: 100,
            },
        ],
    });

    assert.equal(strictGrade.passed, false);
    assert.deepEqual(strictGrade.failureReasons, ["incorrect_taskFacts"]);

    const schemaClassified = classifyAnswerOutcome({
        agentResult: stringifiedBooleanResult,
        expected: UNKNOWN_TASK.expected,
        strictGrade,
    });

    assert.equal(schemaClassified.strictPassed, false);
    assert.equal(schemaClassified.coercedPassed, true);
    assert.equal(schemaClassified.answerSchemaOnlyFailure, true);
    assert.equal(schemaClassified.codeFactFailure, false);
    assert.deepEqual(schemaClassified.schemaCoercions, [
        "taskFacts.servesPreviousGenerationDuringSync",
        "taskFacts.freshnessBlockedStopsBeforeSecondProof",
        "taskFacts.requiresSecondReadinessAfterFreshness",
        "taskFacts.requiresStableRootIdentity",
    ]);

    const wrongFactResult = {
        ...stringifiedBooleanResult,
        answer: {
            ...stringifiedBooleanResult.answer,
            taskFacts: {
                ...stringifiedBooleanResult.answer.taskFacts,
                servesPreviousGenerationDuringSync: "false",
                secondProofSymbol: "wrongHelperName",
            },
        },
    };

    const wrongFactClassified = classifyAnswerOutcome({
        agentResult: wrongFactResult,
        expected: UNKNOWN_TASK.expected,
        strictGrade: { passed: false, failureReasons: ["incorrect_taskFacts"] },
    });

    assert.equal(wrongFactClassified.strictPassed, false);
    assert.equal(wrongFactClassified.coercedPassed, false);
    assert.equal(wrongFactClassified.answerSchemaOnlyFailure, false);
    assert.equal(wrongFactClassified.codeFactFailure, true);
    assert.deepEqual(wrongFactClassified.codeFactMismatches, [
        "taskFacts.servesPreviousGenerationDuringSync",
        "taskFacts.secondProofSymbol",
    ]);
});

test("8. Joint anti-Goodhart gate blocks token/byte blow-ups and strictPassRate regressions across arms", () => {
    const controlRuns = [
        {
            arm: "native",
            strictPassed: true,
            totalInputTokens: 12_000,
            wallTimeMs: 6_000,
            firstSufficientEvidenceCall: 5,
            visibleToolBytes: 4_000,
        },
        {
            arm: "native",
            strictPassed: true,
            totalInputTokens: 13_000,
            wallTimeMs: 6_500,
            firstSufficientEvidenceCall: 6,
            visibleToolBytes: 4_500,
        },
    ];

    // Goodharted treatment: cuts calls from 6 to 1 by dumping a huge blob (4x tokens, 8x bytes)
    const tokenBlowupTreatment = [
        {
            arm: "satori",
            strictPassed: true,
            totalInputTokens: 48_000,
            wallTimeMs: 6_200,
            firstSufficientEvidenceCall: 1,
            visibleToolBytes: 31_000,
        },
    ];
    const tokenGate = evaluateErgonomicsGate({
        controlRuns,
        treatmentRuns: tokenBlowupTreatment,
        armPolicy: { arm: "satori", scriptedFirstCall: false },
    });
    assert.equal(tokenGate.passed, false);
    assert.ok(tokenGate.failureReasons.includes("input_tokens_regression"));
    assert.ok(tokenGate.failureReasons.includes("visible_tool_bytes_regression"));
    assert.equal(tokenGate.checks.firstSufficientEvidenceCall, true);

    // Regressed strict pass rate treatment
    const accuracyDropTreatment = [
        {
            arm: "hybrid",
            strictPassed: false,
            totalInputTokens: 9_000,
            wallTimeMs: 4_500,
            firstSufficientEvidenceCall: 2,
            visibleToolBytes: 3_000,
        },
    ];
    const accuracyGate = evaluateErgonomicsGate({
        controlRuns,
        treatmentRuns: accuracyDropTreatment,
        armPolicy: { arm: "hybrid", scriptedFirstCall: false },
    });
    assert.equal(accuracyGate.passed, false);
    assert.deepEqual(accuracyGate.failureReasons, ["strict_pass_rate_regression"]);

    // Genuine ergonomic win across all metrics
    const genuineWinTreatment = [
        {
            arm: "hybrid",
            strictPassed: true,
            totalInputTokens: 8_500,
            wallTimeMs: 4_200,
            firstSufficientEvidenceCall: 2,
            visibleToolBytes: 2_800,
        },
    ];
    const winningGate = evaluateErgonomicsGate({
        controlRuns,
        treatmentRuns: genuineWinTreatment,
        armPolicy: { arm: "hybrid", scriptedFirstCall: false },
    });
    assert.equal(winningGate.passed, true);
    assert.deepEqual(winningGate.failureReasons, []);
    assert.equal(winningGate.arm, "hybrid");
    assert.equal(winningGate.scriptedFirstCall, false);
});

test("Built-in profiles and transcript replay produce deterministic results", () => {
    const profiles = buildBuiltinEvidenceProfiles();
    assert.equal(profiles["known-exact-target"].ownerSymbol, "runExactRegistryFastPath");
    assert.equal(profiles["unknown-freshness-reuse"].ownerSymbol, "runSearchFrontDoor");

    const replayed = replayResultRecord({
        repoRoot: "/repo",
        result: {
            runId: "test-run-1",
            taskId: "known-exact-target",
            arm: "satori",
            grade: { passed: true, failureReasons: [] },
            agentResult: {
                status: "success",
                answer: KNOWN_TASK.expected,
            },
            harness: {
                toolCalls: [
                    {
                        operation: "satori_read_file",
                        input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts" },
                        output: KNOWN_FULL_OWNER_BODY,
                        visibleResultBytes: 1024,
                    },
                    {
                        operation: "read",
                        input: { filePath: "/repo/packages/mcp/src/core/search-request-coordinator.ts", limit: 50 },
                        output: KNOWN_CALLER_EVIDENCE,
                        visibleResultBytes: 256,
                    },
                    {
                        operation: "read",
                        input: { filePath: "/repo/packages/mcp/src/core/search/exact-registry.ts", limit: 50 },
                        output: KNOWN_CALLEE_EVIDENCE,
                        visibleResultBytes: 256,
                    },
                ],
            },
        },
    });

    assert.equal(replayed.trajectory.sufficient, true);
    assert.equal(replayed.trajectory.firstSufficientEvidenceCall, 3);
    assert.equal(replayed.outcome.strictPassed, true);
});

test("Real Satori call_graph JSON (prefixed symbolLabel + cross-file callee site) and chunked multi-pattern reads satisfy trajectory", () => {
    const chunkA = [
        "export async function runExactRegistryFastPath(input, host) {",
        "  const eligible = isExactRegistryEligible(input, host);",
        '  if (input.navigationAuthority !== "valid") return { kind: "continue" };',
        "  const exactRegistryMatch = await findExactRegistryMatch({ registry });",
        "  semanticPassesUsed: [],",
    ].join("\n");
    const chunkB = [
        "  rerankApplied: false,",
        "  return { kind: 'handled' };",
        "}",
    ].join("\n");

    const callersGraph = JSON.stringify({
        status: "ok",
        nodes: [
            {
                symbolId: "syminst_caller",
                symbolLabel: "function executeSearchAttempt",
                file: "packages/mcp/src/core/search-request-coordinator.ts",
                span: { startLine: 140, endLine: 210 },
            },
            {
                symbolId: "syminst_owner",
                symbolLabel: "function runExactRegistryFastPath",
                file: "packages/mcp/src/core/search-exact-fast-path.ts",
                span: { startLine: 227, endLine: 660 },
            },
        ],
        edges: [
            {
                srcSymbolId: "syminst_caller",
                dstSymbolId: "syminst_owner",
                kind: "call",
                site: { file: "packages/mcp/src/core/search-request-coordinator.ts", startLine: 148, endLine: 148 },
            },
        ],
    });
    const calleesGraph = JSON.stringify({
        status: "ok",
        nodes: [
            {
                symbolId: "syminst_owner",
                symbolLabel: "function runExactRegistryFastPath",
                file: "packages/mcp/src/core/search-exact-fast-path.ts",
                span: { startLine: 227, endLine: 660 },
            },
            {
                symbolId: "syminst_callee",
                symbolLabel: "function findExactRegistryMatch",
                file: "packages/mcp/src/core/search/exact-registry.ts",
                span: { startLine: 88, endLine: 140 },
            },
        ],
        edges: [
            {
                srcSymbolId: "syminst_owner",
                dstSymbolId: "syminst_callee",
                kind: "call",
                site: { file: "packages/mcp/src/core/search-exact-fast-path.ts", startLine: 260, endLine: 260 },
            },
        ],
    });

    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "mcp__satori__read_file",
                input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", start_line: 227, end_line: 460 },
                output: chunkA,
            },
            {
                index: 2,
                tool: "mcp__satori__call_graph",
                input: { path: "/repo", direction: "callers" },
                output: callersGraph,
            },
            {
                index: 3,
                tool: "mcp__satori__call_graph",
                input: { path: "/repo", direction: "callees" },
                output: calleesGraph,
            },
            {
                index: 4,
                tool: "mcp__satori__read_file",
                input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", start_line: 460, end_line: 660 },
                output: chunkB,
            },
            {
                index: 5,
                tool: "mcp__satori__file_outline",
                input: { path: "/repo", file: "packages/mcp/src/core/search-exact-fast-path.ts" },
                output: JSON.stringify({ status: "ok", outline: { symbols: [{ name: "runExactRegistryFastPath" }] } }),
            },
        ],
    });

    assert.equal(trajectory.sufficient, true);
    assert.equal(trajectory.firstSufficientEvidenceCall, 4);
    assert.equal(trajectory.callsAfterSufficientEvidence, 1);
});

test("Multi-result search JSON does not attribute text from another file to the owner file", () => {
    const crossFileSearch = JSON.stringify({
        results: [
            {
                target: { file: "packages/mcp/src/core/search-exact-fast-path.ts", span: { startLine: 227, endLine: 230 } },
                preview: "export async function runExactRegistryFastPath(",
            },
            {
                target: { file: "packages/mcp/src/core/other-file.ts", span: { startLine: 1, endLine: 20 } },
                preview: 'isExactRegistryEligible(input, host) input.navigationAuthority !== "valid" findExactRegistryMatch( semanticPassesUsed: [] rerankApplied: false',
            },
        ],
    });

    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "mcp__satori__search_codebase",
                input: { path: "/repo", query: "runExactRegistryFastPath" },
                output: crossFileSearch,
            },
        ],
    });

    assert.equal(trajectory.sufficient, false);
    assert.deepEqual(
        trajectory.deliveredRequirements.map((req) => req.id),
        ["owner_definition"],
    );
});

test("A5 top-level hydratedExactSource on search_codebase satisfies owner statements at call 1", () => {
    const hydratedSearchEnvelope = JSON.stringify({
        formatVersion: 3,
        status: "ok",
        resultMode: "grouped",
        hydratedExactSource: {
            file: "packages/mcp/src/core/search-exact-fast-path.ts",
            symbolId: "syminst_exact_fast_path",
            span: { startLine: 227, endLine: 660 },
            returnedSpan: { startLine: 227, endLine: 660 },
            completeSymbolReturned: true,
            truncated: false,
            content: KNOWN_FULL_OWNER_BODY,
            sourceAuthority: "publication_hash_matched",
        },
        results: [
            {
                target: {
                    file: "packages/mcp/src/core/search-exact-fast-path.ts",
                    span: { startLine: 227, endLine: 660 },
                    symbolId: "syminst_exact_fast_path",
                },
                preview: "export async function runExactRegistryFastPath(",
            },
        ],
    });

    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "mcp__satori__search_codebase",
                input: { path: "/repo", query: "runExactRegistryFastPath", hydrateExact: true },
                output: hydratedSearchEnvelope,
            },
        ],
    });

    assert.deepEqual(
        trajectory.deliveredRequirements.map((req) => req.id),
        [
            "owner_definition",
            "checks_eligibility",
            "requires_navigation_authority",
            "exact_match_resolver",
            "avoids_semantic_and_rerank",
        ],
    );
    assert.ok(trajectory.deliveredRequirements.every((req) => req.satisfiedAtCall === 1));
});

test("evidence requires a matching fixture, source fields, and a directed edge between the named files", () => {
    const ownerFile = "src/owner.ts";
    const callerFile = "src/caller.ts";
    const evidenceSpec = {
        ownerFile, ownerSymbol: "owner", fixtureRevision: "pinned",
        requiredStatements: [{ id: "body", patterns: ["return actualValue;"] }],
        requiredRelations: [{ relation: "caller", symbol: "caller", file: callerFile }],
    };
    const result = { target: { file: ownerFile }, preview: "return actualValue;" };
    const search = (payload) => ({ tool: "satori_search_codebase", input: { path: "/repo" }, output: JSON.stringify(payload) });
    const edge = { srcSymbolId: "caller-id", dstSymbolId: "owner-id", kind: "call", site: { file: callerFile, startLine: 3 } };
    const graph = (selectedEdge, selectedOwnerFile = ownerFile) => ({
        tool: "satori_call_graph", input: { path: "/repo" }, output: JSON.stringify({
            status: "ok", nodes: [
                { symbolId: "caller-id", file: callerFile, name: "caller" },
                { symbolId: "owner-id", file: selectedOwnerFile, name: "owner" },
            ], edges: [selectedEdge],
        }),
    });
    const score = (tools, fixtureRevision = "pinned") => scoreEvidenceTrajectory({ tools, repoRoot: "/repo", fixtureRevision, evidenceSpec });
    assert.equal(score([search({ codebaseRoot: "/other", results: [result] })]).deliveredRequirements.length, 0);
    assert.equal(score([search({ results: [{ ...result, preview: "", debug: result.preview }] })]).deliveredRequirements.length, 0);
    const source = search({ codebaseRoot: "/repo", results: [result] });
    assert.equal(score([source, graph(edge)], "another").deliveredRequirements.length, 0);
    assert.equal(score([source, graph(edge, "src/unrelated.ts")]).sufficient, false);
    assert.equal(score([source, graph({ ...edge, srcSymbolId: "owner-id", dstSymbolId: "caller-id" })]).sufficient, false);
    assert.equal(score([source, graph({ ...edge, site: { file: ownerFile, startLine: 3 } })]).sufficient, false);
    assert.equal(score([source, graph(edge)]).firstSufficientEvidenceCall, 2);
});

test("legacy host-visible replay supplies gate metrics and missing observations fail closed", () => {
    const output = "function owner() { return 1; }";
    const input = { filePath: "/repo/src/owner.ts" };
    const replay = replayResultRecord({
        evidenceSpec: { ownerFile: "src/owner.ts", ownerSymbol: "owner", requiredStatements: [{ id: "body", patterns: ["return 1;"] }] },
        fixture: { repoRoot: "/repo", gitRevision: "pinned" },
        result: {
            arm: "native", environment: { gitRevision: "pinned" }, grade: { passed: true },
            measurements: { apiInputTokens: 10, taskWallTimeMs: 10, visibleToolResultBytes: Buffer.byteLength(output) },
            harness: { sessionId: "fixture", toolCalls: [{ operation: "read", input, visibleResultBytes: Buffer.byteLength(output) }] },
        },
        hostEvents: [{ type: "tool_use", sessionID: "fixture", part: { tool: "read", state: { input, output } } }],
    });
    assert.equal(replay.trajectory.fixtureRevisionVerified, true);
    assert.equal(replay.firstSufficientEvidenceCall, 1);
    assert.equal(evaluateErgonomicsGate({ controlRuns: [replay], treatmentRuns: [replay] }).passed, true);
    const unobserved = evaluateErgonomicsGate({
        controlRuns: [replay],
        treatmentRuns: [{ grade: { passed: true }, measurements: { stepsToVerifiedAnswer: 1 } }],
        armPolicy: { requireSufficientEvidenceImprovement: true },
    });
    assert.equal(unobserved.passed, false);
    assert.ok(unobserved.failureReasons.includes("sufficient_evidence_unobserved"));
    assert.ok(unobserved.failureReasons.includes("input_tokens_unobserved"));
    assert.ok(unobserved.failureReasons.includes("wall_time_unobserved"));
});

test("Pi events.jsonl extraction and replay joins tool_execution_start + message_end toolResult, preserves isError, and verifies fidelity", () => {
    const sessionIso = "2026-11-23T14:00:00.000Z";
    const sessionStartMs = Date.parse(sessionIso);
    const errorText = "Error: Invalid arguments for 'read_file'. open_symbol.contractVersion: 2 required";
    const truncatedVisibleText = JSON.stringify({
        codebaseRoot: "/repo",
        file: "packages/mcp/src/core/search-exact-fast-path.ts",
        content: KNOWN_FULL_OWNER_BODY,
    });
    const rawUnTruncatedText = `${truncatedVisibleText} /* extra raw bytes not visible to model */`;
    const callerGraphText = JSON.stringify({
        status: "ok",
        codebaseRoot: "/repo",
        nodes: [
            { symbolId: "caller_1", symbolLabel: "method executeSearchAttempt", file: "packages/mcp/src/core/search-request-coordinator.ts" },
            { symbolId: "owner_1", symbolLabel: "function runExactRegistryFastPath", file: "packages/mcp/src/core/search-exact-fast-path.ts" },
            { symbolId: "callee_1", symbolLabel: "function findExactRegistryMatch", file: "packages/mcp/src/core/search/exact-registry.ts" },
        ],
        edges: [
            { srcSymbolId: "caller_1", dstSymbolId: "owner_1", kind: "call", site: { file: "packages/mcp/src/core/search-request-coordinator.ts", startLine: 1508 } },
            { srcSymbolId: "owner_1", dstSymbolId: "callee_1", kind: "call", site: { file: "packages/mcp/src/core/search-exact-fast-path.ts", startLine: 260 } },
        ],
    });
    const fallbackEndText = "fallback tool_execution_end output";

    const piEvents = [
        { type: "session", version: 3, timestamp: sessionIso, cwd: "/repo" },
        { type: "turn_start" },
        { type: "message_end", message: { role: "assistant", timestamp: sessionStartMs + 500 } },
        {
            type: "tool_execution_start",
            toolCallId: "c1",
            toolName: "mcp__satori__read_file",
            args: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", open_symbol: { contractVersion: 1 } },
        },
        {
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "mcp__satori__read_file",
            result: { content: [{ type: "text", text: KNOWN_FULL_OWNER_BODY }] },
            isError: true,
            durationMs: 5,
        },
        {
            type: "message_end",
            message: {
                role: "toolResult",
                toolCallId: "c1",
                toolName: "mcp__satori__read_file",
                isError: true,
                timestamp: sessionStartMs + 1000,
                content: [{ type: "text", text: errorText }],
            },
        },
        { type: "turn_end" },
        { type: "turn_start" },
        { type: "message_end", message: { role: "assistant", timestamp: sessionStartMs + 1100 } },
        {
            type: "tool_execution_start",
            toolCallId: "c2",
            toolName: "mcp__satori__read_file",
            args: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts" },
        },
        {
            type: "tool_execution_end",
            toolCallId: "c2",
            toolName: "mcp__satori__read_file",
            result: { content: [{ type: "text", text: rawUnTruncatedText }] },
            isError: false,
            durationMs: 25,
        },
        {
            type: "message_end",
            message: {
                role: "toolResult",
                toolCallId: "c2",
                toolName: "mcp__satori__read_file",
                isError: false,
                timestamp: sessionStartMs + 2500,
                content: [{ type: "text", text: truncatedVisibleText }],
            },
        },
        { type: "turn_end" },
        { type: "turn_start" },
        { type: "message_end", message: { role: "assistant", timestamp: sessionStartMs + 2600 } },
        {
            type: "tool_execution_start",
            toolCallId: "c3",
            toolName: "mcp__satori__call_graph",
            args: { path: "/repo" },
        },
        {
            type: "tool_execution_end",
            toolCallId: "c3",
            toolName: "mcp__satori__call_graph",
            result: { content: [{ type: "text", text: callerGraphText }] },
            isError: false,
            durationMs: 40,
        },
        {
            type: "message_end",
            message: {
                role: "toolResult",
                toolCallId: "c3",
                toolName: "mcp__satori__call_graph",
                isError: false,
                timestamp: sessionStartMs + 4200,
                content: [{ type: "text", text: callerGraphText }],
            },
        },
        {
            type: "tool_execution_start",
            toolCallId: "c4",
            toolName: "mcp__satori__file_outline",
            args: { path: "/repo", file: "packages/mcp/src/core/search-exact-fast-path.ts" },
        },
        {
            type: "tool_execution_end",
            toolCallId: "c4",
            toolName: "mcp__satori__file_outline",
            result: { content: [{ type: "text", text: fallbackEndText }] },
            isError: false,
            durationMs: 12,
        },
        { type: "turn_end" },
    ];

    const extracted = extractPiToolCalls(piEvents);
    assert.equal(extracted.sessionStartMs, sessionStartMs);
    assert.equal(extracted.sessionCwd, "/repo");
    assert.equal(extracted.toolCallCount, 4);
    assert.equal(extracted.tools[0].status, "error");
    assert.equal(extracted.tools[0].output, errorText);
    assert.equal(extracted.tools[0].turnIndex, 1);
    assert.equal(extracted.tools[1].output, truncatedVisibleText);
    assert.equal(extracted.tools[1].visibleBytes, Buffer.byteLength(truncatedVisibleText, "utf8"));
    assert.equal(extracted.tools[1].turnIndex, 2);
    assert.equal(extracted.tools[3].output, fallbackEndText);

    const expectedBytes = Buffer.byteLength(errorText, "utf8")
        + Buffer.byteLength(truncatedVisibleText, "utf8")
        + Buffer.byteLength(callerGraphText, "utf8")
        + Buffer.byteLength(fallbackEndText, "utf8");
    assert.equal(extracted.extractedVisibleBytes, expectedBytes);

    const replayed = replayResultRecord({
        repoRoot: "/repo",
        fixtureRevision: "rev-1",
        expectedFixtureRevision: "rev-1",
        piEvents,
        result: {
            runId: "pi-test-1",
            taskId: "known-exact-target",
            arm: "satori",
            passed: true,
            failureReasons: [],
            toolCalls: 4,
            visibleToolBytes: expectedBytes,
            agentResult: { status: "success", answer: KNOWN_TASK.expected },
        },
    });

    assert.equal(replayed.fidelity.matched, true);
    assert.equal(replayed.fidelity.extractedToolCallCount, 4);
    assert.equal(replayed.fidelity.extractedVisibleBytes, expectedBytes);
    assert.equal(replayed.strictPassed, true);
    // Error call #1 must not credit owner statements; call #2 credits owner statements; call #3 credits caller+callee.
    assert.equal(replayed.trajectory.perCallProgress[0].newlySatisfied.length, 0);
    assert.equal(replayed.firstSufficientEvidenceCall, 3);
    assert.equal(replayed.firstSufficientEvidenceMs, 4200);
    assert.equal(replayed.inFlightParallelCalls, 1);
    assert.equal(replayed.postEvidenceDispatchedCalls, 0);

    const mismatchReplay = replayResultRecord({
        repoRoot: "/repo",
        piEvents,
        result: {
            runId: "pi-test-mismatch",
            taskId: "known-exact-target",
            arm: "satori",
            passed: true,
            toolCalls: 99,
            visibleToolBytes: 123,
            agentResult: { status: "success", answer: KNOWN_TASK.expected },
        },
    });
    assert.equal(mismatchReplay.fidelity.matched, false);
    assert.equal(mismatchReplay.fidelity.toolCallCountMatches, false);
    assert.equal(mismatchReplay.fidelity.visibleBytesMatches, false);
    assert.equal(mismatchReplay.fidelity.mismatches.length, 2);
});

test("Turn-aware post-sufficiency breakdown separates in-flight parallel calls from later-turn dispatched categories", () => {
    const baseMs = 1_700_000_000_000;
    const trajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        sessionStartMs: baseMs,
        tools: [
            {
                index: 1,
                turnIndex: 1,
                tool: "mcp__satori__read_file",
                input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts" },
                output: KNOWN_FULL_OWNER_BODY,
                dispatchedAtMs: baseMs + 100,
                visibleAtMs: baseMs + 200,
            },
            {
                index: 2,
                turnIndex: 2,
                tool: "mcp__satori__call_graph",
                input: { path: "/repo" },
                output: JSON.stringify({
                    status: "ok",
                    nodes: [
                        { symbolId: "c", symbolLabel: "method executeSearchAttempt", file: "packages/mcp/src/core/search-request-coordinator.ts" },
                        { symbolId: "o", symbolLabel: "function runExactRegistryFastPath", file: "packages/mcp/src/core/search-exact-fast-path.ts" },
                        { symbolId: "e", symbolLabel: "function findExactRegistryMatch", file: "packages/mcp/src/core/search/exact-registry.ts" },
                    ],
                    edges: [
                        { srcSymbolId: "c", dstSymbolId: "o", kind: "call", site: { file: "packages/mcp/src/core/search-request-coordinator.ts", startLine: 148 } },
                        { srcSymbolId: "o", dstSymbolId: "e", kind: "call", site: { file: "packages/mcp/src/core/search-exact-fast-path.ts", startLine: 260 } },
                    ],
                }),
                dispatchedAtMs: baseMs + 300,
                visibleAtMs: baseMs + 500,
            },
            {
                index: 3,
                turnIndex: 2,
                tool: "mcp__satori__read_file",
                input: { path: "/repo/packages/mcp/src/core/search-request-coordinator.ts", start_line: 140, end_line: 160 },
                output: KNOWN_CALLER_EVIDENCE,
                dispatchedAtMs: baseMs + 310,
                visibleAtMs: baseMs + 500,
            },
            {
                index: 4,
                turnIndex: 3,
                status: "error",
                tool: "mcp__satori__read_file",
                input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts", open_symbol: { contractVersion: 1 } },
                output: "Error: Invalid arguments for 'read_file'. contractVersion 2 required",
                dispatchedAtMs: baseMs + 600,
                visibleAtMs: baseMs + 650,
            },
            {
                index: 5,
                turnIndex: 3,
                tool: "mcp__satori__file_outline",
                input: { path: "/repo", file: "packages/mcp/src/core/search-exact-fast-path.ts" },
                output: JSON.stringify({ status: "ok", outline: { symbols: [] } }),
                dispatchedAtMs: baseMs + 600,
                visibleAtMs: baseMs + 660,
            },
            {
                index: 6,
                turnIndex: 3,
                tool: "mcp__satori__call_graph",
                input: { path: "/repo", direction: "callees", symbolRef: { file: "packages/mcp/src/core/search-exact-fast-path.ts", symbol: "runExactRegistryFastPath" } },
                output: "{}",
                dispatchedAtMs: baseMs + 600,
                visibleAtMs: baseMs + 670,
            },
            {
                index: 7,
                turnIndex: 4,
                tool: "read",
                input: { path: "packages/mcp/src/core/search-exact-fast-path.ts", offset: 227, limit: 20 },
                output: KNOWN_FULL_OWNER_BODY,
                dispatchedAtMs: baseMs + 700,
                visibleAtMs: baseMs + 710,
            },
            {
                index: 8,
                turnIndex: 4,
                tool: "grep",
                input: { path: "packages/mcp/src/core", pattern: "runExactRegistryFastPath" },
                output: "No matches found",
                dispatchedAtMs: baseMs + 700,
                visibleAtMs: baseMs + 715,
            },
            {
                index: 9,
                turnIndex: 4,
                tool: "custom_inspect",
                input: { path: "packages/mcp/src/core/search-exact-fast-path.ts" },
                output: "ok",
                dispatchedAtMs: baseMs + 700,
                visibleAtMs: baseMs + 720,
            },
        ],
    });

    assert.equal(trajectory.firstSufficientEvidenceCall, 2);
    assert.equal(trajectory.firstSufficientEvidenceMs, 500);
    assert.equal(trajectory.callsAfterSufficientEvidence, 7);
    assert.equal(trajectory.inFlightParallelCalls, 1);
    assert.equal(trajectory.postEvidenceDispatchedCalls, 6);
    assert.deepEqual(
        trajectory.postEvidenceBreakdown.map((entry) => ({
            index: entry.index,
            turnIndex: entry.turnIndex,
            category: entry.category,
            status: entry.status,
        })),
        [
            { index: 4, turnIndex: 3, category: "schema_retry", status: "error" },
            { index: 5, turnIndex: 3, category: "outline_check", status: "completed" },
            { index: 6, turnIndex: 3, category: "relation_check", status: "completed" },
            { index: 7, turnIndex: 4, category: "source_reread", status: "completed" },
            { index: 8, turnIndex: 4, category: "search_extra", status: "completed" },
            { index: 9, turnIndex: 4, category: "other", status: "completed" },
        ],
    );

    const noTurnOrTimestamps = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "satori_read_file",
                input: { path: "/repo/packages/mcp/src/core/search-exact-fast-path.ts" },
                output: KNOWN_FULL_OWNER_BODY,
            },
            {
                index: 2,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search-request-coordinator.ts" },
                output: KNOWN_CALLER_EVIDENCE,
            },
            {
                index: 3,
                tool: "read",
                input: { filePath: "/repo/packages/mcp/src/core/search/exact-registry.ts" },
                output: KNOWN_CALLEE_EVIDENCE,
            },
            {
                index: 4,
                tool: "satori_file_outline",
                input: { path: "/repo", file: "packages/mcp/src/core/search-exact-fast-path.ts" },
                output: "{}",
            },
        ],
    });
    assert.equal(noTurnOrTimestamps.firstSufficientEvidenceCall, 3);
    assert.equal(noTurnOrTimestamps.firstSufficientEvidenceMs, null);
    assert.equal(noTurnOrTimestamps.callsAfterSufficientEvidence, 1);
    assert.equal(noTurnOrTimestamps.inFlightParallelCalls, null);
    assert.equal(noTurnOrTimestamps.postEvidenceDispatchedCalls, null);
    assert.deepEqual(noTurnOrTimestamps.postEvidenceBreakdown, []);
});

test("firstSufficientEvidenceMs gate passes, fails on regression, and fails closed when unobserved", () => {
    const controlRuns = [
        {
            arm: "native",
            strictPassed: true,
            totalInputTokens: 10_000,
            wallTimeMs: 5_000,
            firstSufficientEvidenceCall: 5,
            firstSufficientEvidenceMs: 4_000,
            visibleToolBytes: 3_000,
        },
    ];
    const fastTreatment = [
        {
            arm: "satori",
            strictPassed: true,
            totalInputTokens: 9_000,
            wallTimeMs: 4_500,
            firstSufficientEvidenceCall: 3,
            firstSufficientEvidenceMs: 3_000,
            visibleToolBytes: 2_800,
        },
    ];
    const passGate = evaluateErgonomicsGate({
        controlRuns,
        treatmentRuns: fastTreatment,
        armPolicy: { arm: "satori", maxFirstSufficientEvidenceMsRatio: 0.9 },
    });
    assert.equal(passGate.passed, true);
    assert.equal(passGate.ratios.firstSufficientEvidenceMsRatio, 0.75);
    assert.equal(passGate.checks.firstSufficientEvidenceMs, true);

    const slowTreatment = [
        {
            ...fastTreatment[0],
            firstSufficientEvidenceMs: 4_500,
        },
    ];
    const regressionGate = evaluateErgonomicsGate({
        controlRuns,
        treatmentRuns: slowTreatment,
        armPolicy: { arm: "satori", maxFirstSufficientEvidenceMsRatio: 1.0 },
    });
    assert.equal(regressionGate.passed, false);
    assert.deepEqual(regressionGate.failureReasons, ["sufficient_evidence_time_regression"]);

    const unobservedTreatment = [
        {
            arm: "satori",
            strictPassed: true,
            totalInputTokens: 9_000,
            wallTimeMs: 4_500,
            firstSufficientEvidenceCall: 3,
            visibleToolBytes: 2_800,
        },
    ];
    const unobservedGate = evaluateErgonomicsGate({
        controlRuns,
        treatmentRuns: unobservedTreatment,
        armPolicy: { arm: "satori", maxFirstSufficientEvidenceMsRatio: 1.0 },
    });
    assert.equal(unobservedGate.passed, false);
    assert.deepEqual(unobservedGate.failureReasons, ["sufficient_evidence_time_unobserved"]);
});

test("Pi native read and grep attribution supports repo-relative paths and context lines while rejecting wrong-root, signature-only, and cross-file lines", () => {
    // 1. Repo-relative Pi read + unnumbered raw body + TS class method caller + Pi grep context lines
    const validPiTrajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        sessionCwd: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "read",
                input: { path: "packages/mcp/src/core/search-exact-fast-path.ts", offset: 227, limit: 200 },
                output: KNOWN_FULL_OWNER_BODY,
            },
            {
                index: 2,
                tool: "read",
                input: { path: "packages/mcp/src/core/search-request-coordinator.ts", offset: 1470, limit: 50 },
                output: "const exactFastPath = await runExactRegistryFastPath({",
            },
            {
                index: 3,
                tool: "grep",
                input: { path: "packages/mcp/src/core/search-request-coordinator.ts", pattern: "executeSearchAttempt" },
                output: "packages/mcp/src/core/search-request-coordinator.ts/search-request-coordinator.ts-940-     private async executeSearchAttempt(",
            },
            {
                index: 4,
                tool: "read",
                input: { path: "packages/mcp/src/core/search/exact-registry.ts", offset: 88, limit: 20 },
                output: KNOWN_CALLEE_EVIDENCE,
            },
        ],
    });
    assert.equal(validPiTrajectory.sufficient, true);
    assert.equal(validPiTrajectory.firstSufficientEvidenceCall, 4);

    // 2. Wrong sessionCwd rejects repo-relative reads even when full source matches
    const wrongCwdTrajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        sessionCwd: "/other-repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "read",
                input: { path: "packages/mcp/src/core/search-exact-fast-path.ts", offset: 227, limit: 200 },
                output: KNOWN_FULL_OWNER_BODY,
            },
        ],
    });
    assert.equal(wrongCwdTrajectory.sufficient, false);
    assert.equal(wrongCwdTrajectory.deliveredRequirements.length, 0);

    // 3. Signature-only + cross-file grep lines must not leak into owner file
    const crossFileGrepTrajectory = scoreEvidenceTrajectory({
        repoRoot: "/repo",
        sessionCwd: "/repo",
        task: KNOWN_TASK,
        tools: [
            {
                index: 1,
                tool: "grep",
                input: { path: "packages/mcp/src/core", pattern: "runExactRegistryFastPath" },
                output: [
                    "packages/mcp/src/core/search-exact-fast-path.ts:227: export async function runExactRegistryFastPath(",
                    "packages/mcp/src/core/other-copy.ts-10- const e = isExactRegistryEligible(input, host);",
                    'packages/mcp/src/core/other-copy.ts-11- if (input.navigationAuthority !== "valid") return;',
                    "packages/mcp/src/core/other-copy.ts-12- const m = findExactRegistryMatch({",
                    "packages/mcp/src/core/other-copy.ts-13- semanticPassesUsed: [], rerankApplied: false",
                ].join("\n"),
            },
        ],
    });
    assert.equal(crossFileGrepTrajectory.sufficient, false);
    assert.deepEqual(
        crossFileGrepTrajectory.deliveredRequirements.map((req) => req.id),
        ["owner_definition"],
    );
});
