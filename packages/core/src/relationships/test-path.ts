/**
 * Classifies repository-relative test and fixture paths for relationship
 * evidence. Keep this independent from search ranking: it decides whether an
 * already resolved call may also be published as a TESTS relationship.
 */
export function isTestOrFixturePath(file: string): boolean {
    const normalized = file.trim().replace(/\\/g, '/');
    if (!normalized) {
        return false;
    }
    const base = normalized.split('/').pop() || normalized;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) {
        return true;
    }
    if (/(^|\/)(__tests__|__mocks__|fixtures|testdata|test-data)(\/|$)/i.test(normalized)) {
        return true;
    }
    return /(^|\/)tests?(\/|$)/i.test(normalized)
        && !/(^|\/)packages\/[^/]+\/src\//i.test(normalized);
}
