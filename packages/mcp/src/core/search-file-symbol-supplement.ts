import type { SymbolRegistry } from "@satori-code/core";
import { readCurrentSourceEvidence } from "./current-source-symbols.js";
import type { SearchLexicalTerm, SearchResultLike } from "./search-lexical-scoring.js";

const MAX_FILES = 3;
const MAX_SYMBOLS_PER_FILE = 6;
const MAX_SYMBOL_LINES = 400;

function normalizedTerms(value: string): Set<string> {
    return new Set((value + " " + value.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase()
        .split(/[^a-z0-9]+/).filter(Boolean)
        .map((term) => term.replace(/(?:ing|ed|s)$/, "")));
}

/** Recover bounded symbol evidence inside files already found by retrieval.
 * The source hash must match the Publication; this never retargets a broad
 * chunk or infers ownership from a function name.
 */
export async function supplementSearchFileSymbols(input: {
    candidates: readonly SearchResultLike[];
    lexicalTerms: readonly SearchLexicalTerm[];
    registry: SymbolRegistry;
    codebaseRoot: string;
    readSourceEvidence?: typeof readCurrentSourceEvidence;
}): Promise<SearchResultLike[]> {
    const queryTerms = new Set(input.lexicalTerms.filter((term) => term.kind === "whole")
        .flatMap((term) => [...normalizedTerms(term.value)]));
    if (queryTerms.size < 2) return [];
    // Preserve retrieval order across distinct files. Declaration names do not
    // establish implementation relevance; the source body must prove it below.
    const files = [...new Set(input.candidates.map((candidate) => candidate.relativePath))]
        .slice(0, MAX_FILES);
    // A declaration-supported file can be retrieved below the initial file
    // window. Retain the previous bounded declaration lane alongside the
    // retrieval lane, so precise generator symbols remain discoverable.
    const declarationFiles = [...new Set(input.candidates.map((candidate) => candidate.relativePath))]
        .map((file, rank) => ({ file, rank, matches: (input.registry.symbolsByFile.get(file) ?? [])
            .filter((symbol) => ["function", "method"].includes(symbol.kind)
                && [...normalizedTerms(symbol.name)].some((term) => queryTerms.has(term))).length }))
        .sort((a, b) => b.matches - a.matches || a.rank - b.rank)
        .slice(0, MAX_FILES).map(({ file }) => file);
    files.push(...declarationFiles.filter((file) => !files.includes(file)));
    const results: SearchResultLike[] = [];
    for (const file of files) {
        const manifestFile = input.registry.manifest.files.find((entry) => entry.path === file);
        if (!manifestFile) continue;
        let evidence;
        try {
            evidence = await (input.readSourceEvidence ?? readCurrentSourceEvidence)(input.codebaseRoot, file);
        } catch {
            continue;
        }
        if (!evidence || evidence.relativeFile !== file || evidence.observedHash !== manifestFile.hash) continue;
        const lines = evidence.source.split(/\r?\n/);
        const pathTerms = normalizedTerms(file);
        const ranked = (input.registry.symbolsByFile.get(file) ?? []).flatMap((symbol) => {
            if (!["function", "method"].includes(symbol.kind)
                || symbol.fileHash !== evidence.observedHash
                || symbol.span.startLine < 1 || symbol.span.endLine > lines.length
                || symbol.span.endLine - symbol.span.startLine + 1 > MAX_SYMBOL_LINES) return [];
            const content = lines.slice(symbol.span.startLine - 1, symbol.span.endLine).join("\n");
            const contentTerms = normalizedTerms(content);
            const nameTerms = normalizedTerms(symbol.name);
            const matched = [...queryTerms].filter((term) => contentTerms.has(term) || nameTerms.has(term));
            if (matched.length < 2 || !matched.some((term) => !pathTerms.has(term))) return [];
            return [{ symbol, content, matches: matched.length,
                nameMatches: matched.filter((term) => nameTerms.has(term)).length }];
        }).sort((left, right) => right.matches - left.matches
            || right.nameMatches - left.nameMatches
            || left.symbol.span.startLine - right.symbol.span.startLine);
        for (const { symbol, content } of ranked.slice(0, MAX_SYMBOLS_PER_FILE)) {
            const existing = input.candidates.find((candidate) => candidate.ownerSymbolInstanceId === symbol.symbolInstanceId
                && candidate.startLine === symbol.span.startLine && candidate.endLine === symbol.span.endLine);
            if (existing) {
                // Return the original identity as bounded admission evidence;
                // the search owner marks it preferred without duplicating it.
                results.push(existing);
                continue;
            }
            results.push({
                relativePath: file,
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
                content,
            });
        }
    }
    return results;
}
