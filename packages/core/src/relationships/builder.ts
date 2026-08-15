import { isLanguageCapabilitySupportedForLanguage } from '../language';
import type { LanguageAnalysisResult } from '../language-analysis';
import type { RelationshipRecord, SymbolRecord, SymbolRegistry } from '../symbols';

import {
    compareRelationshipRecords,
    compareStrings,
    relationshipKey,
    relationshipSpan,
    resolvePythonModulePath,
    resolveRelativeModulePath,
} from './python-resolution';

import type { ResolutionClaim } from './resolution';
import { pythonResolutionContributionEngine } from './contributions/python';
import { syntacticResolutionContributionEngine } from './contributions/syntactic';
import { CbmSemanticContributionEngine } from './contributions/cbm';
import type { RelationshipBuildMode } from './contributions/contracts';
import {
    type LanguageResolutionStrategyRegistry,
    defaultResolutionStrategyRegistry,
    DefaultLanguageResolutionStrategyRegistry,
} from './resolution-strategy-registry';
import type { SemanticProjectEvidence } from '../semantic';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../semantic/descriptor';

export type RelationshipAnalysisEvidence =
    Pick<LanguageAnalysisResult, 'moduleBindings' | 'callSites'>
    & Partial<Pick<LanguageAnalysisResult, 'receiverTypeBindings' | 'pythonFlowFacts'>>
    & {
        readonly resolutionClaims?: readonly ResolutionClaim[];
    };

export interface BuildCallRelationshipsForRegistryInput {
    registry: SymbolRegistry;
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
    /**
     * When provided, only calls originating from these files are rebuilt.
     * Other files in registry are treated as unchanged and retained in the
     * analysis map as semantic context for cross-file resolution.
     */
    sourceFiles?: ReadonlySet<string>;
    mode?: RelationshipBuildMode;
    strategyRegistry?: LanguageResolutionStrategyRegistry;
    semanticRegistry?: SemanticLanguageRegistry;
    semanticEvidenceByLanguage?: ReadonlyMap<string, SemanticProjectEvidence> | Record<string, SemanticProjectEvidence>;
}


export type BuildRelationshipsForRegistryInput = BuildCallRelationshipsForRegistryInput;

export interface BuildRelationshipDeltaInput extends BuildRelationshipsForRegistryInput {
    previousRegistry: SymbolRegistry;
    existingRecords: readonly RelationshipRecord[];
    changedFiles: ReadonlySet<string>;
    previousAnalysisByFile?: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
}

export interface BuildRelationshipDeltaResult {
    records: RelationshipRecord[];
    affectedFiles: string[];
}

function getFileOwners(symbols: readonly SymbolRecord[]): Map<string, SymbolRecord> {
    const fileOwners = new Map<string, SymbolRecord>();
    for (const symbol of symbols) {
        if (symbol.kind === 'file') {
            fileOwners.set(symbol.file, symbol);
        }
    }
    return fileOwners;
}

function resolveUniqueLocalSymbol(
    file: string,
    name: string,
    symbolsByFile: Map<string, SymbolRecord[]>,
): SymbolRecord | undefined {
    const fileSymbols = symbolsByFile.get(file);
    if (!fileSymbols) return undefined;
    const matches = fileSymbols.filter((symbol) => (
        symbol.kind !== 'file'
        && symbol.name === name
        && symbol.parentQualifiedNamePath.length === 0
    ));
    return matches.length === 1 ? matches[0] : undefined;
}

function resolveModulePathForDelta(
    sourceFile: string,
    specifier: string,
    registry: SymbolRegistry,
    language: string,
    availableFiles: ReadonlySet<string>,
): string | undefined {
    return language === 'python'
        ? resolvePythonModulePath(sourceFile, specifier, registry, availableFiles)
        : resolveRelativeModulePath(sourceFile, specifier, registry, language, availableFiles);
}

function getEvidence(
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence> | undefined,
    file: string,
): RelationshipAnalysisEvidence | undefined {
    if (!analysisByFile) return undefined;
    if (analysisByFile instanceof Map) {
        return analysisByFile.get(file);
    }
    return analysisByFile[file];
}

function getEvidenceEntries(
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence> | undefined,
): Array<[string, RelationshipAnalysisEvidence]> {
    if (!analysisByFile) return [];
    if (analysisByFile instanceof Map) {
        return [...analysisByFile.entries()];
    }
    return Object.entries(analysisByFile);
}

function attachResolutionClaims(
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>,
    claimsByFile: Map<string, ResolutionClaim[]>,
): void {
    for (const [file, claims] of claimsByFile) {
        const evidence = getEvidence(analysisByFile, file);
        if (evidence) {
            (evidence as { resolutionClaims?: readonly ResolutionClaim[] }).resolutionClaims =
                [...claims].sort((left, right) =>
                    left.callSpan.startByte - right.callSpan.startByte
                );
        }
    }
}



export {
    admitAuthoritativeProofBackedCalls,
    admitResolvedCallClaims,
} from './admission';

export function buildCallRelationshipsForRegistry(input: BuildCallRelationshipsForRegistryInput): RelationshipRecord[] {
    const semanticRegistry = input.semanticRegistry ?? defaultSemanticLanguageRegistry;
    const strategyRegistry = input.strategyRegistry ?? (input.semanticRegistry ? new DefaultLanguageResolutionStrategyRegistry(undefined, semanticRegistry) : defaultResolutionStrategyRegistry);
    const recordsByKey = new Map<string, RelationshipRecord>();
    const allClaimsByFile = new Map<string, ResolutionClaim[]>();

    // 1. Partition files by strategy and language, evaluating capability eligibility per language
    const filesByStrategyAndLanguage = new Map<string, Map<string, Set<string>>>();

    for (const file of input.registry.manifest.files) {
        if (input.sourceFiles && !input.sourceFiles.has(file.path)) continue;

        const strategy = strategyRegistry.strategyForLanguage(file.language);
        const isEligible = isLanguageCapabilitySupportedForLanguage(file.language, 'callGraphBuild')
            || (input.mode?.kind === 'qualification' && input.mode.enabledUnpromotedCallLanguages.has(file.language));
        if (!isEligible) continue;

        let langMap = filesByStrategyAndLanguage.get(strategy);
        if (!langMap) {
            langMap = new Map();
            filesByStrategyAndLanguage.set(strategy, langMap);
        }
        let fileSet = langMap.get(file.language);
        if (!fileSet) {
            fileSet = new Set();
            langMap.set(file.language, fileSet);
        }
        fileSet.add(file.path);
    }

    // 2. Dispatch Python engine for python_native files
    const pythonLangs = filesByStrategyAndLanguage.get('python_native');
    if (pythonLangs) {
        const pythonFiles = new Set<string>();
        for (const files of pythonLangs.values()) {
            for (const f of files) pythonFiles.add(f);
        }
        if (pythonFiles.size > 0) {
            const pythonResult = pythonResolutionContributionEngine.resolveCalls({
                registry: input.registry,
                analysisByFile: input.analysisByFile,
                sourceFiles: pythonFiles,
                mode: input.mode,
                strategyRegistry,
            });
            for (const record of pythonResult.records) {
                recordsByKey.set(relationshipKey(record), record);
            }
            if (pythonResult.claimsByFile) {
                for (const [file, claims] of pythonResult.claimsByFile) {
                    allClaimsByFile.set(file, [...claims]);
                }
            }
        }
    }

    // 3. Dispatch Syntactic engine for syntactic files
    const syntacticLangs = filesByStrategyAndLanguage.get('syntactic');
    if (syntacticLangs) {
        const syntacticFiles = new Set<string>();
        for (const files of syntacticLangs.values()) {
            for (const f of files) syntacticFiles.add(f);
        }
        if (syntacticFiles.size > 0) {
            const syntacticResult = syntacticResolutionContributionEngine.resolveCalls({
                registry: input.registry,
                analysisByFile: input.analysisByFile,
                sourceFiles: syntacticFiles,
                mode: input.mode,
                strategyRegistry,
            });
            for (const record of syntacticResult.records) {
                recordsByKey.set(relationshipKey(record), record);
            }
            if (syntacticResult.claimsByFile) {
                for (const [file, claims] of syntacticResult.claimsByFile) {
                    const existing = allClaimsByFile.get(file) ?? [];
                    existing.push(...claims);
                    allClaimsByFile.set(file, existing);
                }
            }
        }
    }

    // 4. Dispatch generic CBM contribution engine for each cbm_semantic language
    const cbmLangs = filesByStrategyAndLanguage.get('cbm_semantic');
    if (cbmLangs) {
        for (const [language, files] of cbmLangs) {
            if (files.size === 0) continue;
            let semanticEvidence: SemanticProjectEvidence | undefined;
            if (input.semanticEvidenceByLanguage) {
                semanticEvidence = input.semanticEvidenceByLanguage instanceof Map
                    ? input.semanticEvidenceByLanguage.get(language)
                    : (input.semanticEvidenceByLanguage as Record<string, SemanticProjectEvidence>)[language];
            }
            const cbmEngine = new CbmSemanticContributionEngine(language, undefined, input.semanticRegistry);
            const cbmResult = cbmEngine.resolveCalls({
                registry: input.registry,
                analysisByFile: input.analysisByFile,
                sourceFiles: files,
                mode: input.mode,
                strategyRegistry,
                semanticEvidence,
            });
            for (const record of cbmResult.records) {
                recordsByKey.set(relationshipKey(record), record);
            }
            if (cbmResult.claimsByFile) {
                for (const [file, claims] of cbmResult.claimsByFile) {
                    const existing = allClaimsByFile.get(file) ?? [];
                    existing.push(...claims);
                    allClaimsByFile.set(file, existing);
                }
            }
        }
    }

    attachResolutionClaims(input.analysisByFile, allClaimsByFile);
    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}


function buildImportExportRelationshipsForRegistry(input: BuildRelationshipsForRegistryInput): RelationshipRecord[] {
    const fileOwners = getFileOwners(input.registry.symbols);
    const symbolsByFile = input.registry.symbolsByFile;
    const availableFiles = new Set(input.registry.manifest.files.map((file) => file.path));
    const recordsByKey = new Map<string, RelationshipRecord>();

    for (const source of input.registry.symbols.filter((symbol) => symbol.kind === 'file')) {
        if (input.sourceFiles && !input.sourceFiles.has(source.file)) continue;
        const evidence = getEvidence(input.analysisByFile, source.file);
        if (!evidence) continue;
        for (const binding of evidence.moduleBindings) {
            if (binding.kind === 'import' || binding.kind === 'reexport') {
                const specifier = binding.moduleSpecifier;
                const targetPath = specifier
                    ? source.language === 'python'
                        ? resolvePythonModulePath(source.file, specifier, input.registry, availableFiles)
                        : resolveRelativeModulePath(
                            source.file,
                            specifier,
                            input.registry,
                            source.language,
                            availableFiles,
                        )
                    : undefined;
                const target = targetPath ? fileOwners.get(targetPath) : undefined;
                if (!target) continue;
                const record: RelationshipRecord = {
                    sourceKey: source.symbolKey,
                    sourceInstanceId: source.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    targetPath: target.file,
                    type: binding.kind === 'import' ? 'IMPORTS' : 'EXPORTS',
                    file: source.file,
                    span: relationshipSpan(binding),
                    confidence: 'high',
                };
                recordsByKey.set(relationshipKey(record), record);
                continue;
            }

            const localName = binding.localName ?? binding.exportedName;
            const target = localName
                ? resolveUniqueLocalSymbol(source.file, localName, symbolsByFile)
                : undefined;

            if (!target) continue;
            const record: RelationshipRecord = {
                sourceKey: source.symbolKey,
                sourceInstanceId: source.symbolInstanceId,
                targetKey: target.symbolKey,
                targetInstanceId: target.symbolInstanceId,
                type: 'EXPORTS',
                file: source.file,
                span: relationshipSpan(binding),
                confidence: 'high',
            };
            recordsByKey.set(relationshipKey(record), record);
        }
    }

    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}

export function buildRelationshipsForRegistry(input: BuildRelationshipsForRegistryInput): RelationshipRecord[] {
    const recordsByKey = new Map<string, RelationshipRecord>();
    for (const record of [
        ...buildImportExportRelationshipsForRegistry(input),
        ...buildCallRelationshipsForRegistry(input),
    ]) {
        recordsByKey.set(relationshipKey(record), record);
    }
    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}

export function buildRelationshipDelta(input: BuildRelationshipDeltaInput): BuildRelationshipDeltaResult {
    const affectedFiles = new Set(input.changedFiles);
    const changedTargetNames = new Set<string>();
    const previousFilesByPath = new Map(
        input.previousRegistry.manifest.files.map((file) => [file.path, file]),
    );
    const previousAvailableFiles = new Set(previousFilesByPath.keys());
    const availableFiles = new Set(input.registry.manifest.files.map((file) => file.path));
    const changedPreviousTargetInstanceIds = new Set(
        input.previousRegistry.symbols
            .filter((symbol) => symbol.kind !== 'file' && input.changedFiles.has(symbol.file))
            .map((symbol) => symbol.symbolInstanceId),
    );
    for (const record of input.existingRecords) {
        if (record.targetInstanceId && changedPreviousTargetInstanceIds.has(record.targetInstanceId)) {
            affectedFiles.add(record.file);
        }
    }
    for (const symbol of [...input.previousRegistry.symbols, ...input.registry.symbols]) {
        if (symbol.kind !== 'file' && input.changedFiles.has(symbol.file)) {
            changedTargetNames.add(symbol.name);
        }
    }

    if (input.previousAnalysisByFile) {
        for (const [, evidence] of getEvidenceEntries(input.previousAnalysisByFile)) {
            for (const claim of evidence.resolutionClaims ?? []) {
                if (claim.dependencyKeys.some((dependencyKey) => (
                    [...input.changedFiles].some((file) => dependencyKey.startsWith(`${file}:`))
                ))) {
                    affectedFiles.add(claim.sourceFile);
                }
            }
        }
    }

    for (const file of input.registry.manifest.files) {
        if (affectedFiles.has(file.path)) continue;
        const evidence = getEvidence(input.analysisByFile, file.path);
        if (!evidence) continue;
        if (evidence.callSites.some((call) => changedTargetNames.has(call.calleeName))) {
            affectedFiles.add(file.path);
            continue;
        }
        const previousFile = previousFilesByPath.get(file.path);
        const language = previousFile?.language ?? file.language;
        const resolutionChanged = evidence.moduleBindings.some((binding) => {
            if ((binding.kind !== 'import' && binding.kind !== 'reexport') || !binding.moduleSpecifier) {
                return false;
            }
            const previousTarget = resolveModulePathForDelta(
                file.path,
                binding.moduleSpecifier,
                input.previousRegistry,
                language,
                previousAvailableFiles,
            );
            const nextTarget = resolveModulePathForDelta(
                file.path,
                binding.moduleSpecifier,
                input.registry,
                file.language,
                availableFiles,
            );
            return previousTarget !== nextTarget
                || (previousTarget !== undefined && input.changedFiles.has(previousTarget))
                || (nextTarget !== undefined && input.changedFiles.has(nextTarget));
        });
        if (resolutionChanged) affectedFiles.add(file.path);
    }

    if (input.semanticEvidenceByLanguage) {
        const entries = input.semanticEvidenceByLanguage instanceof Map
            ? [...input.semanticEvidenceByLanguage.entries()]
            : Object.entries(input.semanticEvidenceByLanguage);
        for (const [lang] of entries) {
            for (const file of input.registry.manifest.files) {
                if (file.language === lang) {
                    affectedFiles.add(file.path);
                }
            }
        }
    }

    const retained = input.existingRecords.filter((record) => !affectedFiles.has(record.file));
    const rebuilt = buildRelationshipsForRegistry({
        registry: input.registry,
        analysisByFile: input.analysisByFile,
        sourceFiles: affectedFiles,
        mode: input.mode,
        strategyRegistry: input.strategyRegistry,
        semanticRegistry: input.semanticRegistry,
        semanticEvidenceByLanguage: input.semanticEvidenceByLanguage,
    });

    const recordsByKey = new Map<string, RelationshipRecord>();
    for (const record of [...retained, ...rebuilt]) {
        recordsByKey.set(relationshipKey(record), record);
    }
    return {
        records: [...recordsByKey.values()].sort(compareRelationshipRecords),
        affectedFiles: [...affectedFiles].sort(compareStrings),
    };
}
