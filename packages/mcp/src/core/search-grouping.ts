import crypto from "node:crypto";
import { SEARCH_DIVERSITY_MAX_PER_FILE, SEARCH_DIVERSITY_MAX_PER_SYMBOL, SEARCH_DIVERSITY_RELAXED_FILE_CAP, type SearchGroupBy } from "./search-constants.js";
import type { SearchGroupResult, SearchSpan } from "./search-types.js";

export type SearchDiversitySummary = {
    maxPerFile: number;
    maxPerSymbol: number;
    relaxedFileCap: number;
    skippedByFileCap: number;
    skippedBySymbolCap: number;
    usedRelaxedCap: boolean;
};

export function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const left = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
    const right = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
    return left - right;
}

export function compareNullableStringsAsc(a?: string | null, b?: string | null): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
}

export function buildFallbackGroupId(relativePath: string, span: SearchSpan): string {
    const payload = `${relativePath}:${span.startLine}-${span.endLine}`;
    const digest = crypto.createHash("sha1").update(payload, "utf8").digest("hex").slice(0, 16);
    return `grp_${digest}`;
}

export function applyGroupDiversity<T extends SearchGroupResult>(
    grouped: T[],
    limit: number,
    groupBy: SearchGroupBy,
): { selected: T[]; summary: SearchDiversitySummary } {
    const summary: SearchDiversitySummary = {
        maxPerFile: SEARCH_DIVERSITY_MAX_PER_FILE,
        maxPerSymbol: SEARCH_DIVERSITY_MAX_PER_SYMBOL,
        relaxedFileCap: SEARCH_DIVERSITY_RELAXED_FILE_CAP,
        skippedByFileCap: 0,
        skippedBySymbolCap: 0,
        usedRelaxedCap: false,
    };

    const selected: T[] = [];
    const selectedIds = new Set<string>();
    const fileCounts = new Map<string, number>();
    const symbolCounts = new Map<string, number>();

    const applyPass = (fileCap: number): void => {
        for (const group of grouped) {
            if (selected.length >= limit) {
                return;
            }
            if (selectedIds.has(group.__groupId)) {
                continue;
            }

            const fileCount = fileCounts.get(group.target.file) || 0;
            if (fileCount >= fileCap) {
                summary.skippedByFileCap += 1;
                continue;
            }

            const symbolDiversityKey = group.__symbolInstanceId || group.__symbolKey || group.target.symbolId;
            if (groupBy === "symbol" && typeof symbolDiversityKey === "string") {
                const symbolCount = symbolCounts.get(symbolDiversityKey) || 0;
                if (symbolCount >= SEARCH_DIVERSITY_MAX_PER_SYMBOL) {
                    summary.skippedBySymbolCap += 1;
                    continue;
                }
                symbolCounts.set(symbolDiversityKey, symbolCount + 1);
            }

            selected.push(group);
            selectedIds.add(group.__groupId);
            fileCounts.set(group.target.file, fileCount + 1);
        }
    };

    applyPass(SEARCH_DIVERSITY_MAX_PER_FILE);
    if (selected.length < Math.min(limit, grouped.length)) {
        summary.usedRelaxedCap = true;
        applyPass(SEARCH_DIVERSITY_RELAXED_FILE_CAP);
    }

    return { selected: selected.slice(0, limit), summary };
}
