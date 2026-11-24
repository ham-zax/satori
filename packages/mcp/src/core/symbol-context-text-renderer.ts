import path from "node:path";
import type { SelectedSourceProjection } from "./bounded-source-selector.js";
import type {
    ComposedSymbolContext,
    SymbolContextContinuation,
    SymbolContextRelationshipProjection,
} from "./symbol-context-composer.js";
import {
    SYMBOL_CONTEXT_FORMAT_VERSION,
    type PublicSymbolContextEnvelope,
} from "./symbol-context-public-contract.js";

function sanitizeHeaderText(value: string): string {
    return value.replace(/[\r\n\t]+/g, " ").trim();
}

function splitExcerptLines(content: string, startLine: number, endLine: number): string[] {
    const expectedCount = Math.max(0, endLine - startLine + 1);
    if (expectedCount === 0) {
        return [];
    }
    const rawLines = content.split(/\r\n|\n|\r/);
    if (rawLines.length === expectedCount + 1 && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
    }
    return rawLines.slice(0, expectedCount);
}

function collectEnvelopeLimitations(envelope: PublicSymbolContextEnvelope): string[] {
    const entries: string[] = [...envelope.limitations];
    if ("selectionPolicyVersion" in envelope.source) {
        for (const limitation of envelope.source.limitations) {
            entries.push(`source:${limitation}`);
        }
        if (envelope.source.emptyReason) {
            entries.push(`source:${envelope.source.emptyReason}`);
        }
    } else if (envelope.source.status === "unavailable" || envelope.source.status === "stale") {
        entries.push(`source:${envelope.source.status}:${envelope.source.emptyReason}`);
    }

    for (const rel of [envelope.relationships.callers, envelope.relationships.callees]) {
        const prefix = `${rel.relationship}s`;
        if (rel.status === "unavailable" || rel.status === "unsupported" || rel.status === "ambiguous") {
            entries.push(`${prefix}:${rel.status}:${sanitizeHeaderText(rel.reason)}`);
            continue;
        }
        if (rel.status === "ok" || rel.status === "degraded") {
            for (const limitation of rel.limitations) {
                entries.push(`${prefix}:${limitation}`);
            }
            if (rel.suppressedCount > 0) {
                entries.push(`${prefix}:suppressed=${rel.suppressedCount}`);
            }
        }
    }

    return [...new Set(entries)];
}

function renderSelectedSourceLines(source: SelectedSourceProjection): string[] {
    type SourceSegment =
        | { kind: "excerpt"; startLine: number; endLine: number; lines: string[] }
        | { kind: "omitted"; startLine: number; endLine: number };

    const segments: SourceSegment[] = [
        ...source.excerpts.map((excerpt) => ({
            kind: "excerpt" as const,
            startLine: excerpt.startLine,
            endLine: excerpt.endLine,
            lines: splitExcerptLines(excerpt.content, excerpt.startLine, excerpt.endLine),
        })),
        ...source.omittedRanges.map((range) => ({
            kind: "omitted" as const,
            startLine: range.startLine,
            endLine: range.endLine,
        })),
    ].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

    const rendered: string[] = [];
    for (const segment of segments) {
        if (segment.kind === "omitted") {
            rendered.push(`... omitted lines ${segment.startLine}-${segment.endLine} ...`);
            continue;
        }
        for (let index = 0; index < segment.lines.length; index += 1) {
            rendered.push(`${segment.startLine + index}| ${segment.lines[index]}`);
        }
    }
    return rendered;
}

function formatSymbolHeaderLabel(kind: string, symbolLabel: string): string {
    const cleanLabel = sanitizeHeaderText(symbolLabel);
    const cleanKind = sanitizeHeaderText(kind);
    if (!cleanKind) {
        return cleanLabel;
    }
    if (cleanLabel.toLowerCase().startsWith(`${cleanKind.toLowerCase()} `)) {
        return cleanLabel;
    }
    return `${cleanKind} ${cleanLabel}`;
}

function renderSiblingsSection(siblings: ComposedSymbolContext["outline"]["siblings"]): string[] {
    if (siblings.items.length === 0 && siblings.availableCount === 0) {
        return [];
    }
    const lines = [
        `Siblings (${siblings.returnedCount}/${siblings.availableCount}${siblings.truncated ? ", truncated" : ""}):`,
    ];
    for (const item of siblings.items) {
        lines.push(
            `- ${formatSymbolHeaderLabel(item.kind, item.symbolLabel)} (${item.file}:${item.span.startLine}-${item.span.endLine}) [${item.symbolId}]`,
        );
    }
    return lines;
}

function renderRelationshipSection(title: string, rel: SymbolContextRelationshipProjection): string[] {
    if (rel.status === "not_requested") {
        return [];
    }
    if (rel.status === "ok" || rel.status === "degraded") {
        const countLabel = rel.availableCount !== undefined
            ? `${rel.returnedCount}/${rel.availableCount}`
            : `${rel.returnedCount}`;
        const flags: string[] = [];
        if (rel.truncated) {
            flags.push("truncated");
        }
        if (rel.suppressedCount > 0) {
            flags.push(`suppressed=${rel.suppressedCount}`);
        }
        const lines = [
            `${title} (${countLabel}${flags.length > 0 ? `, ${flags.join(", ")}` : ""}):`,
        ];
        for (const item of rel.items) {
            const sitesText = item.sites.items.length > 0
                ? item.sites.items
                    .map((site) => (
                        site.endLine !== undefined && site.endLine !== site.startLine
                            ? `${site.file}:${site.startLine}-${site.endLine}`
                            : `${site.file}:${site.startLine}`
                    ))
                    .join(", ")
                : "no-site";
            lines.push(
                `- ${item.symbolId} @ ${sitesText} [${item.confidenceClass}, ${item.source}, ${item.sites.status}]`,
            );
        }
        return lines;
    }
    if ("reason" in rel) {
        return [`${title}: ${rel.status} (${sanitizeHeaderText(rel.reason)})`];
    }
    return [];
}

function buildContinuationReadArgs(input: {
    codebaseRoot: string;
    file: string;
    mode: "plain" | "annotated";
    symbolId: string;
    continuation: SymbolContextContinuation;
}): Record<string, unknown> {
    const requestContinuation = input.continuation.kind === "source_range"
        ? {
            kind: "source_range" as const,
            fingerprint: input.continuation.fingerprint,
            startLine: input.continuation.startLine,
            endLine: input.continuation.endLine,
        }
        : {
            kind: input.continuation.kind,
            fingerprint: input.continuation.fingerprint,
            cursor: input.continuation.cursor,
            pageSize: input.continuation.pageSize,
        };
    return {
        path: path.resolve(input.codebaseRoot, input.file),
        codebaseRoot: input.codebaseRoot,
        mode: input.mode,
        format: "text",
        open_symbol: {
            contractVersion: SYMBOL_CONTEXT_FORMAT_VERSION,
            symbolId: input.symbolId,
            continuation: requestContinuation,
        },
    };
}

function renderContinuationsSection(input: {
    codebaseRoot: string;
    envelope: PublicSymbolContextEnvelope;
}): string[] {
    if (input.envelope.continuations.length === 0) {
        return [];
    }
    const lines = ["Continuations:"];
    for (const continuation of input.envelope.continuations) {
        const descriptor = continuation.kind === "source_range"
            ? `lines ${continuation.startLine}-${continuation.endLine}`
            : `pageSize=${continuation.pageSize}`;
        const args = buildContinuationReadArgs({
            codebaseRoot: input.codebaseRoot,
            file: input.envelope.symbol.file,
            mode: input.envelope.effectiveRequest.requestedMode,
            symbolId: input.envelope.symbol.symbolId,
            continuation,
        });
        lines.push(`- ${continuation.kind} (${descriptor}):`);
        lines.push("```json");
        lines.push(JSON.stringify(args));
        lines.push("```");
    }
    return lines;
}

export function renderSymbolContextText(input: {
    codebaseRoot: string;
    envelope: PublicSymbolContextEnvelope;
}): string {
    const { envelope } = input;
    const { symbol, authority } = envelope;
    const headerLines = [
        `# ${symbol.file}:${symbol.span.startLine}-${symbol.span.endLine} | ${formatSymbolHeaderLabel(symbol.kind, symbol.symbolLabel)}`,
        `symbolId: ${symbol.symbolId}`,
        `codebaseRoot: ${input.codebaseRoot}`,
        `authority: navigation=${authority.navigation}, source=${authority.source.freshness}/${authority.source.spanResolution}, relationships=${authority.relationships}`,
    ];

    const limitations = collectEnvelopeLimitations(envelope);
    if (limitations.length > 0) {
        headerLines.push(`limitations: ${limitations.join(", ")}`);
    }

    const sections: string[][] = [headerLines];

    if ("selectionPolicyVersion" in envelope.source) {
        const sourceLines = renderSelectedSourceLines(envelope.source);
        if (sourceLines.length > 0) {
            sections.push(sourceLines);
        }
    } else if (envelope.source.status === "unavailable" || envelope.source.status === "stale") {
        sections.push([`Source: ${envelope.source.status} (${envelope.source.emptyReason})`]);
    }

    const callersSection = renderRelationshipSection("Callers", envelope.relationships.callers);
    if (callersSection.length > 0) {
        sections.push(callersSection);
    }

    const calleesSection = renderRelationshipSection("Callees", envelope.relationships.callees);
    if (calleesSection.length > 0) {
        sections.push(calleesSection);
    }

    const siblingsSection = renderSiblingsSection(envelope.outline.siblings);
    if (siblingsSection.length > 0) {
        sections.push(siblingsSection);
    }

    const continuationsSection = renderContinuationsSection({
        codebaseRoot: input.codebaseRoot,
        envelope,
    });
    if (continuationsSection.length > 0) {
        sections.push(continuationsSection);
    }

    return sections.map((section) => section.join("\n")).join("\n\n");
}

export function renderOrdinaryRangeText(input: {
    absolutePath: string;
    codebaseRoot?: string;
    startLine: number;
    endLine: number;
    lines: readonly string[];
    nextStartLine?: number;
    mode?: "plain" | "annotated";
}): string {
    const rootSuffix = input.codebaseRoot ? ` | codebaseRoot: ${input.codebaseRoot}` : "";
    if (input.lines.length === 0 || input.endLine < input.startLine) {
        return `# ${input.absolutePath} (empty file)${rootSuffix}`;
    }

    const output: string[] = [
        `# ${input.absolutePath}:${input.startLine}-${input.endLine}${rootSuffix}`,
    ];
    for (let index = 0; index < input.lines.length; index += 1) {
        const normalizedLine = input.lines[index]!.replace(/\r$/, "");
        output.push(`${input.startLine + index}| ${normalizedLine}`);
    }

    if (input.nextStartLine !== undefined) {
        const nextArgs = {
            path: input.absolutePath,
            ...(input.codebaseRoot ? { codebaseRoot: input.codebaseRoot } : {}),
            ...(input.mode === "annotated" ? { mode: input.mode } : {}),
            start_line: input.nextStartLine,
            format: "text",
        };
        output.push("");
        output.push(
            `(File truncated at line ${input.endLine}. To read more, call read_file with ${JSON.stringify(nextArgs)}.)`,
        );
    }

    return output.join("\n");
}
