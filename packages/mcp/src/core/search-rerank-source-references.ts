import { compareContractStrings, type SymbolRecord, type SymbolRegistry } from "@satori-code/core";
import { lexicalTokens } from "./bounded-source-selector.js";

/** Textual evidence only: an occurrence inside a published symbol span does
 * not establish a call or a binding to the candidate. */
export interface SearchRerankSourceReference {
    readonly repository_relative_path: string;
    readonly containing_symbol_label: string;
    readonly source_line: number;
    readonly reference_source_excerpt: string;
}

export const SEARCH_RERANK_SOURCE_REFERENCE_LIMIT = 3;
export const SEARCH_RERANK_SOURCE_REFERENCE_MAX_BYTES = 400;

export function buildSearchRerankSourceReferences(input: {
    owner: SymbolRecord | undefined;
    registry: SymbolRegistry;
    source: string;
    sourceStartLine: number;
    observedHash: string;
    query: string;
}): SearchRerankSourceReference[] {
    const { owner } = input;
    if (!owner || owner.fileHash !== input.observedHash
        || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(owner.name)) return [];
    const name = owner.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrence = new RegExp(`(^|[^A-Za-z0-9_$])${name}(?=$|[^A-Za-z0-9_$])`);
    const lines = input.source.split(/\r?\n/);
    const symbols = (input.registry.symbolsByFile.get(owner.file) ?? [])
        .filter((symbol) => symbol.symbolInstanceId !== owner.symbolInstanceId
            && ["function", "method"].includes(symbol.kind)
            && symbol.fileHash === input.observedHash)
        .sort((a, b) => a.span.startLine - b.span.startLine
            || a.span.endLine - b.span.endLine || compareContractStrings(a.label, b.label));
    const references: SearchRerankSourceReference[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < lines.length; index++) {
        const sourceLine = input.sourceStartLine + index;
        if (sourceLine >= owner.span.startLine && sourceLine <= owner.span.endLine
            || !occurrence.test(lines[index])) continue;
        // The narrowest enclosing published callable supplies the label;
        // this is containment evidence, never a resolved caller identity.
        const containing = symbols.filter((symbol) => symbol.span.startLine <= sourceLine
            && symbol.span.endLine >= sourceLine)
            .sort((a, b) => (a.span.endLine - a.span.startLine) - (b.span.endLine - b.span.startLine))[0];
        if (!containing || seen.has(containing.symbolInstanceId)) continue;
        let excerpt = lines[index].trim();
        if (Buffer.byteLength(excerpt, "utf8") > SEARCH_RERANK_SOURCE_REFERENCE_MAX_BYTES) {
            const prefix: string[] = [];
            let bytes = 0;
            for (const character of excerpt) {
                bytes += Buffer.byteLength(character, "utf8");
                if (bytes > SEARCH_RERANK_SOURCE_REFERENCE_MAX_BYTES) break;
                prefix.push(character);
            }
            excerpt = prefix.join("");
        }
        // Truncation must retain the observed name rather than an unrelated prefix.
        if (!occurrence.test(excerpt)) continue;
        references.push({ repository_relative_path: owner.file,
            containing_symbol_label: containing.label || containing.qualifiedName || containing.name,
            source_line: sourceLine, reference_source_excerpt: excerpt });
        seen.add(containing.symbolInstanceId);
    }
    const queryTerms = new Set(lexicalTokens(input.query));
    const score = (reference: SearchRerankSourceReference) => new Set(lexicalTokens(
        `${reference.containing_symbol_label} ${reference.reference_source_excerpt}`,
    ).filter((term) => queryTerms.has(term))).size;
    return references.sort((a, b) => score(b) - score(a) || a.source_line - b.source_line)
        .slice(0, SEARCH_RERANK_SOURCE_REFERENCE_LIMIT);
}
