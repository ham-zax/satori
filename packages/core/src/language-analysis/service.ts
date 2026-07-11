import { buildAnalysisChunks } from './chunks';
import { normalizeLanguageId } from '../language';
import { analyzeWithOxc } from './oxc-adapter';
import { analyzeWithTreeSitter } from './tree-sitter-adapter';
import type {
    LanguageAnalysisBackend,
    LanguageAnalysisInput,
    LanguageAnalysisPort,
    LanguageAnalysisResult,
    LanguageAnalysisServiceOptions,
    StructuralReason,
} from './types';

type AnalysisBackend = 'oxc' | 'tree_sitter_wasm';
type LanguageStrategy = {
    readonly backend: LanguageAnalysisBackend;
    readonly structural: boolean;
};

const BACKEND_BY_LANGUAGE: Readonly<Record<string, AnalysisBackend>> = {
    javascript: 'oxc',
    jsx: 'oxc',
    typescript: 'oxc',
    tsx: 'oxc',
    python: 'tree_sitter_wasm',
    go: 'tree_sitter_wasm',
    rust: 'tree_sitter_wasm',
    java: 'tree_sitter_wasm',
    csharp: 'tree_sitter_wasm',
    cpp: 'tree_sitter_wasm',
    scala: 'tree_sitter_wasm',
};

function strategyForLanguage(language: string): LanguageStrategy {
    const backend = BACKEND_BY_LANGUAGE[normalizeLanguageId(language)];
    return backend
        ? { backend, structural: true }
        : { backend: 'bounded_text', structural: false };
}

function fallbackResult(
    input: LanguageAnalysisInput,
    backend: LanguageAnalysisBackend,
    structuralStatus: 'recovered' | 'unsupported',
    structuralReason: StructuralReason,
    options: { chunkSize?: number; chunkOverlap?: number },
): LanguageAnalysisResult {
    const evidence = {
        backend,
        symbols: [],
        moduleBindings: [],
        callSites: [],
        chunks: buildAnalysisChunks(
            input.content,
            input.relativePath,
            input.language,
            [],
            options,
        ),
    };
    if (structuralStatus === 'unsupported') {
        return { ...evidence, structuralStatus, structuralReason: 'unsupported_language' };
    }
    if (structuralReason === 'unsupported_language') {
        throw new Error('Recovered language analysis requires a recoverable reason');
    }
    return { ...evidence, structuralStatus, structuralReason };
}

export function createLanguageAnalysisService(
    options: LanguageAnalysisServiceOptions = {},
): LanguageAnalysisPort {
    const chunkOptions = {
        chunkSize: options.chunkSize,
        chunkOverlap: options.chunkOverlap,
    };

    return {
        async analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> {
            const normalizedLanguage = normalizeLanguageId(input.language);
            const strategy = strategyForLanguage(normalizedLanguage);
            if (strategy.backend === 'bounded_text') {
                return fallbackResult(
                    { ...input, language: normalizedLanguage },
                    strategy.backend,
                    'unsupported',
                    'unsupported_language',
                    chunkOptions,
                );
            }

            try {
                const normalizedInput = { ...input, language: normalizedLanguage };
                const evidence = strategy.backend === 'oxc'
                    ? analyzeWithOxc(normalizedInput)
                    : await analyzeWithTreeSitter(normalizedInput, options.assetRoot);
                if (!evidence.complete) {
                    return fallbackResult(
                        normalizedInput,
                        strategy.backend,
                        'recovered',
                        evidence.reason,
                        chunkOptions,
                    );
                }
                return {
                    backend: strategy.backend,
                    structuralStatus: 'complete',
                    symbols: evidence.symbols,
                    moduleBindings: evidence.moduleBindings,
                    callSites: evidence.callSites,
                    chunks: buildAnalysisChunks(
                        normalizedInput.content,
                        normalizedInput.relativePath,
                        normalizedInput.language,
                        evidence.symbols,
                        chunkOptions,
                    ),
                };
            } catch {
                return fallbackResult(
                    { ...input, language: normalizedLanguage },
                    strategy.backend,
                    'recovered',
                    'analysis_failure',
                    chunkOptions,
                );
            }
        },
        getDescription(): string {
            return 'Oxc (JS/TS), Tree-sitter WASM (polyglot), bounded text fallback';
        },
        getStrategyForLanguage: strategyForLanguage,
    };
}
