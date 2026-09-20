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
    implementationSeeking = false,
    behavioralOwnerSeeking = false,
): {
    selected: T[];
    omitted: Array<{ group: T; reason: "file_diversity_cap" | "symbol_diversity_cap" | "visible_limit" }>;
    summary: SearchDiversitySummary;
} {
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

    // The passes decide which groups survive the caps. They must not decide
    // the output sequence: authoritative retrieval/reranker order remains the
    // only relevance order after diversity omits groups.
    const finalSelectedIds = new Set(selected.slice(0, limit).map((group) => group.__groupId));
    let finalSelected = grouped
        .filter((group) => finalSelectedIds.has(group.__groupId))
        .slice(0, limit);
    const executableKinds = new Set(["class", "constructor", "function", "method"]);
    const isExecutable = (group: T): boolean => (
        executableKinds.has((group.symbolKind ?? "").toLowerCase())
    );

    if (implementationSeeking && groupBy === "symbol") {
        const selectedByFile = new Map<string, T[]>();
        for (const group of finalSelected) {
            selectedByFile.set(group.target.file, [
                ...(selectedByFile.get(group.target.file) ?? []),
                group,
            ]);
        }

        for (const [file, fileSelected] of selectedByFile) {
            if (fileSelected.length < 2 || fileSelected.some(isExecutable)) {
                continue;
            }
            const replacement = grouped.find((group) => (
                group.target.file === file
                && !finalSelectedIds.has(group.__groupId)
                && isExecutable(group)
            ));
            const replaceable = [...fileSelected]
                .reverse()
                .find((group) => !group.__exactLexicalMatch);
            if (!replacement || !replaceable) {
                continue;
            }
            finalSelectedIds.delete(replaceable.__groupId);
            finalSelectedIds.add(replacement.__groupId);
        }

        finalSelected = grouped
            .filter((group) => finalSelectedIds.has(group.__groupId))
            .slice(0, limit);
    }

    if (behavioralOwnerSeeking && groupBy === "symbol") {
        const selectedByFile = new Map<string, T[]>();
        for (const group of finalSelected) {
            selectedByFile.set(group.target.file, [
                ...(selectedByFile.get(group.target.file) ?? []),
                group,
            ]);
        }
        const visibleFrontier = grouped.slice(0, limit);
        for (const [file, fileSelected] of selectedByFile) {
            if (fileSelected.length < 2) {
                continue;
            }
            const strongestExecutable = visibleFrontier
                .filter((group) => group.target.file === file && isExecutable(group))
                .reduce<T | undefined>((strongest, group) => (
                    !strongest || group.score > strongest.score ? group : strongest
                ), undefined);
            if (!strongestExecutable || finalSelectedIds.has(strongestExecutable.__groupId)) {
                continue;
            }
            const replaceable = [...fileSelected]
                .reverse()
                .find((group) => group.score < strongestExecutable.score);
            if (!replaceable) {
                continue;
            }
            finalSelectedIds.delete(replaceable.__groupId);
            finalSelectedIds.add(strongestExecutable.__groupId);
        }
        finalSelected = grouped
            .filter((group) => finalSelectedIds.has(group.__groupId))
            .slice(0, limit);
    }
    const finalFileCounts = new Map<string, number>();
    const finalSymbolCounts = new Map<string, number>();
    for (const group of finalSelected) {
        finalFileCounts.set(group.target.file, (finalFileCounts.get(group.target.file) || 0) + 1);
        const symbolKey = group.__symbolInstanceId || group.__symbolKey || group.target.symbolId;
        if (typeof symbolKey === "string") {
            finalSymbolCounts.set(symbolKey, (finalSymbolCounts.get(symbolKey) || 0) + 1);
        }
    }
    const finalFileCap = summary.usedRelaxedCap
        ? SEARCH_DIVERSITY_RELAXED_FILE_CAP
        : SEARCH_DIVERSITY_MAX_PER_FILE;
    const omitted = grouped
        .filter((group) => !finalSelectedIds.has(group.__groupId))
        .map((group) => {
            const symbolKey = group.__symbolInstanceId || group.__symbolKey || group.target.symbolId;
            const reason = (finalFileCounts.get(group.target.file) || 0) >= finalFileCap
                ? "file_diversity_cap" as const
                : groupBy === "symbol"
                    && typeof symbolKey === "string"
                    && (finalSymbolCounts.get(symbolKey) || 0) >= SEARCH_DIVERSITY_MAX_PER_SYMBOL
                    ? "symbol_diversity_cap" as const
                    : "visible_limit" as const;
            return { group, reason };
        });

    return { selected: finalSelected, omitted, summary };
}
