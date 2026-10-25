import fs from 'node:fs';

export const TYPESCRIPT_METADATA_FILE_BYTES = 1024 * 1024;
export const TYPESCRIPT_METADATA_TOTAL_BYTES = 64 * TYPESCRIPT_METADATA_FILE_BYTES;

export class TypeScriptReadLimitError extends Error {
    constructor(readonly bytes: number) {
        super('TypeScript file read exceeds its byte limit.');
    }
}

/** Bounds the allocation even when a file grows after stat. */
export function readTypeScriptFileBytes(fileName: string, limit: number): Buffer {
    const fd = fs.openSync(fileName, 'r');
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`TypeScript input '${fileName}' is not a regular file.`);
        if (stat.size > limit) throw new TypeScriptReadLimitError(stat.size);
        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= limit) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
            const count = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (count === 0) break;
            total += count;
            if (total > limit) throw new TypeScriptReadLimitError(total);
            chunks.push(chunk.subarray(0, count));
        }
        return Buffer.concat(chunks, total);
    } finally { fs.closeSync(fd); }
}
