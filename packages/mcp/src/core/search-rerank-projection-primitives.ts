/**
 * Phase 9.2A — canonical rerank document-projection primitives.
 *
 * Neutral projection machinery extracted from the historical V2 module: input
 * normalization, bounded line/documentation handling, source selection budget
 * search, and excerpt assembly. No projection policy lives here; historical
 * and canonical builders share these primitives without importing each other.
 */
import {
    compareContractStrings,
    isRepositoryRelativePath,
} from "@satori-code/core";
import {
    BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
    selectBoundedSource,
    type BoundedSourceSelectionPolicyVersion,
    type SelectedSourceProjection,
    type SourceLineSpan,
} from "./bounded-source-selector.js";
import { serializeCanonicalJson } from "./canonical-json.js";

export const MAXIMUM_UTF8_BYTES = 4_000;
export const MAXIMUM_LINES = 200;
export const MAXIMUM_EXCERPTS = 5;
export const MAXIMUM_EXCERPT_LINES = 40;
export const CONTEXT_LINES = 2;
export const MAXIMUM_DECLARATION_UTF8_BYTES = 1_000;
export const MAXIMUM_DOCUMENTATION_UTF8_BYTES = 1_000;
export const MAXIMUM_DOCUMENTATION_LINES = 8;
export const MAXIMUM_DOCUMENTATION_LINE_UTF8_BYTES = 512;
export const MAXIMUM_SELECTION_ATTEMPTS = 14;

export interface SearchRerankDocumentV2Sibling {
    readonly relativePath: string;
    readonly canonicalSymbolLabel: string;
}

export interface NormalizedRequiredOwnerSibling {
    readonly repository_relative_path: string;
    readonly canonical_symbol_label: string;
}

export interface NormalizedProjectionInput {
    readonly relativePath: string;
    readonly language: string;
    readonly symbolKind: string;
    readonly canonicalSymbolLabel: string;
    readonly signatureOrDeclaration: string;
    readonly documentationExcerpt: string;
    readonly requiredOwnerSiblings: readonly NormalizedRequiredOwnerSibling[];
    readonly content: string;
    readonly query: string;
    readonly symbolSpan: SourceLineSpan;
    readonly evidenceSpans: readonly SourceLineSpan[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireString(
    value: unknown,
    label: string,
    options: { readonly allowEmpty?: boolean } = {},
): string {
    const allowEmpty = options.allowEmpty ?? false;
    if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
        throw new TypeError(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
    }
    return value;
}

export function requireSafeRelativePath(value: unknown): string {
    const relativePath = requireString(value, "relativePath");
    if (!isRepositoryRelativePath(relativePath)) {
        throw new TypeError("relativePath must be a canonical repository-relative path.");
    }
    return relativePath;
}

export function sourceLines(content: string): string[] {
    return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function requireBoundedPhysicalLine(
    value: unknown,
    label: string,
    maximumUtf8Bytes: number,
): string {
    const line = requireString(value, label).trim();
    if (/[\r\n]/.test(line)) {
        throw new TypeError(`${label} must be one physical line.`);
    }
    if (Buffer.byteLength(line, "utf8") > maximumUtf8Bytes) {
        throw new RangeError(`${label} exceeds ${maximumUtf8Bytes} UTF-8 bytes.`);
    }
    return line;
}

export function requireBoundedDocumentation(value: unknown): string {
    const normalized = requireString(value, "documentationExcerpt", { allowEmpty: true })
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > MAXIMUM_DOCUMENTATION_LINES) {
        throw new RangeError(
            `documentationExcerpt exceeds ${MAXIMUM_DOCUMENTATION_LINES} physical lines.`,
        );
    }
    for (const line of lines) {
        if (Buffer.byteLength(line, "utf8") > MAXIMUM_DOCUMENTATION_LINE_UTF8_BYTES) {
            throw new RangeError(
                `documentationExcerpt physical line exceeds ${MAXIMUM_DOCUMENTATION_LINE_UTF8_BYTES} UTF-8 bytes.`,
            );
        }
    }
    if (Buffer.byteLength(normalized, "utf8") > MAXIMUM_DOCUMENTATION_UTF8_BYTES) {
        throw new RangeError(
            `documentationExcerpt exceeds ${MAXIMUM_DOCUMENTATION_UTF8_BYTES} UTF-8 bytes.`,
        );
    }
    return normalized;
}

export function requireLineSpan(value: unknown, label: string, lineCount: number): SourceLineSpan {
    if (
        !isRecord(value)
        || !Number.isSafeInteger(value.startLine)
        || !Number.isSafeInteger(value.endLine)
        || (value.startLine as number) < 1
        || (value.endLine as number) < (value.startLine as number)
        || (value.endLine as number) > lineCount
    ) {
        throw new RangeError(`${label} must be a valid one-based inclusive source span.`);
    }
    return {
        startLine: value.startLine as number,
        endLine: value.endLine as number,
    };
}

export function normalizeEvidenceSpans(
    value: unknown,
    symbolSpan: SourceLineSpan,
    lineCount: number,
): SourceLineSpan[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new TypeError("evidenceSpans must be an array when provided.");
    }
    return value.map((span, index) => {
        const normalized = requireLineSpan(span, `evidenceSpans[${index}]`, lineCount);
        if (
            normalized.startLine < symbolSpan.startLine
            || normalized.endLine > symbolSpan.endLine
        ) {
            throw new RangeError(`evidenceSpans[${index}] must be contained by symbolSpan.`);
        }
        return normalized;
    });
}

export function sourceLinesInSpan(lines: readonly string[], span: SourceLineSpan): string[] {
    return lines.slice(span.startLine - 1, span.endLine);
}

export function firstStructuralDeclaration(
    lines: readonly string[],
    language: string,
    symbolKind: string,
    relativePath: string,
): string {
    const normalizedLanguage = language.toLowerCase();
    const normalizedPath = relativePath.toLowerCase();
    const isFileLevel = symbolKind === "file" || symbolKind === "module";
    const candidates = lines.map((line) => line.trim()).filter(Boolean);
    if (!isFileLevel) return candidates[0] ?? "";
    if (
        ["markdown", "md", "mdx"].includes(normalizedLanguage)
        || /\.mdx?$/u.test(normalizedPath)
    ) {
        return candidates.find((line) => /^#{1,6}\s+\S/u.test(line)) ?? "";
    }
    const configLike = [
        "toml", "yaml", "yml", "json", "jsonc", "ini", "xml",
        "properties", "dockerfile",
    ].includes(normalizedLanguage);
    const structuralPattern = configLike
        ? /^(?:\[[^\]]+\]|[\p{L}_][\p{L}\p{N}_.-]*\s*[:=]|[{[]|<[^!?][^>]*>|---\s*$)/u
        : /^(?:(?:export\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var)\b|(?:async\s+)?def\b|class\b|fn\b|func\b|package\b|module\b|namespace\b|import\b|from\b|use\b|#include\b)/u;
    return candidates.find((line) => structuralPattern.test(line)) ?? "";
}

export function normalizeRequiredOwnerSiblings(value: unknown): NormalizedRequiredOwnerSibling[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new TypeError("requiredOwnerSiblings must be an array when provided.");
    }
    const seen = new Set<string>();
    return value.map((rawSibling, index) => {
        if (!isRecord(rawSibling)) {
            throw new TypeError(`requiredOwnerSiblings[${index}] must be an object.`);
        }
        const sibling = {
            repository_relative_path: requireSafeRelativePath(rawSibling.relativePath),
            canonical_symbol_label: requireString(
                rawSibling.canonicalSymbolLabel,
                `requiredOwnerSiblings[${index}].canonicalSymbolLabel`,
            ),
        };
        const identity = serializeCanonicalJson(sibling);
        if (seen.has(identity)) {
            throw new TypeError(`requiredOwnerSiblings contains duplicate '${identity}'.`);
        }
        seen.add(identity);
        return sibling;
    }).sort((left, right) => (
        compareContractStrings(left.repository_relative_path, right.repository_relative_path)
        || compareContractStrings(left.canonical_symbol_label, right.canonical_symbol_label)
    ));
}

export function selectedExcerptText(source: SelectedSourceProjection): string {
    return source.excerpts.map(({ content }) => content).join("\n...\n");
}

export function selectSource(
    input: NormalizedProjectionInput,
    maxSourceBytes: number,
    selectionPolicyVersion: BoundedSourceSelectionPolicyVersion = BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
) {
    return selectBoundedSource({
        sourceBytes: Buffer.from(input.content, "utf8"),
        symbolSpan: input.symbolSpan,
        budgets: {
            maxSourceBytes,
            maxSourceLines: MAXIMUM_LINES,
            maxExcerpts: MAXIMUM_EXCERPTS,
            maxExcerptBytes: maxSourceBytes,
            maxExcerptLines: MAXIMUM_EXCERPT_LINES,
            contextLines: CONTEXT_LINES,
            maxSerializedSourceBytes: maxSourceBytes,
        },
        capabilities: {
            localLexical: "available",
            lineWindows: "available",
            syntaxBoundaries: "not_requested",
            controlFlowAnchors: "not_requested",
        },
        selectionPolicyVersion,
        ...(input.query ? { query: input.query } : {}),
        ...(input.evidenceSpans.length > 0 ? { evidenceSpans: input.evidenceSpans } : {}),
    });
}

export function selectRerankSourceWithinBudget(input: {
    normalized: NormalizedProjectionInput;
    minimumText: string;
    buildProjectionText: (queryRelevantSourceExcerpt: string) => string;
    selectionPolicyVersion?: BoundedSourceSelectionPolicyVersion;
}): {
    text: string;
    selectedSource?: SelectedSourceProjection;
    selectionAttemptCount: number;
} {
    const minimumBytes = Buffer.byteLength(input.minimumText, "utf8");
    let lowerBudget = 1;
    let upperBudget = Math.max(1, MAXIMUM_UTF8_BYTES - minimumBytes);
    let selectedSource: SelectedSourceProjection | undefined;
    let text = input.minimumText;
    let selectionAttemptCount = 0;
    for (
        let attempt = 0;
        attempt < MAXIMUM_SELECTION_ATTEMPTS && lowerBudget <= upperBudget;
        attempt += 1
    ) {
        selectionAttemptCount += 1;
        const sourceBudget = Math.floor((lowerBudget + upperBudget) / 2);
        const selection = selectSource(
            input.normalized,
            sourceBudget,
            input.selectionPolicyVersion,
        );
        if (selection.status !== "selected") {
            lowerBudget = sourceBudget + 1;
            continue;
        }
        const excerpt = selectedExcerptText(selection.source);
        const candidateText = input.buildProjectionText(excerpt);
        const candidateBytes = Buffer.byteLength(candidateText, "utf8");
        if (candidateBytes <= MAXIMUM_UTF8_BYTES) {
            selectedSource = selection.source;
            text = candidateText;
            lowerBudget = sourceBudget + 1;
            continue;
        }
        upperBudget = sourceBudget - 1;
    }
    return { text, selectedSource, selectionAttemptCount };
}
