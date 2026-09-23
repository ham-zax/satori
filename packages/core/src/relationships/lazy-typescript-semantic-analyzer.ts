import type {
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
    ResolutionProjectInput,
} from './resolution';

export class LazyTypeScriptSemanticProjectAnalyzer implements ResolutionProjectAnalyzer {
    private analyzerPromise?: Promise<ResolutionProjectAnalyzer>;

    constructor(private readonly maxSessions = 4) {}

    supportsLanguage(language: string): boolean {
        return language.trim().toLowerCase() === 'typescript';
    }

    analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        return this.loadAnalyzer().then((analyzer) => analyzer.analyze(input));
    }

    async getSourceControlFiles(input: {
        readonly rootPath: string;
        readonly language: string;
        readonly sourceFiles: readonly string[];
    }): Promise<readonly string[]> {
        if (!this.supportsLanguage(input.language)) return [];
        const analyzer = await this.loadAnalyzer();
        return analyzer.getSourceControlFiles?.(input) ?? [];
    }

    async dispose(): Promise<void> {
        if (!this.analyzerPromise) return;
        const analyzer = await this.analyzerPromise;
        await analyzer.dispose?.();
    }

    private loadAnalyzer(): Promise<ResolutionProjectAnalyzer> {
        this.analyzerPromise ??= Promise.all([
            import('./typescript-semantic-analyzer.js'),
            import('./typescript-provider-composition.js'),
        ]).then(([{ TypeScriptSemanticProjectAnalyzer }, { CompositeTypeScriptResolutionProjectAnalyzer }]) => (
            new CompositeTypeScriptResolutionProjectAnalyzer([{
                analyzer: new TypeScriptSemanticProjectAnalyzer(this.maxSessions),
                participation: 'admission',
            }])
        ));
        return this.analyzerPromise;
    }
}
