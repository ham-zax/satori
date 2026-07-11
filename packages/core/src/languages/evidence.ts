import { readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols/sidecar';
import type { ReadSymbolRegistrySidecarResult } from '../symbols/sidecar';
import type { PublicLanguageClaim } from './types';
import { getLanguageCapabilityDeclaration } from './capabilities';

export type EffectiveLanguageCapabilityState = 'ready' | 'degraded' | 'unavailable' | 'not_applicable';
export type NavigationEvidenceStatus = 'compatible' | 'missing' | 'incompatible' | 'not_checked';

export interface LanguageCapabilityEvidenceEntry {
    language: string;
    declaredClaim: PublicLanguageClaim | 'undeclared';
    indexedFileCount: number;
    symbolEvidence: {
        eligibleFiles: number;
        filesWithNonFileSymbols: number;
        status: 'symbol_rich' | 'mixed' | 'symbol_sparse' | 'search_only' | 'unknown';
    };
    relationshipEvidence: NavigationEvidenceStatus | 'not_applicable';
    capabilities: {
        semanticSearch: EffectiveLanguageCapabilityState;
        exactSymbol: EffectiveLanguageCapabilityState;
        outline: EffectiveLanguageCapabilityState;
        callGraph: EffectiveLanguageCapabilityState;
    };
    degradationReasons: string[];
}

export interface LanguageCapabilityEvidenceSummary {
    basis: 'language_declarations_and_navigation_sidecars';
    registryEvidence: Exclude<NavigationEvidenceStatus, 'not_checked'>;
    relationshipEvidence: NavigationEvidenceStatus;
    languages: LanguageCapabilityEvidenceEntry[];
}

export interface LanguageCapabilityEvidenceInput {
    searchable: boolean;
    registryStatus: Exclude<NavigationEvidenceStatus, 'not_checked'>;
    relationshipStatus: NavigationEvidenceStatus;
    files: readonly { language: string }[];
    symbols: readonly { language: string; kind: string; file?: string }[];
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalLanguage(language: string): string {
    const normalized = String(language || '').trim().toLowerCase() || 'unknown';
    return getLanguageCapabilityDeclaration(normalized)?.languageId || normalized;
}

function symbolState(input: {
    eligibleFiles: number;
    filesWithNonFileSymbols: number;
    searchOnly: boolean;
}): LanguageCapabilityEvidenceEntry['symbolEvidence']['status'] {
    if (input.searchOnly) return 'search_only';
    if (input.eligibleFiles <= 0) return 'unknown';
    const coverage = input.filesWithNonFileSymbols / input.eligibleFiles;
    if (coverage >= 0.60) return 'symbol_rich';
    if (coverage >= 0.20) return 'mixed';
    return 'symbol_sparse';
}

function navigationState(input: {
    eligibleFiles: number;
    filesWithNonFileSymbols: number;
}): EffectiveLanguageCapabilityState {
    if (input.eligibleFiles > 0 && input.filesWithNonFileSymbols === input.eligibleFiles) return 'ready';
    if (input.filesWithNonFileSymbols > 0) return 'degraded';
    return 'unavailable';
}

export function computeLanguageCapabilityEvidence(
    input: LanguageCapabilityEvidenceInput,
): LanguageCapabilityEvidenceSummary {
    const filesByLanguage = new Map<string, number>();
    for (const file of input.files) {
        const language = canonicalLanguage(file.language);
        filesByLanguage.set(language, (filesByLanguage.get(language) || 0) + 1);
    }

    const nonFileSymbolFilesByLanguage = new Map<string, Set<string>>();
    for (const [symbolIndex, symbol] of input.symbols.entries()) {
        if (symbol.kind === 'file') continue;
        const language = canonicalLanguage(symbol.language);
        const files = nonFileSymbolFilesByLanguage.get(language) || new Set<string>();
        files.add(symbol.file || `#symbol-${symbolIndex}`);
        nonFileSymbolFilesByLanguage.set(language, files);
    }

    const languages = Array.from(filesByLanguage.entries())
        .map(([language, indexedFileCount]): LanguageCapabilityEvidenceEntry => {
            const declaration = getLanguageCapabilityDeclaration(language);
            const declaredClaim = declaration?.publicClaim || 'undeclared';
            const searchOnly = declaredClaim === 'search_only';
            const eligibleFiles = searchOnly ? 0 : indexedFileCount;
            const filesWithNonFileSymbols = searchOnly
                ? 0
                : Math.min(indexedFileCount, nonFileSymbolFilesByLanguage.get(language)?.size || 0);
            const status = symbolState({ eligibleFiles, filesWithNonFileSymbols, searchOnly });
            const symbolNavigation = searchOnly
                ? 'not_applicable'
                : navigationState({ eligibleFiles, filesWithNonFileSymbols });
            const effectiveSymbolNavigation = input.searchable || symbolNavigation === 'not_applicable'
                ? symbolNavigation
                : 'unavailable';
            const supportsCallGraph = declaration?.callsCapability !== undefined
                && declaration.callsCapability !== 'none';
            const relationshipEvidence = supportsCallGraph
                ? input.relationshipStatus
                : 'not_applicable';
            let callGraph: EffectiveLanguageCapabilityState = 'not_applicable';
            if (supportsCallGraph) {
                if (!input.searchable || input.relationshipStatus !== 'compatible' || symbolNavigation === 'unavailable') {
                    callGraph = 'unavailable';
                } else if (symbolNavigation === 'degraded') {
                    callGraph = 'degraded';
                } else {
                    callGraph = 'ready';
                }
            }

            const degradationReasons: string[] = [];
            if (!input.searchable) degradationReasons.push('index_not_searchable');
            if (!declaration) degradationReasons.push('undeclared_language');
            if (symbolNavigation === 'degraded') degradationReasons.push('symbol_evidence_partial');
            if (!searchOnly && filesWithNonFileSymbols === 0) degradationReasons.push('symbol_evidence_missing');
            if (supportsCallGraph && input.relationshipStatus !== 'compatible') {
                degradationReasons.push(`relationship_sidecar_${input.relationshipStatus}`);
            }

            return {
                language,
                declaredClaim,
                indexedFileCount,
                symbolEvidence: { eligibleFiles, filesWithNonFileSymbols, status },
                relationshipEvidence,
                capabilities: {
                    semanticSearch: input.searchable ? 'ready' : 'unavailable',
                    exactSymbol: effectiveSymbolNavigation,
                    outline: effectiveSymbolNavigation,
                    callGraph,
                },
                degradationReasons,
            };
        })
        .sort((left, right) => compareStrings(left.language, right.language));

    return {
        basis: 'language_declarations_and_navigation_sidecars',
        registryEvidence: input.registryStatus,
        relationshipEvidence: input.relationshipStatus,
        languages,
    };
}

export async function resolveLanguageCapabilityEvidence(input: {
    normalizedRootPath: string;
    searchable: boolean;
    stateRoot?: string;
    registryRead?: ReadSymbolRegistrySidecarResult;
}): Promise<LanguageCapabilityEvidenceSummary> {
    const registry = input.registryRead ?? await readSymbolRegistrySidecar(input);
    if (registry.status !== 'ok' || !registry.registry) {
        return computeLanguageCapabilityEvidence({
            searchable: input.searchable,
            registryStatus: registry.status,
            relationshipStatus: 'not_checked',
            files: [],
            symbols: [],
        });
    }

    const relationships = await readRelationshipSidecar({
        normalizedRootPath: input.normalizedRootPath,
        stateRoot: input.stateRoot,
        expectedSymbolRegistryManifestHash: registry.manifestHash,
    });
    return computeLanguageCapabilityEvidence({
        searchable: input.searchable,
        registryStatus: 'compatible',
        relationshipStatus: relationships.status === 'ok' ? 'compatible' : relationships.status,
        files: registry.registry.manifest.files,
        symbols: registry.registry.symbols,
    });
}
