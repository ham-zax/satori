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

export type LanguageAnalysisBackend = 'oxc' | 'tree_sitter_wasm' | 'recursive_text';
export type StructuralStatus = 'complete' | 'recovered' | 'unsupported';

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
    readonly span: SourceSpan;
}

export interface LanguageAnalysisInput {
    readonly content: string;
    readonly language: string;
    readonly relativePath: string;
}

export interface LanguageAnalysisResult {
    readonly backend: LanguageAnalysisBackend;
    readonly structuralStatus: StructuralStatus;
    readonly symbols: readonly ExtractedSymbol[];
    readonly moduleBindings: readonly ModuleBinding[];
    readonly callSites: readonly CallSite[];
    readonly chunks: readonly CodeChunk[];
}

export interface LanguageAnalysisPort {
    analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult>;
    setChunkSize(chunkSize: number): void;
    setChunkOverlap(chunkOverlap: number): void;
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
