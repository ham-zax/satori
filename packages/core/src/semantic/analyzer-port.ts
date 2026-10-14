import type { SemanticProjectInput, SemanticProjectEvidence } from './contracts';

export interface SemanticProjectAnalyzer {
    /** Releases an idle execution scope without disabling subsequent analysis. */
    releaseIdleWorker?(): Promise<void>;
    supportsLanguage(language: string): boolean;
    analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence>;
    dispose?(): Promise<void>;
}
