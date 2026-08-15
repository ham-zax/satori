import { isLanguageCapabilitySupportedForLanguage } from '../../language';
import type { RelationshipRecord } from '../../symbols';
import { isTestOrFixturePath } from '../test-path';

import {
    buildTargetIndex,
    getEvidence,
    isEligibleCallTarget,
    ownerForCall,
    relationshipKey,
    relationshipSpan,
    resolveUnambiguousTarget,
} from '../python-resolution';
import type { CallResolutionContribution, CallResolutionEngine, CallResolutionEngineInput } from './contracts';

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

            const evidence = getEvidence(input.analysisByFile, file.path);
            if (!evidence) continue;

            for (const call of evidence.callSites) {
                const source = ownerForCall(symbolsByFile.get(file.path) ?? [], call);
                if (!source) continue;
                const candidates = targetIndex.get(call.calleeName);
                const target = !candidates || candidates.length === 0
                    ? undefined
                    : call.kind === 'member'
                        ? undefined
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
                };
                recordsByKey.set(relationshipKey(record), record);
                if (isTestOrFixturePath(source.file) && !isTestOrFixturePath(target.file)) {
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
