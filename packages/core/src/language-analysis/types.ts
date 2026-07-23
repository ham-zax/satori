import type { ExtractedSymbol } from '../languages';

export interface CodeChunk {
    content: string;
    metadata: {
        startLine: number;
        endLine: number;
        startByte?: number;
        endByte?: number;
        startColumn?: number;
        endColumn?: number;
        language?: string;
        filePath?: string;
        breadcrumbs?: string[];
        symbolId?: string;
        symbolLabel?: string;
        symbolKind?: string;
        ownerSymbolKey?: string;
        ownerSymbolInstanceId?: string;
    };
}

export type LanguageAnalysisBackend = 'oxc' | 'tree_sitter_wasm' | 'bounded_text';
export type StructuralStatus = 'complete' | 'recovered' | 'unsupported';
export type StructuralReason =
    | 'syntax_error'
    | 'parser_unavailable'
    | 'analysis_failure'
    | 'unsupported_language';

export interface SourceSpan {
    readonly startLine: number;
    readonly endLine: number;
    readonly startByte: number;
    readonly endByte: number;
    readonly startColumn: number;
    readonly endColumn: number;
}

export interface ModuleBinding {
    readonly kind: 'import' | 'reexport' | 'export';
    readonly moduleSpecifier?: string;
    readonly importedName?: string;
    readonly localName?: string;
    readonly exportedName?: string;
    readonly typeOnly: boolean;
    readonly span: SourceSpan;
}

export interface CallSite {
    readonly calleeName: string;
    /** Missing only on legacy persisted evidence; current adapters always set this. */
    readonly kind?: 'direct' | 'member' | 'constructor';
    readonly receiverText?: string;
    readonly qualifiedCallee?: string;
    readonly span: SourceSpan;
}

export interface ReceiverTypeBinding {
    readonly localName: string;
    readonly typeName: string;
    readonly kind: 'parameter_annotation';
    readonly span: SourceSpan;
}

export interface LanguageAnalysisInput {
    readonly content: string;
    readonly language: string;
    readonly relativePath: string;
}

interface LanguageAnalysisEvidence {
    readonly backend: LanguageAnalysisBackend;
    readonly symbols: readonly ExtractedSymbol[];
    readonly moduleBindings: readonly ModuleBinding[];
    readonly callSites: readonly CallSite[];
    readonly receiverTypeBindings: readonly ReceiverTypeBinding[];
    readonly chunks: readonly CodeChunk[];
}

export type LanguageAnalysisResult = LanguageAnalysisEvidence & (
    | { readonly structuralStatus: 'complete'; readonly structuralReason?: never }
    | {
        readonly structuralStatus: 'recovered';
        readonly structuralReason: Exclude<StructuralReason, 'unsupported_language'>;
    }
    | { readonly structuralStatus: 'unsupported'; readonly structuralReason: 'unsupported_language' }
);

export interface LanguageAnalysisPort {
    analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult>;
    getDescription(): string;
    getStrategyForLanguage(language: string): {
        backend: LanguageAnalysisBackend;
        structural: boolean;
    };
}

export interface LanguageAnalysisServiceOptions {
    readonly chunkSize?: number;
    readonly chunkOverlap?: number;
    readonly assetRoot?: string;
}
