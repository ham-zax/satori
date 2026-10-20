import {
    buildAnalysisChunks,
    createAnalysisChunkPlan,
    type AnalysisChunkPlanKind,
    type ChunkOptions,
} from './chunks';
import { isLanguageCapabilitySupportedForLanguage, normalizeLanguageId } from '../language';
import { analyzeWithCbmDefinitions, supportsCbmDefinitions } from './cbm-definition-adapter';
import { CbmExtractorUnavailableError } from './cbm-extractor-host';
import { recoverFlowSymbols } from './flow-recovery';
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
import type { IndexingAnalysisCapability, IndexingAnalysisResult } from './indexing-analysis';

type AnalysisBackend = 'oxc' | 'tree_sitter_wasm';
type LanguageStrategy = {
    readonly backend: LanguageAnalysisBackend;
    readonly structural: boolean;
};

type AnalysisFields = Pick<LanguageAnalysisResult,
    | 'backend'
    | 'symbols'
    | 'earlyExitSpans'
    | 'moduleBindings'
    | 'callSites'
    | 'receiverTypeBindings'
    | 'pythonFlowFacts'
> & {
    readonly structuralStatus: LanguageAnalysisResult['structuralStatus'];
    readonly structuralReason?: LanguageAnalysisResult['structuralReason'];
};

type ServiceAnalysisResult = LanguageAnalysisResult | IndexingAnalysisResult;

function finishAnalysis(
    fields: AnalysisFields,
    input: Pick<LanguageAnalysisInput, 'content' | 'relativePath' | 'language'>,
    options: ChunkOptions,
    deferred: boolean,
    kind: AnalysisChunkPlanKind = 'symbols',
): ServiceAnalysisResult {
    if (deferred) return { ...fields, chunkPlan: { kind, options } } as IndexingAnalysisResult;
    const chunks = kind === 'symbols'
        ? buildAnalysisChunks(input.content, input.relativePath, input.language, fields.symbols, options)
        : [...createAnalysisChunkPlan(input.content, input.relativePath, input.language, fields.symbols, options, kind).chunks()];
    return { ...fields, chunks } as LanguageAnalysisResult;
}

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

// Languages without a dedicated analyzer use CBM's own definition extractor
// once their declaration claims symbols (promotion is gated on CBM parity
// evidence) and the language's extractor module is installed.
function strategyForLanguage(language: string): LanguageStrategy {
    const normalized = normalizeLanguageId(language);
    const backend = BACKEND_BY_LANGUAGE[normalized];
    if (backend) return { backend, structural: true };
    if (isLanguageCapabilitySupportedForLanguage(normalized, 'symbols') && supportsCbmDefinitions(normalized)) {
        return { backend: 'cbm_definitions', structural: true };
    }
    return { backend: 'bounded_text', structural: false };
}

function fallbackResult(
    input: LanguageAnalysisInput,
    backend: LanguageAnalysisBackend,
    structuralStatus: 'recovered' | 'unsupported',
    structuralReason: StructuralReason,
    options: ChunkOptions,
    deferred: boolean,
): ServiceAnalysisResult {
    const fields: AnalysisFields = {
        backend,
        symbols: [],
        moduleBindings: [],
        callSites: [],
        receiverTypeBindings: [],
        pythonFlowFacts: [],
        structuralStatus,
        structuralReason: structuralStatus === 'unsupported' ? 'unsupported_language' : structuralReason,
    };
    if (structuralStatus === 'unsupported') {
        return finishAnalysis(fields, input, options, deferred);
    }
    if (structuralReason === 'unsupported_language') {
        throw new Error('Recovered language analysis requires a recoverable reason');
    }
    return finishAnalysis(fields, input, options, deferred);
}

function readInputField(
    input: LanguageAnalysisInput,
    field: 'content' | 'language' | 'relativePath',
    fallback: string,
): string {
    try {
        return input[field];
    } catch {
        return fallback;
    }
}

function emergencyFallbackResult(
    input: LanguageAnalysisInput,
    options: ChunkOptions,
    deferred: boolean,
): ServiceAnalysisResult {
    const content = readInputField(input, 'content', '');
    const relativePath = readInputField(input, 'relativePath', '<unknown>');
    return finishAnalysis({
        backend: 'bounded_text',
        structuralStatus: 'recovered',
        structuralReason: 'analysis_failure',
        symbols: [],
        moduleBindings: [],
        callSites: [],
        receiverTypeBindings: [],
        pythonFlowFacts: [],
    }, { content, relativePath, language: 'text' }, options, deferred, 'emergency');
}

export function createLanguageAnalysisService(
    options: LanguageAnalysisServiceOptions = {},
): LanguageAnalysisPort {
    const chunkOptions = {
        chunkSize: options.chunkSize,
        chunkOverlap: options.chunkOverlap,
    };

    const analyze = async (
        input: LanguageAnalysisInput,
        deferred: boolean,
    ): Promise<ServiceAnalysisResult> => {
        try {
            const normalizedInput = {
                content: input.content,
                relativePath: input.relativePath,
                language: normalizeLanguageId(input.language),
                ...(input.includeEarlyExitSpans ? { includeEarlyExitSpans: true } : {}),
            };
            if (input.perfTiming) Object.assign(normalizedInput, { perfTiming: input.perfTiming });
            const strategy = strategyForLanguage(normalizedInput.language);
            if (strategy.backend === 'bounded_text') {
                return fallbackResult(
                    normalizedInput,
                    strategy.backend,
                    'unsupported',
                    'unsupported_language',
                    chunkOptions,
                    deferred,
                );
            }
            if (strategy.backend === 'cbm_definitions') {
                let symbols;
                try {
                    symbols = await analyzeWithCbmDefinitions(normalizedInput);
                } catch (error) {
                    if (!(error instanceof CbmExtractorUnavailableError)) throw error;
                    return fallbackResult(
                        normalizedInput,
                        strategy.backend,
                        'recovered',
                        'parser_unavailable',
                        chunkOptions,
                        deferred,
                    );
                }
                return finishAnalysis({
                    backend: strategy.backend,
                    structuralStatus: 'complete',
                    symbols,
                    moduleBindings: [],
                    callSites: [],
                    receiverTypeBindings: [],
                    pythonFlowFacts: [],
                }, normalizedInput, chunkOptions, deferred);
            }
            const evidence = strategy.backend === 'oxc'
                ? analyzeWithOxc(normalizedInput)
                : await analyzeWithTreeSitter(normalizedInput, options.assetRoot);
            if (!evidence.complete) {
                if (evidence.symbols.length > 0) {
                    return finishAnalysis({
                        backend: strategy.backend,
                        structuralStatus: 'recovered',
                        structuralReason: evidence.reason,
                        symbols: evidence.symbols,
                        moduleBindings: [],
                        callSites: [],
                        receiverTypeBindings: [],
                        pythonFlowFacts: [],
                    }, normalizedInput, chunkOptions, deferred);
                }
                if ('typedJavaScriptRecoverable' in evidence && evidence.typedJavaScriptRecoverable) {
                    // Type-annotated (Flow) JavaScript is valid for its authors; keep its declarations searchable at symbol level.
                    const symbols = recoverFlowSymbols(normalizedInput.content, normalizedInput.relativePath);
                    if (symbols.length > 0) {
                        return finishAnalysis({
                            backend: strategy.backend,
                            structuralStatus: 'recovered',
                            structuralReason: 'syntax_error',
                            symbols,
                            moduleBindings: [],
                            callSites: [],
                            receiverTypeBindings: [],
                            pythonFlowFacts: [],
                        }, normalizedInput, chunkOptions, deferred);
                    }
                }
                return fallbackResult(
                    normalizedInput,
                    strategy.backend,
                    'recovered',
                    evidence.reason,
                    chunkOptions,
                    deferred,
                );
            }
            return finishAnalysis({
                backend: strategy.backend,
                structuralStatus: 'complete',
                symbols: evidence.symbols,
                moduleBindings: evidence.moduleBindings,
                ...('earlyExitSpans' in evidence && evidence.earlyExitSpans
                    ? { earlyExitSpans: evidence.earlyExitSpans } : {}),
                callSites: evidence.callSites,
                receiverTypeBindings: evidence.receiverTypeBindings,
                pythonFlowFacts: evidence.pythonFlowFacts ?? [],
            }, normalizedInput, chunkOptions, deferred);
        } catch {
            try {
                const fallbackLanguage = normalizeLanguageId(readInputField(input, 'language', 'text'));
                const fallbackBackend = strategyForLanguage(fallbackLanguage).backend;
                return fallbackResult(
                    {
                        content: readInputField(input, 'content', ''),
                        relativePath: readInputField(input, 'relativePath', '<unknown>'),
                        language: fallbackLanguage,
                    },
                    fallbackBackend,
                    'recovered',
                    'analysis_failure',
                    chunkOptions,
                    deferred,
                );
            } catch {
                return emergencyFallbackResult(input, chunkOptions, deferred);
            }
        }
    };

    const service = {
        analyze: async (input: LanguageAnalysisInput) => (
            await analyze(input, false) as LanguageAnalysisResult
        ),
        analyzeForIndexing: async (input: LanguageAnalysisInput) => (
            await analyze(input, true) as IndexingAnalysisResult
        ),
        getDescription(): string {
            return 'Oxc (JS/TS), Tree-sitter WASM (polyglot), CBM definition extractors, bounded text fallback';
        },
        getStrategyForLanguage: strategyForLanguage,
    } as LanguageAnalysisPort & IndexingAnalysisCapability;
    return service;
}
