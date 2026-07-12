import type { ExtractedSymbol } from '../languages';
import { Utf8SourceMap } from './source-map';
import type { CodeChunk } from './types';

const DEFAULT_CHUNK_SIZE = 2500;
const DEFAULT_CHUNK_OVERLAP = 300;

export interface ChunkOptions {
    readonly chunkSize?: number;
    readonly chunkOverlap?: number;
}

function clampPositive(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function chunkForSpan(
    bytes: Buffer,
    sourceMap: Utf8SourceMap,
    relativePath: string,
    language: string,
    startByte: number,
    endByte: number,
    symbol?: ExtractedSymbol,
): CodeChunk {
    const span = sourceMap.span(startByte, endByte);
    return {
        content: bytes.subarray(startByte, endByte).toString('utf8'),
        metadata: {
            ...span,
            language,
            filePath: relativePath,
            ...(symbol ? {
                symbolLabel: symbol.label,
                symbolKind: symbol.kind,
                breadcrumbs: symbol.parentQualifiedNamePath ? [...symbol.parentQualifiedNamePath] : undefined,
            } : {}),
        },
    };
}

function isUtf8Continuation(byte: number | undefined): boolean {
    return byte !== undefined && (byte & 0xc0) === 0x80;
}

function alignUtf8Boundary(bytes: Buffer, offset: number, direction: 'backward' | 'forward'): number {
    let aligned = Math.max(0, Math.min(offset, bytes.length));
    if (direction === 'backward') {
        while (aligned > 0 && isUtf8Continuation(bytes[aligned])) aligned -= 1;
    } else {
        while (aligned < bytes.length && isUtf8Continuation(bytes[aligned])) aligned += 1;
    }
    return aligned;
}

function appendChunksForSpan(input: {
    readonly chunks: CodeChunk[];
    readonly bytes: Buffer;
    readonly sourceMap: Utf8SourceMap;
    readonly relativePath: string;
    readonly language: string;
    readonly startByte: number;
    readonly endByte: number;
    readonly chunkSize: number;
    readonly chunkOverlap: number;
    readonly symbol?: ExtractedSymbol;
}): void {
    const boundedStart = alignUtf8Boundary(input.bytes, input.startByte, 'forward');
    const boundedEnd = alignUtf8Boundary(input.bytes, input.endByte, 'backward');
    const step = input.chunkSize - input.chunkOverlap;
    for (let rawStart = boundedStart; rawStart < boundedEnd; rawStart += step) {
        const start = alignUtf8Boundary(input.bytes, rawStart, 'forward');
        const end = alignUtf8Boundary(
            input.bytes,
            Math.min(boundedEnd, start + input.chunkSize),
            'backward',
        );
        if (end <= start) continue;
        input.chunks.push(chunkForSpan(
            input.bytes,
            input.sourceMap,
            input.relativePath,
            input.language,
            start,
            end,
            input.symbol,
        ));
        if (end === boundedEnd) break;
    }
}

export function buildAnalysisChunks(
    content: string,
    relativePath: string,
    language: string,
    symbols: readonly ExtractedSymbol[],
    options: ChunkOptions,
): CodeChunk[] {
    if (content.length === 0) {
        return [];
    }

    const bytes = Buffer.from(content, 'utf8');
    const sourceMap = new Utf8SourceMap(content);
    const chunkSize = clampPositive(options.chunkSize, DEFAULT_CHUNK_SIZE);
    const overlapOption = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const requestedOverlap = Number.isFinite(overlapOption)
        ? Math.max(0, Math.floor(overlapOption))
        : DEFAULT_CHUNK_OVERLAP;
    const chunkOverlap = Math.min(requestedOverlap, Math.max(0, chunkSize - 1));
    const chunks: CodeChunk[] = [];

    const coveredSpans: Array<{ startByte: number; endByte: number }> = [];
    for (const symbol of symbols) {
        const startByte = symbol.span.startByte;
        const endByte = symbol.span.endByte;
        if (startByte === undefined || endByte === undefined || endByte <= startByte) {
            continue;
        }
        coveredSpans.push({ startByte, endByte });
        appendChunksForSpan({
            chunks,
            bytes,
            sourceMap,
            relativePath,
            language,
            startByte,
            endByte,
            chunkSize,
            chunkOverlap,
            symbol,
        });
    }

    const mergedCoverage: Array<{ startByte: number; endByte: number }> = [];
    for (const span of coveredSpans.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte)) {
        const previous = mergedCoverage.at(-1);
        if (previous && span.startByte <= previous.endByte) {
            previous.endByte = Math.max(previous.endByte, span.endByte);
        } else {
            mergedCoverage.push({ ...span });
        }
    }

    let uncoveredStart = 0;
    for (const span of [...mergedCoverage, { startByte: bytes.length, endByte: bytes.length }]) {
        if (span.startByte > uncoveredStart) {
            const uncovered = bytes.subarray(uncoveredStart, span.startByte).toString('utf8');
            if (uncovered.trim()) {
                appendChunksForSpan({
                    chunks,
                    bytes,
                    sourceMap,
                    relativePath,
                    language,
                    startByte: uncoveredStart,
                    endByte: span.startByte,
                    chunkSize,
                    chunkOverlap,
                });
            }
        }
        uncoveredStart = Math.max(uncoveredStart, span.endByte);
    }

    return chunks;
}
