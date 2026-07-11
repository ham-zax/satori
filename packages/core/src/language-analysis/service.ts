import { buildAnalysisChunks } from './chunks';
import { normalizeLanguageId } from '../language';
import { analyzeWithOxc } from './oxc-adapter';
import { analyzeWithTreeSitter } from './tree-sitter-adapter';
import type {
    LanguageAnalysisInput,
    LanguageAnalysisPort,
    LanguageAnalysisResult,
    LanguageAnalysisServiceOptions,
} from './types';

const OXC_LANGUAGES = new Set(['javascript', 'jsx', 'typescript', 'tsx']);
const TREE_SITTER_LANGUAGES = new Set(['python', 'go', 'rust', 'java', 'csharp', 'cpp', 'scala']);

function fallbackResult(
    input: LanguageAnalysisInput,
    backend: LanguageAnalysisResult['backend'],
    structuralStatus: LanguageAnalysisResult['structuralStatus'],
    options: { chunkSize?: number; chunkOverlap?: number },
): LanguageAnalysisResult {
    return {
        backend,
        structuralStatus,
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
}

export function createLanguageAnalysisService(
    options: LanguageAnalysisServiceOptions = {},
): LanguageAnalysisPort {
    let chunkSize = options.chunkSize;
    let chunkOverlap = options.chunkOverlap;

    return {
        async analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> {
            const normalizedLanguage = normalizeLanguageId(input.language);
            if (OXC_LANGUAGES.has(normalizedLanguage)) {
                try {
                    const normalizedInput = { ...input, language: normalizedLanguage };
                    const evidence = analyzeWithOxc(normalizedInput);
                    const symbols = evidence.complete ? evidence.symbols : [];
                    return {
                        backend: 'oxc',
                        structuralStatus: evidence.complete ? 'complete' : 'recovered',
                        symbols,
                        moduleBindings: evidence.complete ? evidence.moduleBindings : [],
                        callSites: evidence.complete ? evidence.callSites : [],
                        chunks: buildAnalysisChunks(
                            normalizedInput.content,
                            normalizedInput.relativePath,
                            normalizedInput.language,
                            symbols,
                            { chunkSize, chunkOverlap },
                        ),
                    };
                } catch {
                    return fallbackResult(
                        { ...input, language: normalizedLanguage },
                        'oxc',
                        'recovered',
                        { chunkSize, chunkOverlap },
                    );
                }
            }

            if (TREE_SITTER_LANGUAGES.has(normalizedLanguage)) {
                try {
                    const normalizedInput = { ...input, language: normalizedLanguage };
                    const evidence = await analyzeWithTreeSitter(normalizedInput, options.assetRoot);
                    const symbols = evidence.complete ? evidence.symbols : [];
                    return {
                        backend: 'tree_sitter_wasm',
                        structuralStatus: evidence.complete ? 'complete' : 'recovered',
                        symbols,
                        moduleBindings: evidence.complete ? evidence.moduleBindings : [],
                        callSites: evidence.complete ? evidence.callSites : [],
                        chunks: buildAnalysisChunks(
                            normalizedInput.content,
                            normalizedInput.relativePath,
                            normalizedInput.language,
                            symbols,
                            { chunkSize, chunkOverlap },
                        ),
                    };
                } catch {
                    return fallbackResult(
                        { ...input, language: normalizedLanguage },
                        'tree_sitter_wasm',
                        'recovered',
                        { chunkSize, chunkOverlap },
                    );
                }
            }

            return fallbackResult(
                { ...input, language: normalizedLanguage },
                'recursive_text',
                'unsupported',
                { chunkSize, chunkOverlap },
            );
        },
        setChunkSize(value: number): void {
            chunkSize = value;
        },
        setChunkOverlap(value: number): void {
            chunkOverlap = value;
        },
        getDescription(): string {
            return 'Oxc (JS/TS), Tree-sitter WASM (polyglot), recursive text fallback';
        },
        getStrategyForLanguage(language: string) {
            const normalized = normalizeLanguageId(language);
            if (OXC_LANGUAGES.has(normalized)) return { backend: 'oxc', structural: true };
            if (TREE_SITTER_LANGUAGES.has(normalized)) {
                return { backend: 'tree_sitter_wasm', structural: true };
            }
            return { backend: 'recursive_text', structural: false };
        },
    };
}
