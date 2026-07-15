import { compareContractStrings } from "@zokizuan/satori-core";

export const BOUNDED_SOURCE_SELECTION_POLICY_VERSION = "bounded_source_selection_v1" as const;

export type SourceSelectionCapabilityStatus =
    | "available"
    | "unsupported_language"
    | "unavailable_streaming_source"
    | "not_requested";

export interface SourceSelectionCapabilities {
    localLexical: "available";
    lineWindows: "available";
    syntaxBoundaries: SourceSelectionCapabilityStatus;
    controlFlowAnchors: SourceSelectionCapabilityStatus;
}

export type SourceStructuralAnchorKind =
    | "declaration"
    | "documentation"
    | "call"
    | "state_write"
    | "branch"
    | "exception"
    | "resource_boundary"
    | "synchronization"
    | "persistence";

export interface SourceLineSpan {
    startLine: number;
    endLine: number;
}

export interface SourceSelectionAnchor {
    kind: SourceStructuralAnchorKind;
    span: SourceLineSpan;
}

export interface BoundedSourceBudgets {
    maxSourceBytes: number;
    maxSourceLines: number;
    maxExcerpts: number;
    maxExcerptBytes: number;
    maxExcerptLines: number;
    contextLines: number;
    maxSerializedSourceBytes: number;
}

export type SourceExcerptReason =
    | "complete_symbol"
    | "declaration"
    | "query_match"
    | "terminal"
    | "evidence_span"
    | "structural_anchor";

export interface SourceByteLineRange extends SourceLineSpan {
    startByte: number;
    endByte: number;
}

export interface SourceExcerpt extends SourceByteLineRange {
    reason: SourceExcerptReason;
    selectionBases: string[];
    content: string;
}

export interface SelectedSourceProjection {
    selectionPolicyVersion: typeof BOUNDED_SOURCE_SELECTION_POLICY_VERSION;
    mode: "complete" | "bounded";
    status: "available" | "partially_available" | "unavailable";
    span: SourceByteLineRange;
    completeSymbolReturned: boolean;
    totalLines: number;
    totalBytes: number;
    returnedLines: number;
    returnedBytes: number;
    excerptCount: number;
    excerpts: SourceExcerpt[];
    omittedRanges: SourceByteLineRange[];
    truncated: boolean;
    selectionCapabilities: SourceSelectionCapabilities;
    limitations: Array<"line_exceeds_excerpt_limit">;
    emptyReason?: "line_exceeds_excerpt_limit";
}

export type BoundedSourceSelectionResult = {
    status: "selected";
    source: SelectedSourceProjection;
    serializedSourceBytes: number;
} | {
    status: "minimum_projection_exceeds_budget";
    minimumRequiredSerializedSourceBytes: number;
};

export interface BoundedSourceSelectionInput {
    sourceBytes: Uint8Array;
    symbolSpan: SourceLineSpan;
    budgets: BoundedSourceBudgets;
    capabilities: SourceSelectionCapabilities;
    query?: string;
    evidenceSpans?: readonly SourceLineSpan[];
    structuralAnchors?: readonly SourceSelectionAnchor[];
}

interface PhysicalLine {
    line: number;
    startByte: number;
    contentEndByte: number;
    text: string;
}

interface CandidateRange extends SourceLineSpan {
    focusLine: number;
    reason: SourceExcerptReason;
    selectionBasis: string;
    priority: number;
    score: number;
}

interface SelectedRange extends SourceLineSpan {
    reasons: Array<{
        reason: SourceExcerptReason;
        selectionBasis: string;
        priority: number;
    }>;
}

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
}

function validateBudgets(budgets: BoundedSourceBudgets): void {
    assertPositiveInteger(budgets.maxSourceBytes, "maxSourceBytes");
    assertPositiveInteger(budgets.maxSourceLines, "maxSourceLines");
    assertPositiveInteger(budgets.maxExcerpts, "maxExcerpts");
    assertPositiveInteger(budgets.maxExcerptBytes, "maxExcerptBytes");
    assertPositiveInteger(budgets.maxExcerptLines, "maxExcerptLines");
    assertPositiveInteger(budgets.maxSerializedSourceBytes, "maxSerializedSourceBytes");
    if (!Number.isSafeInteger(budgets.contextLines) || budgets.contextLines < 0) {
        throw new RangeError("contextLines must be a non-negative safe integer.");
    }
    if (budgets.maxExcerptBytes > budgets.maxSourceBytes) {
        throw new RangeError("maxExcerptBytes cannot exceed maxSourceBytes.");
    }
    if (budgets.maxExcerptLines > budgets.maxSourceLines) {
        throw new RangeError("maxExcerptLines cannot exceed maxSourceLines.");
    }
}

function readPhysicalLines(sourceBytes: Buffer): PhysicalLine[] {
    new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    const lines: PhysicalLine[] = [];
    let startByte = 0;
    for (let index = 0; index < sourceBytes.length; index += 1) {
        if (sourceBytes[index] !== 0x0a) continue;
        const contentEndByte = index > startByte && sourceBytes[index - 1] === 0x0d
            ? index - 1
            : index;
        lines.push({
            line: lines.length + 1,
            startByte,
            contentEndByte,
            text: sourceBytes.subarray(startByte, contentEndByte).toString("utf8"),
        });
        startByte = index + 1;
    }
    if (startByte <= sourceBytes.length) {
        lines.push({
            line: lines.length + 1,
            startByte,
            contentEndByte: sourceBytes.length,
            text: sourceBytes.subarray(startByte).toString("utf8"),
        });
    }
    return lines;
}

function validateSymbolSpan(span: SourceLineSpan, lineCount: number): void {
    if (
        !Number.isSafeInteger(span.startLine)
        || !Number.isSafeInteger(span.endLine)
        || span.startLine < 1
        || span.endLine < span.startLine
        || span.endLine > lineCount
    ) {
        throw new RangeError("symbolSpan must be a valid one-based inclusive range in sourceBytes.");
    }
}

function byteRangeForLines(
    lines: readonly PhysicalLine[],
    symbolEndLine: number,
    span: SourceLineSpan,
): SourceByteLineRange {
    const start = lines[span.startLine - 1];
    const end = lines[span.endLine - 1];
    if (!start || !end) {
        throw new RangeError("Line range is outside the decoded source.");
    }
    const endByte = span.endLine < symbolEndLine
        ? lines[span.endLine]?.startByte ?? end.contentEndByte
        : end.contentEndByte;
    return {
        ...span,
        startByte: start.startByte,
        endByte,
    };
}

function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clampSpanToSymbol(
    span: SourceLineSpan,
    symbolSpan: SourceLineSpan,
): SourceLineSpan | undefined {
    const startLine = Math.max(symbolSpan.startLine, span.startLine);
    const endLine = Math.min(symbolSpan.endLine, span.endLine);
    if (startLine > endLine) return undefined;
    return { startLine, endLine };
}

function lexicalTokens(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

function splitQueryTerms(query: string): string[] {
    return [...new Set(lexicalTokens(query))]
        .sort(compareContractStrings);
}

function includesTokenSequence(tokens: readonly string[], phrase: readonly string[]): boolean {
    if (phrase.length === 0 || phrase.length > tokens.length) return false;
    for (let start = 0; start <= tokens.length - phrase.length; start += 1) {
        if (phrase.every((term, offset) => tokens[start + offset] === term)) return true;
    }
    return false;
}

function buildQueryCandidates(input: {
    lines: readonly PhysicalLine[];
    symbolSpan: SourceLineSpan;
    query?: string;
    contextLines: number;
}): CandidateRange[] {
    const trimmedQuery = input.query?.trim() || "";
    if (!trimmedQuery) return [];
    const terms = splitQueryTerms(trimmedQuery);
    const phraseTerms = lexicalTokens(trimmedQuery);
    const candidates: CandidateRange[] = [];
    for (let line = input.symbolSpan.startLine; line <= input.symbolSpan.endLine; line += 1) {
        const lineTerms = lexicalTokens(input.lines[line - 1]?.text || "");
        const lineTermSet = new Set(lineTerms);
        const matchedTerms = terms.filter((term) => lineTermSet.has(term));
        const phraseScore = includesTokenSequence(lineTerms, phraseTerms) ? 10_000 : 0;
        const score = phraseScore + (matchedTerms.length * 100);
        if (score === 0) continue;
        candidates.push({
            startLine: Math.max(input.symbolSpan.startLine, line - input.contextLines),
            endLine: Math.min(input.symbolSpan.endLine, line + input.contextLines),
            focusLine: line,
            reason: "query_match",
            selectionBasis: "local_lexical_query",
            priority: 0,
            score,
        });
    }
    return candidates.sort((left, right) => (
        right.score - left.score
        || left.focusLine - right.focusLine
        || left.startLine - right.startLine
        || left.endLine - right.endLine
    ));
}

function anchorPriority(kind: SourceStructuralAnchorKind): number {
    switch (kind) {
        case "documentation": return 0;
        case "call": return 1;
        case "state_write": return 2;
        case "branch": return 3;
        case "exception": return 4;
        case "resource_boundary": return 5;
        case "synchronization": return 6;
        case "persistence": return 7;
        case "declaration": return -1;
    }
}

function buildOrderedCandidates(input: {
    lines: readonly PhysicalLine[];
    symbolSpan: SourceLineSpan;
    query?: string;
    evidenceSpans?: readonly SourceLineSpan[];
    structuralAnchors?: readonly SourceSelectionAnchor[];
    contextLines: number;
}): CandidateRange[] {
    const anchors = (input.structuralAnchors || [])
        .map((anchor) => ({ anchor, span: clampSpanToSymbol(anchor.span, input.symbolSpan) }))
        .filter((entry): entry is { anchor: SourceSelectionAnchor; span: SourceLineSpan } => Boolean(entry.span));
    const declarationAnchor = anchors
        .filter((entry) => entry.anchor.kind === "declaration")
        .sort((left, right) => left.span.startLine - right.span.startLine || left.span.endLine - right.span.endLine)[0];
    const declarationSpan = declarationAnchor?.span || {
        startLine: input.symbolSpan.startLine,
        endLine: input.symbolSpan.startLine,
    };
    const declaration: CandidateRange = {
        ...declarationSpan,
        focusLine: declarationSpan.startLine,
        reason: "declaration",
        selectionBasis: declarationAnchor ? "structural:declaration" : "line_window:declaration",
        priority: 10,
        score: 0,
    };

    const queryCandidates = buildQueryCandidates(input);
    const evidenceCandidates = (input.evidenceSpans || [])
        .map((span) => clampSpanToSymbol(span, input.symbolSpan))
        .filter((span): span is SourceLineSpan => Boolean(span))
        .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
        .map((span): CandidateRange => ({
            ...span,
            focusLine: span.startLine,
            reason: "evidence_span",
            selectionBasis: "validated_evidence_span",
            priority: 0,
            score: 20_000,
        }));
    const queryEvidence = [...evidenceCandidates, ...queryCandidates].sort((left, right) => (
        right.score - left.score
        || left.focusLine - right.focusLine
        || compareContractStrings(left.reason, right.reason)
    ));

    let terminalLine = input.symbolSpan.endLine;
    for (let line = input.symbolSpan.endLine; line >= input.symbolSpan.startLine; line -= 1) {
        if (/\b(return|throw|raise|panic|fail(?:ure)?|abort)\b/i.test(input.lines[line - 1]?.text || "")) {
            terminalLine = line;
            break;
        }
    }
    const terminal: CandidateRange = {
        startLine: terminalLine,
        endLine: terminalLine,
        focusLine: terminalLine,
        reason: "terminal",
        selectionBasis: "line_window:terminal",
        priority: 30,
        score: 0,
    };

    const remainingAnchors = anchors
        .filter((entry) => entry.anchor.kind !== "declaration")
        .sort((left, right) => (
            anchorPriority(left.anchor.kind) - anchorPriority(right.anchor.kind)
            || left.span.startLine - right.span.startLine
            || left.span.endLine - right.span.endLine
        ))
        .map((entry, index): CandidateRange => ({
            ...entry.span,
            focusLine: entry.span.startLine,
            reason: "structural_anchor",
            selectionBasis: `structural:${entry.anchor.kind}`,
            priority: 100 + index,
            score: 0,
        }));

    const highestQuery = queryEvidence[0] ? [{ ...queryEvidence[0], priority: 20 }] : [];
    const additionalQuery = queryEvidence.slice(1).map((candidate, index) => ({
        ...candidate,
        priority: 40 + index,
    }));
    return [declaration, ...highestQuery, terminal, ...additionalQuery, ...remainingAnchors];
}

function capCandidateSpan(
    candidate: CandidateRange,
    symbolSpan: SourceLineSpan,
    maxExcerptLines: number,
): CandidateRange {
    if (candidate.endLine - candidate.startLine + 1 <= maxExcerptLines) return candidate;
    const halfWindow = Math.floor((maxExcerptLines - 1) / 2);
    let startLine = Math.max(symbolSpan.startLine, candidate.focusLine - halfWindow);
    let endLine = startLine + maxExcerptLines - 1;
    if (endLine > symbolSpan.endLine) {
        endLine = symbolSpan.endLine;
        startLine = Math.max(symbolSpan.startLine, endLine - maxExcerptLines + 1);
    }
    return { ...candidate, startLine, endLine };
}

function mergeCandidate(
    selected: readonly SelectedRange[],
    candidate: CandidateRange,
): SelectedRange[] {
    const overlapping = selected.filter((range) => (
        candidate.startLine <= range.endLine && candidate.endLine >= range.startLine
    ));
    const untouched = selected.filter((range) => !overlapping.includes(range));
    const merged: SelectedRange = {
        startLine: Math.min(candidate.startLine, ...overlapping.map((range) => range.startLine)),
        endLine: Math.max(candidate.endLine, ...overlapping.map((range) => range.endLine)),
        reasons: [
            ...overlapping.flatMap((range) => range.reasons),
            {
                reason: candidate.reason,
                selectionBasis: candidate.selectionBasis,
                priority: candidate.priority,
            },
        ],
    };
    return [...untouched, merged].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
}

function buildOmittedRanges(
    lines: readonly PhysicalLine[],
    symbolSpan: SourceLineSpan,
    selected: readonly SelectedRange[],
): SourceByteLineRange[] {
    const omitted: SourceByteLineRange[] = [];
    let nextLine = symbolSpan.startLine;
    for (const range of selected) {
        if (range.startLine > nextLine) {
            omitted.push(byteRangeForLines(lines, symbolSpan.endLine, {
                startLine: nextLine,
                endLine: range.startLine - 1,
            }));
        }
        nextLine = Math.max(nextLine, range.endLine + 1);
    }
    if (nextLine <= symbolSpan.endLine) {
        omitted.push(byteRangeForLines(lines, symbolSpan.endLine, {
            startLine: nextLine,
            endLine: symbolSpan.endLine,
        }));
    }
    return omitted;
}

function buildExcerpts(
    sourceBytes: Buffer,
    lines: readonly PhysicalLine[],
    symbolSpan: SourceLineSpan,
    selected: readonly SelectedRange[],
): SourceExcerpt[] {
    return selected.map((range) => {
        const byteRange = byteRangeForLines(lines, symbolSpan.endLine, range);
        const orderedReasons = [...range.reasons].sort((left, right) => (
            left.priority - right.priority
            || compareContractStrings(left.reason, right.reason)
            || compareContractStrings(left.selectionBasis, right.selectionBasis)
        ));
        return {
            ...byteRange,
            reason: orderedReasons[0]?.reason || "structural_anchor",
            selectionBases: [...new Set(orderedReasons.map((entry) => entry.selectionBasis))],
            content: sourceBytes.subarray(byteRange.startByte, byteRange.endByte).toString("utf8"),
        };
    });
}

function buildSourceProjection(input: {
    sourceBytes: Buffer;
    lines: readonly PhysicalLine[];
    symbolSpan: SourceLineSpan;
    selected: readonly SelectedRange[];
    complete: boolean;
    capabilities: SourceSelectionCapabilities;
    hasOversizedLine: boolean;
}): SelectedSourceProjection {
    const fullSpan = byteRangeForLines(input.lines, input.symbolSpan.endLine, input.symbolSpan);
    const excerpts = buildExcerpts(input.sourceBytes, input.lines, input.symbolSpan, input.selected);
    const returnedLines = input.selected.reduce(
        (total, range) => total + (range.endLine - range.startLine + 1),
        0,
    );
    const returnedBytes = excerpts.reduce(
        (total, excerpt) => total + (excerpt.endByte - excerpt.startByte),
        0,
    );
    const unavailable = !input.complete && excerpts.length === 0 && input.hasOversizedLine;
    return {
        selectionPolicyVersion: BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
        mode: input.complete ? "complete" : "bounded",
        status: unavailable
            ? "unavailable"
            : input.hasOversizedLine ? "partially_available" : "available",
        span: fullSpan,
        completeSymbolReturned: input.complete,
        totalLines: input.symbolSpan.endLine - input.symbolSpan.startLine + 1,
        totalBytes: fullSpan.endByte - fullSpan.startByte,
        returnedLines,
        returnedBytes,
        excerptCount: excerpts.length,
        excerpts,
        omittedRanges: input.complete ? [] : buildOmittedRanges(input.lines, input.symbolSpan, input.selected),
        truncated: !input.complete,
        selectionCapabilities: { ...input.capabilities },
        limitations: input.hasOversizedLine ? ["line_exceeds_excerpt_limit"] : [],
        ...(unavailable ? { emptyReason: "line_exceeds_excerpt_limit" as const } : {}),
    };
}

function selectionSize(selected: readonly SelectedRange[]): { lines: number } {
    return {
        lines: selected.reduce((total, range) => total + (range.endLine - range.startLine + 1), 0),
    };
}

export function selectBoundedSource(
    input: BoundedSourceSelectionInput,
): BoundedSourceSelectionResult {
    validateBudgets(input.budgets);
    const sourceBytes = Buffer.from(input.sourceBytes);
    const lines = readPhysicalLines(sourceBytes);
    validateSymbolSpan(input.symbolSpan, lines.length);
    const fullSpan = byteRangeForLines(lines, input.symbolSpan.endLine, input.symbolSpan);
    const totalLines = input.symbolSpan.endLine - input.symbolSpan.startLine + 1;
    const totalBytes = fullSpan.endByte - fullSpan.startByte;
    const completeSelected: SelectedRange[] = [{
        ...input.symbolSpan,
        reasons: [{
            reason: "complete_symbol",
            selectionBasis: "complete_symbol",
            priority: 0,
        }],
    }];
    const completeProjection = buildSourceProjection({
        sourceBytes,
        lines,
        symbolSpan: input.symbolSpan,
        selected: completeSelected,
        complete: true,
        capabilities: input.capabilities,
        hasOversizedLine: false,
    });
    const completeSerializedBytes = serializedBytes(completeProjection);
    if (
        totalBytes <= input.budgets.maxSourceBytes
        && totalLines <= input.budgets.maxSourceLines
        && completeSerializedBytes <= input.budgets.maxSerializedSourceBytes
    ) {
        return {
            status: "selected",
            source: completeProjection,
            serializedSourceBytes: completeSerializedBytes,
        };
    }

    const oversizedLines = new Set<number>();
    for (let line = input.symbolSpan.startLine; line <= input.symbolSpan.endLine; line += 1) {
        const lineRange = byteRangeForLines(lines, input.symbolSpan.endLine, { startLine: line, endLine: line });
        if (lineRange.endByte - lineRange.startByte > input.budgets.maxExcerptBytes) {
            oversizedLines.add(line);
        }
    }

    const candidates = buildOrderedCandidates({
        lines,
        symbolSpan: input.symbolSpan,
        query: input.query,
        evidenceSpans: input.evidenceSpans,
        structuralAnchors: input.structuralAnchors,
        contextLines: input.budgets.contextLines,
    });
    let selected: SelectedRange[] = [];
    let smallestRejectedProjectionBytes = Number.POSITIVE_INFINITY;
    for (const rawCandidate of candidates) {
        let candidate = capCandidateSpan(rawCandidate, input.symbolSpan, input.budgets.maxExcerptLines);
        let candidateByteRange = byteRangeForLines(lines, input.symbolSpan.endLine, candidate);
        if (candidateByteRange.endByte - candidateByteRange.startByte > input.budgets.maxExcerptBytes) {
            candidate = { ...candidate, startLine: candidate.focusLine, endLine: candidate.focusLine };
            candidateByteRange = byteRangeForLines(lines, input.symbolSpan.endLine, candidate);
        }
        if (candidateByteRange.endByte - candidateByteRange.startByte > input.budgets.maxExcerptBytes) {
            oversizedLines.add(candidate.focusLine);
            continue;
        }

        const merged = mergeCandidate(selected, candidate);
        if (merged.length > input.budgets.maxExcerpts) continue;
        if (selectionSize(merged).lines > input.budgets.maxSourceLines) continue;
        const mergedExcerpts = buildExcerpts(sourceBytes, lines, input.symbolSpan, merged);
        const mergedBytes = mergedExcerpts.reduce(
            (total, excerpt) => total + (excerpt.endByte - excerpt.startByte),
            0,
        );
        if (
            mergedBytes > input.budgets.maxSourceBytes
            || mergedExcerpts.some((excerpt) => (
                excerpt.endByte - excerpt.startByte > input.budgets.maxExcerptBytes
                || excerpt.endLine - excerpt.startLine + 1 > input.budgets.maxExcerptLines
            ))
        ) {
            continue;
        }

        const projection = buildSourceProjection({
            sourceBytes,
            lines,
            symbolSpan: input.symbolSpan,
            selected: merged,
            complete: false,
            capabilities: input.capabilities,
            hasOversizedLine: oversizedLines.size > 0,
        });
        const projectionBytes = serializedBytes(projection);
        if (projectionBytes > input.budgets.maxSerializedSourceBytes) {
            if (rawCandidate.reason === "declaration") {
                return {
                    status: "minimum_projection_exceeds_budget",
                    minimumRequiredSerializedSourceBytes: projectionBytes,
                };
            }
            smallestRejectedProjectionBytes = Math.min(smallestRejectedProjectionBytes, projectionBytes);
            continue;
        }
        selected = merged;
    }

    const boundedProjection = buildSourceProjection({
        sourceBytes,
        lines,
        symbolSpan: input.symbolSpan,
        selected,
        complete: false,
        capabilities: input.capabilities,
        hasOversizedLine: oversizedLines.size > 0,
    });
    const boundedSerializedBytes = serializedBytes(boundedProjection);
    if (selected.length === 0 && oversizedLines.size === 0) {
        return {
            status: "minimum_projection_exceeds_budget",
            minimumRequiredSerializedSourceBytes: Number.isFinite(smallestRejectedProjectionBytes)
                ? smallestRejectedProjectionBytes
                : boundedSerializedBytes,
        };
    }
    if (boundedSerializedBytes > input.budgets.maxSerializedSourceBytes) {
        return {
            status: "minimum_projection_exceeds_budget",
            minimumRequiredSerializedSourceBytes: boundedSerializedBytes,
        };
    }
    return {
        status: "selected",
        source: boundedProjection,
        serializedSourceBytes: boundedSerializedBytes,
    };
}
