import type { SemanticProjectInput, SemanticProjectEvidence } from './contracts';

export interface SemanticProjectAnalyzer {
    /** Releases an idle execution scope without disabling subsequent analysis. */
    releaseIdleWorker?(): Promise<void>;
    supportsLanguage(language: string): boolean;
    /**
     * Returns a failure message only when on-disk source sizes prove that
     * analyze() would exceed the engine's session limits, so the caller can
     * skip reading the sources. Undefined means "unsure": call analyze().
     */
    provableLimitFailure?(language: string, sourceFileBytes: readonly number[]): string | undefined;
    analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence>;
    dispose?(): Promise<void>;
}
