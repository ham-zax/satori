import * as fs from "fs";
import * as path from "path";
import type { RelationshipRecord, SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import type { CallGraphEdge, CallGraphNote } from "./call-graph.js";

const PYTHON_DIRECT_CALL_CONTROL_KEYWORDS = new Set(["if", "for", "while", "return", "class", "def"]);
const PYTHON_BUILTIN_CALL_NAMES = new Set([
    "__import__", "abs", "all", "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes",
    "callable", "chr", "classmethod", "compile", "complex", "delattr", "dict", "dir", "divmod",
    "enumerate", "eval", "exec", "filter", "float", "format", "frozenset", "getattr", "globals",
    "hasattr", "hash", "help", "hex", "id", "input", "int", "isinstance", "issubclass", "iter",
    "len", "list", "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open",
    "ord", "pow", "print", "property", "range", "repr", "reversed", "round", "set", "setattr",
    "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip",
]);

export type PythonSourceBackedSpanRepair = {
    symbol: SymbolRecord;
    attempted: boolean;
    validated: boolean;
    repaired: boolean;
    startBeforeDefinition: boolean;
    endTruncated: boolean;
};

export type SourceBackedPythonCallFallback = {
    edges: CallGraphEdge[];
    symbols: SymbolRecord[];
    notes: CallGraphNote[];
};

type ReadSafeCodebaseFileLines = (codebaseRoot: string, relativeFilePath: string) => string[] | undefined;
type SortCallGraphEdges = (edges: CallGraphEdge[]) => CallGraphEdge[];
type SortCallGraphNotes = (notes: CallGraphNote[]) => CallGraphNote[];

function extractDirectCallNamesFromLine(line: string, options: {
    includeAttributeCalls?: boolean;
    ignoredNames?: ReadonlySet<string>;
} = {}): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const includeAttributeCalls = options.includeAttributeCalls ?? true;
    const directCallRegex = /\b([A-Za-z_][\w]*)\s*\(/g;
    for (const match of line.matchAll(directCallRegex)) {
        const name = match[1] || "";
        const key = name.toLowerCase();
        const prefix = line.slice(0, match.index).trimEnd();
        if (
            !name
            || PYTHON_DIRECT_CALL_CONTROL_KEYWORDS.has(key)
            || options.ignoredNames?.has(key)
            || (!includeAttributeCalls && prefix.endsWith("."))
            || seen.has(key)
        ) {
            continue;
        }
        seen.add(key);
        names.push(name);
    }
    return names;
}

function resolveUnambiguousDirectCallTarget(
    source: SymbolRecord,
    candidates: SymbolRecord[],
    options: {
        allowCrossFileCandidate?: boolean;
    } = {}
): SymbolRecord | undefined {
    const nonSelfCandidates = candidates.filter((candidate) => candidate.symbolInstanceId !== source.symbolInstanceId);
    const sameFileCandidates = nonSelfCandidates.filter((candidate) => candidate.file === source.file);
    if (sameFileCandidates.length === 1) {
        return sameFileCandidates[0];
    }
    if (sameFileCandidates.length > 1) {
        return undefined;
    }
    if (options.allowCrossFileCandidate === false) {
        return undefined;
    }
    return nonSelfCandidates.length === 1 ? nonSelfCandidates[0] : undefined;
}

function buildDirectCallTargetIndex(registry: SymbolRegistry): Map<string, SymbolRecord[]> {
    const targetsByName = new Map<string, SymbolRecord[]>();
    for (const symbol of registry.symbols.filter((candidate) => candidate.kind !== "file")) {
        const key = symbol.name.toLowerCase();
        targetsByName.set(key, [...(targetsByName.get(key) || []), symbol]);
    }
    return targetsByName;
}

const readSafeCodebaseFileLines: ReadSafeCodebaseFileLines = (codebaseRoot, relativeFilePath) => {
    const absoluteFile = path.resolve(codebaseRoot, relativeFilePath);
    const relativeToRoot = path.relative(codebaseRoot, absoluteFile);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) || !fs.existsSync(absoluteFile)) {
        return undefined;
    }
    return fs.readFileSync(absoluteFile, "utf8").split(/\r?\n/);
};

function countPythonIndent(line: string): number {
    let indent = 0;
    for (const char of line) {
        if (char === " ") {
            indent += 1;
        } else if (char === "\t") {
            indent += 4;
        } else {
            break;
        }
    }
    return indent;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPythonHeaderTerminated(trimmedLine: string): boolean {
    return /:\s*(?:#.*)?$/.test(trimmedLine);
}

function findPythonDefinitionIndexByName(
    lines: string[],
    symbolName: string,
    startIndex: number,
    endExclusive: number,
): number | undefined {
    const matcher = new RegExp(`^(?:async\\s+def|def)\\s+${escapeRegExp(symbolName)}\\b`);
    for (let index = Math.max(0, startIndex); index < Math.min(lines.length, endExclusive); index += 1) {
        if (matcher.test((lines[index] || "").trim())) {
            return index;
        }
    }
    return undefined;
}

function findPythonDefinitionIndexNearSpan(lines: string[], symbol: SymbolRecord): number | undefined {
    const startIndex = Math.max(0, symbol.span.startLine - 1);
    const spanEndExclusive = Math.min(lines.length, Math.max(startIndex + 1, symbol.span.endLine));
    const inSpan = findPythonDefinitionIndexByName(lines, symbol.name, startIndex, spanEndExclusive);
    if (inSpan !== undefined) {
        return inSpan;
    }
    const windowStart = Math.max(0, startIndex - 8);
    const windowEnd = Math.min(lines.length, Math.max(spanEndExclusive, startIndex + 48));
    return findPythonDefinitionIndexByName(lines, symbol.name, windowStart, windowEnd);
}

function findPythonDecoratedDefinitionStart(lines: string[], definitionIndex: number): number {
    const indent = countPythonIndent(lines[definitionIndex] || "");
    let startIndex = definitionIndex;
    for (let index = definitionIndex - 1; index >= 0; index -= 1) {
        const line = lines[index] || "";
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            break;
        }
        if (!trimmed.startsWith("@") || countPythonIndent(line) !== indent) {
            break;
        }
        startIndex = index;
    }
    return startIndex;
}

function findPythonSourceBackedBlockEnd(lines: string[], definitionIndex: number, indent: number): number | undefined {
    let lastContentLine = definitionIndex + 1;
    let headerComplete = isPythonHeaderTerminated((lines[definitionIndex] || "").trim());
    for (let index = definitionIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] || "";
        const trimmed = line.trim();
        if (!headerComplete) {
            lastContentLine = index + 1;
            if (isPythonHeaderTerminated(trimmed)) {
                headerComplete = true;
            }
            continue;
        }
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }
        if (countPythonIndent(line) <= indent) {
            return lastContentLine;
        }
        lastContentLine = index + 1;
    }
    return headerComplete ? lastContentLine : undefined;
}

export function repairSourceBackedPythonSpan(input: {
    codebaseRoot: string;
    symbol: SymbolRecord;
    sourceLines?: string[];
}): PythonSourceBackedSpanRepair {
    const symbol = input.symbol;
    if (symbol.language !== "python" || (symbol.kind !== "function" && symbol.kind !== "method")) {
        return {
            symbol,
            attempted: false,
            validated: false,
            repaired: false,
            startBeforeDefinition: false,
            endTruncated: false,
        };
    }
    const absoluteFile = path.resolve(input.codebaseRoot, symbol.file);
    const relativeToRoot = path.relative(input.codebaseRoot, absoluteFile);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) || !fs.existsSync(absoluteFile)) {
        return {
            symbol,
            attempted: false,
            validated: false,
            repaired: false,
            startBeforeDefinition: false,
            endTruncated: false,
        };
    }
    const lines = input.sourceLines || fs.readFileSync(absoluteFile, "utf8").split(/\r?\n/);
    const definitionIndex = findPythonDefinitionIndexNearSpan(lines, symbol);
    if (definitionIndex === undefined) {
        return {
            symbol,
            attempted: true,
            validated: false,
            repaired: false,
            startBeforeDefinition: false,
            endTruncated: false,
        };
    }
    const definitionLine = lines[definitionIndex] || "";
    const repairedStartIndex = findPythonDecoratedDefinitionStart(lines, definitionIndex);
    const repairedEndLine = findPythonSourceBackedBlockEnd(lines, definitionIndex, countPythonIndent(definitionLine));
    if (!repairedEndLine) {
        return {
            symbol,
            attempted: true,
            validated: false,
            repaired: false,
            startBeforeDefinition: false,
            endTruncated: false,
        };
    }
    const repairedStartLine = repairedStartIndex + 1;
    const startBeforeDefinition = symbol.span.startLine < repairedStartLine;
    const endTruncated = symbol.span.endLine < repairedEndLine;
    const repaired = repairedStartLine !== symbol.span.startLine || repairedEndLine !== symbol.span.endLine;
    return {
        symbol: repaired
            ? {
                ...symbol,
                span: {
                    ...symbol.span,
                    startLine: repairedStartLine,
                    endLine: repairedEndLine,
                },
            }
            : symbol,
        attempted: true,
        validated: true,
        repaired,
        startBeforeDefinition,
        endTruncated,
    };
}

export function repairSourceBackedPythonSpans(input: {
    codebaseRoot: string;
    symbols: SymbolRecord[];
}): PythonSourceBackedSpanRepair[] {
    const linesByFile = new Map<string, string[] | undefined>();
    return input.symbols.map((symbol) => {
        if (symbol.language !== "python" || (symbol.kind !== "function" && symbol.kind !== "method")) {
            return {
                symbol,
                attempted: false,
                validated: false,
                repaired: false,
                startBeforeDefinition: false,
                endTruncated: false,
            };
        }
        if (!linesByFile.has(symbol.file)) {
            linesByFile.set(symbol.file, readSafeCodebaseFileLines(input.codebaseRoot, symbol.file));
        }
        return repairSourceBackedPythonSpan({
            codebaseRoot: input.codebaseRoot,
            symbol,
            sourceLines: linesByFile.get(symbol.file),
        });
    });
}

export function buildSourceBackedPythonCalleeFallback(input: {
    codebaseRoot: string;
    registry: SymbolRegistry;
    source: SymbolRecord;
    sortEdges: SortCallGraphEdges;
}): SourceBackedPythonCallFallback {
    const source = input.source;
    if (source.language !== "python" || (source.kind !== "function" && source.kind !== "method")) {
        return { edges: [], symbols: [], notes: [] };
    }
    const lines = readSafeCodebaseFileLines(input.codebaseRoot, source.file);
    if (!lines) {
        return { edges: [], symbols: [], notes: [] };
    }
    const targetsByName = buildDirectCallTargetIndex(input.registry);
    const edgesByKey = new Map<string, CallGraphEdge>();
    const targetSymbolsById = new Map<string, SymbolRecord>();
    const maxLine = Math.min(source.span.endLine, lines.length);
    for (let lineNo = source.span.startLine; lineNo <= maxLine; lineNo += 1) {
        const line = (lines[lineNo - 1] || "").replace(/#.*$/, "");
        if (line.trim().length === 0 || /^\s*(?:async\s+def|def|class)\s+/.test(line)) {
            continue;
        }
        for (const callName of extractDirectCallNamesFromLine(line, {
            includeAttributeCalls: false,
            ignoredNames: PYTHON_BUILTIN_CALL_NAMES,
        })) {
            const target = resolveUnambiguousDirectCallTarget(
                source,
                targetsByName.get(callName.toLowerCase()) || [],
                { allowCrossFileCandidate: false }
            );
            if (!target) {
                continue;
            }
            const edge: CallGraphEdge = {
                srcSymbolId: source.symbolInstanceId,
                dstSymbolId: target.symbolInstanceId,
                kind: "dynamic",
                site: {
                    file: source.file,
                    startLine: lineNo,
                    endLine: lineNo,
                },
                confidence: 0.65,
            };
            edgesByKey.set(`${edge.srcSymbolId}\0${edge.dstSymbolId}\0${lineNo}`, edge);
            targetSymbolsById.set(target.symbolInstanceId, target);
        }
    }

    const edges = input.sortEdges([...edgesByKey.values()]);
    const notes = edges.length > 0
        ? [{
            type: "dynamic_edge" as const,
            file: source.file,
            startLine: source.span.startLine,
            symbolId: source.symbolInstanceId,
            detail: "Source-backed direct callee fallback synthesized edges because the relationship sidecar was built from a truncated Python span.",
        }]
        : [];
    return {
        edges,
        symbols: [...targetSymbolsById.values()],
        notes,
    };
}

export function buildSourceBackedPythonCallerFallback(input: {
    codebaseRoot: string;
    registry: SymbolRegistry;
    resolvedTarget: SymbolRecord;
    suppressedRecords: RelationshipRecord[];
    sortEdges: SortCallGraphEdges;
    sortNotes: SortCallGraphNotes;
}): SourceBackedPythonCallFallback {
    const target = input.resolvedTarget;
    if (target.language !== "python" || (target.kind !== "function" && target.kind !== "method")) {
        return { edges: [], symbols: [], notes: [] };
    }

    const targetsByName = buildDirectCallTargetIndex(input.registry);
    const sourceRepairsById = new Map<string, PythonSourceBackedSpanRepair>();
    const linesByFile = new Map<string, string[] | undefined>();
    const edgesByKey = new Map<string, CallGraphEdge>();
    const sourceSymbolsById = new Map<string, SymbolRecord>();

    for (const record of input.suppressedRecords) {
        if (record.targetInstanceId !== target.symbolInstanceId || !record.sourceInstanceId || !Number.isFinite(record.span?.startLine)) {
            continue;
        }

        const source = input.registry.symbolsByInstanceId.get(record.sourceInstanceId);
        if (!source || source.language !== "python" || (source.kind !== "function" && source.kind !== "method")) {
            continue;
        }

        let sourceRepair = sourceRepairsById.get(source.symbolInstanceId);
        if (!sourceRepair) {
            let sourceLines = linesByFile.get(source.file);
            if (sourceLines === undefined) {
                sourceLines = readSafeCodebaseFileLines(input.codebaseRoot, source.file);
                linesByFile.set(source.file, sourceLines);
            }
            sourceRepair = repairSourceBackedPythonSpan({
                codebaseRoot: input.codebaseRoot,
                symbol: source,
                sourceLines,
            });
            sourceRepairsById.set(source.symbolInstanceId, sourceRepair);
        }
        if (!sourceRepair.validated) {
            continue;
        }

        const repairedSource = sourceRepair.symbol;
        const siteStartLine = Number(record.span?.startLine);
        const siteEndLine = Number.isFinite(record.span?.endLine) ? Number(record.span?.endLine) : siteStartLine;
        if (
            record.file !== repairedSource.file
            || siteStartLine < repairedSource.span.startLine
            || siteEndLine > repairedSource.span.endLine
        ) {
            continue;
        }

        let sourceLines = linesByFile.get(repairedSource.file);
        if (sourceLines === undefined) {
            sourceLines = readSafeCodebaseFileLines(input.codebaseRoot, repairedSource.file);
            linesByFile.set(repairedSource.file, sourceLines);
        }
        const siteLine = sourceLines?.[siteStartLine - 1];
        if (typeof siteLine !== "string") {
            continue;
        }

        const verifiedTarget = extractDirectCallNamesFromLine(siteLine.replace(/#.*$/, ""), {
            ignoredNames: PYTHON_BUILTIN_CALL_NAMES,
        })
            .map((callName) => resolveUnambiguousDirectCallTarget(
                repairedSource,
                targetsByName.get(callName.toLowerCase()) || []
            ))
            .find((candidate) => candidate?.symbolInstanceId === target.symbolInstanceId);
        if (!verifiedTarget) {
            continue;
        }

        const edge: CallGraphEdge = {
            srcSymbolId: repairedSource.symbolInstanceId,
            dstSymbolId: target.symbolInstanceId,
            kind: "dynamic",
            site: {
                file: record.file,
                startLine: siteStartLine,
                ...(Number.isFinite(record.span?.endLine) ? { endLine: Number(record.span?.endLine) } : {}),
            },
            confidence: 0.65,
        };
        edgesByKey.set(`${edge.srcSymbolId}\0${edge.dstSymbolId}\0${edge.site.file}\0${edge.site.startLine}`, edge);
        sourceSymbolsById.set(repairedSource.symbolInstanceId, repairedSource);
    }

    const edges = input.sortEdges([...edgesByKey.values()]);
    const notes = [...sourceSymbolsById.values()].map((source) => ({
        type: "dynamic_edge" as const,
        file: source.file,
        startLine: source.span.startLine,
        symbolId: source.symbolInstanceId,
        detail: "Source-backed direct caller fallback synthesized edges because the relationship sidecar suppressed a usable Python caller edge.",
    }));
    return {
        edges,
        symbols: [...sourceSymbolsById.values()],
        notes: input.sortNotes(notes),
    };
}
