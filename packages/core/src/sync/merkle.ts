import * as crypto from 'crypto';

function hashChunk(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Compute a deterministic Merkle-like root from file hashes.
 * Input keys are expected to be normalized relative paths.
 */
export function computeMerkleRoot(fileHashes: Map<string, string>): string {
    const hasher = crypto.createHash('sha256');
    const sortedEntries = Array.from(fileHashes.entries()).sort(([a], [b]) => a.localeCompare(b));

    for (const [relativePath, hash] of sortedEntries) {
        hasher.update(relativePath);
        hasher.update('\0');
        hasher.update(hash);
        hasher.update('\n');
    }

    return hasher.digest('hex');
}

export function computeMerkleLeaf(relativePath: string, hash: string): string {
    return hashChunk(`${relativePath}\0${hash}`);
}
