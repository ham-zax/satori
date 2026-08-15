import type { SemanticProjectAnalyzer } from './analyzer-port';
import type { SemanticProjectInput, SemanticProjectEvidence } from './contracts';

export class NoopSemanticProjectAnalyzer implements SemanticProjectAnalyzer {
    supportsLanguage(_language: string): boolean {
        return false;
    }

    async analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence> {
        return {
            language: input.language,
            occurrencesByFile: new Map(),
        };
    }
}

export const noopSemanticProjectAnalyzer = new NoopSemanticProjectAnalyzer();
