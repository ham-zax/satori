import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    type RelationshipRecord,
    type Reranker,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from "@satori-code/core";
import { BOUNDED_SOURCE_SELECTION_POLICY_VERSION } from "./bounded-source-selector.js";
import { serializeCanonicalJson } from "./canonical-json.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { resolveSearchCandidateRole } from "./search-candidate-role.js";
import {
    SEARCH_RERANK_DOCUMENT_POLICY,
    buildSearchRerankDocument,
} from "./search-rerank-document.js";
const SEARCH_RERANK_DOCUMENT_V3_POLICY_EVIDENCE = Object.freeze({
    id: "search_rerank_document_v3",
    previousVersion: "search_rerank_document_v2",
    maximumUtf8Bytes: 4_000,
    serialization: "canonical_json_utf8",
    serializedKeyOrder: "lexicographic_recursive_canonical_json_v1",
    addedField: "candidate_role",
});

const SEARCH_RERANK_DOCUMENT_V3_CONTRACT_EVIDENCE =
    "{\"candidate_role\":\"implementation\",\"canonical_symbol_label\":\"validate_order\",\"documentation_excerpt\":\"\",\"language\":\"typescript\",\"query_relevant_source_excerpt\":\"function validate_order(order) {\\n    return check_shariah_compliance(order);\\n}\",\"repository_relative_path\":\"src/core/veto.ts\",\"required_owner_siblings\":[],\"signature_or_declaration\":\"function validate_order(order) {\",\"symbol_kind\":\"function\"}";
import { resolveSearchRerankDocumentProjectionIdentity } from "./search-rerank-document-routing.js";
import { buildSearchRerankQuery } from "./search-rerank-query.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";
import { SEARCH_RERANK_QUERY_RAW_IDENTITY } from "./search-rerank-query-routing.js";
import {
    SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY,
    buildSearchRerankStructuralContext,
    prepareSearchRerankStructuralRelationships,
} from "./search-rerank-structural-context.js";
import {
    applyNativeRerankToSelectedSlots,
    validateNativeRerankResults,
} from "./search-native-rerank.js";
import {
    SEARCH_RERANK_MIN_PROJECTED_CANDIDATES,
    selectRerankCandidates,
    selectRerankInputWithinUtf8Budget,
    shouldCallRerankerForProjectedCandidateCount,
} from "./search-rerank-policy.js";
export { SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY } from "./search-rerank-structural-context.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";

export const SEARCH_RERANK_REQUEST_CONTRACT_SCHEMA_VERSION =
    "satori_rerank_request_contract_v1" as const;
export const SEARCH_RERANK_REQUEST_CONTRACT_ASSET_RELPATH =
    "assets/lateon/rerank-request-contract-v1.json";
export { SEARCH_RERANK_DOCUMENT_RAW_IDENTITY } from "./search-rerank-document-routing.js";

export const SEARCH_RERANK_PARTIAL_PROJECTION_SEMANTICS = Object.freeze({
    warnings: [
        "RERANKER_INPUT_DEGRADED",
        "RERANKER_SKIPPED_INPUT",
        "RERANKER_FAILED",
    ] as const,
    providerNeverCalledOnZeroProjectable: true,
    minimumProjectedCandidatesForProviderCall: SEARCH_RERANK_MIN_PROJECTED_CANDIDATES,
    failedCandidatesRetainOriginalSlots: true,
    projectedSubsetSlotConfinement: true,
    byteBudgetOmission: "ordered_prefix_v1",
});

export interface SearchRerankRequestIdentityV1 {
    provider: string;
    model: string;
    profile: string;
    queryProjectionIdentity: string;
    documentProjectionIdentity: string;
    requestContractSha256: string;
}

export type SearchRerankRequestContractFixtures = Readonly<{
    answerFocusResolution: Record<string, string>;
    queryProjectionV1: Record<string, string>;
    queryProjectionV2: Record<string, string>;
    candidateRoleClassification: Record<string, string>;
    documentProjectionV3: string;
    documentProjectionV4: string;
    documentProjectionV4Structural: string;
    documentProjectionV4SourceFirst: string;
    sourceSelectionPolicyIdentity: string;
    canonicalJsonIdentity: string;
    structuralContext: typeof SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY;
    structuralContextBehavior: ReturnType<typeof buildStructuralContextBehaviorFixture>;
    partialProjectionSemantics: typeof SEARCH_RERANK_PARTIAL_PROJECTION_SEMANTICS;
    partialProjectionBehavior: ReturnType<typeof buildPartialProjectionBehaviorFixture>;
}>;

export type SearchRerankRequestContractManifest = Readonly<{
    schemaVersion: typeof SEARCH_RERANK_REQUEST_CONTRACT_SCHEMA_VERSION;
    contractSha256: string;
    fixtures: SearchRerankRequestContractFixtures;
}>;

const FOCUS_FIXTURE_QUESTIONS: Record<string, string> = {
    implementation: "how does Shariah compliance checking block trades",
    tests: "find tests for trade veto behavior",
    documentation: "what do the docs say about order validation",
    configuration: "where is the risk threshold configured",
    references: "who calls validate_order",
    neutral: "order validation overview",
};

const ROLE_FIXTURES: readonly { relativePath: string; language: string }[] = [
    { relativePath: "src/core/veto.ts", language: "typescript" },
    { relativePath: "tests/veto.test.ts", language: "typescript" },
    { relativePath: "docs/architecture.md", language: "markdown" },
    { relativePath: "config/risk.toml", language: "toml" },
    { relativePath: "src/generated/types.ts", language: "typescript" },
    { relativePath: "data/fixtures/orders.json", language: "json" },
    { relativePath: "examples/basic_usage.py", language: "python" },
    { relativePath: "reports/render-trace.bin", language: "binary" },
];

const DOCUMENT_PROJECTION_FIXTURE = Object.freeze({
    relativePath: "src/core/veto.ts",
    language: "typescript",
    candidateRole: "implementation",
    symbolKind: "function",
    canonicalSymbolLabel: "validate_order",
    symbolSpan: { startLine: 1, endLine: 3 },
    content: [
        "function validate_order(order) {",
        "    return check_shariah_compliance(order);",
        "}",
    ].join("\n"),
    query: FOCUS_FIXTURE_QUESTIONS.implementation,
});

const DOCUMENT_PROJECTION_STRUCTURAL_FIXTURE = Object.freeze({
    ...DOCUMENT_PROJECTION_FIXTURE,
    structuralContext: {
        directCallers: [{
            repository_relative_path: "src/core/trading_core.ts",
            canonical_symbol_label: "TradingCore.__init__",
            relation: "caller" as const,
        }],
        directCallees: [{
            repository_relative_path: "src/core/checks.ts",
            canonical_symbol_label: "check_shariah_compliance",
            relation: "callee" as const,
        }],
        supportingTests: [{
            repository_relative_path: "tests/veto.test.ts",
            canonical_symbol_label: "validates_trade_veto",
            relation: "test_support" as const,
        }],
    },
});

const DOCUMENT_PROJECTION_SOURCE_FIRST_FIXTURE = Object.freeze({
    ...DOCUMENT_PROJECTION_FIXTURE,
    symbolSpan: { startLine: 1, endLine: 96 },
    content: Array.from(
        { length: 96 },
        (_, index) => `line ${index}: validate_order_for_exact_question(${index});`,
    ).join("\n"),
    query: "validate order exact question",
    structuralContext: {
        directCallers: [1, 2, 3].map((index) => ({
            repository_relative_path: `src/callers/caller-${index}.ts`,
            canonical_symbol_label: `proof_backed_caller_${index}_${"x".repeat(160)}`,
            relation: "caller" as const,
        })),
        directCallees: [1, 2, 3].map((index) => ({
            repository_relative_path: `src/callees/callee-${index}.ts`,
            canonical_symbol_label: `proof_backed_callee_${index}_${"x".repeat(160)}`,
            relation: "callee" as const,
        })),
        supportingTests: [1, 2].map((index) => ({
            repository_relative_path: `tests/veto-${index}.test.ts`,
            canonical_symbol_label: `proof_backed_test_${index}_${"x".repeat(160)}`,
            relation: "test_support" as const,
        })),
    },
});

function buildCandidateRoleClassificationFixture(): Record<string, string> {
    const candidateRoleClassification: Record<string, string> = {};
    for (const fixture of ROLE_FIXTURES) {
        candidateRoleClassification[`${fixture.relativePath}|${fixture.language}`] =
            resolveSearchCandidateRole(fixture);
    }
    return candidateRoleClassification;
}

function createContractSymbol(input: {
    file: string;
    name: string;
    label: string;
    fileHash: string;
}): SymbolRecord {
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language: "typescript",
        kind: "function",
        qualifiedName: input.name,
        parentQualifiedNamePath: [],
    });
    const span = { startLine: 1, endLine: 3 };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: "contract-fixture-v1",
        }),
        language: "typescript",
        kind: "function",
        name: input.name,
        qualifiedName: input.name,
        label: input.label,
        file: input.file,
        span,
        parentQualifiedNamePath: [],
        fileHash: input.fileHash,
        extractorVersion: "contract-fixture-v1",
    };
}

function buildStructuralContextBehaviorFixture() {
    const owner = createContractSymbol({
        file: "src/core/veto.ts",
        name: "validate_order",
        label: "function validate_order()",
        fileHash: "a".repeat(64),
    });
    const proofBackedCaller = createContractSymbol({
        file: "src/core/trading_core.ts",
        name: "TradingCore.__init__",
        label: "method TradingCore.__init__",
        fileHash: "b".repeat(64),
    });
    const unsupportedCaller = createContractSymbol({
        file: "src/core/guess.ts",
        name: "guess_caller",
        label: "function guess_caller()",
        fileHash: "c".repeat(64),
    });
    const symbols = [owner, proofBackedCaller, unsupportedCaller];
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: "/contract-fixture",
        rootFingerprint: "contract-root-v1",
        indexPolicyHash: "contract-policy-v1",
        languageRouterVersion: "contract-router-v1",
        extractorVersion: "contract-fixture-v1",
        relationshipVersion: "contract-relationship-v1",
        builtAt: "2026-08-09T00:00:00.000Z",
        files: symbols.map((symbol) => ({
            path: symbol.file,
            hash: symbol.fileHash,
            language: symbol.language,
            symbolCount: 1,
            definitionStatus: "definitions_present" as const,
        })),
    };
    const registry = buildSymbolRegistry({ manifest, symbols });
    const relationship = (
        source: SymbolRecord,
        resolutionAuthority: RelationshipRecord["resolutionAuthority"],
    ): RelationshipRecord => ({
        sourceKey: source.symbolKey,
        sourceInstanceId: source.symbolInstanceId,
        targetKey: owner.symbolKey,
        targetInstanceId: owner.symbolInstanceId,
        type: "CALLS",
        file: source.file,
        span: source.span,
        confidence: "low",
        resolutionAuthority,
    });
    const preparedRelationships = prepareSearchRerankStructuralRelationships([
        relationship(proofBackedCaller, "direct_binding"),
        relationship(unsupportedCaller, "unsupported"),
    ]);
    const context = buildSearchRerankStructuralContext({
        candidate: {
            relativePath: owner.file,
            startLine: owner.span.startLine,
            endLine: owner.span.endLine,
            ownerSymbolInstanceId: owner.symbolInstanceId,
            ownerSymbolKey: owner.symbolKey,
            language: owner.language,
            symbolLabel: owner.label,
        },
        registry,
        preparedRelationships,
    });
    return {
        lowConfidenceAdmission: context,
    } as const;
}

function buildPartialProjectionBehaviorFixture() {
    const candidateIds = ["a", "b", "c", "d"] as const;
    const selectedCandidateIds = ["a", "b", "d"] as const;
    const orderedItems = validateNativeRerankResults({
        candidateIds: selectedCandidateIds,
        results: [
            { index: 2, relevanceScore: 0.9 },
            { index: 1, relevanceScore: 0.8 },
            { index: 0, relevanceScore: 0.7 },
        ],
    });
    const slotPreservingOrder = applyNativeRerankToSelectedSlots({
        allCandidates: candidateIds,
        selectedCandidateIds,
        orderedItems,
        identify: (candidate) => candidate,
    });
    const byteSelection = selectRerankInputWithinUtf8Budget({
        candidates: ["a", "b", "c"],
        documents: ["abc", "éé", "tail"],
        maxInputBytes: 7,
    });
    const buildAdmissionCandidates = (count: number) => Array.from({ length: count }, (_, index) => ({
        id: `candidate-${index + 1}`,
        result: {
            relativePath: `src/candidate-${index + 1}.ts`,
            startLine: 1,
            endLine: 3,
            language: "typescript",
            ownerSymbolInstanceId: `owner-${index + 1}`,
        },
    }));
    const admissionSelection = (count: number, providerMaximumDocuments?: number) => (
        selectRerankCandidates({
            candidates: buildAdmissionCandidates(count),
            requestedLimit: 2,
            ...(providerMaximumDocuments === undefined ? {} : { providerMaximumDocuments }),
        })
    );
    const providerCapacityAdmission = admissionSelection(16, 32);
    const legacyAdmission = admissionSelection(16);
    const providerBoundAdmission = admissionSelection(40, 32);
    const globalBoundAdmission = admissionSelection(60, 80);
    const invalidCapacityAdmission = admissionSelection(30, 0);
    return {
        providerCallByProjectedCandidateCount: {
            zero: shouldCallRerankerForProjectedCandidateCount(0),
            one: shouldCallRerankerForProjectedCandidateCount(1),
            two: shouldCallRerankerForProjectedCandidateCount(2),
        },
        failedCandidateSlotPreservation: {
            allCandidateIds: candidateIds,
            projectedCandidateIds: selectedCandidateIds,
            providerOrder: orderedItems.map((item) => item.candidateId),
            finalOrder: slotPreservingOrder,
        },
        byteBudgetOmission: {
            selectedCandidateIds: byteSelection.candidates,
            inputBytes: byteSelection.inputBytes,
            omittedCandidateCount: byteSelection.omittedCandidateCount,
        },
        candidateAdmission: {
            providerCapacity32: {
                selectedCandidateIds: providerCapacityAdmission.selected.map(({ id }) => id),
                budget: providerCapacityAdmission.budget,
                reason: providerCapacityAdmission.budgetReason,
            },
            providerCapacityAbsent: {
                selectedCandidateIds: legacyAdmission.selected.map(({ id }) => id),
                budget: legacyAdmission.budget,
                reason: legacyAdmission.budgetReason,
            },
            providerCapacityBound: {
                selectedCandidateIds: providerBoundAdmission.selected.map(({ id }) => id),
                budget: providerBoundAdmission.budget,
                reason: providerBoundAdmission.budgetReason,
            },
            globalCapacityBound: {
                selectedCandidateIds: globalBoundAdmission.selected.map(({ id }) => id),
                budget: globalBoundAdmission.budget,
                reason: globalBoundAdmission.budgetReason,
            },
            invalidProviderCapacity: {
                selectedCandidateIds: invalidCapacityAdmission.selected.map(({ id }) => id),
                budget: invalidCapacityAdmission.budget,
                reason: invalidCapacityAdmission.budgetReason,
            },
        },
    } as const;
}

export function buildSearchRerankRequestContractFixtures(): SearchRerankRequestContractFixtures {
    const answerFocusResolution: Record<string, string> = {};
    const queryProjectionV1: Record<string, string> = {};
    const queryProjectionV2: Record<string, string> = {};
    for (const [focus, question] of Object.entries(FOCUS_FIXTURE_QUESTIONS)) {
        const parsedOperators = parseSearchOperators(question);
        const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
        answerFocusResolution[question] = resolveSearchAnswerFocus(queryPlan).focus;
        const answerFocus = focus as SearchAnswerFocus;
        queryProjectionV1[focus] = SEARCH_RERANK_QUERY_V1_CONTRACT_EVIDENCE[answerFocus];
        queryProjectionV2[focus] = buildSearchRerankQuery({
            semanticQuery: question,
            answerFocus,
        });
    }
    const candidateRoleClassification = buildCandidateRoleClassificationFixture();
    return {
        answerFocusResolution,
        queryProjectionV1,
        queryProjectionV2,
        candidateRoleClassification,
        documentProjectionV3: SEARCH_RERANK_DOCUMENT_V3_CONTRACT_EVIDENCE,
        documentProjectionV4: buildSearchRerankDocument(DOCUMENT_PROJECTION_FIXTURE).text,
        documentProjectionV4Structural: buildSearchRerankDocument(
            DOCUMENT_PROJECTION_STRUCTURAL_FIXTURE,
        ).text,
        documentProjectionV4SourceFirst: buildSearchRerankDocument(
            DOCUMENT_PROJECTION_SOURCE_FIRST_FIXTURE,
        ).text,
        sourceSelectionPolicyIdentity: serializeCanonicalJson({
            boundedSourceSelection: BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
            sourceSelection: SEARCH_RERANK_DOCUMENT_V3_POLICY_EVIDENCE,
            answerPacketBudget: SEARCH_RERANK_DOCUMENT_POLICY,
        }),
        canonicalJsonIdentity: serializeCanonicalJson({ b: 1, a: [2, { d: "x", c: null }] }),
        structuralContext: SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY,
        structuralContextBehavior: buildStructuralContextBehaviorFixture(),
        partialProjectionSemantics: SEARCH_RERANK_PARTIAL_PROJECTION_SEMANTICS,
        partialProjectionBehavior: buildPartialProjectionBehaviorFixture(),
    };
}

export function computeSearchRerankRequestContractSha256(
    fixtures: SearchRerankRequestContractFixtures,
): string {
    return crypto.createHash("sha256")
        .update(serializeCanonicalJson(fixtures), "utf8")
        .digest("hex");
}

export function buildSearchRerankRequestContractManifest(): SearchRerankRequestContractManifest {
    const fixtures = buildSearchRerankRequestContractFixtures();
    return {
        schemaVersion: SEARCH_RERANK_REQUEST_CONTRACT_SCHEMA_VERSION,
        contractSha256: computeSearchRerankRequestContractSha256(fixtures),
        fixtures,
    };
}

/**
 * Inert historical contract evidence (Phase 9.2D): the frozen request contract
 * serializes the retired v1 query projection. Production routing never
 * executes this data; it exists only to keep `contractSha256` byte-stable.
 * The bytes are frozen literals, not regenerated from any executable builder.
 */
const SEARCH_RERANK_QUERY_V1_CONTRACT_EVIDENCE: Record<SearchAnswerFocus, string> = {
    implementation: [
        "Question:",
        "how does Shariah compliance checking block trades",
        "",
        "Answer focus: implementation",
        "",
        "Guidance:",
        "Rank the production mechanism and its integration path first. Tests and documentation are supporting evidence unless they are the clearest direct answer.",
    ].join("\n"),
    tests: [
        "Question:",
        "find tests for trade veto behavior",
        "",
        "Answer focus: tests",
        "",
        "Guidance:",
        "Rank tests that directly prove the requested behavior first. Production code may be supporting context.",
    ].join("\n"),
    documentation: [
        "Question:",
        "what do the docs say about order validation",
        "",
        "Answer focus: documentation",
        "",
        "Guidance:",
        "Rank documentation that directly explains the requested topic first. Code may be supporting context.",
    ].join("\n"),
    configuration: [
        "Question:",
        "where is the risk threshold configured",
        "",
        "Answer focus: configuration",
        "",
        "Guidance:",
        "Rank active configuration declarations and the code that loads or applies them first.",
    ].join("\n"),
    references: [
        "Question:",
        "who calls validate_order",
        "",
        "Answer focus: references",
        "",
        "Guidance:",
        "Rank direct callers, callees, references, and integration sites that answer the relationship question first.",
    ].join("\n"),
    neutral: [
        "Question:",
        "order validation overview",
        "",
        "Answer focus: neutral",
        "",
        "Guidance:",
        "Rank the candidate that most directly answers the question. Candidate role is evidence, not a fixed preference.",
    ].join("\n"),
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Rerank request contract ${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
    const record = requireRecord(value, label);
    for (const [key, entry] of Object.entries(record)) {
        if (typeof entry !== "string") {
            throw new Error(`Rerank request contract ${label}.${key} must be a string.`);
        }
    }
    return record as Record<string, string>;
}

export function parseSearchRerankRequestContract(raw: unknown): SearchRerankRequestContractManifest {
    const record = requireRecord(raw, "manifest");
    const keys = Object.keys(record).sort();
    const expected = ["contractSha256", "fixtures", "schemaVersion"];
    if (serializeCanonicalJson(keys) !== serializeCanonicalJson(expected)) {
        throw new Error("Rerank request contract manifest carries unexpected keys.");
    }
    if (record.schemaVersion !== SEARCH_RERANK_REQUEST_CONTRACT_SCHEMA_VERSION) {
        throw new Error(`Rerank request contract schema '${String(record.schemaVersion)}' is unsupported.`);
    }
    if (typeof record.contractSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.contractSha256)) {
        throw new Error("Rerank request contract digest must be a SHA-256 hex string.");
    }
    const fixturesRecord = requireRecord(record.fixtures, "fixtures");
    const fixtureKeys = Object.keys(fixturesRecord).sort();
    const expectedFixtureKeys = [
        "answerFocusResolution",
        "candidateRoleClassification",
        "canonicalJsonIdentity",
        "documentProjectionV3",
        "documentProjectionV4",
        "documentProjectionV4SourceFirst",
        "documentProjectionV4Structural",
        "partialProjectionBehavior",
        "partialProjectionSemantics",
        "queryProjectionV1",
        "queryProjectionV2",
        "sourceSelectionPolicyIdentity",
        "structuralContext",
        "structuralContextBehavior",
    ];
    if (serializeCanonicalJson(fixtureKeys) !== serializeCanonicalJson(expectedFixtureKeys)) {
        throw new Error("Rerank request contract fixtures carry unexpected keys.");
    }
    const structuralContext = requireRecord(fixturesRecord.structuralContext, "fixtures.structuralContext");
    if (
        serializeCanonicalJson(structuralContext)
        !== serializeCanonicalJson(SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY)
    ) {
        throw new Error("Rerank request contract structural-context policy drifted from the runtime policy.");
    }
    const structuralContextBehavior = requireRecord(
        fixturesRecord.structuralContextBehavior,
        "fixtures.structuralContextBehavior",
    );
    if (
        serializeCanonicalJson(structuralContextBehavior)
        !== serializeCanonicalJson(buildStructuralContextBehaviorFixture())
    ) {
        throw new Error("Rerank request contract structural-context behavior drifted from runtime owners.");
    }
    const partialProjection = requireRecord(
        fixturesRecord.partialProjectionSemantics,
        "fixtures.partialProjectionSemantics",
    );
    if (
        serializeCanonicalJson(partialProjection)
        !== serializeCanonicalJson(SEARCH_RERANK_PARTIAL_PROJECTION_SEMANTICS)
    ) {
        throw new Error("Rerank request contract partial-projection semantics drifted from the runtime policy.");
    }
    const partialProjectionBehavior = requireRecord(
        fixturesRecord.partialProjectionBehavior,
        "fixtures.partialProjectionBehavior",
    );
    if (
        serializeCanonicalJson(partialProjectionBehavior)
        !== serializeCanonicalJson(buildPartialProjectionBehaviorFixture())
    ) {
        throw new Error("Rerank request contract partial-projection behavior drifted from runtime owners.");
    }
    if (typeof fixturesRecord.documentProjectionV3 !== "string") {
        throw new Error("Rerank request contract document projection fixture must be a string.");
    }
    if (typeof fixturesRecord.documentProjectionV4 !== "string") {
        throw new Error("Rerank request contract document projection v4 fixture must be a string.");
    }
    if (typeof fixturesRecord.documentProjectionV4Structural !== "string") {
        throw new Error("Rerank request contract structural document projection v4 fixture must be a string.");
    }
    if (typeof fixturesRecord.documentProjectionV4SourceFirst !== "string") {
        throw new Error("Rerank request contract source-first document projection v4 fixture must be a string.");
    }
    if (typeof fixturesRecord.sourceSelectionPolicyIdentity !== "string") {
        throw new Error("Rerank request contract source-selection identity must be a string.");
    }
    if (typeof fixturesRecord.canonicalJsonIdentity !== "string") {
        throw new Error("Rerank request contract canonical-JSON identity must be a string.");
    }
    const candidateRoleClassification = requireStringRecord(
        fixturesRecord.candidateRoleClassification,
        "fixtures.candidateRoleClassification",
    );
    if (
        serializeCanonicalJson(candidateRoleClassification)
        !== serializeCanonicalJson(buildCandidateRoleClassificationFixture())
    ) {
        throw new Error("Rerank request contract candidate-role behavior drifted from runtime classification.");
    }
    const manifest: SearchRerankRequestContractManifest = {
        schemaVersion: SEARCH_RERANK_REQUEST_CONTRACT_SCHEMA_VERSION,
        contractSha256: record.contractSha256,
        fixtures: {
            answerFocusResolution: requireStringRecord(
                fixturesRecord.answerFocusResolution,
                "fixtures.answerFocusResolution",
            ),
            queryProjectionV1: requireStringRecord(
                fixturesRecord.queryProjectionV1,
                "fixtures.queryProjectionV1",
            ),
            queryProjectionV2: requireStringRecord(
                fixturesRecord.queryProjectionV2,
                "fixtures.queryProjectionV2",
            ),
            candidateRoleClassification,
            documentProjectionV3: fixturesRecord.documentProjectionV3,
            documentProjectionV4: fixturesRecord.documentProjectionV4,
            documentProjectionV4Structural: fixturesRecord.documentProjectionV4Structural,
            documentProjectionV4SourceFirst: fixturesRecord.documentProjectionV4SourceFirst,
            sourceSelectionPolicyIdentity: fixturesRecord.sourceSelectionPolicyIdentity,
            canonicalJsonIdentity: fixturesRecord.canonicalJsonIdentity,
            structuralContext: SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY,
            structuralContextBehavior: buildStructuralContextBehaviorFixture(),
            partialProjectionSemantics: SEARCH_RERANK_PARTIAL_PROJECTION_SEMANTICS,
            partialProjectionBehavior: buildPartialProjectionBehaviorFixture(),
        },
    };
    if (computeSearchRerankRequestContractSha256(manifest.fixtures) !== manifest.contractSha256) {
        throw new Error("Rerank request contract digest does not match its fixtures.");
    }
    return manifest;
}

export function resolveSearchRerankRequestContractAssetPath(): string {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        SEARCH_RERANK_REQUEST_CONTRACT_ASSET_RELPATH,
    );
}

let cachedManifest: SearchRerankRequestContractManifest | null = null;

export function loadSearchRerankRequestContract(): SearchRerankRequestContractManifest {
    if (cachedManifest) return cachedManifest;
    const raw = JSON.parse(fs.readFileSync(resolveSearchRerankRequestContractAssetPath(), "utf8"));
    cachedManifest = parseSearchRerankRequestContract(raw);
    return cachedManifest;
}

export function resolveSearchRerankRequestIdentity(reranker: Reranker): SearchRerankRequestIdentityV1 {
    const identity = reranker.getIdentity();
    const queryProjectionIdentity = reranker.getQueryProjectionVersion?.()?.trim();
    const documentProjectionIdentity = reranker.getDocumentProjectionVersion?.()?.trim();
    return {
        provider: identity.provider,
        model: identity.model,
        profile: identity.profile,
        queryProjectionIdentity: queryProjectionIdentity || SEARCH_RERANK_QUERY_RAW_IDENTITY,
        documentProjectionIdentity: resolveSearchRerankDocumentProjectionIdentity(
            documentProjectionIdentity,
        ),
        requestContractSha256: loadSearchRerankRequestContract().contractSha256,
    };
}
