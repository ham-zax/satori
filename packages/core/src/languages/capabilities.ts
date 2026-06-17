import type { CapabilityStatus, LanguageCapabilityDeclaration } from './types';

const NONE: CapabilityStatus = 'none';
const PRODUCTION_READY: CapabilityStatus = 'production_ready';

type DeclarationInput = Omit<LanguageCapabilityDeclaration, 'fixtures'> & {
    readonly fixtures?: LanguageCapabilityDeclaration['fixtures'];
};

function declaration(input: DeclarationInput): LanguageCapabilityDeclaration {
    return {
        ...input,
        fixtures: input.fixtures ?? {},
    };
}

function fullNavigationLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: PRODUCTION_READY,
        symbolExtractionCapability: PRODUCTION_READY,
        ownerExtractionCapability: PRODUCTION_READY,
        importExportCapability: NONE,
        callsCapability: PRODUCTION_READY,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: PRODUCTION_READY,
        publicClaim: 'calls_v0',
    });
}

function astSearchOnlyLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: PRODUCTION_READY,
        symbolExtractionCapability: NONE,
        ownerExtractionCapability: NONE,
        importExportCapability: NONE,
        callsCapability: NONE,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: NONE,
        publicClaim: 'search_only',
    });
}

function searchOnlyLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
    readonly filenames?: readonly string[];
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: NONE,
        symbolExtractionCapability: NONE,
        ownerExtractionCapability: NONE,
        importExportCapability: NONE,
        callsCapability: NONE,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: NONE,
        publicClaim: 'search_only',
    });
}

const DECLARATIONS: readonly LanguageCapabilityDeclaration[] = [
    searchOnlyLanguage({
        languageId: 'astro',
        aliases: [],
        extensions: ['.astro'],
    }),
    searchOnlyLanguage({
        languageId: 'cmake',
        aliases: [],
        extensions: [],
        filenames: ['CMakeLists.txt'],
    }),
    astSearchOnlyLanguage({
        languageId: 'cpp',
        aliases: ['c++', 'c'],
        extensions: ['.cpp', '.c', '.h', '.hpp', '.cc', '.cxx', '.hh', '.hxx', '.ixx'],
    }),
    astSearchOnlyLanguage({
        languageId: 'csharp',
        aliases: ['cs'],
        extensions: ['.cs'],
    }),
    searchOnlyLanguage({
        languageId: 'css',
        aliases: ['scss'],
        extensions: ['.css', '.scss'],
    }),
    searchOnlyLanguage({
        languageId: 'dockerfile',
        aliases: [],
        extensions: [],
        filenames: ['Dockerfile'],
    }),
    astSearchOnlyLanguage({
        languageId: 'go',
        aliases: [],
        extensions: ['.go'],
    }),
    astSearchOnlyLanguage({
        languageId: 'java',
        aliases: [],
        extensions: ['.java'],
    }),
    fullNavigationLanguage({
        languageId: 'javascript',
        aliases: ['js'],
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    }),
    searchOnlyLanguage({
        languageId: 'justfile',
        aliases: [],
        extensions: [],
        filenames: ['justfile', 'Justfile'],
    }),
    searchOnlyLanguage({
        languageId: 'jupyter',
        aliases: ['ipynb'],
        extensions: ['.ipynb'],
    }),
    searchOnlyLanguage({
        languageId: 'kotlin',
        aliases: ['kt'],
        extensions: ['.kt', '.kts'],
    }),
    searchOnlyLanguage({
        languageId: 'makefile',
        aliases: [],
        extensions: [],
        filenames: ['Makefile'],
    }),
    searchOnlyLanguage({
        languageId: 'objective-c',
        aliases: ['objectivec'],
        extensions: ['.m', '.mm'],
    }),
    searchOnlyLanguage({
        languageId: 'php',
        aliases: [],
        extensions: ['.php'],
    }),
    fullNavigationLanguage({
        languageId: 'python',
        aliases: ['py'],
        extensions: ['.py'],
    }),
    searchOnlyLanguage({
        languageId: 'ruby',
        aliases: ['rb'],
        extensions: ['.rb'],
    }),
    astSearchOnlyLanguage({
        languageId: 'rust',
        aliases: ['rs'],
        extensions: ['.rs'],
    }),
    astSearchOnlyLanguage({
        languageId: 'scala',
        aliases: [],
        extensions: ['.scala'],
    }),
    searchOnlyLanguage({
        languageId: 'svelte',
        aliases: [],
        extensions: ['.svelte'],
    }),
    searchOnlyLanguage({
        languageId: 'swift',
        aliases: [],
        extensions: ['.swift'],
    }),
    searchOnlyLanguage({
        languageId: 'text',
        aliases: ['md', 'markdown'],
        extensions: ['.md', '.markdown'],
    }),
    fullNavigationLanguage({
        languageId: 'typescript',
        aliases: ['ts'],
        extensions: ['.ts', '.tsx', '.mts', '.cts'],
    }),
    searchOnlyLanguage({
        languageId: 'vue',
        aliases: [],
        extensions: ['.vue'],
    }),
].sort((a, b) => a.languageId.localeCompare(b.languageId));

const DECLARATION_BY_KEY = new Map<string, LanguageCapabilityDeclaration>();

for (const item of DECLARATIONS) {
    DECLARATION_BY_KEY.set(item.languageId, item);
    for (const alias of item.aliases) {
        DECLARATION_BY_KEY.set(alias.toLowerCase(), item);
    }
}

export function getLanguageCapabilityDeclarations(): readonly LanguageCapabilityDeclaration[] {
    return DECLARATIONS;
}

export function getLanguageCapabilityDeclaration(language: string): LanguageCapabilityDeclaration | undefined {
    const key = String(language || '').trim().toLowerCase();
    if (!key) {
        return undefined;
    }
    return DECLARATION_BY_KEY.get(key);
}
