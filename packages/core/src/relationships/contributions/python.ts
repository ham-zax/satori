import { resolvePythonRelationships, resolvePythonRelationshipsWork } from '../python-resolution';
import type { RelationshipResolutionWork } from '../resolution-work';
import type { CallResolutionContribution, CallResolutionEngine, CallResolutionEngineInput } from './contracts';

export class PythonResolutionContributionEngine implements CallResolutionEngine {
    *resolveCallsWork(input: CallResolutionEngineInput): RelationshipResolutionWork<CallResolutionContribution> {
        return yield* resolvePythonRelationshipsWork({
            registry: input.registry,
            analysisByFile: input.analysisByFile,
            settings: { sourceFiles: input.sourceFiles },
        });
    }

    resolveCalls(input: CallResolutionEngineInput): CallResolutionContribution {
        const result = resolvePythonRelationships({
            registry: input.registry,
            analysisByFile: input.analysisByFile,
            settings: {
                sourceFiles: input.sourceFiles,
            },
        });
        return {
            records: result.records,
            claimsByFile: result.claimsByFile,
        };
    }
}

export const pythonResolutionContributionEngine = new PythonResolutionContributionEngine();
