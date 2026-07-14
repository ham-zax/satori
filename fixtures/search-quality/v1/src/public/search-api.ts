import { planQuery } from '../search/query-router.js';
import { executeSearch } from '../search/execution.js';
import { finalizeResults } from '../search/finalize.js';

export function searchCodebase(query: string): string[] {
    const plan = planQuery(query);
    const candidates = executeSearch(plan);
    return finalizeResults(candidates);
}
