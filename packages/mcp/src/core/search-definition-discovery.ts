import type { SymbolRecord } from "@satori-code/core";
import { SEARCH_RRF_K } from "./search-constants.js";
import type { SearchQueryPlan } from "./search-lexical-scoring.js";
import { classifyPathCategory, isConfigurationPath, normalizeSearchPath } from "./search-ranking-policy.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";
import { tokenizeMetadataField } from "./search-symbol-metadata-bm25.js";

/** Definition evidence is independent of chunk-body fluency and provider score scales. */
export type DefinitionDiscoveryMetadata = Pick<SymbolRecord, "name" | "qualifiedName" | "file" | "kind">;

const DEFINITION_KINDS = new Set(["function", "method", "constructor", "class", "struct", "enum", "interface", "type", "trait", "file"]);
const QUERY_STOP_WORDS = new Set("the a an and or of to in for is are be does do where when how what which current against".split(" "));
type DefinitionTerms = { terms: string[]; ownerTerms: string[]; abstains: boolean };
const termsByDefinition = new WeakMap<DefinitionDiscoveryMetadata, DefinitionTerms & { witness: string[] }>();

export function allowsDefinitionDiscovery(input: {
    enabled: boolean;
    queryPlan: SearchQueryPlan;
    answerFocus: SearchAnswerFocus;
    hasPathConstraint: boolean;
    hasMustConstraint: boolean;
    scope: string;
}): boolean {
    const plan = input.queryPlan;
    return input.enabled && input.scope !== "docs"
        && (input.answerFocus === "neutral" || input.answerFocus === "implementation")
        && (plan.route.kind === "conceptual" || plan.route.kind === "mixed" || plan.route.kind === "ownership")
        && !plan.testSeeking && !plan.documentationSeeking && !plan.referenceSeeking
        && !input.hasPathConstraint && !input.hasMustConstraint;
}

/**
 * Definition fusion corrects a provider order with a symbol-name vote. The
 * Voyage rerank-3 family already ranks the owner first where that vote
 * displaces it (docs/improvements/voyage-reranker-and-definition-fusion.md),
 * so its order stays authoritative. Other providers keep the fused order.
 */
export function rerankerOrderNeedsDefinitionFusion(identity: { provider: string; model: string } | undefined): boolean {
    return !(identity?.provider === "voyage" && (identity.model === "rerank-3" || identity.model === "rerank-3-lite"));
}

function definitionTerms(metadata: DefinitionDiscoveryMetadata): DefinitionTerms {
    const cached = termsByDefinition.get(metadata);
    const witness = [metadata.name, metadata.qualifiedName, metadata.file, metadata.kind];
    if (cached && cached.witness.every((field, index) => field === witness[index])) return cached;
    const relativePath = normalizeSearchPath(metadata.file);
    const category = classifyPathCategory(relativePath);
    // Supporting evidence keeps its provider vote. It does not also get an
    // implementation-definition vote merely because it narrates the query.
    const narrative = ["tests", "fixture", "docs", "generated", "example", "artifact", "landing"].includes(category)
        || /(?:^|[._-])fixtures?(?:[._-]|$)/u.test(relativePath.split("/").pop() ?? "");
    const supporting = narrative || isConfigurationPath(relativePath);
    const validName = metadata.kind === "file" || /^[$_\p{L}][$_\p{L}\p{N}]*$/u.test(metadata.name);
    const ownerTerms = !supporting && DEFINITION_KINDS.has(metadata.kind) && validName
        ? [...tokenizeMetadataField(metadata.name), ...tokenizeMetadataField(metadata.qualifiedName)] : [];
    const terms = ownerTerms.length > 0 ? [...ownerTerms, ...tokenizeMetadataField(metadata.file)] : [];
    // A definition the query cannot name keeps a last-place name prior: an
    // implementation, a configuration declaration (pyproject.toml), or a
    // non-definition kind (a module-level proxy). Without it, one provider vote
    // falls behind every definition with two. Narrative paths would rise on
    // provider fluency alone. File chunks would rise and then yield the slot to
    // a same-file definition.
    const abstains = !narrative && metadata.kind !== "file";
    const evidence = { witness, terms, ownerTerms, abstains };
    termsByDefinition.set(metadata, evidence);
    return evidence;
}

/**
 * Exact-token metadata BM25 cannot relate an inflected query word to the
 * declaration it names. A query for "parsing" does not vote for
 * `ParseAnyValue`, although the declaration carries "parse". The owner then
 * keeps only its provider vote while union/type helpers behind it gain a
 * definition vote and pass it.
 *
 * Recover only that inflection, and only when the exact query token is
 * absent from this rerank window. The document side and BM25 weights are
 * unchanged, so this adds a query term and never rewrites symbol metadata.
 */
function inflectedBaseTerm(term: string, corpusHas: (term: string) => boolean): string | null {
    if (term.length < 5 || !term.endsWith("ing")) return null;
    let stem = term.slice(0, -3);
    if (stem.length < 3) return null;
    if (/([b-df-hj-np-tv-z])\1$/u.test(stem)) stem = stem.slice(0, -1);
    const withE = `${stem}e`;
    if (corpusHas(withE)) return withE;
    return corpusHas(stem) ? stem : null;
}

/**
 * BM25 over definition fields in the validated rerank window, fused with
 * provider order using the existing RRF constant. A path category alone
 * never promotes a candidate: its definition fields must match the query.
 * File targets retain a location vote as a truthful fallback; they are not
 * converted into symbols. Equal fused votes favor observed definition evidence
 * over abstention, then preserve provider order.
 */
export function fuseDefinitionDiscovery<T extends { originalIndex: number; providerRank: number }>(input: {
    items: readonly T[];
    query: string;
    metadata: (originalIndex: number) => DefinitionDiscoveryMetadata | undefined;
}): { items: T[]; applied: boolean } {
    const queryTerms = [...new Set(tokenizeMetadataField(input.query)
        .filter(term => term.length >= 3 && !QUERY_STOP_WORDS.has(term)))];
    if (queryTerms.length === 0) return { items: [...input.items], applied: false };
    const docs = input.items.map(item => {
        const metadata = input.metadata(item.originalIndex);
        const evidence = metadata ? definitionTerms(metadata) : { terms: [], ownerTerms: [], abstains: false };
        const { terms } = evidence;
        const counts = new Map<string, number>();
        for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
        return { item, metadata, ownerTerms: evidence.ownerTerms, abstains: evidence.abstains, counts, length: terms.length };
    });
    const populated = docs.filter(doc => doc.length > 0);
    if (populated.length === 0) return { items: [...input.items], applied: false };
    const averageLength = populated.reduce((sum, doc) => sum + doc.length, 0) / populated.length;
    const corpusTerms = new Set(docs.flatMap(doc => [...doc.counts.keys()]));
    const effectiveQueryTerms = [...new Set(queryTerms.flatMap(term => {
        if (corpusTerms.has(term)) return [term];
        const base = inflectedBaseTerm(term, candidate => corpusTerms.has(candidate));
        return base ? [term, base] : [term];
    }))];
    const scores = new Map<T, number>();
    for (const term of effectiveQueryTerms) {
        const df = docs.filter(doc => doc.counts.has(term)).length;
        if (df === 0) continue;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        for (const { item, counts, length } of populated) {
            const tf = counts.get(term) ?? 0;
            if (tf === 0) continue;
            const score = idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / averageLength));
            scores.set(item, (scores.get(item) ?? 0) + score);
        }
    }
    if (scores.size === 0) return { items: [...input.items], applied: false };
    const definitionRank = new Map([...scores.keys()]
        .sort((a, b) => scores.get(b)! - scores.get(a)! || a.originalIndex - b.originalIndex)
        .map((item, index) => [item, index + 1]));
    const evidenceByItem = new Map(docs.map(doc => [doc.item, doc]));
    const score = (item: T) => {
        const evidence = evidenceByItem.get(item)!;
        // A behavior description need not share the declaration's name.
        // Missing definition evidence is not evidence against the body.
        // Single-term lookup keeps lexical semantics.
        const abstentionRank = queryTerms.length > 1 && evidence.abstains ? scores.size + 1 : undefined;
        const rank = definitionRank.get(item) ?? abstentionRank;
        return 1 / (SEARCH_RRF_K + item.providerRank)
            + (rank !== undefined ? 1 / (SEARCH_RRF_K + rank) : 0);
    };
    const items = [...input.items].sort((a, b) => score(b) - score(a)
        || Number(definitionRank.has(b)) - Number(definitionRank.has(a))
        || a.providerRank - b.providerRank);
    const fileSlots = new Map<string, number[]>();
    items.forEach((item, index) => {
        const file = evidenceByItem.get(item)?.metadata?.file;
        if (file) fileSlots.set(file, [...(fileSlots.get(file) ?? []), index]);
    });
    // Name coverage compares definitions the query actually names. Preserve
    // provider order within the file for implementations named only by behavior.
    // Supporting/file targets can still yield a slot to a matching definition.
    const coverage = (item: T) => {
        const terms = evidenceByItem.get(item)!.ownerTerms;
        return queryTerms.filter(term => terms.includes(term)).length;
    };
    for (const slots of fileSlots.values()) {
        const withinFile = slots.map(index => items[index]!)
            .sort((a, b) => a.providerRank - b.providerRank);
        const matchingSlots = withinFile.map(item => {
            const evidence = evidenceByItem.get(item)!;
            return coverage(item) > 0 || evidence.ownerTerms.length === 0
                || evidence.metadata?.kind === "file";
        }).flatMap((matches, index) => matches ? [index] : []);
        const matchingDefinitions = matchingSlots.map(index => withinFile[index]!)
            .sort((a, b) => coverage(b) - coverage(a) || score(b) - score(a) || a.providerRank - b.providerRank);
        matchingSlots.forEach((slot, index) => { withinFile[slot] = matchingDefinitions[index]!; });
        slots.forEach((slot, index) => { items[slot] = withinFile[index]!; });
    }
    return { items, applied: true };
}
