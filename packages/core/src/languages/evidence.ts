import { readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols/sidecar';
import type { ReadSymbolRegistrySidecarResult } from '../symbols/sidecar';
import type { StructuralDefinitionStatus } from '../symbols/contracts';
import type { SemanticProviderCoverage } from '../semantic/contracts';
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
        definitionBearingFiles: number;
        definitionFreeFiles: number;
        structurallyUnavailableFiles: number;
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
    files: readonly { language: string; definitionStatus: StructuralDefinitionStatus }[];
    symbols: readonly { language: string; kind: string; file?: string }[];
    providerCoverage?: readonly SemanticProviderCoverage[];
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
    definitionBearingFiles: number;
    structurallyUnavailableFiles: number;
}): EffectiveLanguageCapabilityState {
    if (input.definitionBearingFiles <= 0) return 'unavailable';
    return input.structurallyUnavailableFiles > 0 ? 'degraded' : 'ready';
}

export function computeLanguageCapabilityEvidence(
    input: LanguageCapabilityEvidenceInput,
): LanguageCapabilityEvidenceSummary {
    const filesByLanguage = new Map<string, {
        indexedFileCount: number;
        definitionBearingFiles: number;
        definitionFreeFiles: number;
        structurallyUnavailableFiles: number;
    }>();
    for (const file of input.files) {
        const language = canonicalLanguage(file.language);
        const stats = filesByLanguage.get(language) || {
            indexedFileCount: 0,
            definitionBearingFiles: 0,
            definitionFreeFiles: 0,
            structurallyUnavailableFiles: 0,
        };
        stats.indexedFileCount += 1;
        if (file.definitionStatus === 'definitions_present') stats.definitionBearingFiles += 1;
        if (file.definitionStatus === 'definition_free') stats.definitionFreeFiles += 1;
        if (file.definitionStatus === 'structural_unavailable') stats.structurallyUnavailableFiles += 1;
        filesByLanguage.set(language, stats);
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
        .map(([language, fileStats]): LanguageCapabilityEvidenceEntry => {
            const declaration = getLanguageCapabilityDeclaration(language);
            const declaredClaim = declaration?.publicClaim || 'undeclared';
            const searchOnly = declaredClaim === 'search_only';
            const indexedFileCount = fileStats.indexedFileCount;
            const definitionBearingFiles = searchOnly ? 0 : fileStats.definitionBearingFiles;
            const definitionFreeFiles = searchOnly ? 0 : fileStats.definitionFreeFiles;
            const structurallyUnavailableFiles = searchOnly ? 0 : fileStats.structurallyUnavailableFiles;
            const eligibleFiles = definitionBearingFiles + structurallyUnavailableFiles;
            const filesWithNonFileSymbols = searchOnly
                ? 0
                : Math.min(definitionBearingFiles, nonFileSymbolFilesByLanguage.get(language)?.size || 0);
            const status = symbolState({ eligibleFiles, filesWithNonFileSymbols, searchOnly });
            const symbolNavigation = searchOnly
                ? 'not_applicable'
                : navigationState({ definitionBearingFiles, structurallyUnavailableFiles });
            const effectiveSymbolNavigation = input.searchable || symbolNavigation === 'not_applicable'
                ? symbolNavigation
                : 'unavailable';
            const supportsCallGraph = declaration?.callsCapability !== undefined
                && declaration.callsCapability !== 'none';
            const relationshipEvidence = supportsCallGraph
                ? input.relationshipStatus
                : 'not_applicable';
            const providerCoverage = (input.providerCoverage ?? [])
                .filter((coverage) => canonicalLanguage(coverage.language) === language);
            const providerUnavailable = providerCoverage.some((coverage) => coverage.status === 'unavailable');
            const providerDegraded = providerCoverage.some((coverage) => coverage.status === 'degraded');
            let callGraph: EffectiveLanguageCapabilityState = 'not_applicable';
            if (supportsCallGraph) {
                if (
                    !input.searchable
                    || input.relationshipStatus !== 'compatible'
                    || symbolNavigation === 'unavailable'
                    || providerUnavailable
                ) {
                    callGraph = 'unavailable';
                } else if (symbolNavigation === 'degraded' || providerDegraded) {
                    callGraph = 'degraded';
                } else {
                    callGraph = 'ready';
                }
            }

            const degradationReasons: string[] = [];
            if (!input.searchable) degradationReasons.push('index_not_searchable');
            if (!declaration) degradationReasons.push('undeclared_language');
            if (structurallyUnavailableFiles > 0) degradationReasons.push('structural_evidence_unavailable');
            if (!searchOnly && definitionBearingFiles === 0) degradationReasons.push('definition_evidence_missing');
            if (supportsCallGraph && input.relationshipStatus !== 'compatible') {
                degradationReasons.push(`relationship_sidecar_${input.relationshipStatus}`);
            }
            for (const coverage of providerCoverage) {
                if (coverage.status === 'unavailable') {
                    degradationReasons.push(`relationship_provider_unavailable:${coverage.providerId}`);
                } else if (coverage.status === 'degraded') {
                    degradationReasons.push(`relationship_provider_degraded:${coverage.providerId}`);
                }
            }

            return {
                language,
                declaredClaim,
                indexedFileCount,
                symbolEvidence: {
                    eligibleFiles,
                    filesWithNonFileSymbols,
                    definitionBearingFiles,
                    definitionFreeFiles,
                    structurallyUnavailableFiles,
                    status,
                },
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
    publicationId: string;
    navigationRoot: string;
    registryRead?: ReadSymbolRegistrySidecarResult;
}): Promise<LanguageCapabilityEvidenceSummary> {
    const registry = input.registryRead ?? await readSymbolRegistrySidecar(input);
    if (registry.status !== 'ok' || !registry.registry) {
        return computeLanguageCapabilityEvidence({
            searchable: input.searchable,
            registryStatus: registry.status === 'corrupt' ? 'incompatible' : registry.status,
            relationshipStatus: 'not_checked',
            files: [],
            symbols: [],
        });
    }

    const relationships = await readRelationshipSidecar({
        normalizedRootPath: input.normalizedRootPath,
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
        expectedSymbolRegistryManifestHash: registry.manifestHash,
    });
    return computeLanguageCapabilityEvidence({
        searchable: input.searchable,
        registryStatus: 'compatible',
        relationshipStatus: relationships.status === 'ok'
            ? 'compatible'
            : relationships.status === 'corrupt' ? 'incompatible' : relationships.status,
        files: registry.registry.manifest.files,
        symbols: registry.registry.symbols,
        ...(relationships.status === 'ok'
            ? { providerCoverage: relationships.manifest.providerCoverage }
            : {}),
    });
}
