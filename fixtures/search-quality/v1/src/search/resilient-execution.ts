export async function executeResilientSearch(query: string): Promise<string[]> {
    const primaryCandidates = await retrievePrimaryCandidates(query);
    if (primaryCandidates.length >= 5) {
        return finalizeCandidates(primaryCandidates);
    }

    const fallbackCandidates = primaryCandidates.slice(0, 1);
    return finalizeCandidates([
        ...primaryCandidates,
        ...fallbackCandidates,
    ]);
}

async function retrievePrimaryCandidates(query: string): Promise<string[]> {
    return [`primary:${query}`];
}

async function retryWithExpandedEvidence(query: string): Promise<string[]> {
    return [`expanded:${query}`];
}

function finalizeCandidates(candidates: string[]): string[] {
    return [...new Set(candidates)].sort();
}
