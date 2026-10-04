import * as path from "node:path";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { readCurrentSourceEvidence } from "./current-source-symbols.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";

/**
 * Dedicated symbol-metadata BM25 retrieval owner (flag-gated experiment).
 *
 * Scores registry metadata only: symbol name, qualifiedName and file path.
 * Source bodies are never indexed and never influence the rank; they are
 * read only to materialize bounded excerpts for already-selected symbols.
 * No label bonuses, path biases or tuned rank boosts are applied here.
 */
export const SYMBOL_METADATA_BM25_LIMIT = 12;

/** Conventional documented BM25 saturation and length-normalization constants. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Bounded declaration-start excerpt: at most this many lines per symbol. */
const MAX_EXCERPT_LINES = 80;

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Identifier segmentation mirrors core/src/core/search-projections.ts: the
 * identifier-token pattern keeps punctuation from sticking to terms, and the
 * two camel/acronym-boundary replacements split both lower-to-upper
 * transitions and uppercase runs (HTTPServer -> HTTP Server).
 */
const IDENTIFIER_TOKEN_PATTERN = /[\p{L}\p{N}_$]+/gu;

function splitIdentifierComponents(token: string): string[] {
    return token
        .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
        .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
        .split(/[_$\s]+/u)
        .filter(Boolean);
}

/**
 * Tokenize one metadata field into a term multiset holding both the original
 * spelling of each identifier token and its camel/acronym/snake components,
 * lowercased. Query and document sides share this tokenizer so split-name
 * queries meet split-name metadata without any source-body vocabulary.
 */
export function tokenizeMetadataField(value: string): string[] {
    const terms: string[] = [];
    for (const token of value.match(IDENTIFIER_TOKEN_PATTERN) ?? []) {
        const original = token.toLowerCase();
        terms.push(original);
        for (const part of splitIdentifierComponents(token)) {
            const term = part.toLowerCase();
            if (term.length > 0 && term !== original) {
                terms.push(term);
            }
        }
    }
    return terms;
}

function metadataTermsForSymbol(symbol: SymbolRecord): string[] {
    return [
        ...tokenizeMetadataField(symbol.name ?? ""),
        ...tokenizeMetadataField(symbol.qualifiedName ?? ""),
        ...tokenizeMetadataField(symbol.file ?? ""),
    ];
}

type MetadataPosting = {
    doc: number;
    tf: number;
};

type SymbolMetadataCorpus = {
    manifestHash: string;
    docs: SymbolRecord[];
    docLengths: number[];
    averageLength: number;
    postings: Map<string, MetadataPosting[]>;
    idf: Map<string, number>;
    /** Manifest file hash by path, immutable per supplied manifest hash. */
    manifestHashesByPath: Map<string, string>;
};

function buildSymbolMetadataCorpus(registry: SymbolRegistry, manifestHash: string): SymbolMetadataCorpus {
    // Corpus is every non-file named published symbol; production paths,
    // test paths and generated paths all enter on equal terms.
    const docs = registry.symbols
        .filter((symbol) => symbol.kind !== "file"
            && typeof symbol.name === "string"
            && symbol.name.length > 0);
    const docLengths: number[] = [];
    const postings = new Map<string, MetadataPosting[]>();
    let totalLength = 0;
    docs.forEach((symbol, doc) => {
        const counts = new Map<string, number>();
        for (const term of metadataTermsForSymbol(symbol)) {
            counts.set(term, (counts.get(term) ?? 0) + 1);
        }
        const length = [...counts.values()].reduce((sum, count) => sum + count, 0);
        docLengths.push(length);
        totalLength += length;
        for (const [term, tf] of counts) {
            const posting = postings.get(term);
            if (posting) {
                posting.push({ doc, tf });
            } else {
                postings.set(term, [{ doc, tf }]);
            }
        }
    });
    const idf = new Map<string, number>();
    for (const [term, posting] of postings) {
        const df = posting.length;
        // Positive Robertson-Sparck Jones IDF with the conventional +1
        // inside the logarithm: every matching term contributes >= 0.
        idf.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
    }
    return {
        manifestHash,
        docs,
        docLengths,
        averageLength: docs.length > 0 && totalLength > 0 ? totalLength / docs.length : 1,
        postings,
        idf,
        manifestHashesByPath: new Map(registry.manifest.files.map((file) => [file.path, file.hash])),
    };
}

/**
 * Cached metadata postings keyed by registry object identity and validated
 * against the supplied manifest hash. A new publication (or a new hash on
 * the same object) rebuilds; re-ranking never retokenizes the registry.
 */
const corpusByRegistry = new WeakMap<SymbolRegistry, SymbolMetadataCorpus>();

function getSymbolMetadataCorpus(registry: SymbolRegistry, manifestHash: string): SymbolMetadataCorpus {
    const cached = corpusByRegistry.get(registry);
    if (cached && cached.manifestHash === manifestHash) {
        return cached;
    }
    const corpus = buildSymbolMetadataCorpus(registry, manifestHash);
    corpusByRegistry.set(registry, corpus);
    return corpus;
}

function compareInstanceId(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Rank registry symbol metadata with standard in-memory BM25 over name,
 * qualifiedName and file-path terms. Only documents sharing at least one
 * query term are scored or filtered; the request accepts filter applies to
 * those candidates before the bounded selection, so rejected leaders never
 * consume the limit budget. Ties break deterministically on
 * symbolInstanceId.
 */
export function rankSymbolMetadataBm25(input: {
    registry: SymbolRegistry;
    registryManifestHash: string;
    query: string;
    limit: number;
    accepts: (symbol: SymbolRecord) => boolean;
}): Array<{ symbol: SymbolRecord; score: number }> {
    const limit = Number.isSafeInteger(input.limit) ? Math.max(0, input.limit) : 0;
    if (limit === 0) {
        return [];
    }
    const corpus = getSymbolMetadataCorpus(input.registry, input.registryManifestHash);
    if (corpus.docs.length === 0) {
        return [];
    }
    const queryTerms = [...new Set(tokenizeMetadataField(input.query))];
    if (queryTerms.length === 0) {
        return [];
    }
    const scores = new Map<number, number>();
    for (const term of queryTerms) {
        const posting = corpus.postings.get(term);
        const termIdf = corpus.idf.get(term);
        if (!posting || termIdf === undefined) {
            continue;
        }
        for (const { doc, tf } of posting) {
            const docLength = corpus.docLengths[doc] ?? 0;
            const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / corpus.averageLength));
            const increment = denominator > 0 ? termIdf * ((tf * (BM25_K1 + 1)) / denominator) : 0;
            scores.set(doc, (scores.get(doc) ?? 0) + increment);
        }
    }
    return [...scores.entries()]
        .filter(([doc]) => input.accepts(corpus.docs[doc] as SymbolRecord))
        .map(([doc, score]) => ({ symbol: corpus.docs[doc] as SymbolRecord, score }))
        .sort((left, right) => right.score - left.score
            || compareInstanceId(left.symbol.symbolInstanceId, right.symbol.symbolInstanceId))
        .slice(0, limit);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal || !signal.aborted) {
        return;
    }
    // Cancellation propagates as a failure; it must never degrade into an
    // empty but successful candidate list.
    if (typeof signal.throwIfAborted === "function") {
        signal.throwIfAborted();
    }
    throw (signal.reason as unknown) ?? new Error("Symbol metadata BM25 retrieval aborted.");
}

/**
 * Materialize the top-ranked accepted symbols as bounded declaration-start
 * excerpts from actual current source. Each selected file is read at most
 * once per request through the existing source-evidence owner; results are
 * then emitted in the original BM25 rank order (not file-grouped read
 * order) so downstream fusion consumes the true rank. Admission requires
 * the observed full-file hash to equal both the symbol fileHash and the
 * registry manifest file hash, plus agreement on the canonical root and
 * relative file. Hash mismatches, invalid spans and out-of-file spans are
 * rejected, never admitted. The excerpt holds at most 80 lines from the
 * declaration start with a truthfully adjusted endLine; byte bounds are
 * derived from the actual byte slice when the published symbol has byte
 * bounds. Owner identity
 * follows the supplement conventions with the full published symbol as the
 * canonical owner; the actual BM25 score is reported with the lexical_rank
 * backend kind so traces identify this arm's scoring accurately.
 */
export async function retrieveSymbolMetadataBm25Candidates(input: {
    registry: SymbolRegistry;
    registryManifestHash: string;
    query: string;
    codebaseRoot: string;
    accepts: (symbol: SymbolRecord) => boolean;
    signal?: AbortSignal;
    readSourceEvidence?: typeof readCurrentSourceEvidence;
}): Promise<SearchResultLike[]> {
    throwIfAborted(input.signal);
    const corpus = getSymbolMetadataCorpus(input.registry, input.registryManifestHash);
    const ranked = rankSymbolMetadataBm25({
        registry: input.registry,
        registryManifestHash: input.registryManifestHash,
        query: input.query,
        limit: SYMBOL_METADATA_BM25_LIMIT,
        accepts: input.accepts,
    });
    throwIfAborted(input.signal);
    if (ranked.length === 0) {
        return [];
    }
    // Reads group by file, but emission below follows the original rank, so
    // interleaved file scores keep their BM25 order for downstream fusion.
    const selected = ranked.slice(0, SYMBOL_METADATA_BM25_LIMIT);
    const symbolsByFile = new Map<string, Array<{ symbol: SymbolRecord; score: number }>>();
    const filesInRankOrder: string[] = [];
    for (const entry of selected) {
        const existing = symbolsByFile.get(entry.symbol.file);
        if (existing) {
            existing.push(entry);
        } else {
            symbolsByFile.set(entry.symbol.file, [entry]);
            filesInRankOrder.push(entry.symbol.file);
        }
    }
    const read = input.readSourceEvidence ?? readCurrentSourceEvidence;
    // The coordinator passes the canonical effective root; evidence from any
    // other root is rejected even when its file hash matches.
    const expectedCanonicalRoot = path.resolve(input.codebaseRoot);
    const admitted = new Map<string, SearchResultLike>();
    for (const file of filesInRankOrder) {
        throwIfAborted(input.signal);
        const manifestHash = corpus.manifestHashesByPath.get(file);
        if (!manifestHash || !SHA256_HEX.test(manifestHash)) {
            continue;
        }
        let evidence;
        try {
            evidence = await read(input.codebaseRoot, file);
        } catch {
            throwIfAborted(input.signal);
            continue;
        }
        throwIfAborted(input.signal);
        if (!evidence || evidence.relativeFile !== file || evidence.observedHash !== manifestHash) {
            continue;
        }
        if (path.resolve(evidence.canonicalRoot) !== expectedCanonicalRoot) {
            continue;
        }
        const lines = evidence.source.split(/\r\n?|\n/);
        const sourceBytes = Buffer.from(evidence.sourceBytes);
        for (const { symbol, score } of symbolsByFile.get(file) ?? []) {
            if (admitted.size >= SYMBOL_METADATA_BM25_LIMIT) {
                break;
            }
            if (admitted.has(symbol.symbolInstanceId)
                || symbol.file !== file || symbol.fileHash !== evidence.observedHash
                || !SHA256_HEX.test(symbol.fileHash)) {
                continue;
            }
            const { startLine, endLine } = symbol.span;
            if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
                || startLine < 1 || endLine < startLine
                || startLine > lines.length || endLine > lines.length) {
                continue;
            }
            const boundedEndLine = Math.min(endLine, startLine + MAX_EXCERPT_LINES - 1);
            let content: string;
            let byteSpan: { startByte: number; endByte: number } | undefined;
            if (symbol.span.startByte !== undefined || symbol.span.endByte !== undefined) {
                const { startByte, endByte } = symbol.span;
                if (typeof startByte !== "number" || typeof endByte !== "number"
                    || !Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)
                    || startByte < 0 || endByte < startByte || endByte > sourceBytes.length) {
                    continue;
                }
                const ownerBytes = sourceBytes.subarray(startByte, endByte);
                content = ownerBytes.toString("utf8");
                // Preserve CRLF and Unicode bytes; a line-normalized excerpt
                // cannot truthfully reuse the full owner's byte bounds.
                if (!Buffer.from(content).equals(ownerBytes)) continue;
                let lineBreakCount = 0;
                for (const match of content.matchAll(/\r\n?|\n/g)) {
                    if (++lineBreakCount === MAX_EXCERPT_LINES) {
                        content = content.slice(0, match.index);
                        break;
                    }
                }
                byteSpan = { startByte, endByte: startByte + Buffer.byteLength(content) };
            } else {
                content = lines.slice(startLine - 1, boundedEndLine).join("\n");
            }
            if (content.length === 0) {
                continue;
            }
            admitted.set(symbol.symbolInstanceId, {
                relativePath: file,
                language: symbol.language,
                symbolKind: symbol.kind,
                symbolLabel: symbol.label,
                symbolId: symbol.symbolKey,
                ownerSymbolKey: symbol.symbolKey,
                ownerSymbolInstanceId: symbol.symbolInstanceId,
                startLine,
                endLine: boundedEndLine,
                ...byteSpan,
                content,
                score,
                backendScoreKind: "lexical_rank",
            });
        }
        if (admitted.size >= SYMBOL_METADATA_BM25_LIMIT) {
            break;
        }
    }
    return selected
        .map(({ symbol }) => admitted.get(symbol.symbolInstanceId))
        .filter((result): result is SearchResultLike => result !== undefined);
}
