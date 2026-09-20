import { isLanguageCapabilitySupportedForLanguage } from '../../language';
import type { CallSite } from '../../language-analysis';
import { isCallableSymbolKind, type RelationshipRecord, type SymbolRecord, type SymbolRegistry } from '../../symbols';
import { isTestOrFixturePath } from '../test-path';

import {
    buildTargetIndex,
    getEvidence,
    isEligibleCallTarget,
    ownerForCall,
    relationshipKey,
    relationshipSpan,
    resolveRelativeModulePath,
    resolveUnambiguousTarget,
} from '../python-resolution';
import type { RelationshipAnalysisEvidence } from '../builder';
import type { CallResolutionContribution, CallResolutionEngine, CallResolutionEngineInput } from './contracts';

function resolveSameClassThisMemberTarget(
    source: SymbolRecord,
    candidates: readonly SymbolRecord[],
): SymbolRecord | undefined {
    if (!source.parentKey) return undefined;
    const sameClassCandidates = candidates.filter((candidate) => (
        candidate.symbolInstanceId !== source.symbolInstanceId
        && candidate.file === source.file
        && candidate.parentKey === source.parentKey
        && isCallableSymbolKind(candidate.kind)
    ));
    return sameClassCandidates.length === 1 ? sameClassCandidates[0] : undefined;
}

function resolveTypedMemberTarget(input: {
    call: CallSite;
    source: SymbolRecord;
    candidates: readonly SymbolRecord[];
    evidence: RelationshipAnalysisEvidence;
    registry: SymbolRegistry;
}): SymbolRecord | undefined {
    const receiver = input.call.receiverText?.trim();
    if (!receiver || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(receiver)) return undefined;

    const fileSymbols = input.registry.symbolsByFile.get(input.source.file) ?? [];
    const bindings = (input.evidence.receiverTypeBindings ?? []).filter((binding) => (
        binding.kind === 'local_annotation'
        && binding.localName === receiver
        && binding.span.startByte <= input.call.span.startByte
        && ownerForCall(
            fileSymbols,
            { calleeName: '', span: binding.span },
        )?.symbolInstanceId === input.source.symbolInstanceId
    ));
    const typeNames = [...new Set(bindings.map((binding) => binding.typeName))];
    if (typeNames.length !== 1) return undefined;
    const [typeName] = typeNames;

    const imports = input.evidence.moduleBindings.filter((binding) => (
        binding.kind === 'import'
        && binding.localName === typeName
        && Boolean(binding.moduleSpecifier)
    ));
    if (imports.length > 1) return undefined;

    let classCandidates: SymbolRecord[] = [];
    if (imports.length === 1) {
        const importedFile = resolveRelativeModulePath(
            input.source.file,
            imports[0].moduleSpecifier!,
            input.registry,
            input.source.language,
        );
        if (!importedFile) return undefined;
        const importedName = imports[0].importedName && imports[0].importedName !== 'default'
            ? imports[0].importedName
            : typeName;
        classCandidates = (input.registry.symbolsByFile.get(importedFile) ?? []).filter((candidate) => (
            candidate.kind === 'class'
            && candidate.name === importedName
        ));
    } else {
        classCandidates = fileSymbols.filter((candidate) => (
            candidate.kind === 'class'
            && candidate.name === typeName
        ));
    }
    if (classCandidates.length !== 1) return undefined;

    const targetClass = classCandidates[0];
    const memberCandidates = input.candidates.filter((candidate) => (
        candidate.symbolInstanceId !== input.source.symbolInstanceId
        && isCallableSymbolKind(candidate.kind)
        && candidate.parentKey === targetClass.symbolKey
    ));
    return memberCandidates.length === 1 ? memberCandidates[0] : undefined;
}

export class SyntacticResolutionContributionEngine implements CallResolutionEngine {
    resolveCalls(input: CallResolutionEngineInput): CallResolutionContribution {
        const targetIndex = buildTargetIndex(input.registry.symbols);
        const symbolsByFile = input.registry.symbolsByFile;
        const recordsByKey = new Map<string, RelationshipRecord>();

        for (const file of input.registry.manifest.files) {
            if (input.sourceFiles && !input.sourceFiles.has(file.path)) continue;
            if (file.language === 'python') continue;

            const isEligible = isLanguageCapabilitySupportedForLanguage(file.language, 'callGraphBuild')
                || (input.mode?.kind === 'qualification' && input.mode.enabledUnpromotedCallLanguages.has(file.language));
            if (!isEligible) continue;
            const testReferencesReady = isLanguageCapabilitySupportedForLanguage(file.language, 'testLinks');

            const evidence = getEvidence(input.analysisByFile, file.path);
            if (!evidence) continue;

            for (const call of evidence.callSites) {
                const source = ownerForCall(symbolsByFile.get(file.path) ?? [], call);
                if (!source) continue;
                const candidates = targetIndex.get(call.calleeName);
                const typedMemberTarget = candidates
                    && call.kind === 'member'
                    && call.receiverText !== 'this'
                    ? resolveTypedMemberTarget({
                        call,
                        source,
                        candidates,
                        evidence,
                        registry: input.registry,
                    })
                    : undefined;
                const target = !candidates || candidates.length === 0
                    ? undefined
                    : call.kind === 'member'
                        ? call.receiverText === 'this'
                            ? resolveSameClassThisMemberTarget(source, candidates)
                            : typedMemberTarget
                        : resolveUnambiguousTarget(
                            source,
                            candidates.filter((candidate) => isEligibleCallTarget(call, candidate)),
                        );
                if (!target) continue;
                const record: RelationshipRecord = {
                    sourceKey: source.symbolKey,
                    sourceInstanceId: source.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    type: 'CALLS',
                    file: source.file,
                    span: relationshipSpan(call),
                    confidence: target.file === source.file ? 'high' : 'low',
                    ...(typedMemberTarget ? { resolutionAuthority: 'direct_binding' as const } : {}),
                };
                recordsByKey.set(relationshipKey(record), record);
                if (testReferencesReady && isTestOrFixturePath(source.file) && !isTestOrFixturePath(target.file)) {
                    const testRecord: RelationshipRecord = {
                        ...record,
                        type: 'TESTS',
                    };
                    recordsByKey.set(relationshipKey(testRecord), testRecord);
                }

            }
        }

        return {
            records: [...recordsByKey.values()],
        };
    }
}

export const syntacticResolutionContributionEngine = new SyntacticResolutionContributionEngine();
