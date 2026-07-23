export type CapabilityStatus =
    | 'none'
    | 'declared'
    | 'fixture_covered'
    | 'production_ready';

export type PublicLanguageClaim =
    | 'search_only'
    | 'symbol_only'
    | 'imports_exports'
    | 'calls_v0'
    | 'type_receiver_aware';

export interface LanguageCapabilityFixtures {
    readonly navigation?: readonly string[];
    readonly parser?: readonly string[];
    readonly symbols?: readonly string[];
    readonly ownerMetadata?: readonly string[];
    readonly fileOutline?: readonly string[];
    readonly readFileOpenSymbol?: readonly string[];
    readonly importsExports?: readonly string[];
    readonly calls?: readonly string[];
    readonly typeReceiverAware?: readonly string[];
}

export interface LanguageCapabilityDeclaration {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
    readonly filenames?: readonly string[];
    readonly searchEligibility: CapabilityStatus;
    readonly parserCapability: CapabilityStatus;
    readonly symbolExtractionCapability: CapabilityStatus;
    readonly ownerExtractionCapability: CapabilityStatus;
    readonly importExportCapability: CapabilityStatus;
    readonly callsCapability: CapabilityStatus;
    readonly typeReceiverAwareCapability: CapabilityStatus;
    readonly testReferenceCapability: CapabilityStatus;
    readonly fixtures: LanguageCapabilityFixtures;
    readonly publicClaim: PublicLanguageClaim;
}

export type ExtractedSymbolKind =
    | 'file'
    | 'class'
    | 'interface'
    | 'type'
    | 'function'
    | 'method'
    | 'constructor'
    | 'struct'
    | 'enum'
    | 'trait'
    | 'module'
    | 'namespace'
    | 'macro'
    | 'constant'
    | 'variable';

export interface ExtractedSymbol {
    readonly kind: ExtractedSymbolKind;
    readonly name: string;
    readonly label: string;
    readonly qualifiedName?: string;
    readonly parentQualifiedNamePath?: readonly string[];
    readonly span: {
        readonly startLine: number;
        readonly endLine: number;
        readonly startByte?: number;
        readonly endByte?: number;
        readonly startColumn?: number;
        readonly endColumn?: number;
    };
}
