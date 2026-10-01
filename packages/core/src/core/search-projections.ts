import type { CodeChunk } from '../language-analysis';
import { validateRepositoryRelativePath } from '../paths/repository-path';
import type { SearchProjections } from '../vectordb/types';

export const EMBEDDING_PROJECTION_VERSION = 'embedding_projection_v3' as const;
export const LEXICAL_PROJECTION_VERSION = 'lexical_projection_v2' as const;

export interface SearchProjectionInput {
    readonly chunk: CodeChunk;
    readonly relativePath: string;
}

const IDENTIFIER_TOKEN_PATTERN = /[\p{L}\p{N}_$]+/gu;

function splitIdentifierComponents(token: string): string[] {
    return token
        .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
        .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, '$1 $2')
        .split(/[_$\s]+/u)
        .filter(Boolean);
}

function buildAdditiveLexicalTerms(values: readonly string[]): string[] {
    const terms = new Set<string>();
    for (const value of values) {
        for (const token of value.match(IDENTIFIER_TOKEN_PATTERN) ?? []) {
            for (const component of splitIdentifierComponents(token)) {
                if (component !== token) terms.add(component);
            }
        }
    }
    return [...terms];
}

function buildLexicalIdentifierAliases(identityValues: readonly string[], content: string): string[] {
    const aliases = new Set<string>();
    const add = (token: string): void => {
        const components = splitIdentifierComponents(token);
        if (components.length > 1) aliases.add(components.join(''));
        for (const component of components) {
            // Short prefixes are too broad to identify an owner. Keep exact
            // terms as well; aliases never change literal/exact-match evidence.
            for (let length = 4; length < component.length; length++) {
                aliases.add(component.slice(0, length));
            }
        }
    };
    for (const value of identityValues) {
        for (const token of value.match(IDENTIFIER_TOKEN_PATTERN) ?? []) add(token);
    }
    // Source contributes compound identifiers, not prefixes of every prose word.
    for (const token of content.match(IDENTIFIER_TOKEN_PATTERN) ?? []) {
        if (splitIdentifierComponents(token).length > 1) add(token);
    }
    return [...aliases];
}

/**
 * Builds backend-neutral search text from information available on every
 * indexing path. Adapters must not reconstruct or enrich these values.
 */
export function buildSearchProjections(input: SearchProjectionInput): SearchProjections {
    const { chunk } = input;
    const relativePath = validateRepositoryRelativePath(input.relativePath);
    const { metadata } = chunk;
    const metadataValues = [
        relativePath,
        metadata.language,
        metadata.symbolKind,
        metadata.symbolLabel,
        ...(metadata.breadcrumbs ?? []),
    ].filter((value): value is string => Boolean(value));
    const additiveLexicalTerms = buildAdditiveLexicalTerms([
        ...metadataValues,
        chunk.content,
    ]);
    const lexicalIdentifierAliases = buildLexicalIdentifierAliases([
        metadata.symbolLabel ?? '',
        ...(metadata.breadcrumbs ?? []),
    ], chunk.content);
    const projectionMetadata = JSON.stringify({
        path: relativePath,
        ...(metadata.language ? { language: metadata.language } : {}),
        ...(metadata.symbolKind ? { symbolKind: metadata.symbolKind } : {}),
        ...(metadata.symbolLabel ? { symbolLabel: metadata.symbolLabel } : {}),
        ...(metadata.breadcrumbs?.length ? { breadcrumbs: metadata.breadcrumbs } : {}),
    });
    const contentSection = `content:${chunk.content.length}\n${chunk.content}`;
    const semanticIdentifierTerms = buildAdditiveLexicalTerms([
        metadata.symbolLabel ?? '',
        ...(metadata.breadcrumbs ?? []),
    ]);
    const semanticIdentity = [
        `path:${JSON.stringify(relativePath)}`,
        ...(metadata.language ? [`language:${JSON.stringify(metadata.language)}`] : []),
        ...(metadata.symbolKind ? [`symbol-kind:${JSON.stringify(metadata.symbolKind)}`] : []),
        ...(metadata.symbolLabel ? [`symbol:${JSON.stringify(metadata.symbolLabel)}`] : []),
        ...(semanticIdentifierTerms.length
            ? [`symbol-terms:${JSON.stringify(semanticIdentifierTerms.join(' '))}`]
            : []),
        ...(metadata.breadcrumbs?.length
            ? [`breadcrumbs:${JSON.stringify(metadata.breadcrumbs)}`]
            : []),
    ].join('\n');

    return {
        embeddingText: `search-identity:\n${semanticIdentity}\n${contentSection}`,
        lexicalText: `${contentSection}\nmetadata:${projectionMetadata}\nidentifier-components:${JSON.stringify(additiveLexicalTerms)}\nidentifier-aliases:${JSON.stringify(lexicalIdentifierAliases)}`,
        embeddingVersion: EMBEDDING_PROJECTION_VERSION,
        lexicalVersion: LEXICAL_PROJECTION_VERSION,
    };
}
