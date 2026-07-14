import type { SearchPlan } from './query-router.js';
import { retrieveCandidates } from './retrieval.js';
import { rankCandidates } from './ranking.js';
import { finalizeResults } from './finalize.js';

export function executeSearch(plan: SearchPlan): string[] {
    const candidates = retrieveCandidates(plan);
    const ranked = rankCandidates(candidates);
    return finalizeResults(ranked);
}
