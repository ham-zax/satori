import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import {
    matchesPublishedPathScope,
    type PublishedPathScope,
} from "./navigation-path-scope.js";

export const EXACT_REFERENCE_EVIDENCE_CLASS = "published_source_text" as const;
// Occurrences scanned from edited bytes whose hash differs from the Publication.
export const EXACT_REFERENCE_CURRENT_EVIDENCE_CLASS = "current_source_text" as const;
const EXACT_REFERENCE_READ_CONCURRENCY = 16;

export type ExactReferenceOccurrenceKind = "declaration" | "member" | "identifier";

export type ExactReferenceCoverageReason = Readonly<{
    code: "source_unreadable" | "source_too_large" | "source_replaced" | "source_changed" | "source_unverified" | "result_limit";
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
    evidenceClass: typeof EXACT_REFERENCE_EVIDENCE_CLASS | typeof EXACT_REFERENCE_CURRENT_EVIDENCE_CLASS;
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
    /** Offset of the first occurrence after this page, when more occurrences matched. */
    nextOffset?: number;
}>;

export type ExactReferenceSourceRead =
    | Readonly<{ status: "ok"; text: string; sourceSha256?: string }>
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
    currentSource: boolean;
}): ExactReferenceOccurrenceKind {
    // The published declaration line does not apply to edited bytes.
    if (
        !input.currentSource
        && !input.declarationSeen
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
    /** Occurrences to skip in deterministic source order before the returned page. */
    offset?: number;
    signal?: AbortSignal;
    readPublishedSource(file: string): Promise<ExactReferenceSourceRead>;
}): Promise<ExactReferenceSearchResult> {
    input.signal?.throwIfAborted();
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const windowEnd = offset + limit;
    const publishedEntries = input.registry.manifest.files
        .map((entry) => ({
            path: entry.path.replace(/\\/g, "/"),
            hash: entry.hash,
        }))
        .sort((left, right) => compareStrings(left.path, right.path));
    const publishedFiles = publishedEntries.map((entry) => entry.path);
    const eligibleEntries = publishedEntries.filter((entry) => (
        matchesPublishedPathScope(entry.path, input.scope ?? {})
    ));
    const eligibleFiles = eligibleEntries.map((entry) => entry.path);
    const references: ExactSourceReference[] = [];
    let matchedOccurrenceCount = 0;
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
    const identifierPart = "\\p{ID_Continue}$\\u200C\\u200D";
    const matcher = new RegExp("(^|[^" + identifierPart + "])(" + escaped + ")(?=$|[^" + identifierPart + "])", "gu");

    // Authorized reads are syscall-bound, so a bounded window of them runs
    // ahead while results are still consumed in path order.
    const pendingReads: Promise<ExactReferenceSourceRead>[] = [];
    let nextReadIndex = 0;
    const fillReadWindow = () => {
        while (nextReadIndex < eligibleEntries.length && pendingReads.length < EXACT_REFERENCE_READ_CONCURRENCY) {
            if (input.signal?.aborted) break;
            const read = input.readPublishedSource(eligibleEntries[nextReadIndex++]!.path);
            // Observed when awaited in order; this only prevents an unhandled
            // rejection for reads left in flight when an earlier one throws.
            read.catch(() => undefined);
            pendingReads.push(read);
        }
    };

    try {
        for (const entry of eligibleEntries) {
            const file = entry.path;
            input.signal?.throwIfAborted();
            fillReadWindow();
            const source = await pendingReads.shift()!;
            input.signal?.throwIfAborted();
            if (source.status === "skipped") {
                reasons.push({
                    code: source.code,
                    file,
                    ...(source.detail ? { detail: source.detail } : {}),
                });
                continue;
            }
            const expectedSourceHash = entry.hash?.trim().toLowerCase();
            let currentSource = false;
            if (expectedSourceHash) {
                if (!/^[a-f0-9]{64}$/.test(expectedSourceHash)) {
                    reasons.push({
                        code: "source_unverified",
                        file,
                        detail: "Publication source identity is not a valid SHA-256 content hash.",
                    });
                    continue;
                }
                const observedSha256 = source.sourceSha256?.trim().toLowerCase();
                if (!observedSha256) {
                    reasons.push({
                        code: "source_unverified",
                        file,
                        detail: "Current source bytes could not be bound to the Publication content hash.",
                    });
                    continue;
                }
                if (observedSha256 !== expectedSourceHash) {
                    // Edited files are scanned, not skipped. Their occurrences are
                    // labeled current_source_text and carry no published owner,
                    // because published owner spans do not apply to edited lines.
                    reasons.push({
                        code: "source_changed",
                        file,
                        detail: "Current source bytes differ from the Publication content hash; occurrences come from current bytes (evidenceClass=current_source_text).",
                    });
                    currentSource = true;
                }
            }
            inspectedFileCount += 1;
            const lines = source.text.split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                const lineText = lines[lineIndex] ?? "";
                matcher.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = matcher.exec(lineText)) !== null) {
                    const occurrenceIndex = matchedOccurrenceCount;
                    matchedOccurrenceCount += 1;
                    // Files, lines, and matches are consumed in source order, so
                    // only this prefix can appear in the limited response. Matches
                    // before the page are still classified: declarationSeen depends on them.
                    if (occurrenceIndex >= windowEnd) continue;
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
                        currentSource,
                    });
                    if (occurrenceKind === "declaration") {
                        declarationSeen = true;
                    }
                    if (occurrenceIndex < offset) continue;
                    const owner = currentSource ? undefined : findOwningSymbol(input.registry, file, line);
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
                        evidenceClass: currentSource ? EXACT_REFERENCE_CURRENT_EVIDENCE_CLASS : EXACT_REFERENCE_EVIDENCE_CLASS,
                    });
                    if (match[0].length === 0) {
                        matcher.lastIndex += 1;
                    }
                }
            }
        }
    } finally {
        // The caller owns a Publication lease until every started read settles.
        await Promise.allSettled(pendingReads);
    }

    const sorted = references.sort(compareReferences);
    const hasMore = matchedOccurrenceCount > windowEnd;
    if (hasMore) {
        reasons.push({
            code: "result_limit",
            detail: offset === 0
                ? "Matched " + matchedOccurrenceCount + " occurrences; returned first " + limit + " in deterministic source order."
                : "Matched " + matchedOccurrenceCount + " occurrences; returned " + (offset + 1) + "-" + windowEnd + " in deterministic source order.",
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
            matchedOccurrenceCount,
            returnedOccurrenceCount: returned.length,
            reasons,
        },
        ...(hasMore ? { nextOffset: windowEnd } : {}),
    };
}
