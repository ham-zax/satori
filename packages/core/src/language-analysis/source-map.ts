import type { SourceSpan } from './types';

export class Utf8SourceMap {
    private readonly lineStartBytes: readonly number[];
    private readonly sourceBytes: Buffer;

    constructor(private readonly source: string) {
        this.sourceBytes = Buffer.from(source, 'utf8');
        const starts = [0];
        let byteOffset = 0;
        for (const character of source) {
            byteOffset += Buffer.byteLength(character, 'utf8');
            if (character === '\n') {
                starts.push(byteOffset);
            }
        }
        this.lineStartBytes = starts;
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

    private utf16Column(lineIndex: number, byteOffset: number): number {
        const lineStart = this.lineStartBytes[lineIndex] ?? 0;
        const prefixBytes = this.sourceBytes.subarray(lineStart, byteOffset);
        return prefixBytes.toString('utf8').length;
    }
}
