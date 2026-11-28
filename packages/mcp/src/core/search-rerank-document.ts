/**
 * Canonical rerank document projection (`search_rerank_document_v6`).
 *
 * One production projector (`search_rerank_document_v6`: identity-first,
 * 3,200-byte plain-text view) plus the raw fallback identity
 * (`semantic_document_raw_v1`). Retired v1–v5 identities fail closed before
 * any provider call.
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
    SEARCH_RERANK_SOURCE_REFERENCE_LIMIT,
    SEARCH_RERANK_SOURCE_REFERENCE_MAX_BYTES,
    type SearchRerankSourceReference,
} from "./search-rerank-source-references.js";
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

export const SEARCH_RERANK_DOCUMENT_RAW_IDENTITY = "semantic_document_raw_v1" as const;

/**
 * Identity-first, token-budgeted plain-text projection for rerankers.
 * Places path, role, kind, canonical symbol label, declaration, and bounded
 * structural context ahead of the source excerpt so right-truncation can never
 * drop candidate identity or declaration metadata, without JSON escaping overhead.
 */
export const SEARCH_RERANK_DOCUMENT_POLICY = Object.freeze({
    id: "search_rerank_document_v6",
    maximumUtf8Bytes: 3_200,
    structuralHeaderMaximumUtf8Bytes: 320,
    sourceReferenceLimit: SEARCH_RERANK_SOURCE_REFERENCE_LIMIT,
    sourceReferenceExcerptMaximumBytes: SEARCH_RERANK_SOURCE_REFERENCE_MAX_BYTES,
    directCallerLimit: 3,
    directCalleeLimit: 3,
    supportingTestLimit: 2,
});

export type SearchRerankDocumentProjectionIdentity =
    | typeof SEARCH_RERANK_DOCUMENT_RAW_IDENTITY
    | typeof SEARCH_RERANK_DOCUMENT_POLICY.id;

export function resolveSearchRerankDocumentProjectionIdentity(
    projectionIdentity: string | undefined,
): SearchRerankDocumentProjectionIdentity {
    const identity = projectionIdentity?.trim();
    if (!identity || identity === SEARCH_RERANK_DOCUMENT_RAW_IDENTITY) {
        return SEARCH_RERANK_DOCUMENT_RAW_IDENTITY;
    }
    if (identity === SEARCH_RERANK_DOCUMENT_POLICY.id) {
        return SEARCH_RERANK_DOCUMENT_POLICY.id;
    }
    throw new Error(`search_rerank_document_projection_identity_unknown:${identity}`);
}

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
    readonly sourceReferences?: readonly SearchRerankSourceReference[];
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
    readonly sourceReferencesTruncated: boolean;
}

function normalizeSourceReferences(value: unknown): SearchRerankSourceReference[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError("sourceReferences must be an array.");
    return value.map((entry, index) => {
        if (!isRecord(entry)) throw new TypeError(`sourceReferences[${index}] must be an object.`);
        requireOnlyKeys(entry, "source reference", ["repository_relative_path", "containing_symbol_label",
            "source_line", "reference_source_excerpt"]);
        if (!Number.isSafeInteger(entry.source_line) || (entry.source_line as number) < 1) {
            throw new TypeError("source reference source_line must be a positive integer.");
        }
        return {
            repository_relative_path: requireSafeRelativePath(entry.repository_relative_path),
            containing_symbol_label: requireString(entry.containing_symbol_label, "containing_symbol_label"),
            source_line: entry.source_line as number,
            reference_source_excerpt: requireBoundedPhysicalLine(entry.reference_source_excerpt,
                "reference_source_excerpt", SEARCH_RERANK_SOURCE_REFERENCE_MAX_BYTES),
        };
    }).slice(0, SEARCH_RERANK_SOURCE_REFERENCE_LIMIT);
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

function formatStructuralLines(context: SearchRerankStructuralContext): string[] {
    const lines: string[] = [];
    const formatRef = (entry: SearchRerankStructuralReference): string => (
        `${entry.repository_relative_path}:${entry.canonical_symbol_label}`
    );
    if (context.directCallers.length > 0) {
        lines.push(`callers: ${context.directCallers.map(formatRef).join("; ")}`);
    }
    if (context.directCallees.length > 0) {
        lines.push(`callees: ${context.directCallees.map(formatRef).join("; ")}`);
    }
    if (context.supportingTests.length > 0) {
        lines.push(`tests: ${context.supportingTests.map(formatRef).join("; ")}`);
    }
    return lines;
}

function parseValidatedDocumentInput(rawInput: unknown): Readonly<{
    candidateRole: SearchCandidateRole;
    normalized: NormalizedProjectionInput;
    structural: StructuralContextNormalization;
    sourceReferences: readonly SearchRerankSourceReference[];
    rawSourceReferenceCount: number;
}> {
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
        "sourceReferences",
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
    const sourceReferences = normalizeSourceReferences(rawInput.sourceReferences);
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
    return {
        candidateRole,
        normalized,
        structural,
        sourceReferences,
        rawSourceReferenceCount: Array.isArray(rawInput.sourceReferences)
            ? rawInput.sourceReferences.length
            : 0,
    };
}

export function buildSearchRerankDocument(rawInput: unknown): SearchRerankDocumentResult {
    const {
        candidateRole,
        normalized,
        structural,
        sourceReferences,
        rawSourceReferenceCount,
    } = parseValidatedDocumentInput(rawInput);
    const {
        relativePath,
        symbolKind,
        canonicalSymbolLabel,
        signatureOrDeclaration,
    } = normalized;
    const maxBytes = SEARCH_RERANK_DOCUMENT_POLICY.maximumUtf8Bytes;
    const maxStructuralBytes = SEARCH_RERANK_DOCUMENT_POLICY.structuralHeaderMaximumUtf8Bytes;

    const buildProjectionText = (
        context: SearchRerankStructuralContext,
        queryRelevantSourceExcerpt: string,
        references: readonly SearchRerankSourceReference[] = [],
    ): string => {
        const lines: string[] = [
            `path: ${relativePath}`,
            `role: ${candidateRole} | kind: ${symbolKind} | symbol: ${canonicalSymbolLabel}`,
            `declaration: ${signatureOrDeclaration}`,
            ...formatStructuralLines(context),
            "source:",
        ];
        if (queryRelevantSourceExcerpt.length > 0) {
            lines.push(queryRelevantSourceExcerpt);
        }
        if (references.length > 0) {
            lines.push("references:");
            for (const entry of references) {
                lines.push(
                    `${entry.repository_relative_path}:${entry.source_line} (${entry.containing_symbol_label}): ${entry.reference_source_excerpt}`,
                );
            }
        }
        return lines.join("\n");
    };

    // Bound optional structural context into a compact header ahead of source
    // so identity and direct graph links stay ahead of right-truncation without
    // starving the source excerpt budget.
    let directCallers = [...structural.context.directCallers];
    let directCallees = [...structural.context.directCallees];
    let supportingTests = [...structural.context.supportingTests];
    let structuralTruncated = structural.truncated;
    for (;;) {
        const candidateContext: SearchRerankStructuralContext = {
            directCallers,
            directCallees,
            supportingTests,
        };
        const structuralBytes = Buffer.byteLength(
            formatStructuralLines(candidateContext).join("\n"),
            "utf8",
        );
        const headerBytes = Buffer.byteLength(buildProjectionText(candidateContext, ""), "utf8");
        if (structuralBytes <= maxStructuralBytes && headerBytes <= maxBytes) {
            break;
        }
        if (supportingTests.length > 0) {
            supportingTests = supportingTests.slice(0, -1);
        } else if (directCallees.length > 0) {
            directCallees = directCallees.slice(0, -1);
        } else if (directCallers.length > 0) {
            directCallers = directCallers.slice(0, -1);
        } else {
            throw new RangeError(
                `Projection base projection exceeds ${maxBytes} UTF-8 bytes.`,
            );
        }
        structuralTruncated = true;
    }

    const boundedContext: SearchRerankStructuralContext = {
        directCallers,
        directCallees,
        supportingTests,
    };
    const sourceSelection = selectRerankSourceWithinBudget({
        normalized,
        minimumText: buildProjectionText(boundedContext, ""),
        buildProjectionText: (excerpt) => buildProjectionText(boundedContext, excerpt),
        selectionPolicyVersion: BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
        maximumUtf8Bytes: maxBytes,
    });
    const queryRelevantSourceExcerpt = sourceSelection.selectedSource
        ? selectedExcerptText(sourceSelection.selectedSource)
        : "";
    const admittedReferences = [...sourceReferences];
    while (
        admittedReferences.length > 0
        && Buffer.byteLength(
            buildProjectionText(boundedContext, queryRelevantSourceExcerpt, admittedReferences),
            "utf8",
        ) > maxBytes
    ) {
        admittedReferences.pop();
    }
    const text = buildProjectionText(boundedContext, queryRelevantSourceExcerpt, admittedReferences);

    return {
        version: SEARCH_RERANK_DOCUMENT_POLICY.id,
        text,
        utf8Bytes: Buffer.byteLength(text, "utf8"),
        selectedSourceLineCount: sourceSelection.selectedSource?.returnedLines ?? 0,
        selectedSourceExcerptCount: sourceSelection.selectedSource?.excerptCount ?? 0,
        sourceTruncated: sourceSelection.selectedSource?.truncated ?? normalized.content.length > 0,
        selectionAttemptCount: sourceSelection.selectionAttemptCount,
        structuralContextTruncated: structuralTruncated,
        sourceReferencesTruncated: admittedReferences.length < sourceReferences.length
            || rawSourceReferenceCount > sourceReferences.length,
    };
}
