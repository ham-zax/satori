import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import {
    matchesPublishedPathScope,
    type PublishedPathScope,
} from "./navigation-path-scope.js";

export const EXACT_REFERENCE_EVIDENCE_CLASS = "published_source_text" as const;

export type ExactReferenceOccurrenceKind = "declaration" | "member" | "identifier";

export type ExactReferenceCoverageReason = Readonly<{
    code: "source_unreadable" | "source_too_large" | "source_replaced" | "result_limit";
    file?: string;
    detail?: string;
}>;

export type ExactSourceReference = Readonly<{
    file: string;
    span: Readonly<{
        startLine: number;
        endLine: number;
        startColumn: number;
        endColumn: number;
    }>;
    owningSymbol?: Readonly<{
        symbolId: string;
        symbolLabel: string;
        file: string;
        span: Readonly<{ startLine: number; endLine: number }>;
    }>;
    occurrenceKind: ExactReferenceOccurrenceKind;
    matchedText: string;
    member?: string;
    evidenceClass: typeof EXACT_REFERENCE_EVIDENCE_CLASS;
}>;

export type ExactReferenceSearchCoverage = Readonly<{
    status: "complete" | "partial";
    publishedFileCount: number;
    eligibleFileCount: number;
    inspectedFileCount: number;
    skippedFileCount: number;
    matchedOccurrenceCount: number;
    returnedOccurrenceCount: number;
    reasons: ExactReferenceCoverageReason[];
}>;

export type ExactReferenceSearchResult = Readonly<{
    target: Readonly<{
        symbolId: string;
        symbolLabel: string;
        name: string;
        qualifiedName: string;
        file: string;
        span: Readonly<{ startLine: number; endLine: number }>;
    }>;
    references: ExactSourceReference[];
    coverage: ExactReferenceSearchCoverage;
}>;

export type ExactReferenceSourceRead =
    | Readonly<{ status: "ok"; text: string }>
    | Readonly<{
        status: "skipped";
        code: Exclude<ExactReferenceCoverageReason["code"], "result_limit">;
        detail?: string;
    }>;

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareReferences(left: ExactSourceReference, right: ExactSourceReference): number {
    return compareStrings(left.file, right.file)
        || left.span.startLine - right.span.startLine
        || left.span.startColumn - right.span.startColumn
        || compareStrings(left.occurrenceKind, right.occurrenceKind);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

function findOwningSymbol(
    registry: SymbolRegistry,
    file: string,
    line: number,
): SymbolRecord | undefined {
    return [...(registry.symbolsByFile.get(file) ?? [])]
        .filter((symbol) => (
            symbol.kind !== "file"
            && symbol.span.startLine <= line
            && line <= symbol.span.endLine
        ))
        .sort((left, right) => (
            (left.span.endLine - left.span.startLine) - (right.span.endLine - right.span.startLine)
            || right.parentQualifiedNamePath.length - left.parentQualifiedNamePath.length
            || compareStrings(left.symbolInstanceId, right.symbolInstanceId)
        ))[0];
}

function classifyOccurrence(input: {
    file: string;
    line: number;
    lineText: string;
    startIndex: number;
    target: SymbolRecord;
    declarationSeen: boolean;
}): ExactReferenceOccurrenceKind {
    if (
        !input.declarationSeen
        && input.file === input.target.file
        && input.line === input.target.span.startLine
    ) {
        return "declaration";
    }
    const prefix = input.lineText.slice(0, input.startIndex).trimEnd();
    return prefix.endsWith(".") ? "member" : "identifier";
}

/**
 * Deterministic textual occurrence search over the validated Publication source universe.
 *
 * This deliberately has no dependency on semantic retrieval, lexical candidate ranking,
 * reranking, or search result budgets. Every eligible published file is presented to the
 * supplied publication-authorized reader before output limiting is applied.
 */
export async function findExactPublishedSourceReferences(input: {
    registry: SymbolRegistry;
    target: SymbolRecord;
    scope?: PublishedPathScope;
    limit?: number;
    readPublishedSource(file: string): Promise<ExactReferenceSourceRead>;
}): Promise<ExactReferenceSearchResult> {
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const publishedFiles = input.registry.manifest.files
        .map((entry) => entry.path.replace(/\\/g, "/"))
        .sort(compareStrings);
    const eligibleFiles = publishedFiles.filter((file) => (
        matchesPublishedPathScope(file, input.scope ?? {})
    ));
    const references: ExactSourceReference[] = [];
    const reasons: ExactReferenceCoverageReason[] = [];
    let inspectedFileCount = 0;
    let declarationSeen = false;

    const identifier = input.target.name.trim();
    if (!identifier) {
        return {
            target: {
                symbolId: input.target.symbolInstanceId,
                symbolLabel: input.target.label,
                name: input.target.name,
                qualifiedName: input.target.qualifiedName,
                file: input.target.file,
                span: {
                    startLine: input.target.span.startLine,
                    endLine: input.target.span.endLine,
                },
            },
            references: [],
            coverage: {
                status: "partial",
                publishedFileCount: publishedFiles.length,
                eligibleFileCount: eligibleFiles.length,
                inspectedFileCount: 0,
                skippedFileCount: eligibleFiles.length,
                matchedOccurrenceCount: 0,
                returnedOccurrenceCount: 0,
                reasons: [{
                    code: "source_unreadable",
                    detail: "Target symbol has no searchable identifier name.",
                }],
            },
        };
    }

    const escaped = escapeRegExp(identifier);
    const matcher = new RegExp("(^|[^A-Za-z0-9_$])(" + escaped + ")(?=$|[^A-Za-z0-9_$])", "g");

    for (const file of eligibleFiles) {
        const source = await input.readPublishedSource(file);
        if (source.status === "skipped") {
            reasons.push({
                code: source.code,
                file,
                ...(source.detail ? { detail: source.detail } : {}),
            });
            continue;
        }
        inspectedFileCount += 1;
        const lines = source.text.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const lineText = lines[lineIndex] ?? "";
            matcher.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = matcher.exec(lineText)) !== null) {
                const leading = match[1] ?? "";
                const startIndex = match.index + leading.length;
                const line = lineIndex + 1;
                const occurrenceKind = classifyOccurrence({
                    file,
                    line,
                    lineText,
                    startIndex,
                    target: input.target,
                    declarationSeen,
                });
                if (occurrenceKind === "declaration") {
                    declarationSeen = true;
                }
                const owner = findOwningSymbol(input.registry, file, line);
                references.push({
                    file,
                    span: {
                        startLine: line,
                        endLine: line,
                        startColumn: startIndex + 1,
                        endColumn: startIndex + identifier.length + 1,
                    },
                    ...(owner ? {
                        owningSymbol: {
                            symbolId: owner.symbolInstanceId,
                            symbolLabel: owner.label,
                            file: owner.file,
                            span: {
                                startLine: owner.span.startLine,
                                endLine: owner.span.endLine,
                            },
                        },
                    } : {}),
                    occurrenceKind,
                    matchedText: identifier,
                    ...(occurrenceKind === "member" ? { member: identifier } : {}),
                    evidenceClass: EXACT_REFERENCE_EVIDENCE_CLASS,
                });
                if (match[0].length === 0) {
                    matcher.lastIndex += 1;
                }
            }
        }
    }

    const sorted = references.sort(compareReferences);
    if (sorted.length > limit) {
        reasons.push({
            code: "result_limit",
            detail: "Matched " + sorted.length + " occurrences; returned first " + limit + " in deterministic source order.",
        });
    }
    const returned = sorted.slice(0, limit);
    return {
        target: {
            symbolId: input.target.symbolInstanceId,
            symbolLabel: input.target.label,
            name: input.target.name,
            qualifiedName: input.target.qualifiedName,
            file: input.target.file,
            span: {
                startLine: input.target.span.startLine,
                endLine: input.target.span.endLine,
            },
        },
        references: returned,
        coverage: {
            status: reasons.length === 0 ? "complete" : "partial",
            publishedFileCount: publishedFiles.length,
            eligibleFileCount: eligibleFiles.length,
            inspectedFileCount,
            skippedFileCount: eligibleFiles.length - inspectedFileCount,
            matchedOccurrenceCount: sorted.length,
            returnedOccurrenceCount: returned.length,
            reasons,
        },
    };
}
