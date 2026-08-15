import type { SemanticProjectInput, SemanticProjectEvidence } from './contracts';

export interface SemanticProjectAnalyzer {
    supportsLanguage(language: string): boolean;
    analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence>;
    dispose?(): Promise<void>;
}
