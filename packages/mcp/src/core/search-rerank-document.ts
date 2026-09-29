/**
 * Canonical rerank document projection (Phase 9.2B).
 *
 * One production projector. `SEARCH_RERANK_DOCUMENT_POLICY` carries the full
 * frozen policy semantics of the current contract identity
 * (`search_rerank_document_v4`); `buildSearchRerankDocument` is its single
 * executable implementation. Historical V2/V3 builders are retired, and their
 * fixture material survives only as inert contract evidence in
 * `search-rerank-request-contract.ts`.
 */
import { compareContractStrings } from "@satori-code/core";
import { serializeCanonicalJson } from "./canonical-json.js";
import {
    isSearchCandidateRole,
    type SearchCandidateRole,
} from "./search-rerank-context.js";
import type {
    SearchRerankStructuralContext,
    SearchRerankStructuralReference,
} from "./search-rerank-structural-context.js";
import {
    BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
    type SourceLineSpan,
} from "./bounded-source-selector.js";
import {
    MAXIMUM_DECLARATION_UTF8_BYTES,
    firstStructuralDeclaration,
    isRecord,
    normalizeEvidenceSpans,
    requireBoundedPhysicalLine,
    requireLineSpan,
    requireSafeRelativePath,
    requireString,
    selectRerankSourceWithinBudget,
    selectedExcerptText,
    sourceLines,
    sourceLinesInSpan,
    type NormalizedProjectionInput,
} from "./search-rerank-projection-primitives.js";

export const SEARCH_RERANK_DOCUMENT_POLICY = Object.freeze({
    id: "search_rerank_document_v4",
    previousVersion: "search_rerank_document_v3",
    maximumUtf8Bytes: 4_000,
    serialization: "canonical_json_utf8",
    serializedKeyOrder: "lexicographic_recursive_canonical_json_v1",
    addedField: "structural_context",
    fieldSetDecision: {
        language: "intentionally_omitted_v1",
        documentationExcerpt: "intentionally_removed_v1",
        requiredOwnerSiblings: "superseded_by_structural_context_v1",
    },
    declarationRequirement: "trusted_non_empty_declaration_required_v1",
    structuralContextBudget: "source_before_references_v1",
    structuralContextOrder: "relation_then_path_then_label_v1",
    directCallerLimit: 3,
    directCalleeLimit: 3,
    supportingTestLimit: 2,
});

export interface SearchRerankDocumentInput {
    readonly relativePath: string;
    readonly language: string;
    readonly candidateRole: SearchCandidateRole;
    readonly symbolKind: string;
    readonly canonicalSymbolLabel: string;
    readonly symbolSpan: SourceLineSpan;
    readonly content: string;
    readonly signatureOrDeclaration?: string;
    readonly query?: string;
    readonly evidenceSpans?: readonly SourceLineSpan[];
    readonly structuralContext?: SearchRerankStructuralContext;
}

export interface SearchRerankDocumentResult {
    readonly version: typeof SEARCH_RERANK_DOCUMENT_POLICY.id;
    readonly text: string;
    readonly utf8Bytes: number;
    readonly selectedSourceLineCount: number;
    readonly selectedSourceExcerptCount: number;
    readonly sourceTruncated: boolean;
    readonly selectionAttemptCount: number;
    readonly structuralContextTruncated: boolean;
}

interface SearchRerankDocumentProjection {
    readonly repository_relative_path: string;
    readonly candidate_role: SearchCandidateRole;
    readonly symbol_kind: string;
    readonly canonical_symbol_label: string;
    readonly signature_or_declaration: string;
    readonly query_relevant_source_excerpt: string;
    readonly structural_context: {
        readonly direct_callers: readonly SearchRerankStructuralReference[];
        readonly direct_callees: readonly SearchRerankStructuralReference[];
        readonly supporting_tests: readonly SearchRerankStructuralReference[];
    };
}

type StructuralContextNormalization = Readonly<{
    context: SearchRerankStructuralContext;
    truncated: boolean;
}>;

const RELATION_ORDER: Record<SearchRerankStructuralReference["relation"], number> = {
    caller: 0,
    callee: 1,
    test_support: 2,
};

function requireOnlyKeys(
    value: Record<string, unknown>,
    label: string,
    allowed: readonly string[],
): void {
    const allowedKeys = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unknown key ${key}.`);
    }
}

function compareReferences(
    left: SearchRerankStructuralReference,
    right: SearchRerankStructuralReference,
): number {
    return RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation]
        || compareContractStrings(left.repository_relative_path, right.repository_relative_path)
        || compareContractStrings(left.canonical_symbol_label, right.canonical_symbol_label);
}

function normalizeStructuralReferences(input: {
    value: unknown;
    label: string;
    expectedRelation: SearchRerankStructuralReference["relation"];
    maximum: number;
}): Readonly<{ references: readonly SearchRerankStructuralReference[]; truncated: boolean }> {
    if (input.value === undefined) return { references: [], truncated: false };
    if (!Array.isArray(input.value)) {
        throw new TypeError(`${input.label} must be an array of structural references.`);
    }
    const unique = new Map<string, SearchRerankStructuralReference>();
    for (const [index, entry] of input.value.entries()) {
        if (!isRecord(entry)) {
            throw new TypeError(`${input.label}[${index}] must be a structural reference object.`);
        }
        requireOnlyKeys(entry, `${input.label}[${index}]`, [
            "repository_relative_path",
            "canonical_symbol_label",
            "relation",
        ]);
        if (entry.relation !== input.expectedRelation) {
            throw new TypeError(
                `${input.label}[${index}].relation must be ${input.expectedRelation}.`,
            );
        }
        const reference: SearchRerankStructuralReference = Object.freeze({
            repository_relative_path: requireSafeRelativePath(entry.repository_relative_path),
            canonical_symbol_label: requireString(
                entry.canonical_symbol_label,
                `${input.label}[${index}].canonical_symbol_label`,
            ),
            relation: input.expectedRelation,
        });
        // The authoritative structural builder deduplicates by instance id
        // before projection. Direct contract callers have only the public
        // representation, so exact duplicate packet entries collapse here.
        unique.set(serializeCanonicalJson(reference), reference);
    }
    const sorted = [...unique.values()].sort(compareReferences);
    return {
        references: sorted.slice(0, input.maximum),
        truncated: sorted.length > input.maximum,
    };
}

function normalizeStructuralContext(
    rawInput: Record<string, unknown>,
): StructuralContextNormalization {
    const raw = rawInput.structuralContext === undefined ? {} : rawInput.structuralContext;
    if (!isRecord(raw)) throw new TypeError("structuralContext must be an object.");
    requireOnlyKeys(raw, "structuralContext", ["directCallers", "directCallees", "supportingTests"]);
    const directCallers = normalizeStructuralReferences({
        value: raw.directCallers,
        label: "structuralContext.directCallers",
        expectedRelation: "caller",
        maximum: SEARCH_RERANK_DOCUMENT_POLICY.directCallerLimit,
    });
    const directCallees = normalizeStructuralReferences({
        value: raw.directCallees,
        label: "structuralContext.directCallees",
        expectedRelation: "callee",
        maximum: SEARCH_RERANK_DOCUMENT_POLICY.directCalleeLimit,
    });
    const supportingTests = normalizeStructuralReferences({
        value: raw.supportingTests,
        label: "structuralContext.supportingTests",
        expectedRelation: "test_support",
        maximum: SEARCH_RERANK_DOCUMENT_POLICY.supportingTestLimit,
    });
    return {
        context: {
            directCallers: directCallers.references,
            directCallees: directCallees.references,
            supportingTests: supportingTests.references,
        },
        truncated: directCallers.truncated || directCallees.truncated || supportingTests.truncated,
    };
}

/**
 * Structural references are optional supporting context. Source selection runs
 * against the base answer packet first; references then consume only the
 * remaining bytes and are dropped in deterministic priority order. Thus no
 * reference can displace an otherwise valid primary source excerpt.
 */
function truncateStructuralContextToBudget(input: {
    context: SearchRerankStructuralContext;
    queryRelevantSourceExcerpt: string;
    buildProjectionText: (
        context: SearchRerankStructuralContext,
        queryRelevantSourceExcerpt: string,
    ) => string;
}): { context: SearchRerankStructuralContext; truncated: boolean } {
    let directCallers = [...input.context.directCallers];
    let directCallees = [...input.context.directCallees];
    let supportingTests = [...input.context.supportingTests];
    let truncated = false;
    for (;;) {
        const context: SearchRerankStructuralContext = {
            directCallers,
            directCallees,
            supportingTests,
        };
        const text = input.buildProjectionText(context, input.queryRelevantSourceExcerpt);
        if (Buffer.byteLength(text, "utf8") <= SEARCH_RERANK_DOCUMENT_POLICY.maximumUtf8Bytes) {
            return { context, truncated };
        }
        if (supportingTests.length > 0) {
            supportingTests = supportingTests.slice(0, -1);
        } else if (directCallees.length > 0) {
            directCallees = directCallees.slice(0, -1);
        } else if (directCallers.length > 0) {
            directCallers = directCallers.slice(0, -1);
        } else {
            throw new RangeError(
                `Projection v4 base projection exceeds ${SEARCH_RERANK_DOCUMENT_POLICY.maximumUtf8Bytes} UTF-8 bytes.`,
            );
        }
        truncated = true;
    }
}

export function buildSearchRerankDocument(rawInput: unknown): SearchRerankDocumentResult {
    if (!isRecord(rawInput)) throw new TypeError("Projection input must be an object.");
    requireOnlyKeys(rawInput, "Projection input", [
        "relativePath",
        "language",
        "candidateRole",
        "symbolKind",
        "canonicalSymbolLabel",
        "symbolSpan",
        "content",
        "signatureOrDeclaration",
        "query",
        "evidenceSpans",
        "structuralContext",
    ]);
    const candidateRole = requireString(rawInput.candidateRole, "candidateRole");
    if (!isSearchCandidateRole(candidateRole)) {
        throw new TypeError("candidateRole must be a valid SearchCandidateRole.");
    }
    const content = requireString(rawInput.content, "content", { allowEmpty: true });
    const lines = sourceLines(content);
    const symbolSpan = requireLineSpan(rawInput.symbolSpan, "symbolSpan", lines.length);
    const relativePath = requireSafeRelativePath(rawInput.relativePath);
    const language = requireString(rawInput.language, "language");
    const symbolKind = requireString(rawInput.symbolKind, "symbolKind");
    const canonicalSymbolLabel = requireString(
        rawInput.canonicalSymbolLabel,
        "canonicalSymbolLabel",
    );
    const inferredDeclaration = firstStructuralDeclaration(
        sourceLinesInSpan(lines, symbolSpan),
        language,
        symbolKind,
        relativePath,
    );
    const inferredOrFileHeading = inferredDeclaration
        || (["file", "module"].includes(symbolKind) ? canonicalSymbolLabel : "");
    const signatureOrDeclaration = rawInput.signatureOrDeclaration === undefined
        ? requireBoundedPhysicalLine(
            inferredOrFileHeading,
            "inferred signatureOrDeclaration",
            MAXIMUM_DECLARATION_UTF8_BYTES,
        )
        : requireBoundedPhysicalLine(
            rawInput.signatureOrDeclaration,
            "signatureOrDeclaration",
            MAXIMUM_DECLARATION_UTF8_BYTES,
        );
    const structural = normalizeStructuralContext(rawInput);
    const normalized: NormalizedProjectionInput = {
        relativePath,
        language,
        symbolKind,
        canonicalSymbolLabel,
        signatureOrDeclaration,
        documentationExcerpt: "",
        requiredOwnerSiblings: [],
        content,
        query: rawInput.query === undefined
            ? ""
            : requireString(rawInput.query, "query", { allowEmpty: true }),
        symbolSpan,
        evidenceSpans: normalizeEvidenceSpans(rawInput.evidenceSpans, symbolSpan, lines.length),
    };

    const buildProjectionText = (
        context: SearchRerankStructuralContext,
        queryRelevantSourceExcerpt: string,
    ): string => {
        const projection: SearchRerankDocumentProjection = {
            repository_relative_path: relativePath,
            candidate_role: candidateRole,
            symbol_kind: symbolKind,
            canonical_symbol_label: canonicalSymbolLabel,
            signature_or_declaration: signatureOrDeclaration,
            query_relevant_source_excerpt: queryRelevantSourceExcerpt,
            structural_context: {
                direct_callers: context.directCallers,
                direct_callees: context.directCallees,
                supporting_tests: context.supportingTests,
            },
        };
        return serializeCanonicalJson(projection);
    };

    const emptyContext: SearchRerankStructuralContext = {
        directCallers: [],
        directCallees: [],
        supportingTests: [],
    };
    const sourceSelection = selectRerankSourceWithinBudget({
        normalized,
        minimumText: buildProjectionText(emptyContext, ""),
        buildProjectionText: (excerpt) => buildProjectionText(emptyContext, excerpt),
        selectionPolicyVersion: BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
    });
    const queryRelevantSourceExcerpt = sourceSelection.selectedSource
        ? selectedExcerptText(sourceSelection.selectedSource)
        : "";
    const bounded = truncateStructuralContextToBudget({
        context: structural.context,
        queryRelevantSourceExcerpt,
        buildProjectionText,
    });
    const text = buildProjectionText(bounded.context, queryRelevantSourceExcerpt);

    return {
        version: SEARCH_RERANK_DOCUMENT_POLICY.id,
        text,
        utf8Bytes: Buffer.byteLength(text, "utf8"),
        selectedSourceLineCount: sourceSelection.selectedSource?.returnedLines ?? 0,
        selectedSourceExcerptCount: sourceSelection.selectedSource?.excerptCount ?? 0,
        sourceTruncated: sourceSelection.selectedSource?.truncated ?? content.length > 0,
        selectionAttemptCount: sourceSelection.selectionAttemptCount,
        structuralContextTruncated: structural.truncated || bounded.truncated,
    };
}
