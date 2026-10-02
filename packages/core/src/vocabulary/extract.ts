import type { SymbolRecord } from '../symbols/contracts';
import { MAX_VOCABULARY_TERMS, VOCABULARY_EVIDENCE_VERSION, type VocabularyTerm } from './contracts';

const STOP_WORDS = new Set(('a an and are as at be been being by can class const def do does else export false fn for from function if impl import in into is it let mut new null of on or pub public return self static struct than that the their then there these this to true type var void was were where which while with').split(' '));

/** Shared lexical normalization; this introduces no inferred synonyms. */
export function vocabularyTokens(text: string): string[] {
    const words = text.replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ')
        .toLowerCase().match(/[\p{L}\p{N}]{2,64}/gu) ?? [];
    return [...new Set(words.filter(word => !STOP_WORDS.has(word)))];
}

/** Matching uses stems; persisted evidence keeps the actual source word. */
export function vocabularyStem(word: string): string {
        if (word.length > 5 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
        else if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
        else if (word.length > 4 && word.endsWith('ed')) word = word.slice(0, -2);
        else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
        if (word.length > 4 && word.endsWith('e')) word = word.slice(0, -1);
    return word;
}

/** Extract once from the same observed bytes used to publish the symbols. */
export function withSourceVocabulary(symbols: readonly SymbolRecord[], source: string): SymbolRecord[] {
    const lines = source.split(/\r?\n/);
    const ordered = [...symbols].filter(symbol => symbol.kind !== 'file')
        .sort((a, b) => a.span.startLine - b.span.startLine || b.span.endLine - a.span.endLine);
    const positions = new Map(ordered.map((symbol, index) => [symbol.symbolInstanceId, index]));
    const leadingStart = (startLine: number) => {
        let start = startLine - 1;
        for (let i = start - 1; i >= Math.max(0, startLine - 17); i--) {
            if (!/^\s*(?:\/\/|#|\/\*|\*|\*\/)/.test(lines[i] ?? '')) break;
            start = i;
        }
        return start;
    };
    return symbols.map(symbol => {
        if (symbol.kind === 'file' || symbol.kind === 'test') return symbol;
        const terms = new Map<string, VocabularyTerm>();
        const add = (text: string, kind: VocabularyTerm['kind'], line: number) => {
            for (const term of vocabularyTokens(text)) {
                if (terms.size >= MAX_VOCABULARY_TERMS) break;
                const key = vocabularyStem(term);
                if (!terms.has(key)) terms.set(key, { term, kind, line });
            }
        };
        // Identifier evidence must be proven by the definition header itself: only words
        // from the real symbol name that occur on the recorded source line (after the
        // shared tokenizer normalization) are emitted. Qualified display titles may
        // carry synthetic container labels (for example enclosing test titles) that do
        // not occur at this definition; container context already travels via parent
        // links, so unproven words are omitted here and remain ordinary source terms.
        const proven = new Set(vocabularyTokens(lines[symbol.span.startLine - 1] ?? ''));
        for (const term of vocabularyTokens(symbol.name)) {
            if (terms.size >= MAX_VOCABULARY_TERMS) break;
            if (!proven.has(term)) continue;
            const key = vocabularyStem(term);
            if (!terms.has(key)) terms.set(key, { term, kind: 'identifier', line: symbol.span.startLine });
        }
        // Only contiguous comment lines preceding the definition may cross its span.
        const start = leadingStart(symbol.span.startLine);
        let end = symbol.span.endLine;
        // Container vocabulary describes the container, not the bodies of its members.
        if (['class', 'interface', 'trait', 'module', 'namespace', 'enum', 'type'].includes(symbol.kind)) {
            for (let i = (positions.get(symbol.symbolInstanceId) ?? -1) + 1; i < ordered.length; i++) {
                const child = ordered[i]!;
                if (child.span.startLine > symbol.span.endLine) break;
                if (child.span.endLine <= symbol.span.endLine) {
                    end = Math.min(end, leadingStart(child.span.startLine));
                    break;
                }
            }
        }
        let remaining = 4096;
        for (let i = start; i < Math.min(lines.length, end) && remaining > 0; i++) {
            const line = (lines[i] ?? '').slice(0, remaining);
            add(line, 'source', i + 1);
            remaining -= line.length + 1;
        }
        return { ...symbol, vocabulary: { version: VOCABULARY_EVIDENCE_VERSION, terms: [...terms.values()] } };
    });
}
