import { Splitter, CodeChunk } from './index';

interface TextChunk {
    content: string;
    startOffset: number;
    endOffset: number;
}

const BOUNDARY_SEPARATORS = ['\n\n', '\n', '};', '}', ';', ' ', '\t'];

// Keep the historical class name for public API compatibility.
export class LangChainCodeSplitter implements Splitter {
    private chunkSize: number = 1000;
    private chunkOverlap: number = 200;

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize !== undefined) this.setChunkSize(chunkSize);
        if (chunkOverlap !== undefined) this.setChunkOverlap(chunkOverlap);
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        if (code.length === 0) {
            return [];
        }

        const newlineOffsets = this.collectNewlineOffsets(code);
        return this.splitText(code).map((chunk) => ({
            content: chunk.content,
            metadata: {
                startLine: this.lineForOffset(chunk.startOffset, newlineOffsets),
                endLine: this.lineForOffset(chunk.endOffset, newlineOffsets),
                language,
                filePath,
            },
        }));
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = Math.max(1, Math.floor(chunkSize));
        if (this.chunkOverlap >= this.chunkSize) {
            this.chunkOverlap = this.chunkSize - 1;
        }
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = Math.max(0, Math.floor(chunkOverlap));
        if (this.chunkOverlap >= this.chunkSize) {
            this.chunkOverlap = this.chunkSize - 1;
        }
    }

    private splitText(code: string): TextChunk[] {
        const chunks: TextChunk[] = [];
        let startOffset = 0;

        while (startOffset < code.length) {
            const endOffset = this.findChunkEnd(code, startOffset);
            const content = code.slice(startOffset, endOffset);
            if (content.length > 0) {
                chunks.push({ content, startOffset, endOffset });
            }

            if (endOffset >= code.length) {
                break;
            }

            const overlap = Math.min(this.chunkOverlap, Math.max(0, endOffset - startOffset - 1));
            startOffset = this.adjustStartOffset(code, Math.max(startOffset + 1, endOffset - overlap));
        }

        return chunks;
    }

    private findChunkEnd(code: string, startOffset: number): number {
        const maxEnd = Math.min(startOffset + this.chunkSize, code.length);
        if (maxEnd >= code.length) {
            return code.length;
        }

        const minimumBoundary = startOffset + Math.max(1, Math.floor(this.chunkSize * 0.4));
        for (const separator of BOUNDARY_SEPARATORS) {
            const searchFrom = Math.max(startOffset, maxEnd - separator.length);
            const boundaryStart = code.lastIndexOf(separator, searchFrom);
            const boundaryEnd = boundaryStart + separator.length;
            if (boundaryStart >= minimumBoundary && boundaryEnd <= maxEnd) {
                return boundaryEnd;
            }
        }

        return this.adjustEndOffset(code, startOffset, maxEnd);
    }

    private adjustEndOffset(code: string, startOffset: number, endOffset: number): number {
        if (
            endOffset > startOffset
            && endOffset < code.length
            && this.isHighSurrogate(code.charCodeAt(endOffset - 1))
            && this.isLowSurrogate(code.charCodeAt(endOffset))
        ) {
            return endOffset - 1;
        }
        return endOffset;
    }

    private adjustStartOffset(code: string, startOffset: number): number {
        if (
            startOffset > 0
            && startOffset < code.length
            && this.isLowSurrogate(code.charCodeAt(startOffset))
            && this.isHighSurrogate(code.charCodeAt(startOffset - 1))
        ) {
            return startOffset + 1;
        }
        return startOffset;
    }

    private isHighSurrogate(code: number): boolean {
        return code >= 0xd800 && code <= 0xdbff;
    }

    private isLowSurrogate(code: number): boolean {
        return code >= 0xdc00 && code <= 0xdfff;
    }

    private collectNewlineOffsets(code: string): number[] {
        const offsets: number[] = [];
        for (let index = 0; index < code.length; index += 1) {
            if (code[index] === '\n') {
                offsets.push(index);
            }
        }
        return offsets;
    }

    private lineForOffset(offset: number, newlineOffsets: number[]): number {
        let low = 0;
        let high = newlineOffsets.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (newlineOffsets[mid] < offset) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        return low + 1;
    }
}
