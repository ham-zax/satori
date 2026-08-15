import { normalizeLanguageId } from '../language';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../semantic/descriptor';

export type LanguageResolutionStrategy =
    | 'python_native'
    | 'syntactic'
    | 'cbm_semantic'
    | 'none';

export interface LanguageResolutionStrategyRegistry {
    strategyForLanguage(language: string): LanguageResolutionStrategy;
}

const STATIC_BUILTIN_STRATEGIES: Readonly<Record<string, LanguageResolutionStrategy>> = {
    python: 'python_native',
    javascript: 'syntactic',
    typescript: 'syntactic',
};

export class DefaultLanguageResolutionStrategyRegistry implements LanguageResolutionStrategyRegistry {
    private readonly customStrategies: Map<string, LanguageResolutionStrategy>;
    private readonly semanticRegistry: SemanticLanguageRegistry;

    constructor(
        customStrategies?: ReadonlyMap<string, LanguageResolutionStrategy> | Record<string, LanguageResolutionStrategy>,
        semanticRegistry: SemanticLanguageRegistry = defaultSemanticLanguageRegistry,
    ) {
        this.customStrategies = new Map();
        this.semanticRegistry = semanticRegistry;

        if (customStrategies) {
            const entries = customStrategies instanceof Map ? customStrategies.entries() : Object.entries(customStrategies);
            for (const [lang, strategy] of entries) {
                this.customStrategies.set(normalizeLanguageId(lang), strategy);
            }
        }
    }

    strategyForLanguage(language: string): LanguageResolutionStrategy {
        const canonical = normalizeLanguageId(language);

        // 1. Custom override takes highest precedence
        const custom = this.customStrategies.get(canonical);
        if (custom) return custom;

        // 2. Declarative descriptor registry (CBM-backed semantic languages)
        const descriptorStrategy = this.semanticRegistry.getStrategyForLanguage(canonical);
        if (descriptorStrategy) {
            return descriptorStrategy as LanguageResolutionStrategy;
        }

        // 3. Static built-in non-CBM strategies
        return STATIC_BUILTIN_STRATEGIES[canonical] ?? 'none';
    }
}

export const defaultResolutionStrategyRegistry: LanguageResolutionStrategyRegistry =
    new DefaultLanguageResolutionStrategyRegistry();
