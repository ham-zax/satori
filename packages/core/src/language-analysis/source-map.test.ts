import assert from 'node:assert/strict';
import test from 'node:test';
import { Utf8SourceMap } from './source-map';

// Entire pre-M05 class, kept independent of the production mapping implementation.
import type { SourceSpan } from './types';

class OldUtf8SourceMap {
    private readonly lineStartBytes: readonly number[];
    private readonly sourceBytes: Buffer;
    private readonly utf16ToByte: readonly number[];

    constructor(private readonly source: string) {
        this.sourceBytes = Buffer.from(source, 'utf8');
        const starts = [0];
        const utf16ToByte = new Array<number>(source.length + 1);
        utf16ToByte[0] = 0;
        let utf16Offset = 0;
        let byteOffset = 0;
        for (const character of source) {
            const startByte = byteOffset;
            for (let index = 1; index < character.length; index += 1) {
                utf16ToByte[utf16Offset + index] = startByte;
            }
            byteOffset += Buffer.byteLength(character, 'utf8');
            utf16Offset += character.length;
            utf16ToByte[utf16Offset] = byteOffset;
            if (character === '\n') {
                starts.push(byteOffset);
            }
        }
        this.lineStartBytes = starts;
        this.utf16ToByte = utf16ToByte;
    }

    spanFromUtf16(startOffset: number, endOffset: number): SourceSpan {
        return this.span(
            this.byteOffsetForUtf16(startOffset),
            this.byteOffsetForUtf16(endOffset),
        );
    }

    span(startByte: number, endByte: number): SourceSpan {
        const boundedStart = Math.max(0, startByte);
        const boundedEnd = Math.max(boundedStart, endByte);
        const startLineIndex = this.lineIndexForByte(boundedStart);
        const endLineIndex = this.lineIndexForByte(Math.max(boundedStart, boundedEnd - 1));

        return {
            startLine: startLineIndex + 1,
            endLine: endLineIndex + 1,
            startByte: boundedStart,
            endByte: boundedEnd,
            startColumn: this.utf16Column(startLineIndex, boundedStart),
            endColumn: this.utf16Column(endLineIndex, boundedEnd),
        };
    }

    private lineIndexForByte(byteOffset: number): number {
        let low = 0;
        let high = this.lineStartBytes.length - 1;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (this.lineStartBytes[middle] <= byteOffset) {
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return Math.max(0, high);
    }

    private byteOffsetForUtf16(offset: number): number {
        const boundedOffset = Math.min(this.source.length, Math.max(0, Math.trunc(offset)));
        return this.utf16ToByte[boundedOffset] ?? this.sourceBytes.length;
    }

    private utf16Column(lineIndex: number, byteOffset: number): number {
        const lineStart = this.lineStartBytes[lineIndex] ?? 0;
        const prefixBytes = this.sourceBytes.subarray(lineStart, byteOffset);
        return prefixBytes.toString('utf8').length;
    }
}

const fixtures = [
    ['empty', ''],
    ['ASCII', 'alpha beta'],
    ['mixed Unicode', 'é中😀e\u0301\n𐐀 fin'],
    ['lone surrogates', 'a\ud800b\udc00\ud800\udc00\ud800\n\udc00z'],
    ['CRLF and empty lines', '\r\nalpha\r\n\nβ\n'],
    ['newlines', '\n\nlast\n'],
] as const;

function offsets(length: number): number[] {
    return [...Array.from({ length: length + 1 }, (_, index) => index),
        -Infinity, Infinity, NaN, -10, -0.5, 0.5, 1.5, length - 0.5, length + 0.5, length + 10];
}

for (const [name, source] of fixtures) {
    test(`byte and UTF16 spans preserve the entire old class behavior for ${name}`, () => {
        const old = new OldUtf8SourceMap(source);
        const current = new Utf8SourceMap(source);
        const byteOffsets = offsets(Buffer.byteLength(source, 'utf8'));
        for (const start of byteOffsets) for (const end of byteOffsets) {
            assert.deepEqual(current.span(start, end), old.span(start, end), `byte ${start}:${end}`);
        }
        const utf16Offsets = offsets(source.length);
        for (const start of utf16Offsets) {
            assert.equal(current['byteOffsetForUtf16'](start), old['byteOffsetForUtf16'](start), `offset ${start}`);
            for (const end of utf16Offsets) {
                assert.deepEqual(current.spanFromUtf16(start, end), old.spanFromUtf16(start, end), `UTF16 ${start}:${end}`);
            }
        }
    });
}

test('byte-only spans leave conversion table unallocated; first UTF16 span builds it once', () => {
    const source = 'alpha\n😀 é\ud800\r\nlast';
    const current = new Utf8SourceMap(source);
    const old = new OldUtf8SourceMap(source);
    assert.equal(current['utf16ToByte'], undefined);
    for (const [start, end] of [[0, 5], [6, 10], [11, Infinity], [NaN, 3]]) {
        assert.deepEqual(current.span(start!, end!), old.span(start!, end!));
    }
    assert.equal(current['utf16ToByte'], undefined);
    assert.deepEqual(current.spanFromUtf16(7, 12), old.spanFromUtf16(7, 12));
    const table = current['utf16ToByte'];
    assert.ok(Array.isArray(table));
    assert.deepEqual(table, old['utf16ToByte']);
    for (const offset of offsets(source.length)) {
        assert.equal(current['byteOffsetForUtf16'](offset), old['byteOffsetForUtf16'](offset));
        assert.equal(current['utf16ToByte'], table);
    }
});

test('direct UTF16 conversion initializes lazily and source bytes share the original buffer', () => {
    const source = 'é😀\ud800\r\nend';
    const current = new Utf8SourceMap(source);
    assert.equal(current['utf16ToByte'], undefined);
    const bytes = current.getSourceBytes();
    assert.equal(bytes, current['sourceBytes']);
    assert.equal(current.getSourceBytes(), bytes);
    assert.deepEqual(bytes, Buffer.from(source, 'utf8'));
    assert.equal(current['utf16ToByte'], undefined);
    assert.equal(current['byteOffsetForUtf16'](2), new OldUtf8SourceMap(source)['byteOffsetForUtf16'](2));
    const table = current['utf16ToByte'];
    assert.ok(Array.isArray(table));
    current.spanFromUtf16(0, source.length);
    assert.equal(current['utf16ToByte'], table);
    assert.equal(current.getSourceBytes(), bytes);
});

for (const [name, source, expectedDecodesPerSpan] of [
    ['ASCII', 'alpha\0beta\r\nnext\nlast', 0],
    ['Unicode', 'ASCII prefix\né😀e\u0301\ud800\r\nrest', 2],
] as const) {
    test(`${name} column path preserves bounded spans with ${expectedDecodesPerSpan} prefix decodes`, (t) => {
        const current = new Utf8SourceMap(source);
        const old = new OldUtf8SourceMap(source);
        const boundaries = offsets(Buffer.byteLength(source, 'utf8'));
        const inputs = boundaries.flatMap(start => boundaries.map(end => [start, end] as const));
        // Compute the independent oracle before observing production decoding.
        const expected = inputs.map(([start, end]) => old.span(start, end));
        const decode = t.mock.method(Buffer.prototype, 'toString');
        let actual: SourceSpan[];
        let decodeCount: number;
        try {
            actual = inputs.map(([start, end]) => current.span(start, end));
            decodeCount = decode.mock.callCount();
        } finally {
            decode.mock.restore();
        }
        assert.deepEqual(actual, expected);
        assert.equal(decodeCount, inputs.length * expectedDecodesPerSpan);
        assert.equal(current['utf16ToByte'], undefined);
    });
}
