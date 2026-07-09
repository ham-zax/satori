import * as crypto from 'crypto';
import { compareContractStrings } from '../utils/compare-contract-strings';

function hashChunk(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Compute a deterministic Merkle-like root from file hashes.
 * Input keys are expected to be normalized relative paths.
 * Ordering uses code-unit compare (not localeCompare) so roots are stable across hosts/locales.
 */
export function computeMerkleRoot(fileHashes: Map<string, string>): string {
    const hasher = crypto.createHash('sha256');
    const sortedEntries = Array.from(fileHashes.entries()).sort(([a], [b]) => compareContractStrings(a, b));

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
