import { resolvePythonRelationships } from '../python-resolution';
import type { CallResolutionContribution, CallResolutionEngine, CallResolutionEngineInput } from './contracts';

export class PythonResolutionContributionEngine implements CallResolutionEngine {
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
