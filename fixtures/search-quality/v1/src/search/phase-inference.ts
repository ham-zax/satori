export type SearchPhase = "exact" | "semantic" | "hybrid";

export function normalizePhaseSignals(query: string): string[] {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function inferPhase(query: string, hasExactIdentifier: boolean): SearchPhase {
    const signals = normalizePhaseSignals(query);
    if (hasExactIdentifier && signals.length <= 2) return "exact";
    if (signals.some((signal) => signal === "behavior" || signal === "concept")) return "semantic";
    return "hybrid";
}

export function explainPhase(query: string, hasExactIdentifier: boolean): string {
    return `selected ${inferPhase(query, hasExactIdentifier)} retrieval`;
}
