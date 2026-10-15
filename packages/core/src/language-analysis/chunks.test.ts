import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractedSymbol } from '../languages';
import { Utf8SourceMap } from './source-map';
import { buildAnalysisChunks, createAnalysisChunkPlan, type ChunkOptions } from './chunks';
import type { CodeChunk } from './types';

const DEFAULT_CHUNK_SIZE = 2500;
const DEFAULT_CHUNK_OVERLAP = 300;

function referenceClampPositive(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function referenceChunkForSpan(
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

function referenceIsUtf8Continuation(byte: number | undefined): boolean {
    return byte !== undefined && (byte & 0xc0) === 0x80;
}

function referenceAlignUtf8Boundary(
    bytes: Buffer,
    offset: number,
    direction: 'backward' | 'forward',
): number {
    let aligned = Math.max(0, Math.min(offset, bytes.length));
    if (direction === 'backward') {
        while (aligned > 0 && referenceIsUtf8Continuation(bytes[aligned])) aligned -= 1;
    } else {
        while (aligned < bytes.length && referenceIsUtf8Continuation(bytes[aligned])) aligned += 1;
    }
    return aligned;
}

function referenceAppendChunksForSpan(input: {
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
    const boundedStart = referenceAlignUtf8Boundary(input.bytes, input.startByte, 'forward');
    const boundedEnd = referenceAlignUtf8Boundary(input.bytes, input.endByte, 'backward');
    const step = input.chunkSize - input.chunkOverlap;
    for (let rawStart = boundedStart; rawStart < boundedEnd; rawStart += step) {
        const start = referenceAlignUtf8Boundary(input.bytes, rawStart, 'forward');
        const end = referenceAlignUtf8Boundary(
            input.bytes,
            Math.min(boundedEnd, start + input.chunkSize),
            'backward',
        );
        if (end <= start) continue;
        input.chunks.push(referenceChunkForSpan(
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

/** Frozen pre-M04 implementation; deliberately independent of the production span code. */
function referenceBuildAnalysisChunks(
    content: string,
    relativePath: string,
    language: string,
    symbols: readonly ExtractedSymbol[],
    options: ChunkOptions,
): CodeChunk[] {
    if (content.length === 0) return [];

    const bytes = Buffer.from(content, 'utf8');
    const sourceMap = new Utf8SourceMap(content);
    const chunkSize = referenceClampPositive(options.chunkSize, DEFAULT_CHUNK_SIZE);
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
        if (startByte === undefined || endByte === undefined || endByte <= startByte) continue;
        coveredSpans.push({ startByte, endByte });
        referenceAppendChunksForSpan({
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
                referenceAppendChunksForSpan({
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

function referenceEmergencyChunks(
    content: string,
    relativePath: string,
    options: ChunkOptions,
): CodeChunk[] {
    const bytes = Buffer.from(content, 'utf8');
    const positions = new Array<{ line: number; column: number }>(bytes.length + 1);
    let byteOffset = 0;
    let line = 1;
    let column = 0;
    positions[0] = { line, column };
    for (const codePoint of content) {
        const encodedLength = Buffer.byteLength(codePoint, 'utf8');
        for (let index = 1; index < encodedLength; index += 1) positions[byteOffset + index] = { line, column };
        byteOffset += encodedLength;
        if (codePoint === '\n') { line += 1; column = 0; }
        else column += codePoint.length;
        positions[byteOffset] = { line, column };
    }
    const configuredSize = typeof options.chunkSize === 'number'
        && Number.isFinite(options.chunkSize) && options.chunkSize > 0
        ? Math.floor(options.chunkSize)
        : 2500;
    const chunkSize = Math.max(4, configuredSize);
    const configuredOverlap = typeof options.chunkOverlap === 'number'
        && Number.isFinite(options.chunkOverlap)
        ? Math.max(0, Math.floor(options.chunkOverlap))
        : 0;
    const chunkOverlap = Math.min(configuredOverlap, Math.max(0, chunkSize - 1));
    const chunks: CodeChunk[] = [];
    for (let startByte = 0; startByte < bytes.length;) {
        let endByte = referenceAlignUtf8Boundary(bytes, Math.min(bytes.length, startByte + chunkSize), 'backward');
        if (endByte <= startByte) {
            endByte = referenceAlignUtf8Boundary(bytes, Math.min(bytes.length, startByte + chunkSize), 'forward');
        }
        if (endByte <= startByte) break;
        const start = positions[startByte]!;
        const end = positions[endByte]!;
        chunks.push({
            content: bytes.subarray(startByte, endByte).toString('utf8'),
            metadata: {
                startLine: start.line,
                endLine: end.line,
                startByte,
                endByte,
                startColumn: start.column,
                endColumn: end.column,
                language: 'text',
                filePath: relativePath,
            },
        });
        if (endByte === bytes.length) break;
        const nextStart = referenceAlignUtf8Boundary(
            bytes,
            Math.max(startByte + 1, endByte - chunkOverlap),
            'backward',
        );
        startByte = nextStart > startByte ? nextStart : endByte;
    }
    return chunks;
}

function extractedSymbol(
    name: string,
    startByte: number | undefined,
    endByte: number | undefined,
    parentQualifiedNamePath?: readonly string[],
): ExtractedSymbol {
    return {
        kind: 'function',
        name,
        label: 'function ' + name,
        ...(parentQualifiedNamePath ? { parentQualifiedNamePath } : {}),
        span: { startLine: 1, endLine: 1, startByte, endByte },
    };
}

const cases: Array<{
    readonly name: string;
    readonly content: string;
    readonly symbols: readonly ExtractedSymbol[];
    readonly options: ChunkOptions;
}> = [
    {
        name: 'nested overlapping symbols preserve input symbol order and duplicate text',
        content: 'const before = 1;\nfunction outer() {\n  function inner() { return "😀"; }\n}\nconst after = 2;\n',
        symbols: [
            extractedSymbol('inner', 42, 74, ['outer']),
            extractedSymbol('outer', 19, 76),
        ],
        options: { chunkSize: 24, chunkOverlap: 7 },
    },
    {
        name: 'uncovered code is chunked while whitespace gaps are skipped',
        content: 'const before = 1;\n  \n\nfunction body() { return 2; }\n  \nconst after = 3;\n',
        symbols: [extractedSymbol('body', 21, 49)],
        options: { chunkSize: 18, chunkOverlap: 4 },
    },
    {
        name: 'missing, zero, and reversed symbol spans leave the source uncovered',
        content: 'let a = 1;\nfunction b() {}\nlet c = 3;\n',
        symbols: [
            extractedSymbol('missing', undefined, undefined),
            extractedSymbol('zero', 4, 4),
            extractedSymbol('reversed', 25, 19),
        ],
        options: { chunkSize: 11, chunkOverlap: 3 },
    },
    {
        name: 'UTF-8 continuation byte span edges align around astral characters',
        content: 'a😀b\nç🚀d\n',
        symbols: [extractedSymbol('unicode', 2, 10)],
        options: { chunkSize: 5, chunkOverlap: 1 },
    },
    {
        name: 'zero and non-finite options use the established defaults',
        content: 'x😀y\n'.repeat(900),
        symbols: [extractedSymbol('whole', 0, Buffer.byteLength('x😀y\n'.repeat(900), 'utf8'))],
        options: { chunkSize: 0, chunkOverlap: Number.NaN },
    },
    {
        name: 'fractional size and overlap are floored',
        content: '0123456789😀abcdefghij\n'.repeat(8),
        symbols: [extractedSymbol('fractional', 2, Buffer.byteLength('0123456789😀abcdefghij\n'.repeat(8), 'utf8') - 1)],
        options: { chunkSize: 12.8, chunkOverlap: 4.9 },
    },
    {
        name: 'negative size falls back while a fractional overlap is floored',
        content: 'const data = "😀";\n'.repeat(300),
        symbols: [],
        options: { chunkSize: -1, chunkOverlap: 3.7 },
    },
];

for (const sample of cases) {
    test('chunk equivalence: ' + sample.name, () => {
        const expected = referenceBuildAnalysisChunks(
            sample.content,
            'src/sample.ts',
            'typescript',
            sample.symbols,
            sample.options,
        );
        const actual = buildAnalysisChunks(
            sample.content,
            'src/sample.ts',
            'typescript',
            sample.symbols,
            sample.options,
        );
        assert.deepEqual(actual, expected);
    });
}

test('empty source returns no chunks', () => {
    assert.deepEqual(buildAnalysisChunks('', 'empty.ts', 'typescript', [], {}), []);
});

test('normal chunk plan allocates source bytes once and preserves full reference chunks', (t) => {
    const sample = cases[0]!;
    const expected = referenceBuildAnalysisChunks(
        sample.content, 'src/sample.ts', 'typescript', sample.symbols, sample.options,
    );
    const from = t.mock.method(Buffer, 'from');
    const plan = createAnalysisChunkPlan(
        sample.content, 'src/sample.ts', 'typescript', sample.symbols, sample.options,
    );
    const sourceAllocations = from.mock.calls.filter(call => call.arguments[0] === sample.content).length;
    from.mock.restore();

    assert.equal(sourceAllocations, 1, 'plan construction must allocate only one UTF-8 source buffer');
    assert.equal(plan.count(), expected.length);
    assert.deepEqual([...plan.chunks()], expected);
    assert.deepEqual([...plan.spans()].map(span => plan.materialize(span)), expected);
});

test('emergency indexing plan preserves fallback chunks and metadata', () => {
    for (const options of [
        { chunkSize: 3, chunkOverlap: 1 },
        { chunkSize: 0, chunkOverlap: Number.NaN },
        { chunkSize: 12.8, chunkOverlap: 3.9 },
    ]) {
        const content = '😀alpha\n🚀beta\n';
        const expected = referenceEmergencyChunks(content, 'src/fallback.txt', options);
        const actual = [...createAnalysisChunkPlan(
            content,
            'src/fallback.txt',
            'text',
            [],
            options,
            'emergency',
        ).chunks()];
        assert.deepEqual(actual, expected);
    }
});
