import * as path from "path";
import type { CallGraphEdge, CallGraphNode } from "./call-graph.js";
import type { SearchDebugHint, SearchResponseEnvelope, SearchSpan } from "./search-types.js";

type ChangedCodeDebug = NonNullable<SearchDebugHint["changedCode"]>;
type ChangedCodeDebugSymbol = ChangedCodeDebug["symbols"][number];
type ChangedCodeDebugDirectCaller = ChangedCodeDebug["directCallers"][number];

export function buildChangedCodeDebug(input: {
    sidecar: { nodes: CallGraphNode[]; edges: CallGraphEdge[] } | null | undefined;
    changedFilesState: { available: boolean; files: Set<string> };
    normalizeRelativeFilePath: (relativeFilePath: string) => string;
    normalizeSearchSymbolLabel: (label: string | null | undefined) => string | undefined;
    compareNullableStringsAsc: (a?: string | null, b?: string | null) => number;
    compareNullableNumbersAsc: (a?: number | null, b?: number | null) => number;
    maxFiles: number;
    maxSymbols: number;
    maxDirectCallers: number;
}): SearchDebugHint["changedCode"] | undefined {
    if (!input.changedFilesState.available || input.changedFilesState.files.size === 0) {
        return undefined;
    }
    if (!input.sidecar || !Array.isArray(input.sidecar.nodes) || !Array.isArray(input.sidecar.edges)) {
        return undefined;
    }

    const changedFiles = Array.from(input.changedFilesState.files)
        .map((file) => input.normalizeRelativeFilePath(file))
        .filter((file) => file.length > 0 && !file.startsWith("..") && !path.posix.isAbsolute(file))
        .sort((a, b) => a.localeCompare(b));
    const changedFileSet = new Set(changedFiles);
    const nodeById = new Map<string, CallGraphNode>();
    for (const node of input.sidecar.nodes) {
        if (node && typeof node.symbolId === "string") {
            nodeById.set(node.symbolId, node);
        }
    }

    const changedSymbols = input.sidecar.nodes
        .filter((node) => node && typeof node.file === "string" && changedFileSet.has(input.normalizeRelativeFilePath(node.file)))
        .map((node): ChangedCodeDebugSymbol => {
            const symbolLabel = input.normalizeSearchSymbolLabel(node.symbolLabel);
            return {
                file: input.normalizeRelativeFilePath(node.file),
                symbolId: String(node.symbolId),
                ...(symbolLabel ? { symbolLabel } : {}),
                span: {
                    startLine: Number.isFinite(node.span?.startLine) ? Number(node.span.startLine) : 1,
                    endLine: Number.isFinite(node.span?.endLine) ? Number(node.span.endLine) : (Number.isFinite(node.span?.startLine) ? Number(node.span.startLine) : 1),
                },
            };
        })
        .sort((a, b) => {
            const fileCmp = input.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = input.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = input.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return input.compareNullableStringsAsc(a.symbolId, b.symbolId);
        });

    const changedSymbolIds = new Set(changedSymbols.map((symbol) => symbol.symbolId));
    const directCallers = input.sidecar.edges
        .filter((edge) => edge && changedSymbolIds.has(edge.dstSymbolId))
        .map((edge): ChangedCodeDebugDirectCaller | null => {
            const caller = nodeById.get(edge.srcSymbolId);
            if (!caller) {
                return null;
            }
            const startLine = Number.isFinite(caller.span?.startLine) ? Number(caller.span.startLine) : 1;
            const endLine = Number.isFinite(caller.span?.endLine) ? Number(caller.span.endLine) : startLine;
            const callerSymbolLabel = input.normalizeSearchSymbolLabel(caller.symbolLabel);
            return {
                targetSymbolId: String(edge.dstSymbolId),
                file: input.normalizeRelativeFilePath(caller.file),
                symbolId: String(caller.symbolId),
                ...(callerSymbolLabel ? { symbolLabel: callerSymbolLabel } : {}),
                span: {
                    startLine,
                    endLine,
                },
                site: {
                    file: input.normalizeRelativeFilePath(edge.site?.file || caller.file),
                    startLine: Number.isFinite(edge.site?.startLine) ? Number(edge.site.startLine) : startLine,
                    ...(Number.isFinite(edge.site?.endLine) ? { endLine: Number(edge.site.endLine) } : {}),
                },
                kind: edge.kind === "import" || edge.kind === "dynamic" ? edge.kind : "call",
                confidence: Number.isFinite(edge.confidence) ? Number(edge.confidence) : 0,
            };
        })
        .filter((caller): caller is ChangedCodeDebugDirectCaller => Boolean(caller))
        .sort((a, b) => {
            const targetCmp = input.compareNullableStringsAsc(a.targetSymbolId, b.targetSymbolId);
            if (targetCmp !== 0) return targetCmp;
            const fileCmp = input.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = input.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = input.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            const symbolCmp = input.compareNullableStringsAsc(a.symbolId, b.symbolId);
            if (symbolCmp !== 0) return symbolCmp;
            return input.compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
        });

    const files = changedFiles.slice(0, input.maxFiles);
    const symbols = changedSymbols.slice(0, input.maxSymbols);
    const cappedDirectCallers = directCallers.slice(0, input.maxDirectCallers);

    return {
        files,
        symbols,
        directCallers: cappedDirectCallers,
        totalFiles: changedFiles.length,
        totalSymbols: changedSymbols.length,
        totalDirectCallers: directCallers.length,
        truncated: files.length < changedFiles.length
            || symbols.length < changedSymbols.length
            || cappedDirectCallers.length < directCallers.length,
    };
}

export function buildGeneratedArtifactsVerificationHint(input: {
    codebaseRoot: string;
    results: Array<{ file: string; span: SearchSpan }>;
    sanitizeIndexedRelativeFilePath: (relativeFilePath: string) => string | undefined;
    isGeneratedFile: (relativeFilePath: string) => boolean;
}): NonNullable<NonNullable<SearchResponseEnvelope["hints"]>["verification"]>["generatedArtifacts"] | undefined {
    const byFile = new Map<string, SearchSpan>();

    for (const result of input.results) {
        const normalizedFile = input.sanitizeIndexedRelativeFilePath(result.file);
        if (!normalizedFile) {
            continue;
        }
        if (!input.isGeneratedFile(normalizedFile)) {
            continue;
        }
        const safeStartLine = Number.isFinite(result.span.startLine) ? Math.max(1, Number(result.span.startLine)) : 1;
        const safeEndLine = Number.isFinite(result.span.endLine) ? Math.max(safeStartLine, Number(result.span.endLine)) : safeStartLine;
        const existing = byFile.get(normalizedFile);
        byFile.set(normalizedFile, existing
            ? {
                startLine: Math.min(existing.startLine, safeStartLine),
                endLine: Math.max(existing.endLine, safeEndLine),
            }
            : { startLine: safeStartLine, endLine: safeEndLine });
    }

    const files = Array.from(byFile.keys()).sort((a, b) => a.localeCompare(b)).slice(0, 5);
    if (files.length === 0) {
        return undefined;
    }

    return {
        reason: "generated_outputs_present",
        message: "Generated or build output appeared in search context. Source matches do not prove generated output is current; verify the artifact directly when behavior depends on it.",
        files,
        nextSteps: files.map((file) => {
            const span = byFile.get(file)!;
            return {
                tool: "read_file",
                args: {
                    path: path.resolve(input.codebaseRoot, file),
                    start_line: span.startLine,
                    end_line: span.endLine,
                },
            };
        }),
    };
}
