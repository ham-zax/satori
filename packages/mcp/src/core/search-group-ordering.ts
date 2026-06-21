import type { SearchGroupResult } from "./search-types.js";

function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const av = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
    const bv = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
    return av - bv;
}

function compareNullableStringsAsc(a?: string | null, b?: string | null): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
}

function compareGroupedSearchResults(
    a: SearchGroupResult,
    b: SearchGroupResult,
): number {
    if (b.score !== a.score) return b.score - a.score;
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    const spanCmp = compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
    if (spanCmp !== 0) return spanCmp;
    const labelCmp = compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
    if (labelCmp !== 0) return labelCmp;
    return compareNullableStringsAsc(a.symbolId, b.symbolId);
}

function isDeclarationSearchGroup(group: SearchGroupResult): boolean {
    const label = (group.symbolLabel || "").trim().toLowerCase();
    if (/^(class|type|interface|enum|struct|function|def)\b/.test(label)) {
        return true;
    }
    if (/^(const|let|var)\s+[a-z0-9_$]+\s*=/.test(label)) {
        return true;
    }

    const previewStart = (group.preview || "").slice(0, 240).toLowerCase();
    return /\b(class|type|interface|enum|struct|function|def)\s+[a-z0-9_]/i.test(previewStart)
        || /\b(?:const|let|var)\s+[a-z0-9_$]+\s*=\s*(?:async\s+)?function\b/i.test(previewStart)
        || /\b(?:const|let|var)\s+[a-z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/i.test(previewStart);
}

function normalizeDeclarationGroupKey(group: SearchGroupResult): string | null {
    if (!group.file || !group.symbolLabel) {
        return null;
    }
    if (!isDeclarationSearchGroup(group)) {
        return null;
    }

    const normalizedLabel = group.symbolLabel
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    const ownerIdentity = group.symbolKey || group.symbolInstanceId;
    return ownerIdentity
        ? `${group.file}::${normalizedLabel}::${ownerIdentity}`
        : `${group.file}::${normalizedLabel}`;
}

export function sortGroupedSearchResults<T extends SearchGroupResult & { __exactLexicalMatch: boolean }>(
    results: T[],
    exactMatchPinningEnabled: boolean,
): boolean {
    const topWithoutPinning = results.length > 0
        ? [...results].sort((a, b) => compareGroupedSearchResults(a, b))[0]
        : undefined;
    results.sort((a, b) => {
        if (exactMatchPinningEnabled && a.__exactLexicalMatch !== b.__exactLexicalMatch) {
            return a.__exactLexicalMatch ? -1 : 1;
        }
        return compareGroupedSearchResults(a, b);
    });
    const applied = Boolean(
        exactMatchPinningEnabled
        && topWithoutPinning
        && results.length > 0
        && topWithoutPinning.__exactLexicalMatch !== results[0].__exactLexicalMatch
    );
    if (applied && results[0].debug?.provenance) {
        results[0].debug.provenance.exactMatchPinned = true;
    }
    return applied;
}

export function collapseDuplicateDeclarationGroups<T extends SearchGroupResult>(groups: T[]): T[] {
    const deduped = new Map<string, T>();
    for (const group of groups) {
        const key = normalizeDeclarationGroupKey(group);
        if (!key) {
            deduped.set(`unique:${deduped.size}`, group);
            continue;
        }

        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, group);
            continue;
        }

        if (compareGroupedSearchResults(group, existing) < 0) {
            deduped.set(key, group);
        }
    }

    return Array.from(deduped.values());
}
