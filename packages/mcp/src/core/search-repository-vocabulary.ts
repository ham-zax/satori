import type {
    PublicationRef,
    RepositoryVocabularyResult,
    RepositoryVocabularyFilter,
    SymbolRecord,
    SymbolRegistry,
} from '@satori-code/core';
import { resolveSearchAltTerms } from './search-expansion-terms.js';
import type { SearchQueryPlan } from './search-lexical-scoring.js';

/** Conceptual questions can name identifiers without becoming exact identifier requests. */
export function allowsRepositoryVocabulary(plan: Pick<SearchQueryPlan, 'route'>): boolean {
    return plan.route.kind === 'conceptual' || plan.route.kind === 'mixed';
}

/** Check only matching postings against the authoritative registry and request constraints. */
export function buildRepositoryVocabularyFilter(
    registry: Pick<SymbolRegistry, 'symbolsByInstanceId'>,
    accepts: (symbol: SymbolRecord) => boolean,
): RepositoryVocabularyFilter {
    return document => {
        const symbol = registry.symbolsByInstanceId.get(document.symbolInstanceId);
        return Boolean(symbol && symbol.file === document.file && symbol.language === document.language
            && accepts(symbol));
    };
}

/** Explicit caller terminology wins. Automatic terminology is bound to the held publication. */
export async function resolveRepositorySearchTerms(input: {
    publication: PublicationRef;
    semanticQuery: string;
    callerTerms?: string[] | string;
    enabled: boolean;
    accepts?: RepositoryVocabularyFilter;
    lookup?: (publication: PublicationRef, query: string, limit: number,
        accepts?: RepositoryVocabularyFilter) => Promise<RepositoryVocabularyResult>;
}) {
    const resolved = resolveSearchAltTerms(input.callerTerms);
    if (input.callerTerms !== undefined || !input.enabled || !input.lookup) return { resolved };
    const vocabulary = await input.lookup(input.publication, input.semanticQuery, 4, input.accepts);
    // An older or unavailable artifact must preserve the existing search and response bytes.
    if (vocabulary.status !== 'ok' || vocabulary.publicationId !== input.publication.id) return { resolved };
    const terms = vocabulary.terms.filter(term => typeof term === 'string' && term.trim().length > 0
        && term.length <= 128);
    const automatic = resolveSearchAltTerms(terms);
    return automatic.termsEmitted.length ? { resolved: automatic, vocabulary } : { resolved };
}
