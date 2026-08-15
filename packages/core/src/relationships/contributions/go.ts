import { CbmSemanticContributionEngine, type CbmResolutionInput } from './cbm';
import type { CallResolutionContribution, CallResolutionEngine } from './contracts';

export const CBM_GO_PROVIDER_ID = 'satori-cbm-semantic-go';
export const CBM_GO_PROVIDER_VERSION = 'cbm-d150ebe4+satori-go-semantic-v1';
export const CBM_GO_ENVIRONMENT_CONFIG_ID = 'cbm-go-semantic-v1';

export type GoResolutionInput = CbmResolutionInput;

export class GoResolutionContributionEngine implements CallResolutionEngine {
    private readonly genericEngine = new CbmSemanticContributionEngine('go');

    resolveCalls(input: GoResolutionInput): CallResolutionContribution {
        return this.genericEngine.resolveCalls(input);
    }
}

export const goResolutionContributionEngine = new GoResolutionContributionEngine();
