import type { SymbolRegistry, RelationshipRecord } from '../../symbols';
import type { RelationshipAnalysisEvidence } from '../builder';
import type { ResolutionClaim } from '../resolution';

import type { LanguageResolutionStrategyRegistry } from '../resolution-strategy-registry';

export type RelationshipBuildMode =
    | { readonly kind: 'production' }
    | {
        readonly kind: 'qualification';
        readonly enabledUnpromotedCallLanguages: ReadonlySet<string>;
    };

export interface CallResolutionContribution {
    readonly records: readonly RelationshipRecord[];
    readonly claimsByFile?: ReadonlyMap<string, readonly ResolutionClaim[]>;
}

export interface CallResolutionEngineInput {
    readonly registry: SymbolRegistry;
    readonly analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
    readonly sourceFiles?: ReadonlySet<string>;
    readonly mode?: RelationshipBuildMode;
    readonly strategyRegistry?: LanguageResolutionStrategyRegistry;
}


export interface CallResolutionEngine {
    resolveCalls(input: CallResolutionEngineInput): CallResolutionContribution;
}
