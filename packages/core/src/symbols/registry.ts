import crypto from 'node:crypto';
import path from 'node:path';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    canonicalizeSymbolSpanForHash,
} from './contracts';
import type {
    CodeChunk,
} from '../splitter';
import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import type {
    SymbolKind,
    SymbolRecord,
    SymbolRegistryManifest,
    SymbolSpan,
} from './contracts';

export { SYMBOL_REGISTRY_SCHEMA_VERSION };

export interface SymbolKeyInput {
    relativePath: string;
    language: string;
    kind: SymbolKind;
    qualifiedName: string;
    parentQualifiedNamePath: string[];
}

export interface SymbolInstanceIdInput {
    symbolKey: string;
    fileHash: string;
    span: SymbolSpan;
    extractorVersion: string;
}

export interface SynthesizedFileSymbolInput {
    relativePath: string;
    language: string;
    content: string;
    fileHash: string;
    extractorVersion: string;
}

export interface BuildSymbolRegistryInput {
    manifest: SymbolRegistryManifest;
    symbols: SymbolRecord[];
}

export interface BuildSymbolRecordsForFileInput {
    relativePath: string;
    language: string;
    content: string;
    fileHash: string;
    extractorVersion: string;
    chunks: CodeChunk[];
    extractedSymbols?: readonly ExtractedSymbol[];
}

export interface ResolveOwnerSymbolForChunkInput {
    chunk: CodeChunk;
    symbols: SymbolRecord[];
}

export interface SymbolRegistry {
    manifest: SymbolRegistryManifest;
    symbols: SymbolRecord[];
    symbolsByInstanceId: Map<string, SymbolRecord>;
    symbolsByKey: Map<string, SymbolRecord[]>;
    symbolsByFile: Map<string, SymbolRecord[]>;
    symbolsByLabel: Map<string, SymbolRecord[]>;
    symbolsByQualifiedName: Map<string, SymbolRecord[]>;
    warnings: string[];
}

function sha256Id(prefix: string, value: string): string {
    const digest = crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
    return `${prefix}_${digest}`;
}

function normalizeRelativePath(value: string): string {
    return value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function canonicalStringify(value: unknown): string {
    return JSON.stringify(value);
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function createSymbolKey(input: SymbolKeyInput): string {
    const payload = {
        relativePath: normalizeRelativePath(input.relativePath),
        language: input.language.trim().toLowerCase(),
        kind: input.kind,
        qualifiedName: input.qualifiedName.trim(),
        parentQualifiedNamePath: input.parentQualifiedNamePath.map((item) => item.trim()),
    };
    return sha256Id('symkey', canonicalStringify(payload));
}

export function createSymbolInstanceId(input: SymbolInstanceIdInput): string {
    const payload = {
        symbolKey: input.symbolKey,
        fileHash: input.fileHash,
        span: canonicalizeSymbolSpanForHash(input.span),
        extractorVersion: input.extractorVersion,
    };
    return sha256Id('syminst', canonicalStringify(payload));
}

function countLogicalLines(content: string): number {
    if (content.length === 0) {
        return 1;
    }
    const lines = content.split(/\r\n|\n|\r/);
    return Math.max(1, content.endsWith('\n') || content.endsWith('\r') ? lines.length - 1 : lines.length);
}

export function createSynthesizedFileSymbol(input: SynthesizedFileSymbolInput): SymbolRecord {
    const relativePath = normalizeRelativePath(input.relativePath);
    const fileName = path.posix.basename(relativePath);
    const span: SymbolSpan = {
        startLine: 1,
        endLine: countLogicalLines(input.content),
        startByte: 0,
        endByte: Buffer.byteLength(input.content, 'utf8'),
    };
    const symbolKey = createSymbolKey({
        relativePath,
        language: input.language,
        kind: 'file',
        qualifiedName: relativePath,
        parentQualifiedNamePath: [],
    });

    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: input.extractorVersion,
        }),
        language: input.language,
        kind: 'file',
        name: fileName,
        qualifiedName: relativePath,
        label: relativePath,
        file: relativePath,
        span,
        parentQualifiedNamePath: [],
        fileHash: input.fileHash,
        extractorVersion: input.extractorVersion,
    };
}

interface ParsedSymbolLabel {
    kind: SymbolKind;
    name: string;
}

function parseNameBeforeParameters(value: string): string {
    const beforeParameters = value.split('(')[0]?.trim() || value.trim();
    return beforeParameters.replace(/\s+/g, ' ').trim();
}

function parseTypeLikeName(value: string): string {
    const beforeBaseOrGeneric = value.split(/[<(]/)[0]?.trim() || value.trim();
    return beforeBaseOrGeneric.split(/\s+/)[0]?.trim() || beforeBaseOrGeneric;
}

function parseSymbolLabel(label: string): ParsedSymbolLabel | null {
    const compact = label.replace(/\s+/g, ' ').trim();
    if (!compact) {
        return null;
    }

    const prefixRules: Array<[RegExp, SymbolKind]> = [
        [/^async method\s+(.+)$/, 'method'],
        [/^method\s+(.+)$/, 'method'],
        [/^async function\s+(.+)$/, 'function'],
        [/^function\s+(.+)$/, 'function'],
        [/^class\s+(.+)$/, 'class'],
        [/^interface\s+(.+)$/, 'interface'],
        [/^type\s+(.+)$/, 'type'],
        [/^enum\s+(.+)$/, 'enum'],
        [/^trait\s+(.+)$/, 'trait'],
        [/^module\s+(.+)$/, 'module'],
    ];

    for (const [pattern, kind] of prefixRules) {
        const match = compact.match(pattern);
        if (!match) {
            continue;
        }
        const rawName = kind === 'class' || kind === 'interface' || kind === 'type'
            ? parseTypeLikeName(match[1])
            : parseNameBeforeParameters(match[1]);
        if (rawName.length === 0) {
            return null;
        }
        return { kind, name: rawName };
    }

    return null;
}

function toParentIdentitySegment(label: string): string | null {
    const parsed = parseSymbolLabel(label);
    return parsed ? `${parsed.kind} ${parsed.name}` : null;
}

function buildQualifiedName(name: string, parentQualifiedNamePath: string[]): string {
    const parentNames = parentQualifiedNamePath
        .map((parent) => parseSymbolLabel(parent)?.name)
        .filter((parentName): parentName is string => Boolean(parentName && parentName.length > 0));
    return [...parentNames, name].join('.');
}

function buildLineSpan(startLine: number, endLine: number): SymbolSpan {
    return {
        startLine,
        endLine: Math.max(startLine, endLine),
    };
}

function buildExtractedSymbolSpan(symbol: ExtractedSymbol): SymbolSpan {
    return {
        startLine: symbol.span.startLine,
        endLine: Math.max(symbol.span.startLine, symbol.span.endLine),
        ...(symbol.span.startByte !== undefined ? { startByte: symbol.span.startByte } : {}),
        ...(symbol.span.endByte !== undefined ? { endByte: symbol.span.endByte } : {}),
        ...(symbol.span.startColumn !== undefined ? { startColumn: symbol.span.startColumn } : {}),
        ...(symbol.span.endColumn !== undefined ? { endColumn: symbol.span.endColumn } : {}),
    };
}

function toRegistrySymbolKind(kind: ExtractedSymbolKind): SymbolKind | null {
    const mappings: Record<ExtractedSymbolKind, SymbolKind | null> = {
        file: 'file',
        class: 'class',
        interface: 'interface',
        type: 'type',
        function: 'function',
        method: 'method',
        constructor: 'method',
        struct: 'type',
        enum: 'enum',
        trait: 'trait',
        module: 'module',
        constant: 'property',
        variable: 'property',
    };
    return mappings[kind] ?? null;
}

function normalizeExtractedParentPath(parentQualifiedNamePath: readonly string[] | undefined): string[] {
    return (parentQualifiedNamePath || [])
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter((item) => item.length > 0);
}

function buildRecordForExtractedSymbol(input: {
    symbol: ExtractedSymbol;
    relativePath: string;
    language: string;
    fileHash: string;
    extractorVersion: string;
}): SymbolRecord | null {
    const kind = toRegistrySymbolKind(input.symbol.kind);
    if (!kind || kind === 'file') {
        return null;
    }
    const name = input.symbol.name.trim();
    const label = input.symbol.label.replace(/\s+/g, ' ').trim();
    if (!name || !label) {
        return null;
    }
    const parentQualifiedNamePath = normalizeExtractedParentPath(input.symbol.parentQualifiedNamePath);
    const qualifiedName = (input.symbol.qualifiedName || buildQualifiedName(name, parentQualifiedNamePath)).trim();
    if (!qualifiedName) {
        return null;
    }
    const span = buildExtractedSymbolSpan(input.symbol);
    const symbolKey = createSymbolKey({
        relativePath: input.relativePath,
        language: input.language,
        kind,
        qualifiedName,
        parentQualifiedNamePath,
    });

    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: input.extractorVersion,
        }),
        language: input.language,
        kind,
        name,
        qualifiedName,
        label,
        file: input.relativePath,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: input.extractorVersion,
    };
}

export function buildSymbolRecordsForFile(input: BuildSymbolRecordsForFileInput): SymbolRecord[] {
    const relativePath = normalizeRelativePath(input.relativePath);
    const fileOwner = createSynthesizedFileSymbol({
        relativePath,
        language: input.language,
        content: input.content,
        fileHash: input.fileHash,
        extractorVersion: input.extractorVersion,
    });
    const extracted: SymbolRecord[] = [];
    const seenInstanceIds = new Set<string>();

    for (const symbol of input.extractedSymbols || []) {
        const record = buildRecordForExtractedSymbol({
            symbol,
            relativePath,
            language: input.language,
            fileHash: input.fileHash,
            extractorVersion: input.extractorVersion,
        });
        if (!record || seenInstanceIds.has(record.symbolInstanceId)) {
            continue;
        }
        seenInstanceIds.add(record.symbolInstanceId);
        extracted.push(record);
    }

    if (input.extractedSymbols !== undefined) {
        return [fileOwner, ...extracted.sort(compareSymbols)];
    }

    const chunkRecordsByLogicalIdentity = new Map<string, SymbolRecord>();

    for (const chunk of input.chunks) {
        const label = chunk.metadata.symbolLabel?.trim();
        if (!label) {
            continue;
        }
        const parsed = parseSymbolLabel(label);
        if (!parsed) {
            continue;
        }
        const breadcrumbs = (chunk.metadata.breadcrumbs || [])
            .map((breadcrumb) => breadcrumb.replace(/\s+/g, ' ').trim())
            .filter((breadcrumb) => breadcrumb.length > 0);
        const parentQualifiedNamePath = breadcrumbs.length > 0 && breadcrumbs[breadcrumbs.length - 1] === label
            ? breadcrumbs.slice(0, -1)
            : breadcrumbs;
        let normalizedParentQualifiedNamePath = parentQualifiedNamePath
            .map((breadcrumb) => toParentIdentitySegment(breadcrumb))
            .filter((breadcrumb): breadcrumb is string => Boolean(breadcrumb));
        const selfParentSegment = `${parsed.kind} ${parsed.name}`;
        if (normalizedParentQualifiedNamePath[normalizedParentQualifiedNamePath.length - 1] === selfParentSegment) {
            normalizedParentQualifiedNamePath = normalizedParentQualifiedNamePath.slice(0, -1);
        }
        const qualifiedName = buildQualifiedName(parsed.name, normalizedParentQualifiedNamePath);
        const span = buildLineSpan(chunk.metadata.startLine, chunk.metadata.endLine);
        const symbolKey = createSymbolKey({
            relativePath,
            language: input.language,
            kind: parsed.kind,
            qualifiedName,
            parentQualifiedNamePath: normalizedParentQualifiedNamePath,
        });
        const symbolInstanceId = createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: input.extractorVersion,
        });
        const logicalIdentity = `${symbolKey}\0${label}`;
        const existing = chunkRecordsByLogicalIdentity.get(logicalIdentity);

        if (existing) {
            const mergedSpan = buildLineSpan(
                Math.min(existing.span.startLine, span.startLine),
                Math.max(existing.span.endLine, span.endLine),
            );
            chunkRecordsByLogicalIdentity.set(logicalIdentity, {
                ...existing,
                symbolInstanceId: createSymbolInstanceId({
                    symbolKey,
                    fileHash: input.fileHash,
                    span: mergedSpan,
                    extractorVersion: input.extractorVersion,
                }),
                span: mergedSpan,
            });
            continue;
        }

        chunkRecordsByLogicalIdentity.set(logicalIdentity, {
            symbolKey,
            symbolInstanceId,
            language: input.language,
            kind: parsed.kind,
            name: parsed.name,
            qualifiedName,
            label,
            file: relativePath,
            span,
            parentQualifiedNamePath: normalizedParentQualifiedNamePath,
            fileHash: input.fileHash,
            extractorVersion: input.extractorVersion,
        });
    }

    return [fileOwner, ...[...chunkRecordsByLogicalIdentity.values()].sort(compareSymbols)];
}

const SYMBOL_OWNER_KIND_PRIORITY: Record<SymbolKind, number> = {
    method: 0,
    function: 1,
    hook: 2,
    component: 3,
    property: 4,
    type: 5,
    enum: 6,
    trait: 7,
    class: 8,
    interface: 9,
    namespace: 10,
    module: 11,
    config: 12,
    test: 13,
    macro: 14,
    file: 15,
};

function getSynthesizedFileOwner(symbols: SymbolRecord[]): SymbolRecord {
    const fileOwner = symbols.find((symbol) => symbol.kind === 'file');
    if (!fileOwner) {
        throw new Error('Cannot resolve owner symbol: synthesized file symbol is missing');
    }
    return fileOwner;
}

function isByteContained(chunk: CodeChunk, symbol: SymbolRecord): boolean {
    return chunk.metadata.startByte !== undefined
        && chunk.metadata.endByte !== undefined
        && symbol.span.startByte !== undefined
        && symbol.span.endByte !== undefined
        && symbol.span.startByte <= chunk.metadata.startByte
        && chunk.metadata.endByte <= symbol.span.endByte;
}

function isLineContained(chunk: CodeChunk, symbol: SymbolRecord): boolean {
    return symbol.span.startLine <= chunk.metadata.startLine
        && chunk.metadata.endLine <= symbol.span.endLine;
}

function byteSpanSize(symbol: SymbolRecord): number | null {
    if (symbol.span.startByte === undefined || symbol.span.endByte === undefined) {
        return null;
    }
    return Math.max(0, symbol.span.endByte - symbol.span.startByte);
}

function lineSpanSize(symbol: SymbolRecord): number {
    return Math.max(0, symbol.span.endLine - symbol.span.startLine);
}

function compareOwnerCandidates(a: SymbolRecord, b: SymbolRecord): number {
    const aByteSize = byteSpanSize(a);
    const bByteSize = byteSpanSize(b);
    if (aByteSize !== null && bByteSize !== null && aByteSize !== bByteSize) {
        return aByteSize - bByteSize;
    }
    if ((aByteSize !== null) !== (bByteSize !== null)) {
        return aByteSize !== null ? -1 : 1;
    }

    const aLineSize = lineSpanSize(a);
    const bLineSize = lineSpanSize(b);
    if (aLineSize !== bLineSize) {
        return aLineSize - bLineSize;
    }

    const aDepth = a.parentQualifiedNamePath.length;
    const bDepth = b.parentQualifiedNamePath.length;
    if (aDepth !== bDepth) {
        return bDepth - aDepth;
    }

    const aKindPriority = SYMBOL_OWNER_KIND_PRIORITY[a.kind] ?? 99;
    const bKindPriority = SYMBOL_OWNER_KIND_PRIORITY[b.kind] ?? 99;
    if (aKindPriority !== bKindPriority) {
        return aKindPriority - bKindPriority;
    }

    return compareStrings(a.symbolKey, b.symbolKey);
}

export function resolveOwnerSymbolForChunk(input: ResolveOwnerSymbolForChunkInput): SymbolRecord {
    const fileOwner = getSynthesizedFileOwner(input.symbols);
    const extractedSymbols = input.symbols.filter((symbol) => symbol.kind !== 'file');
    const byteCandidates = extractedSymbols.filter((symbol) => isByteContained(input.chunk, symbol));
    const lineCandidates = extractedSymbols.filter((symbol) => isLineContained(input.chunk, symbol));
    const candidates = byteCandidates.length > 0 ? byteCandidates : lineCandidates;

    if (candidates.length === 0) {
        return fileOwner;
    }

    return [...candidates].sort(compareOwnerCandidates)[0] ?? fileOwner;
}

function compareSymbols(a: SymbolRecord, b: SymbolRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    if (a.span.startLine !== b.span.startLine) return a.span.startLine - b.span.startLine;
    if (a.span.endLine !== b.span.endLine) return b.span.endLine - a.span.endLine;
    if (a.kind !== b.kind) return compareStrings(a.kind, b.kind);
    if (a.qualifiedName !== b.qualifiedName) return compareStrings(a.qualifiedName, b.qualifiedName);
    return compareStrings(a.symbolInstanceId, b.symbolInstanceId);
}

function appendToMap(map: Map<string, SymbolRecord[]>, key: string, symbol: SymbolRecord): void {
    const existing = map.get(key);
    if (existing) {
        existing.push(symbol);
        return;
    }
    map.set(key, [symbol]);
}

export function buildSymbolRegistry(input: BuildSymbolRegistryInput): SymbolRegistry {
    const symbols = [...input.symbols].sort(compareSymbols);
    const symbolsByInstanceId = new Map<string, SymbolRecord>();
    const symbolsByKey = new Map<string, SymbolRecord[]>();
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const symbolsByLabel = new Map<string, SymbolRecord[]>();
    const symbolsByQualifiedName = new Map<string, SymbolRecord[]>();
    const warnings: string[] = [];

    for (const symbol of symbols) {
        if (symbolsByInstanceId.has(symbol.symbolInstanceId)) {
            throw new Error(`Duplicate symbolInstanceId '${symbol.symbolInstanceId}' in ${symbol.file}`);
        }
        symbolsByInstanceId.set(symbol.symbolInstanceId, symbol);
        appendToMap(symbolsByKey, symbol.symbolKey, symbol);
        appendToMap(symbolsByFile, symbol.file, symbol);
        appendToMap(symbolsByLabel, symbol.label, symbol);
        appendToMap(symbolsByQualifiedName, symbol.qualifiedName, symbol);
    }

    for (const [symbolKey, candidates] of symbolsByKey) {
        if (candidates.length > 1) {
            warnings.push(`Duplicate symbolKey '${symbolKey}' has ${candidates.length} candidates`);
        }
    }

    return {
        manifest: input.manifest,
        symbols,
        symbolsByInstanceId,
        symbolsByKey,
        symbolsByFile,
        symbolsByLabel,
        symbolsByQualifiedName,
        warnings,
    };
}

export function computeSymbolRegistryManifestHash(manifest: SymbolRegistryManifest): string {
    const payload = {
        schemaVersion: manifest.schemaVersion,
        rootFingerprint: manifest.rootFingerprint,
        repoIdentity: manifest.repoIdentity,
        indexPolicyHash: manifest.indexPolicyHash,
        languageRouterVersion: manifest.languageRouterVersion,
        extractorVersion: manifest.extractorVersion,
        relationshipVersion: manifest.relationshipVersion,
        files: [...manifest.files]
            .map((file) => ({
                path: normalizeRelativePath(file.path),
                hash: file.hash,
                language: file.language,
                symbolCount: file.symbolCount,
            }))
            .sort((a, b) => compareStrings(a.path, b.path)),
    };
    return sha256Id('symmanifest', canonicalStringify(payload));
}
