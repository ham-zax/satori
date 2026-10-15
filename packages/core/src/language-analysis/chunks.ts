import type { ExtractedSymbol } from '../languages';
import { Utf8SourceMap } from './source-map';
import type { CodeChunk } from './types';

const DEFAULT_CHUNK_SIZE = 2500;
const DEFAULT_CHUNK_OVERLAP = 300;

export interface ChunkOptions {
    readonly chunkSize?: number;
    readonly chunkOverlap?: number;
}

export interface AnalysisChunkSpan {
    readonly startByte: number;
    readonly endByte: number;
    /** Null marks uncovered source, which has no associated symbol metadata. */
    readonly symbolIndex: number | null;
}

export type AnalysisChunkPlanKind = 'symbols' | 'emergency';

export interface AnalysisChunkPlan {
    count(): number;
    spans(): IterableIterator<AnalysisChunkSpan>;
    materialize(span: AnalysisChunkSpan): CodeChunk;
    chunks(): IterableIterator<CodeChunk>;
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

function* spansForCoveredRange(input: {
    readonly bytes: Buffer;
    readonly startByte: number;
    readonly endByte: number;
    readonly chunkSize: number;
    readonly chunkOverlap: number;
    readonly symbolIndex: number | null;
}): IterableIterator<AnalysisChunkSpan> {
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
        yield { startByte: start, endByte: end, symbolIndex: input.symbolIndex };
        if (end === boundedEnd) break;
    }
}

function* symbolChunkSpans(
    bytes: Buffer,
    symbols: readonly ExtractedSymbol[],
    chunkSize: number,
    chunkOverlap: number,
): IterableIterator<AnalysisChunkSpan> {
    const coveredSpans: Array<{ startByte: number; endByte: number }> = [];
    for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
        const symbol = symbols[symbolIndex];
        const startByte = symbol.span.startByte;
        const endByte = symbol.span.endByte;
        if (startByte === undefined || endByte === undefined || endByte <= startByte) continue;
        coveredSpans.push({ startByte, endByte });
        yield* spansForCoveredRange({
            bytes,
            startByte,
            endByte,
            chunkSize,
            chunkOverlap,
            symbolIndex,
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
                yield* spansForCoveredRange({
                    bytes,
                    startByte: uncoveredStart,
                    endByte: span.startByte,
                    chunkSize,
                    chunkOverlap,
                    symbolIndex: null,
                });
            }
        }
        uncoveredStart = Math.max(uncoveredStart, span.endByte);
    }
}

function emergencyChunkBound(value: number | undefined, fallback: number): number {
    const configured = typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
    // Four bytes is the largest UTF-8 code point. A smaller byte ceiling cannot
    // preserve both valid UTF-8 and the configured bound.
    return Math.max(4, configured);
}

function buildEmergencyPositions(content: string, byteLength: number): Array<{ line: number; column: number }> {
    const positions = new Array<{ line: number; column: number }>(byteLength + 1);
    let byteOffset = 0;
    let line = 1;
    let column = 0;
    positions[0] = { line, column };
    for (const codePoint of content) {
        const encodedLength = Buffer.byteLength(codePoint, 'utf8');
        for (let index = 1; index < encodedLength; index += 1) {
            positions[byteOffset + index] = { line, column };
        }
        byteOffset += encodedLength;
        if (codePoint === '\n') {
            line += 1;
            column = 0;
        } else {
            column += codePoint.length;
        }
        positions[byteOffset] = { line, column };
    }
    return positions;
}

function* emergencyChunkSpans(
    bytes: Buffer,
    chunkSize: number,
    chunkOverlap: number,
): IterableIterator<AnalysisChunkSpan> {
    for (let startByte = 0; startByte < bytes.length;) {
        let endByte = alignUtf8Boundary(
            bytes,
            Math.min(bytes.length, startByte + chunkSize),
            'backward',
        );
        if (endByte <= startByte) {
            endByte = alignUtf8Boundary(
                bytes,
                Math.min(bytes.length, startByte + chunkSize),
                'forward',
            );
        }
        if (endByte <= startByte) break;
        yield { startByte, endByte, symbolIndex: null };
        if (endByte === bytes.length) break;
        const nextStart = alignUtf8Boundary(
            bytes,
            Math.max(startByte + 1, endByte - chunkOverlap),
            'backward',
        );
        startByte = nextStart > startByte ? nextStart : endByte;
    }
}

export function createAnalysisChunkPlan(
    content: string,
    relativePath: string,
    language: string,
    symbols: readonly ExtractedSymbol[],
    options: ChunkOptions,
    kind: AnalysisChunkPlanKind = 'symbols',
): AnalysisChunkPlan {
    const sourceMap = kind === 'symbols' ? new Utf8SourceMap(content) : undefined;
    const bytes = sourceMap?.getSourceBytes() ?? Buffer.from(content, 'utf8');
    const emergencyPositions = kind === 'emergency'
        ? buildEmergencyPositions(content, bytes.length)
        : undefined;
    const chunkSize = kind === 'symbols'
        ? clampPositive(options.chunkSize, DEFAULT_CHUNK_SIZE)
        : emergencyChunkBound(options.chunkSize, DEFAULT_CHUNK_SIZE);
    const overlapOption = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const requestedOverlap = kind === 'emergency'
        ? typeof options.chunkOverlap === 'number' && Number.isFinite(options.chunkOverlap)
            ? Math.max(0, Math.floor(options.chunkOverlap))
            : 0
        : Number.isFinite(overlapOption)
            ? Math.max(0, Math.floor(overlapOption))
            : DEFAULT_CHUNK_OVERLAP;
    const chunkOverlap = Math.min(requestedOverlap, Math.max(0, chunkSize - 1));
    const spans = (): IterableIterator<AnalysisChunkSpan> => kind === 'emergency'
        ? emergencyChunkSpans(bytes, chunkSize, chunkOverlap)
        : symbolChunkSpans(bytes, symbols, chunkSize, chunkOverlap);

    return {
        count(): number {
            let total = 0;
            const iterator = spans();
            while (!iterator.next().done) total += 1;
            return total;
        },
        spans,
        materialize(span: AnalysisChunkSpan): CodeChunk {
            if (kind === 'emergency') {
                const start = emergencyPositions![span.startByte];
                const end = emergencyPositions![span.endByte];
                return {
                    content: bytes.subarray(span.startByte, span.endByte).toString('utf8'),
                    metadata: {
                        startLine: start.line,
                        endLine: end.line,
                        startByte: span.startByte,
                        endByte: span.endByte,
                        startColumn: start.column,
                        endColumn: end.column,
                        language: 'text',
                        filePath: relativePath,
                    },
                };
            }
            const symbol = span.symbolIndex === null ? undefined : symbols[span.symbolIndex];
            return chunkForSpan(
                bytes,
                sourceMap!,
                relativePath,
                language,
                span.startByte,
                span.endByte,
                symbol,
            );
        },
        *chunks(): IterableIterator<CodeChunk> {
            for (const span of spans()) yield this.materialize(span);
        },
    };
}

export function buildAnalysisChunks(
    content: string,
    relativePath: string,
    language: string,
    symbols: readonly ExtractedSymbol[],
    options: ChunkOptions,
): CodeChunk[] {
    if (content.length === 0) return [];
    return [...createAnalysisChunkPlan(content, relativePath, language, symbols, options).chunks()];
}
