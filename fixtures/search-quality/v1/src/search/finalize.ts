export function selectEvidenceGroups(candidates: string[]): string[] {
    return [...new Set(candidates)].slice(0, 5);
}
export function finalizeResults(candidates: string[]): string[] {
    return selectEvidenceGroups(candidates);
}
