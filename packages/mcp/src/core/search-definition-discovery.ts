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
type DefinitionTerms = { terms: string[]; ownerTerms: string[] };
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

function definitionTerms(metadata: DefinitionDiscoveryMetadata): DefinitionTerms {
    const cached = termsByDefinition.get(metadata);
    const witness = [metadata.name, metadata.qualifiedName, metadata.file, metadata.kind];
    if (cached && cached.witness.every((field, index) => field === witness[index])) return cached;
    const relativePath = normalizeSearchPath(metadata.file);
    const category = classifyPathCategory(relativePath);
    // Supporting evidence keeps its provider vote. It does not also get an
    // implementation-definition vote merely because it narrates the query.
    const supporting = ["tests", "fixture", "docs", "generated", "example", "artifact", "landing"].includes(category)
        || /(?:^|[._-])fixtures?(?:[._-]|$)/u.test(relativePath.split("/").pop() ?? "")
        || isConfigurationPath(relativePath);
    const validName = metadata.kind === "file" || /^[$_\p{L}][$_\p{L}\p{N}]*$/u.test(metadata.name);
    const ownerTerms = !supporting && DEFINITION_KINDS.has(metadata.kind) && validName
        ? [...tokenizeMetadataField(metadata.name), ...tokenizeMetadataField(metadata.qualifiedName)] : [];
    const terms = ownerTerms.length > 0 ? [...ownerTerms, ...tokenizeMetadataField(metadata.file)] : [];
    const evidence = { witness, terms, ownerTerms };
    termsByDefinition.set(metadata, evidence);
    return evidence;
}

/**
 * BM25 over definition fields in the validated rerank window, fused with
 * provider order using the existing RRF constant. A path category alone
 * never promotes a candidate: its definition fields must match the query.
 * File targets retain a location vote as a truthful fallback; they are not
 * converted into symbols. Ties preserve provider order.
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
        const evidence = metadata ? definitionTerms(metadata) : { terms: [], ownerTerms: [] };
        const { terms } = evidence;
        const counts = new Map<string, number>();
        for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
        return { item, metadata, ownerTerms: evidence.ownerTerms, counts, length: terms.length };
    });
    const populated = docs.filter(doc => doc.length > 0);
    if (populated.length === 0) return { items: [...input.items], applied: false };
    const averageLength = populated.reduce((sum, doc) => sum + doc.length, 0) / populated.length;
    const scores = new Map<T, number>();
    for (const term of queryTerms) {
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
    const score = (item: T) => 1 / (SEARCH_RRF_K + item.providerRank)
        + (definitionRank.has(item) ? 1 / (SEARCH_RRF_K + definitionRank.get(item)!) : 0);
    const items = [...input.items].sort((a, b) => score(b) - score(a) || a.providerRank - b.providerRank);
    const evidenceByItem = new Map(docs.map(doc => [doc.item, doc]));
    const fileSlots = new Map<string, number[]>();
    items.forEach((item, index) => {
        const file = evidenceByItem.get(item)?.metadata?.file;
        if (file) fileSlots.set(file, [...(fileSlots.get(file) ?? []), index]);
    });
    // A file-diversity cap must not spend an owner's slots on generic helpers
    // before its more specific definition. Change only the order within each
    // file's existing slots; do not promote files or increase disclosure.
    const coverage = (item: T) => {
        const terms = evidenceByItem.get(item)!.ownerTerms;
        return queryTerms.filter(term => terms.includes(term)).length;
    };
    for (const slots of fileSlots.values()) {
        const withinFile = slots.map(index => items[index]!)
            .sort((a, b) => coverage(b) - coverage(a) || score(b) - score(a) || a.providerRank - b.providerRank);
        slots.forEach((slot, index) => { items[slot] = withinFile[index]!; });
    }
    return { items, applied: true };
}
