import type { SearchPlan } from './query-router.js';

export function retrieveCandidates(plan: SearchPlan): string[] {
    return [plan.query, plan.route];
}
export function expandSemanticCandidates(query: string): string[] {
    return [`${query} implementation runtime source entrypoint`];
}
