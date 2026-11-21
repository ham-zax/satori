import fs from 'node:fs';
import type { TypeScriptFsBoundary } from './typescript-fs-boundary';

export const TYPESCRIPT_METADATA_FILE_BYTES = 1024 * 1024;
export const TYPESCRIPT_METADATA_TOTAL_BYTES = 64 * TYPESCRIPT_METADATA_FILE_BYTES;

export class TypeScriptReadLimitError extends Error {
    constructor(readonly bytes: number) {
        super('TypeScript file read exceeds its byte limit.');
    }
}

export class TypeScriptBoundaryError extends Error {
    constructor(fileName: string) {
        super(`TypeScript input '${fileName}' resolves outside the allowed repository boundary.`);
        this.name = 'TypeScriptBoundaryError';
    }
}

/**
 * Bounds allocation even when a file grows after stat, refuses non-regular
 * files (including FIFOs, sockets, and devices) before opening so reads cannot
 * hang, and enforces repository-root containment when a boundary is supplied.
 */
export function readTypeScriptFileBytes(
    fileName: string,
    limit: number,
    boundary?: TypeScriptFsBoundary,
): Buffer {
    const targetPath = boundary ? boundary.resolveAllowedPath(fileName) : fileName;
    if (targetPath === null) {
        throw new TypeScriptBoundaryError(fileName);
    }

    // Check file type before openSync so a named pipe (FIFO) never blocks.
    const preStat = fs.statSync(targetPath);
    if (!preStat.isFile()) {
        throw new Error(`TypeScript input '${fileName}' is not a regular file.`);
    }

    const openFlags = fs.constants.O_RDONLY
        | (fs.constants.O_NONBLOCK ?? 0)
        | (boundary ? (fs.constants.O_NOFOLLOW ?? 0) : 0);
    const fd = fs.openSync(targetPath, openFlags);
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
