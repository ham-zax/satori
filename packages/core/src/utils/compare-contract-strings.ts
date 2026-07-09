/**
 * Deterministic total order for contract-critical string keys (Merkle, etc.).
 * Uses UTF-16 code-unit ordering (same as `<` / `>` on JavaScript strings).
 * Does not use localeCompare / ICU / host locale.
 */
export function compareContractStrings(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}
