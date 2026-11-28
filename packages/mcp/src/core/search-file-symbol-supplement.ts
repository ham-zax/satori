import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { readCurrentSourceEvidence, type CurrentSourceEvidence } from "./current-source-symbols.js";
import type { SearchLexicalTerm, SearchResultLike } from "./search-lexical-scoring.js";
import type { PreparedSearchRerankStructuralRelationships } from "./search-rerank-structural-context.js";

const MAX_FILES = 3;
const MAX_SYMBOL_LINES = 1_000;
const MAX_CONTENT_PREVIEW_LINES = 400;
const MAX_GRAPH_SEED_OWNERS = 6;
const MAX_GRAPH_CALLEES = 6;

function normalizedTerms(value: string): Set<string> {
    return new Set((value + " " + value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean)
        .map((term) => term.replace(/(?:ing|ed|s)$/, "")));
}

function pathContextScore(file: string, queryTerms: Set<string>): number {
    const pathTerms = normalizedTerms(file);
    const matches = [...queryTerms].filter((term) => pathTerms.has(term)).length;
    return matches >= 2 ? matches : 0;
}

/** Recover bounded symbol evidence inside files already found by retrieval
 * and across high-confidence verified CALLS edges from top retrieved owners.
 * The source hash must match the Publication; this never retargets a broad
 * chunk or infers ownership from a function name.
 */
export async function supplementSearchFileSymbols(input: {
    candidates: readonly SearchResultLike[];
    lexicalTerms: readonly SearchLexicalTerm[];
    registry: SymbolRegistry;
    codebaseRoot: string;
    preparedStructuralRelationships?: PreparedSearchRerankStructuralRelationships;
    readSourceEvidence?: typeof readCurrentSourceEvidence;
}): Promise<SearchResultLike[]> {
    const queryTerms = new Set(input.lexicalTerms.filter((term) => term.kind === "whole")
        .flatMap((term) => [...normalizedTerms(term.value)]));
    if (queryTerms.size < 2) return [];
    const readEvidence = input.readSourceEvidence ?? readCurrentSourceEvidence;
    const loadedEvidenceByFile = new Map<
        string,
        Readonly<{ evidence: CurrentSourceEvidence; lines: readonly string[] }> | null
    >();
    const loadVerifiedFile = async (
        file: string,
    ): Promise<Readonly<{ evidence: CurrentSourceEvidence; lines: readonly string[] }> | null> => {
        if (loadedEvidenceByFile.has(file)) return loadedEvidenceByFile.get(file) ?? null;
        const manifestFile = input.registry.manifest.files.find((entry) => entry.path === file);
        if (!manifestFile) {
            loadedEvidenceByFile.set(file, null);
            return null;
        }
        let evidence: CurrentSourceEvidence | undefined;
        try {
            evidence = await readEvidence(input.codebaseRoot, file);
        } catch {
            loadedEvidenceByFile.set(file, null);
            return null;
        }
        if (!evidence || evidence.relativeFile !== file || evidence.observedHash !== manifestFile.hash) {
            loadedEvidenceByFile.set(file, null);
            return null;
        }
        const loaded = { evidence, lines: evidence.source.split(/\r?\n/) };
        loadedEvidenceByFile.set(file, loaded);
        return loaded;
    };
    const results: SearchResultLike[] = [];
    const emittedKeys = new Set<string>();
    const symbolEmissionKey = (symbol: SymbolRecord): string => `${symbol.file}\0${symbol.symbolInstanceId}`;
    const appendSymbolResult = (symbol: SymbolRecord, lines: readonly string[]): void => {
        const key = symbolEmissionKey(symbol);
        if (emittedKeys.has(key)) return;
        emittedKeys.add(key);
        const existing = input.candidates.find((candidate) => candidate.ownerSymbolInstanceId === symbol.symbolInstanceId
            && candidate.startLine === symbol.span.startLine && candidate.endLine === symbol.span.endLine);
        if (existing) {
            // Return the original identity as bounded admission evidence;
            // the search owner marks it preferred without duplicating it.
            results.push(existing);
            return;
        }
        const previewEndLine = Math.min(
            symbol.span.endLine,
            symbol.span.startLine + MAX_CONTENT_PREVIEW_LINES - 1,
        );
        results.push({
            relativePath: symbol.file,
            language: symbol.language,
            symbolKind: symbol.kind,
            symbolLabel: symbol.label,
            symbolId: symbol.symbolKey,
            ownerSymbolKey: symbol.symbolKey,
            ownerSymbolInstanceId: symbol.symbolInstanceId,
            startLine: symbol.span.startLine,
            endLine: symbol.span.endLine,
            startByte: symbol.span.startByte,
            endByte: symbol.span.endByte,
            content: lines.slice(symbol.span.startLine - 1, previewEndLine).join("\n"),
        });
    };

    // Preserve retrieval order across distinct files. Declaration names do not
    // establish implementation relevance; the source body must prove it below.
    const files = [...new Set(input.candidates.map((candidate) => candidate.relativePath))]
        .slice(0, MAX_FILES);
    // A declaration-supported file can be retrieved below the initial file
    // window. Retain the previous bounded declaration lane alongside the
    // retrieval lane, so precise generator symbols remain discoverable.
    // Overlap must not consume the additional lane's file budget.
    const declarationFiles = [...new Set(input.candidates.map((candidate) => candidate.relativePath))]
        .filter((file) => !files.includes(file))
        .map((file, rank) => ({ file, rank, context: pathContextScore(file, queryTerms), matches: (input.registry.symbolsByFile.get(file) ?? [])
            .filter((symbol) => ["function", "method"].includes(symbol.kind)
                && [...normalizedTerms(symbol.name)].some((term) => queryTerms.has(term))).length }))
        .sort((a, b) => b.context - a.context || b.matches - a.matches || a.rank - b.rank)
        .slice(0, MAX_FILES).map(({ file }) => file);
    files.push(...declarationFiles.filter((file) => !files.includes(file)));
    for (const file of files) {
        const loaded = await loadVerifiedFile(file);
        if (!loaded) continue;
        const { evidence, lines } = loaded;
        const pathTerms = normalizedTerms(file);
        const hasPathContext = pathContextScore(file, queryTerms) > 0;
        const ranked = (input.registry.symbolsByFile.get(file) ?? []).flatMap((symbol) => {
            if (!["function", "method"].includes(symbol.kind)
                || symbol.fileHash !== evidence.observedHash
                || symbol.span.startLine < 1 || symbol.span.endLine > lines.length
                || symbol.span.endLine - symbol.span.startLine + 1 > MAX_SYMBOL_LINES) return [];
            const content = lines.slice(symbol.span.startLine - 1, symbol.span.endLine).join("\n");
            const contentTerms = normalizedTerms(content);
            const nameTerms = normalizedTerms(symbol.name);
            const matched = [...queryTerms].filter((term) => contentTerms.has(term) || nameTerms.has(term));
            const sourceOnlyMatch = matched.some((term) => contentTerms.has(term)
                && !pathTerms.has(term) && !nameTerms.has(term));
            if (!matched.some((term) => !pathTerms.has(term))
                || (matched.length < 2 && !(hasPathContext && sourceOnlyMatch))) return [];
            return [{ symbol, matches: matched.length,
                nameMatches: matched.filter((term) => nameTerms.has(term)).length }];
        }).sort((left, right) => right.matches - left.matches
            || right.nameMatches - right.nameMatches
            || left.symbol.span.startLine - right.symbol.span.startLine);
        for (const { symbol } of ranked) {
            appendSymbolResult(symbol, lines);
        }
    }

    // Bounded verified graph-callee admission: when high-confidence or
    // proof-backed CALLS edges exist from top retrieved owners, admit callees
    // whose publication-verified body or name matches non-path query terms
    // (e.g. FromData -> permutateMatches).
    const outgoingCalls = input.preparedStructuralRelationships?.outgoingCallsBySourceInstanceId;
    if (outgoingCalls && outgoingCalls.size > 0 && input.registry.symbolsByInstanceId) {
        const seedOwnerIds: string[] = [];
        const seenSeedOwners = new Set<string>();
        for (const candidate of input.candidates) {
            const ownerId = typeof candidate.ownerSymbolInstanceId === "string"
                ? candidate.ownerSymbolInstanceId.trim()
                : "";
            if (!ownerId || seenSeedOwners.has(ownerId)) continue;
            seenSeedOwners.add(ownerId);
            seedOwnerIds.push(ownerId);
            if (seedOwnerIds.length >= MAX_GRAPH_SEED_OWNERS) break;
        }
        let admittedGraphCallees = 0;
        for (const seedOwnerId of seedOwnerIds) {
            if (admittedGraphCallees >= MAX_GRAPH_CALLEES) break;
            const edges = outgoingCalls.get(seedOwnerId);
            if (!edges || edges.length === 0) continue;
            for (const edge of edges) {
                if (admittedGraphCallees >= MAX_GRAPH_CALLEES) break;
                const targetId = typeof edge.targetInstanceId === "string"
                    ? edge.targetInstanceId.trim()
                    : "";
                if (!targetId) continue;
                const target = input.registry.symbolsByInstanceId.get(targetId);
                if (!target || emittedKeys.has(symbolEmissionKey(target)) || !["function", "method"].includes(target.kind)) continue;
                const loaded = await loadVerifiedFile(target.file);
                if (!loaded) continue;
                const { evidence, lines } = loaded;
                if (
                    target.fileHash !== evidence.observedHash
                    || target.span.startLine < 1
                    || target.span.endLine > lines.length
                    || target.span.endLine - target.span.startLine + 1 > MAX_SYMBOL_LINES
                ) {
                    continue;
                }
                const pathTerms = normalizedTerms(target.file);
                const content = lines.slice(target.span.startLine - 1, target.span.endLine).join("\n");
                const contentTerms = normalizedTerms(content);
                const nameTerms = normalizedTerms(target.name);
                const nonPathMatch = [...queryTerms].some((term) => (
                    !pathTerms.has(term) && (contentTerms.has(term) || nameTerms.has(term))
                ));
                if (!nonPathMatch) continue;
                appendSymbolResult(target, lines);
                admittedGraphCallees += 1;
            }
        }
    }
    return results;
}
