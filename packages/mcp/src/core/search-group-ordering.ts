import type { SearchGroupResult } from "./search-types.js";

/** Relative score gap treated as a near-tie for tight-owner preference. */
export const GROUPED_SCORE_NEAR_TIE_RATIO = 0.05;

function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const av = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
    const bv = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
    return av - bv;
}

/** Deterministic string order (no localeCompare). */
function compareContractStringsAsc(a?: string | null, b?: string | null): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

export function scoresNearlyEqual(a: number, b: number): boolean {
    const max = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return Math.abs(a - b) / max <= GROUPED_SCORE_NEAR_TIE_RATIO;
}

function symbolKindRank(kind?: string): number {
    const normalized = (kind || "").trim().toLowerCase();
    if (normalized === "method" || normalized === "function") {
        return 0;
    }
    if (normalized === "const" || normalized === "variable" || normalized === "property") {
        return 1;
    }
    if (
        normalized === "class"
        || normalized === "interface"
        || normalized === "type"
        || normalized === "enum"
        || normalized === "struct"
    ) {
        return 2;
    }
    if (normalized === "file") {
        return 4;
    }
    return 3;
}

function resolveOwnerSpan(group: SearchGroupResult): { startLine?: number; endLine?: number } | undefined {
    return group.target.span;
}

function spanLineCount(group: SearchGroupResult): number {
    const span = resolveOwnerSpan(group);
    if (!span || typeof span.startLine !== "number" || typeof span.endLine !== "number") {
        return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, span.endLine - span.startLine);
}

/**
 * On near-tied scores, prefer tighter proof units:
 * - method/function over class/file (cross-file ok)
 * - declaration over comment/prose (cross-file ok)
 * - smaller span only within the same file (avoid demoting large core owners vs tiny wrappers)
 */
function compareTightOwnerPreference(a: SearchGroupResult, b: SearchGroupResult): number {
    const aKind = a.symbolKind?.trim();
    const bKind = b.symbolKind?.trim();
    if (aKind || bKind) {
        const kindCmp = symbolKindRank(a.symbolKind) - symbolKindRank(b.symbolKind);
        if (kindCmp !== 0) {
            return kindCmp;
        }
    }

    const aDecl = isDeclarationSearchGroup(a);
    const bDecl = isDeclarationSearchGroup(b);
    if (aDecl !== bDecl) {
        return aDecl ? -1 : 1;
    }

    if (a.target.file === b.target.file) {
        const spanCmp = spanLineCount(a) - spanLineCount(b);
        if (spanCmp !== 0) {
            return spanCmp;
        }
    }

    return 0;
}

function compareGroupedSearchResults(
    a: SearchGroupResult,
    b: SearchGroupResult,
): number {
    if (!scoresNearlyEqual(a.score, b.score)) {
        return b.score - a.score;
    }

    const tightCmp = compareTightOwnerPreference(a, b);
    if (tightCmp !== 0) {
        return tightCmp;
    }

    // Clear score winner when tight preference is equal (preserve ranking signal).
    if (b.score !== a.score) {
        return b.score - a.score;
    }

    const fileCmp = compareContractStringsAsc(a.target.file, b.target.file);
    if (fileCmp !== 0) return fileCmp;
    const spanCmp = compareNullableNumbersAsc(a.target.span.startLine, b.target.span.startLine);
    if (spanCmp !== 0) return spanCmp;
    const labelCmp = compareContractStringsAsc(a.displayLabel, b.displayLabel);
    if (labelCmp !== 0) return labelCmp;
    return compareContractStringsAsc(a.target.symbolId, b.target.symbolId);
}

function isDeclarationSearchGroup(group: SearchGroupResult): boolean {
    const label = group.displayLabel.trim().toLowerCase();
    if (/^(?:async\s+)?(?:class|type|interface|enum|struct|function|method|def)\b/.test(label)) {
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
    if (!group.target.file || !group.displayLabel) {
        return null;
    }
    if (!isDeclarationSearchGroup(group)) {
        return null;
    }

    const normalizedLabel = group.displayLabel
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    const ownerIdentity = group.__symbolKey || group.__symbolInstanceId;
    return ownerIdentity
        ? `${group.target.file}::${normalizedLabel}::${ownerIdentity}`
        : `${group.target.file}::${normalizedLabel}`;
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

        const candidateIds = Array.from(new Set([
            ...existing.__candidateIds,
            ...group.__candidateIds,
        ])).sort();
        const winner = compareGroupedSearchResults(group, existing) < 0 ? group : existing;
        deduped.set(key, { ...winner, __candidateIds: candidateIds });
    }

    return Array.from(deduped.values());
}
