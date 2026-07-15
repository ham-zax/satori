import * as path from "node:path";
import {
    buildSymbolRecordsForFile,
    createLanguageAnalysisService,
    normalizeLanguageId,
    recordSourceProcessing,
    type SymbolRecord,
    type LanguageAnalysisPort,
    type SourceMeasurementObservation,
    type SourceProcessingOutcome,
} from "@zokizuan/satori-core";
import { prepareInspectableSource } from "./inspectable-source.js";
import type { PythonSourceBackedSpanRepair } from "./python-call-fallback.js";

const CURRENT_SOURCE_MAX_BYTES = 256 * 1024;

export const CURRENT_SOURCE_SPAN_RESOLUTION_POLICY_VERSION = "current_source_span_resolution_v1" as const;

export type CurrentSourceSpanResolutionEvidence = {
    resolutionDerivation: "exact_registry_rebuild_match";
    currentSpanIdentity: {
        kind: "resolved_symbol_instance";
        symbolInstanceId: string;
    };
    spanResolutionPolicyVersion: typeof CURRENT_SOURCE_SPAN_RESOLUTION_POLICY_VERSION;
    extractorLanguageImplementationVersion: string;
} | {
    resolutionDerivation: "language_structural_reresolution";
    currentSpanIdentity: {
        kind: "canonical_structural_identity";
        language: string;
        qualifiedName: string;
        kindName: string;
        parentPath: string[];
    };
    spanResolutionPolicyVersion: string;
    extractorLanguageImplementationVersion: string;
};

export type CurrentSourceSymbolValidation = PythonSourceBackedSpanRepair & ({
    match: "matched";
    validated: true;
    resolutionEvidence: CurrentSourceSpanResolutionEvidence;
} | {
    match: "missing" | "ambiguous" | "unavailable" | "not_applicable";
    validated: false;
    resolutionEvidence?: never;
});

export type CurrentSourceEvidence = {
    canonicalRoot: string;
    relativeFile: string;
    sourceBytes: Uint8Array;
    source: string;
    observedHash: string;
    measurementObservation?: SourceMeasurementObservation;
};

export async function readCurrentSourceEvidence(
    codebaseRoot: string,
    relativeFile: string,
): Promise<CurrentSourceEvidence | undefined> {
    const prepared = await prepareInspectableSource({
        codebaseRoot,
        relativeFile,
        maxInspectableBytes: CURRENT_SOURCE_MAX_BYTES,
    });
    if (prepared.status !== "available") {
        return undefined;
    }
    try {
        const finalized = await prepared.finalizer.finalize();
        if (finalized.status !== "available") return undefined;
        return {
            canonicalRoot: prepared.evidence.canonicalRoot,
            relativeFile: prepared.evidence.relativeFile,
            sourceBytes: prepared.evidence.sourceBytes,
            source: prepared.evidence.source,
            observedHash: prepared.evidence.observedHash,
            ...(prepared.evidence.measurementObservation
                ? { measurementObservation: prepared.evidence.measurementObservation }
                : {}),
        };
    } finally {
        await prepared.finalizer.release();
    }
}

/**
 * Read only the current source owned by one persisted symbol. The descriptor-bound
 * read and full-file digest prevent registry metadata from being presented as
 * current source after the file changes.
 */
export async function readHashMatchedCurrentSourceSymbolContent(input: {
    codebaseRoot: string;
    symbol: SymbolRecord;
}): Promise<string | undefined> {
    const expectedHash = input.symbol.fileHash;
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        return undefined;
    }
    const evidence = await readCurrentSourceEvidence(input.codebaseRoot, input.symbol.file);
    if (!evidence) {
        return undefined;
    }
    return sliceHashMatchedCurrentSourceSymbolContent(evidence, evidence.canonicalRoot, input.symbol);
}

export function sliceHashMatchedCurrentSourceSymbolContent(
    evidence: CurrentSourceEvidence,
    expectedCanonicalRoot: string,
    symbol: SymbolRecord,
): string | undefined {
    if (
        path.resolve(evidence.canonicalRoot) !== path.resolve(expectedCanonicalRoot)
        || evidence.relativeFile !== symbol.file
        || evidence.observedHash !== symbol.fileHash
    ) {
        return undefined;
    }

    const { startLine, endLine } = symbol.span;
    if (
        !Number.isSafeInteger(startLine)
        || !Number.isSafeInteger(endLine)
        || startLine < 1
        || endLine < startLine
    ) {
        return undefined;
    }
    const selectorStartedAt = performance.now();
    let selectorOutcome: SourceProcessingOutcome = "failed";
    try {
        const lines = evidence.source.split(/\r\n?|\n/);
        if (startLine > lines.length || endLine > lines.length) {
            selectorOutcome = "rejected";
            return undefined;
        }
        const content = lines.slice(startLine - 1, endLine).join("\n");
        selectorOutcome = content.length > 0 ? "success" : "rejected";
        return content.length > 0 ? content : undefined;
    } finally {
        recordSourceProcessing({
            observation: evidence.measurementObservation,
            owner: "selector",
            inputBytesProcessed: Buffer.byteLength(evidence.source, "utf8"),
            basis: "shared_buffer",
            outcome: selectorOutcome,
            durationMs: performance.now() - selectorStartedAt,
        });
    }
}

function unchangedValidation(
    symbol: SymbolRecord,
    match: Exclude<CurrentSourceSymbolValidation["match"], "matched">,
): CurrentSourceSymbolValidation {
    return {
        symbol,
        attempted: match !== "not_applicable",
        validated: false,
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
    return (await validateCurrentSourceSymbolSpansWithEvidence(input)).validations;
}

export async function validateCurrentSourceSymbolSpansWithEvidence(input: {
    codebaseRoot: string;
    symbols: SymbolRecord[];
    languageAnalyzer?: LanguageAnalysisPort;
}): Promise<{ validations: CurrentSourceSymbolValidation[]; evidence?: CurrentSourceEvidence }> {
    if (input.symbols.length === 0) {
        return { validations: [] };
    }

    const language = normalizeLanguageId(input.symbols[0].language);
    const languageAnalyzer = input.languageAnalyzer ?? createLanguageAnalysisService({
        chunkSize: CURRENT_SOURCE_MAX_BYTES,
        chunkOverlap: 0,
    });
    if (!languageAnalyzer.getStrategyForLanguage(language).structural) {
        return { validations: input.symbols.map((symbol) => unchangedValidation(symbol, "not_applicable")) };
    }

    const relativeFile = input.symbols[0].file;
    if (input.symbols.some((symbol) => symbol.file !== relativeFile || normalizeLanguageId(symbol.language) !== language)) {
        return { validations: input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable")) };
    }

    const evidence = await readCurrentSourceEvidence(input.codebaseRoot, relativeFile);
    if (!evidence) {
        return { validations: input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable")) };
    }
    return validateCurrentSourceSymbolSpansFromEvidence({
        symbols: input.symbols,
        evidence,
        languageAnalyzer,
    });
}

/**
 * Re-resolve persisted symbols against bytes already acquired by the canonical
 * root-bound source owner. Callers must not reopen the path for this work.
 */
export async function validateCurrentSourceSymbolSpansFromEvidence(input: {
    symbols: SymbolRecord[];
    evidence: CurrentSourceEvidence;
    languageAnalyzer?: LanguageAnalysisPort;
}): Promise<{ validations: CurrentSourceSymbolValidation[]; evidence: CurrentSourceEvidence }> {
    if (input.symbols.length === 0) {
        return { validations: [], evidence: input.evidence };
    }

    const language = normalizeLanguageId(input.symbols[0].language);
    const languageAnalyzer = input.languageAnalyzer ?? createLanguageAnalysisService({
        chunkSize: Math.max(CURRENT_SOURCE_MAX_BYTES, input.evidence.sourceBytes.byteLength),
        chunkOverlap: 0,
    });
    if (!languageAnalyzer.getStrategyForLanguage(language).structural) {
        return {
            validations: input.symbols.map((symbol) => unchangedValidation(symbol, "not_applicable")),
            evidence: input.evidence,
        };
    }

    const relativeFile = input.symbols[0].file;
    if (
        input.evidence.relativeFile !== relativeFile
        || input.symbols.some((symbol) => (
            symbol.file !== relativeFile || normalizeLanguageId(symbol.language) !== language
        ))
    ) {
        return {
            validations: input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable")),
            evidence: input.evidence,
        };
    }

    const evidence = input.evidence;
    const source = evidence.source;

    try {
        const parserStartedAt = performance.now();
        let parserOutcome: SourceProcessingOutcome = "failed";
        let analysis: Awaited<ReturnType<LanguageAnalysisPort["analyze"]>>;
        try {
            analysis = await languageAnalyzer.analyze({ content: source, language, relativePath: relativeFile });
            parserOutcome = "success";
        } finally {
            recordSourceProcessing({
                observation: evidence.measurementObservation,
                owner: "parser",
                inputBytesProcessed: Buffer.byteLength(source, "utf8"),
                basis: "parser_input",
                outcome: parserOutcome,
                durationMs: performance.now() - parserStartedAt,
            });
        }
        if (analysis.structuralStatus !== "complete") {
            return { validations: input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable")), evidence };
        }
        const fileHash = evidence.observedHash;
        const extractorVersion = input.symbols[0].extractorVersion;
        const extractorStartedAt = performance.now();
        const currentByIdentityAndSpan = new Map<string, SymbolRecord>();
        let extractorOutcome: SourceProcessingOutcome = "failed";
        let currentRecords: SymbolRecord[];
        try {
            currentRecords = buildSymbolRecordsForFile({
                relativePath: relativeFile,
                language,
                content: source,
                fileHash,
                extractorVersion,
                chunks: [...analysis.chunks],
                extractedSymbols: analysis.symbols,
            });
            extractorOutcome = "success";
        } finally {
            recordSourceProcessing({
                observation: evidence.measurementObservation,
                owner: "extractor",
                inputBytesProcessed: Buffer.byteLength(source, "utf8"),
                basis: "extractor_input",
                outcome: extractorOutcome,
                durationMs: performance.now() - extractorStartedAt,
            });
        }
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

        const validations: CurrentSourceSymbolValidation[] = input.symbols.map((symbol): CurrentSourceSymbolValidation => {
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
                resolutionEvidence: {
                    resolutionDerivation: "exact_registry_rebuild_match",
                    currentSpanIdentity: {
                        kind: "resolved_symbol_instance",
                        symbolInstanceId: symbol.symbolInstanceId,
                    },
                    spanResolutionPolicyVersion: CURRENT_SOURCE_SPAN_RESOLUTION_POLICY_VERSION,
                    extractorLanguageImplementationVersion: extractorVersion,
                },
            };
        });
        return { validations, evidence };
    } catch {
        return { validations: input.symbols.map((symbol) => unchangedValidation(symbol, "unavailable")), evidence };
    }
}
