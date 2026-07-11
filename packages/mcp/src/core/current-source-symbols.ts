import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    buildSymbolRecordsForFile,
    createLanguageAnalysisService,
    normalizeLanguageId,
    openRegularFileInsideRoot,
    type SymbolRecord,
    type LanguageAnalysisPort,
} from "@zokizuan/satori-core";
import type { PythonSourceBackedSpanRepair } from "./python-call-fallback.js";

const CURRENT_SOURCE_MAX_BYTES = 256 * 1024;

export type CurrentSourceSymbolValidation = PythonSourceBackedSpanRepair & {
    match: "matched" | "missing" | "ambiguous" | "unavailable" | "not_applicable";
};

function isInsideRoot(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readCurrentSource(codebaseRoot: string, relativeFile: string): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof openRegularFileInsideRoot>> | undefined;
    try {
        const canonicalRoot = await fs.realpath(codebaseRoot);
        const logicalFile = path.resolve(canonicalRoot, relativeFile);
        if (!isInsideRoot(logicalFile, canonicalRoot)) {
            return undefined;
        }
        handle = await openRegularFileInsideRoot(logicalFile, canonicalRoot);
        const stat = await handle.stat();
        if (stat.size > CURRENT_SOURCE_MAX_BYTES) {
            return undefined;
        }
        const buffer = Buffer.allocUnsafe(CURRENT_SOURCE_MAX_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > CURRENT_SOURCE_MAX_BYTES) {
            return undefined;
        }
        return buffer.subarray(0, offset).toString("utf8");
    } catch {
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function unchangedValidation(symbol: SymbolRecord, match: CurrentSourceSymbolValidation["match"]): CurrentSourceSymbolValidation {
    return {
        symbol,
        attempted: match !== "not_applicable",
        validated: match === "matched",
        repaired: false,
        startBeforeDefinition: false,
        endTruncated: false,
        match,
    };
}

function currentDeclarationKey(symbol: SymbolRecord): string {
    const span = symbol.span;
    if (span.endByte !== undefined) {
        // Export/decorator wrapper nodes and their declaration node share the
        // same end boundary. Distinct same-line declarations do not.
        return `${symbol.symbolKey}\0endByte:${span.endByte}`;
    }
    return [
        symbol.symbolKey,
        span.endLine,
        span.endColumn ?? "",
    ].join("\0");
}

function minOptional(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.min(left, right);
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.max(left, right);
}

function compareOptionalPosition(left: number | undefined, right: number | undefined): number {
    if (left === right) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
}

function compareSourcePosition(left: SymbolRecord, right: SymbolRecord): number {
    return left.span.startLine - right.span.startLine
        || compareOptionalPosition(left.span.startByte, right.span.startByte)
        || compareOptionalPosition(left.span.startColumn, right.span.startColumn)
        || left.span.endLine - right.span.endLine
        || compareOptionalPosition(left.span.endByte, right.span.endByte)
        || compareOptionalPosition(left.span.endColumn, right.span.endColumn);
}

function hasDistinctSourcePositions(symbols: readonly SymbolRecord[]): boolean {
    return symbols.every((symbol, index) => index === 0 || compareSourcePosition(symbols[index - 1], symbol) !== 0);
}

/**
 * Rebuild exact-navigation identities from the current file using the same
 * language analyzer and registry builder as indexing. Persisted IDs remain handles;
 * only source-proven spans are substituted.
 */
export async function validateCurrentSourceSymbolSpans(input: {
    codebaseRoot: string;
    symbols: SymbolRecord[];
    languageAnalyzer?: LanguageAnalysisPort;
}): Promise<CurrentSourceSymbolValidation[]> {
    if (input.symbols.length === 0) {
        return [];
    }

    const language = normalizeLanguageId(input.symbols[0].language);
    const languageAnalyzer = input.languageAnalyzer ?? createLanguageAnalysisService({
        chunkSize: CURRENT_SOURCE_MAX_BYTES,
        chunkOverlap: 0,
    });
    if (!languageAnalyzer.getStrategyForLanguage(language).structural) {
        return input.symbols.map((symbol) => unchangedValidation(symbol, "not_applicable"));
    }

    const relativeFile = input.symbols[0].file;
    if (input.symbols.some((symbol) => symbol.file !== relativeFile || normalizeLanguageId(symbol.language) !== language)) {
        return input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable"));
    }

    const source = await readCurrentSource(input.codebaseRoot, relativeFile);
    if (source === undefined) {
        return input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable"));
    }

    try {
        const analysis = await languageAnalyzer.analyze({ content: source, language, relativePath: relativeFile });
        if (analysis.structuralStatus !== "complete") {
            return input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable"));
        }
        const fileHash = crypto.createHash("sha256").update(source, "utf8").digest("hex");
        const extractorVersion = input.symbols[0].extractorVersion;
        const currentByIdentityAndSpan = new Map<string, SymbolRecord>();
        const currentRecords = buildSymbolRecordsForFile({
            relativePath: relativeFile,
            language,
            content: source,
            fileHash,
            extractorVersion,
            chunks: [...analysis.chunks],
            extractedSymbols: analysis.symbols,
        });
        const currentFileOwner = currentRecords.find((symbol) => symbol.kind === "file");
        if (currentFileOwner) {
            currentByIdentityAndSpan.set(
                currentDeclarationKey(currentFileOwner),
                currentFileOwner,
            );
        }
        for (const current of currentRecords.filter((symbol) => symbol.kind !== "file")) {
                const declarationKey = currentDeclarationKey(current);
                const existing = currentByIdentityAndSpan.get(declarationKey);
                if (!existing) {
                    currentByIdentityAndSpan.set(declarationKey, current);
                    continue;
                }
                currentByIdentityAndSpan.set(declarationKey, {
                    ...existing,
                    span: {
                        ...existing.span,
                        startLine: Math.min(existing.span.startLine, current.span.startLine),
                        endLine: Math.max(existing.span.endLine, current.span.endLine),
                        startByte: minOptional(existing.span.startByte, current.span.startByte),
                        endByte: maxOptional(existing.span.endByte, current.span.endByte),
                        startColumn: minOptional(existing.span.startColumn, current.span.startColumn),
                        endColumn: maxOptional(existing.span.endColumn, current.span.endColumn),
                    },
                });
        }
        const currentSymbols = [...currentByIdentityAndSpan.values()];
        const currentByKey = new Map<string, SymbolRecord[]>();
        for (const current of currentSymbols) {
            const matches = currentByKey.get(current.symbolKey) || [];
            matches.push(current);
            currentByKey.set(current.symbolKey, matches);
        }

        const persistedByKey = new Map<string, SymbolRecord[]>();
        for (const symbol of input.symbols) {
            const matches = persistedByKey.get(symbol.symbolKey) || [];
            matches.push(symbol);
            persistedByKey.set(symbol.symbolKey, matches);
        }
        const assignedCurrentByPersistedId = new Map<string, SymbolRecord>();
        for (const [symbolKey, persisted] of persistedByKey) {
            const current = currentByKey.get(symbolKey) || [];
            if (persisted.length !== current.length) {
                continue;
            }
            if (persisted.length > 1 && persisted.some((symbol) => symbol.fileHash !== fileHash)) {
                continue;
            }
            const sortedPersisted = [...persisted].sort(compareSourcePosition);
            const sortedCurrent = [...current].sort(compareSourcePosition);
            if (persisted.length > 1
                && (!hasDistinctSourcePositions(sortedPersisted) || !hasDistinctSourcePositions(sortedCurrent))) {
                continue;
            }
            for (let index = 0; index < sortedPersisted.length; index += 1) {
                assignedCurrentByPersistedId.set(sortedPersisted[index].symbolInstanceId, sortedCurrent[index]);
            }
        }

        return input.symbols.map((symbol) => {
            const matches = currentByKey.get(symbol.symbolKey) || [];
            if (matches.length === 0) {
                return unchangedValidation(symbol, "missing");
            }
            const current = assignedCurrentByPersistedId.get(symbol.symbolInstanceId);
            if (!current) {
                return unchangedValidation(symbol, "ambiguous");
            }
            const repaired = current.span.startLine !== symbol.span.startLine
                || current.span.endLine !== symbol.span.endLine
                || current.span.startByte !== symbol.span.startByte
                || current.span.endByte !== symbol.span.endByte
                || current.span.startColumn !== symbol.span.startColumn
                || current.span.endColumn !== symbol.span.endColumn;
            return {
                symbol: repaired ? { ...symbol, span: current.span } : symbol,
                attempted: true,
                validated: true,
                repaired,
                startBeforeDefinition: symbol.span.startLine < current.span.startLine,
                endTruncated: symbol.span.endLine < current.span.endLine,
                match: "matched",
            };
        });
    } catch {
        return input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable"));
    }
}
