import type { CodeChunk } from '../language-analysis';
import { validateRepositoryRelativePath } from '../paths/repository-path';
import type { SearchProjections } from '../vectordb/types';

export const EMBEDDING_PROJECTION_VERSION = 'embedding_projection_v1' as const;
export const LEXICAL_PROJECTION_VERSION = 'lexical_projection_v1' as const;

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
    const projectionMetadata = JSON.stringify({
        path: relativePath,
        ...(metadata.language ? { language: metadata.language } : {}),
        ...(metadata.symbolKind ? { symbolKind: metadata.symbolKind } : {}),
        ...(metadata.symbolLabel ? { symbolLabel: metadata.symbolLabel } : {}),
        ...(metadata.breadcrumbs?.length ? { breadcrumbs: metadata.breadcrumbs } : {}),
    });
    const contentSection = `content:${chunk.content.length}\n${chunk.content}`;

    return {
        embeddingText: `metadata:${projectionMetadata}\n${contentSection}`,
        lexicalText: `${contentSection}\nmetadata:${projectionMetadata}\nidentifier-components:${JSON.stringify(additiveLexicalTerms)}`,
        embeddingVersion: EMBEDDING_PROJECTION_VERSION,
        lexicalVersion: LEXICAL_PROJECTION_VERSION,
    };
}
