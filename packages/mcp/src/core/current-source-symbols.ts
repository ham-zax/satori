import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    AstCodeSplitter,
    buildSymbolRecordsForFile,
    normalizeLanguageId,
    openRegularFileInsideRoot,
    type SymbolRecord,
} from "@zokizuan/satori-core";
import type { PythonSourceBackedSpanRepair } from "./python-call-fallback.js";

const CURRENT_SOURCE_LANGUAGES = new Set(["typescript", "javascript", "python"]);

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
        return await handle.readFile("utf8");
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

/**
 * Rebuild exact-navigation identities from the current file using the same
 * splitter and registry builder as indexing. Persisted IDs remain handles;
 * only source-proven spans are substituted.
 */
export async function validateCurrentSourceSymbolSpans(input: {
    codebaseRoot: string;
    symbols: SymbolRecord[];
}): Promise<CurrentSourceSymbolValidation[]> {
    if (input.symbols.length === 0) {
        return [];
    }

    const language = normalizeLanguageId(input.symbols[0].language);
    if (!CURRENT_SOURCE_LANGUAGES.has(language)) {
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
        const splitter = new AstCodeSplitter(Number.MAX_SAFE_INTEGER);
        splitter.setChunkOverlap(0);
        const chunks = await splitter.split(source, language, relativeFile);
        const fileHash = crypto.createHash("sha256").update(source, "utf8").digest("hex");
        const extractorVersion = input.symbols[0].extractorVersion;
        const currentByIdentityAndSpan = new Map<string, SymbolRecord>();
        const currentFileOwner = buildSymbolRecordsForFile({
            relativePath: relativeFile,
            language,
            content: source,
            fileHash,
            extractorVersion,
            chunks: [],
        })[0];
        if (currentFileOwner) {
            currentByIdentityAndSpan.set(
                `${currentFileOwner.symbolKey}\0${currentFileOwner.span.startLine}\0${currentFileOwner.span.endLine}`,
                currentFileOwner,
            );
        }
        for (const chunk of chunks) {
            const chunkSymbols = buildSymbolRecordsForFile({
                relativePath: relativeFile,
                language,
                content: source,
                fileHash,
                extractorVersion,
                chunks: [chunk],
            });
            for (const current of chunkSymbols.filter((symbol) => symbol.kind !== "file")) {
                const spanKey = `${current.symbolKey}\0${current.span.startLine}\0${current.span.endLine}`;
                const existing = currentByIdentityAndSpan.get(spanKey);
                if (!existing) {
                    currentByIdentityAndSpan.set(spanKey, current);
                    continue;
                }
                currentByIdentityAndSpan.set(spanKey, {
                    ...existing,
                    span: {
                        ...existing.span,
                        startByte: minOptional(existing.span.startByte, current.span.startByte),
                        endByte: maxOptional(existing.span.endByte, current.span.endByte),
                        startColumn: minOptional(existing.span.startColumn, current.span.startColumn),
                        endColumn: maxOptional(existing.span.endColumn, current.span.endColumn),
                    },
                });
            }
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
            const sortedPersisted = [...persisted].sort((a, b) => a.span.startLine - b.span.startLine || a.span.endLine - b.span.endLine);
            const sortedCurrent = [...current].sort((a, b) => a.span.startLine - b.span.startLine || a.span.endLine - b.span.endLine);
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
