import type { SearchGroupResult } from "./search-types.js";
import type { SearchOrderAuthority } from "./search-order-policy.js";

export function isDeclarationSearchGroup(group: SearchGroupResult): boolean {
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

function compareAuthoritativeRanks(a: SearchGroupResult, b: SearchGroupResult): number {
    const left = a.__authoritativeRank ?? Number.POSITIVE_INFINITY;
    const right = b.__authoritativeRank ?? Number.POSITIVE_INFINITY;
    return left - right;
}

export function sortNativeGroupedSearchResults<
    T extends SearchGroupResult & { __exactLexicalMatch: boolean },
>(
    results: T[],
    exactMatchPinningEnabled: boolean,
    orderAuthority: SearchOrderAuthority = "retrieval_order",
): boolean {
    const shouldPinExactMatch = exactMatchPinningEnabled && orderAuthority !== "reranker_order";
    const topWithoutPinning = results[0];
    results.sort((a, b) => {
        if (shouldPinExactMatch && a.__exactLexicalMatch !== b.__exactLexicalMatch) {
            return a.__exactLexicalMatch ? -1 : 1;
        }
        return compareAuthoritativeRanks(a, b);
    });
    const applied = Boolean(
        shouldPinExactMatch
        && topWithoutPinning
        && results.length > 0
        && topWithoutPinning.__exactLexicalMatch !== results[0].__exactLexicalMatch,
    );
    if (applied && results[0].debug?.provenance) {
        results[0].debug.provenance.exactMatchPinned = true;
    }
    return applied;
}

export function collapseDuplicateDeclarationGroups<T extends SearchGroupResult>(
    groups: T[],
): T[] {
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
        const winner = compareAuthoritativeRanks(group, existing) < 0 ? group : existing;
        deduped.set(key, { ...winner, __candidateIds: candidateIds });
    }

    return Array.from(deduped.values());
}

// This deliberately recognizes only simple wrappers. Unsupported syntax stays
// distinct; a display preview cannot prove that two implementations are equal.
function simpleWrapperTokens(content: string): string[] | null {
    const tokens: string[] = [];
    let offset = 0;
    while (offset < content.length) {
        const rest = content.slice(offset);
        const trivia = /^(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
        if (trivia) {
            if (/[\r\n]/.test(trivia[0]) && ["return", "async"].includes(tokens.at(-1) ?? "")) return null;
            offset += trivia[0].length;
            continue;
        }
        if (rest[0] === "'" || rest[0] === '"') {
            const quote = rest[0];
            let end = 1;
            for (; end < rest.length && rest[end] !== quote; end += 1) {
                if (rest[end] === "\\") end += 1;
                else if (rest[end] === "\n" || rest[end] === "\r") return null;
            }
            if (end >= rest.length) return null;
            tokens.push(rest.slice(0, end + 1));
            offset += end + 1;
            continue;
        }
        const token = /^(?:[a-zA-Z_$][\w$]*|\d+(?:\.\d+)?|=>|===|!==|==|!=|<=|>=|&&|\|\||[()[\]{}.,;:=<>|?+*!&%-])/.exec(rest);
        if (!token || rest.startsWith("++") || rest.startsWith("--")) return null;
        tokens.push(token[0]);
        offset += token[0].length;
    }

    const stack: string[] = [];
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "(" || token === "[" || token === "{") {
            if (token === "{" && stack.length === 0) bodyStart = index;
            stack.push(token);
        } else if (token === ")" || token === "]" || token === "}") {
            const opening = token === ")" ? "(" : token === "]" ? "[" : "{";
            if (stack.pop() !== opening) return null;
            if (token === "}" && stack.length === 0) bodyEnd = index;
        }
    }
    if (stack.length || bodyStart < 0 || bodyEnd <= bodyStart
        || !tokens.slice(0, bodyStart).includes("(")
        || !(bodyEnd === tokens.length - 1
            || (bodyEnd === tokens.length - 2 && tokens.at(-1) === ","))) return null;

    const body = tokens.slice(bodyStart + 1, bodyEnd);
    if (body.at(-1) !== ";" || body.some((token) => token === "{" || token === "}")) return null;
    const identifier = /^[a-zA-Z_$][\w$]*$/;
    const scalar = /^(?:[a-zA-Z_$][\w$]*|\d+(?:\.\d+)?|'[\s\S]*'|"[\s\S]*")$/;
    let statement: string[] = [];
    for (const token of body) {
        if (token !== ";") {
            statement.push(token);
            continue;
        }
        if (statement[0] === "return") statement = statement.slice(1);
        const assignment = statement.length === 3 && identifier.test(statement[0])
            && statement[1] === "=" && scalar.test(statement[2]);
        const callStart = statement.indexOf("(");
        const target = statement.slice(0, callStart);
        const call = callStart > 0 && statement.at(-1) === ")"
            && target.every((part, index) => index % 2 === 0 ? identifier.test(part) : part === ".")
            && target.length % 2 === 1
            && !["if", "while", "for", "switch", "with", "catch"].includes(target[0])
            && statement.slice(callStart).every((part) => scalar.test(part) || ["(", ")", ",", "."].includes(part));
        if (!assignment && !call) return null;
        statement = [];
    }
    return tokens;
}

export function collapseEquivalentImplementationGroups<T extends SearchGroupResult>(groups: T[]): T[] {
    const deduped: T[] = [];
    const representatives = new Map<string, number>();
    for (const group of groups) {
        const content = group.__implementationContent;
        const supported = (group.symbolKind === "function" || group.symbolKind === "method")
            && ["javascript", "typescript", "jsx", "tsx"].includes(group.language);
        const tokens = supported && content ? simpleWrapperTokens(content) : null;
        const key = tokens
            ? JSON.stringify([group.target.file, group.language, group.displayLabel, tokens])
            : null;
        const index = key ? representatives.get(key) : undefined;
        if (index === undefined) {
            if (key) representatives.set(key, deduped.length);
            deduped.push(group);
            continue;
        }
        const existing = deduped[index];
        const winner = compareAuthoritativeRanks(group, existing) < 0 ? group : existing;
        deduped[index] = {
            ...winner,
            __candidateIds: Array.from(new Set([...existing.__candidateIds, ...group.__candidateIds])).sort(),
        };
    }
    return deduped;
}

export function collapseSupersededFileGroups<T extends SearchGroupResult>(groups: T[]): T[] {
    const preciseByFile = new Map<string, T[]>();
    for (const group of groups) {
        if (group.__sourceBackedQueryEvidence && group.__symbolInstanceId
            && group.target.symbolId && group.quality.owner === "high"
            && ["function", "method"].includes(group.symbolKind ?? "")) {
            preciseByFile.set(group.target.file, [...(preciseByFile.get(group.target.file) ?? []), group]);
        }
    }
    const span = (group: T) => group.__declarationSpan ?? group.target.span;
    // The precise function takes over the superseded file's position: the file
    // ranked there on evidence from the same source, so dropping it must not
    // also drop the file below results it outranked.
    const promoted = new Map<T, T>();
    const kept = groups.filter((group) => {
        if (!["file", "module"].includes(group.symbolKind ?? "")) return true;
        const contained = (preciseByFile.get(group.target.file) ?? []).filter((precise) =>
            span(group).startLine <= span(precise).startLine && span(precise).endLine <= span(group).endLine);
        if (contained.length === 0) return true;
        const best = contained.reduce((left, right) =>
            compareAuthoritativeRanks(promoted.get(right) ?? right, promoted.get(left) ?? left) < 0 ? right : left);
        const current = promoted.get(best) ?? best;
        if (compareAuthoritativeRanks(group, current) < 0) {
            promoted.set(best, {
                ...current,
                __authoritativeRank: group.__authoritativeRank,
                __candidateIds: Array.from(new Set([...current.__candidateIds, ...group.__candidateIds])).sort(),
            });
        }
        return false;
    });
    return kept.map((group) => promoted.get(group) ?? group);
}
