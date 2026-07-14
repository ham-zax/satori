export function normalizeSourceScores(scores: number[]): number[] {
    const maximum = Math.max(...scores, 1);
    return scores.map((score) => score / maximum);
}
export function applyRoleBoosts(candidate: string): number {
    return candidate.includes('runtime') ? 1.25 : 1;
}

export function rankCandidates(candidates: string[]): string[] {
    return [...candidates].sort((left, right) => {
        return applyRoleBoosts(right) - applyRoleBoosts(left)
            || left.localeCompare(right);
    });
}
