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
    usedComplementaryOwnerSlot: boolean;
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
    // Kept in the call contract because query planning still supplies it; the
    // owner-aware sibling policy is intentionally not query-gated.
    void behavioralOwnerSeeking;

    const summary: SearchDiversitySummary = {
        maxPerFile: SEARCH_DIVERSITY_MAX_PER_FILE,
        maxPerSymbol: SEARCH_DIVERSITY_MAX_PER_SYMBOL,
        relaxedFileCap: SEARCH_DIVERSITY_RELAXED_FILE_CAP,
        skippedByFileCap: 0,
        skippedBySymbolCap: 0,
        usedRelaxedCap: false,
        usedComplementaryOwnerSlot: false,
    };

    const selected: T[] = [];
    const selectedIds = new Set<string>();
    const fileCounts = new Map<string, number>();
    const symbolCounts = new Map<string, number>();
    const complementaryOwnerFiles = new Set<string>();
    const executableKinds = new Set(["class", "constructor", "function", "method"]);
    const isExecutable = (group: T): boolean => (
        executableKinds.has((group.symbolKind ?? "").toLowerCase())
    );

    const applyPass = (fileCap: number): void => {
        for (const group of grouped) {
            if (selected.length >= limit) {
                return;
            }
            if (selectedIds.has(group.__groupId)) {
                continue;
            }

            const fileCount = fileCounts.get(group.target.file) || 0;
            const symbolDiversityKey = group.__symbolInstanceId || group.__symbolKey || group.target.symbolId;
            const complementaryOwnerSlot = groupBy === "symbol"
                && fileCap === SEARCH_DIVERSITY_MAX_PER_FILE
                && fileCount === SEARCH_DIVERSITY_MAX_PER_FILE
                && typeof symbolDiversityKey === "string"
                && !complementaryOwnerFiles.has(group.target.file)
                && isExecutable(group);
            if (fileCount >= fileCap && !complementaryOwnerSlot) {
                summary.skippedByFileCap += 1;
                continue;
            }

            if (groupBy === "symbol" && typeof symbolDiversityKey === "string") {
                const symbolCount = symbolCounts.get(symbolDiversityKey) || 0;
                if (symbolCount >= SEARCH_DIVERSITY_MAX_PER_SYMBOL) {
                    summary.skippedBySymbolCap += 1;
                    continue;
                }
                symbolCounts.set(symbolDiversityKey, symbolCount + 1);
            }

            if (complementaryOwnerSlot) {
                complementaryOwnerFiles.add(group.target.file);
                summary.usedComplementaryOwnerSlot = true;
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

    const finalFileCounts = new Map<string, number>();
    const finalFileOwnerKeys = new Map<string, Set<string>>();
    const finalSymbolCounts = new Map<string, number>();
    for (const group of finalSelected) {
        const file = group.target.file;
        finalFileCounts.set(file, (finalFileCounts.get(file) || 0) + 1);
        const symbolKey = group.__symbolInstanceId || group.__symbolKey || group.target.symbolId;
        if (typeof symbolKey === "string") {
            finalSymbolCounts.set(symbolKey, (finalSymbolCounts.get(symbolKey) || 0) + 1);
            const ownerKeys = finalFileOwnerKeys.get(file) ?? new Set<string>();
            ownerKeys.add(symbolKey);
            finalFileOwnerKeys.set(file, ownerKeys);
        }
    }
    const omitted = grouped
        .filter((group) => !finalSelectedIds.has(group.__groupId))
        .map((group) => {
            const file = group.target.file;
            const fileCount = finalFileCounts.get(file) || 0;
            const symbolKey = group.__symbolInstanceId || group.__symbolKey || group.target.symbolId;
            const complementaryOwnerSlotAvailable = (
                !summary.usedRelaxedCap
                && fileCount === SEARCH_DIVERSITY_MAX_PER_FILE
                && groupBy === "symbol"
                && typeof symbolKey === "string"
                && !finalFileOwnerKeys.get(file)?.has(symbolKey)
                && isExecutable(group)
            );
            const blockedByFileCap = summary.usedRelaxedCap
                ? fileCount >= SEARCH_DIVERSITY_RELAXED_FILE_CAP
                : fileCount > SEARCH_DIVERSITY_MAX_PER_FILE
                    || (
                        fileCount === SEARCH_DIVERSITY_MAX_PER_FILE
                        && !complementaryOwnerSlotAvailable
                    );
            const reason = blockedByFileCap
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
