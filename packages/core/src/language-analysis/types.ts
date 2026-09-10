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
    /** Source expressions in argument order; absent for legacy/unsupported evidence. */
    readonly args?: readonly string[];
    readonly calleeName: string;
    /** Missing only on legacy persisted evidence; current adapters always set this. */
    readonly kind?: 'direct' | 'member' | 'constructor';
    readonly receiverText?: string;
    readonly qualifiedCallee?: string;
    readonly span: SourceSpan;
    readonly statementBlockSpan?: SourceSpan;
}

export type PythonFlowFact =
    | {
        readonly kind: 'assignment_origin';
        readonly targetText: string;
        readonly valueText: string;
        readonly valueKind: 'constructor' | 'call' | 'member' | 'identifier' | 'unknown';
        readonly constructorTypeName?: string;
        readonly calleeName?: string;
        readonly span: SourceSpan;
        /** The callable or module scope in which this value was allocated. */
        readonly contextSpan: SourceSpan;
    }
    | {
        readonly kind: 'call_argument';
        readonly calleeText: string;
        readonly argumentName?: string;
        readonly argumentIndex?: number;
        readonly valueText: string;
        readonly span: SourceSpan;
        /** The callable or module scope from which the call was made. */
        readonly contextSpan: SourceSpan;
    }
    | {
        readonly kind: 'class_bases';
        readonly className: string;
        readonly baseNames: readonly string[];
        readonly span: SourceSpan;
        readonly contextSpan: SourceSpan;
    };

export type ReceiverTypeBinding =
    | {
        readonly localName: string;
        readonly typeName: string;
        readonly kind: 'parameter_annotation';
        readonly span: SourceSpan;
    }
    | {
        readonly localName: string;
        readonly typeName: string;
        readonly kind: 'local_constructor';
        readonly span: SourceSpan;
        readonly statementBlockSpan: SourceSpan;
    }
    | {
        readonly localName: string;
        readonly typeName: string;
        readonly kind: 'self_field_constructor';
        readonly span: SourceSpan;
    };

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
    /** Python-only bounded origin facts; absent for non-Python adapters. */
    readonly pythonFlowFacts?: readonly PythonFlowFact[];
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
