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
        receiverTypeBindings: [],
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

function readInputField(
    input: LanguageAnalysisInput,
    field: keyof LanguageAnalysisInput,
    fallback: string,
): string {
    try {
        return input[field];
    } catch {
        return fallback;
    }
}

function emergencyChunkBound(value: number | undefined, fallback: number): number {
    const configured = typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
    // Four bytes is the largest UTF-8 code point. A smaller byte ceiling cannot
    // preserve both valid UTF-8 and the configured bound.
    return Math.max(4, configured);
}

function alignEmergencyByteBoundary(
    bytes: Buffer,
    offset: number,
    direction: 'backward' | 'forward',
): number {
    let aligned = Math.max(0, Math.min(offset, bytes.length));
    const isContinuation = (byte: number | undefined): boolean => (
        byte !== undefined && (byte & 0xc0) === 0x80
    );
    if (direction === 'backward') {
        while (aligned > 0 && isContinuation(bytes[aligned])) aligned -= 1;
    } else {
        while (aligned < bytes.length && isContinuation(bytes[aligned])) aligned += 1;
    }
    return aligned;
}

function buildEmergencyPositions(content: string, byteLength: number): Array<{ line: number; column: number }> {
    const positions = new Array<{ line: number; column: number }>(byteLength + 1);
    let byteOffset = 0;
    let line = 1;
    let column = 0;
    positions[0] = { line, column };
    for (const codePoint of content) {
        const encodedLength = Buffer.byteLength(codePoint, 'utf8');
        for (let index = 1; index < encodedLength; index += 1) {
            positions[byteOffset + index] = { line, column };
        }
        byteOffset += encodedLength;
        if (codePoint === '\n') {
            line += 1;
            column = 0;
        } else {
            column += codePoint.length;
        }
        positions[byteOffset] = { line, column };
    }
    return positions;
}

function emergencyFallbackResult(
    input: LanguageAnalysisInput,
    options: { chunkSize?: number; chunkOverlap?: number },
): LanguageAnalysisResult {
    const content = readInputField(input, 'content', '');
    const relativePath = readInputField(input, 'relativePath', '<unknown>');
    const bytes = Buffer.from(content, 'utf8');
    const positions = buildEmergencyPositions(content, bytes.length);
    const chunkSize = emergencyChunkBound(options.chunkSize, 2500);
    const requestedOverlap = typeof options.chunkOverlap === 'number'
        && Number.isFinite(options.chunkOverlap)
        ? Math.max(0, Math.floor(options.chunkOverlap))
        : 0;
    const chunkOverlap = Math.min(requestedOverlap, Math.max(0, chunkSize - 1));
    const chunks: Array<LanguageAnalysisResult['chunks'][number]> = [];

    for (let startByte = 0; startByte < bytes.length;) {
        let endByte = alignEmergencyByteBoundary(
            bytes,
            Math.min(bytes.length, startByte + chunkSize),
            'backward',
        );
        if (endByte <= startByte) {
            endByte = alignEmergencyByteBoundary(
                bytes,
                Math.min(bytes.length, startByte + chunkSize),
                'forward',
            );
        }
        if (endByte <= startByte) break;

        const start = positions[startByte];
        const end = positions[endByte];
        chunks.push({
            content: bytes.subarray(startByte, endByte).toString('utf8'),
            metadata: {
                startLine: start.line,
                endLine: end.line,
                startByte,
                endByte,
                startColumn: start.column,
                endColumn: end.column,
                language: 'text',
                filePath: relativePath,
            },
        });

        if (endByte === bytes.length) break;
        const nextStart = alignEmergencyByteBoundary(
            bytes,
            Math.max(startByte + 1, endByte - chunkOverlap),
            'backward',
        );
        startByte = nextStart > startByte ? nextStart : endByte;
    }

    return {
        backend: 'bounded_text',
        structuralStatus: 'recovered',
        structuralReason: 'analysis_failure',
        symbols: [],
        moduleBindings: [],
        callSites: [],
        receiverTypeBindings: [],
        chunks,
    };
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
            try {
                const normalizedInput = {
                    content: input.content,
                    relativePath: input.relativePath,
                    language: normalizeLanguageId(input.language),
                };
                const strategy = strategyForLanguage(normalizedInput.language);
                if (strategy.backend === 'bounded_text') {
                    return fallbackResult(
                        normalizedInput,
                        strategy.backend,
                        'unsupported',
                        'unsupported_language',
                        chunkOptions,
                    );
                }
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
                    receiverTypeBindings: evidence.receiverTypeBindings,
                    chunks: buildAnalysisChunks(
                        normalizedInput.content,
                        normalizedInput.relativePath,
                        normalizedInput.language,
                        evidence.symbols,
                        chunkOptions,
                    ),
                };
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
                    );
                } catch {
                    return emergencyFallbackResult(input, chunkOptions);
                }
            }
        },
        getDescription(): string {
            return 'Oxc (JS/TS), Tree-sitter WASM (polyglot), bounded text fallback';
        },
        getStrategyForLanguage: strategyForLanguage,
    };
}
