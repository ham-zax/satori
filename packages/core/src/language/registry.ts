export type LanguageCapability =
    | 'search'
    | 'astSplitter'
    | 'symbols'
    | 'symbolMetadata'
    | 'owner'
    | 'imports'
    | 'callGraph'
    | 'callGraphBuild'
    | 'callGraphQuery'
    | 'fileOutline'
    | 'testLinks';

export interface LanguageAdapterCapabilities {
    search: boolean;
    astSplitter: boolean;
    symbols: boolean;
    symbolMetadata: boolean;
    owner: boolean;
    imports: boolean;
    callGraph: boolean;
    callGraphBuild: boolean;
    callGraphQuery: boolean;
    fileOutline: boolean;
    testLinks: boolean;
}

export interface LanguageAdapter {
    id: string;
    aliases: string[];
    extensions: string[];
    filenames?: string[];
    capabilities: LanguageAdapterCapabilities;
}

const CURRENT_NAVIGATION_CAPABILITIES: LanguageAdapterCapabilities = {
    search: true,
    astSplitter: true,
    symbols: true,
    symbolMetadata: true,
    owner: true,
    imports: false,
    callGraph: true,
    callGraphBuild: true,
    callGraphQuery: true,
    fileOutline: true,
    testLinks: true,
};

const AST_SEARCH_ONLY_CAPABILITIES: LanguageAdapterCapabilities = {
    search: true,
    astSplitter: true,
    symbols: false,
    symbolMetadata: false,
    owner: false,
    imports: false,
    callGraph: false,
    callGraphBuild: false,
    callGraphQuery: false,
    fileOutline: false,
    testLinks: false,
};

const SEARCH_ONLY_CAPABILITIES: LanguageAdapterCapabilities = {
    search: true,
    astSplitter: false,
    symbols: false,
    symbolMetadata: false,
    owner: false,
    imports: false,
    callGraph: false,
    callGraphBuild: false,
    callGraphQuery: false,
    fileOutline: false,
    testLinks: false,
};

const LANGUAGE_ADAPTERS: LanguageAdapter[] = [
    {
        id: 'typescript',
        aliases: ['ts'],
        extensions: ['.ts', '.tsx', '.mts', '.cts'],
        capabilities: { ...CURRENT_NAVIGATION_CAPABILITIES },
    },
    {
        id: 'javascript',
        aliases: ['js'],
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
        capabilities: { ...CURRENT_NAVIGATION_CAPABILITIES },
    },
    {
        id: 'python',
        aliases: ['py'],
        extensions: ['.py'],
        capabilities: { ...CURRENT_NAVIGATION_CAPABILITIES },
    },
    {
        id: 'java',
        aliases: [],
        extensions: ['.java'],
        capabilities: { ...AST_SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'cpp',
        aliases: ['c++', 'c'],
        extensions: ['.cpp', '.c', '.h', '.hpp', '.cc', '.cxx', '.hh', '.hxx', '.ixx'],
        capabilities: { ...AST_SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'go',
        aliases: [],
        extensions: ['.go'],
        capabilities: { ...AST_SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'rust',
        aliases: ['rs'],
        extensions: ['.rs'],
        capabilities: { ...AST_SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'csharp',
        aliases: ['cs'],
        extensions: ['.cs'],
        capabilities: { ...AST_SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'scala',
        aliases: [],
        extensions: ['.scala'],
        capabilities: { ...AST_SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'php',
        aliases: [],
        extensions: ['.php'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'ruby',
        aliases: ['rb'],
        extensions: ['.rb'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'swift',
        aliases: [],
        extensions: ['.swift'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'kotlin',
        aliases: ['kt'],
        extensions: ['.kt', '.kts'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'objective-c',
        aliases: ['objectivec'],
        extensions: ['.m', '.mm'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'jupyter',
        aliases: ['ipynb'],
        extensions: ['.ipynb'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'text',
        aliases: ['md', 'markdown'],
        extensions: ['.md', '.markdown'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'vue',
        aliases: [],
        extensions: ['.vue'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'svelte',
        aliases: [],
        extensions: ['.svelte'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'astro',
        aliases: [],
        extensions: ['.astro'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'css',
        aliases: ['scss'],
        extensions: ['.css', '.scss'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'dockerfile',
        aliases: [],
        extensions: [],
        filenames: ['Dockerfile'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'makefile',
        aliases: [],
        extensions: [],
        filenames: ['Makefile'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'cmake',
        aliases: [],
        extensions: [],
        filenames: ['CMakeLists.txt'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
    {
        id: 'justfile',
        aliases: [],
        extensions: [],
        filenames: ['justfile', 'Justfile'],
        capabilities: { ...SEARCH_ONLY_CAPABILITIES },
    },
];

const LANGUAGE_BY_KEY = new Map<string, LanguageAdapter>();
const LANGUAGE_BY_EXTENSION = new Map<string, LanguageAdapter>();
const LANGUAGE_BY_FILENAME = new Map<string, LanguageAdapter>();

for (const adapter of LANGUAGE_ADAPTERS) {
    LANGUAGE_BY_KEY.set(adapter.id, adapter);
    for (const alias of adapter.aliases) {
        LANGUAGE_BY_KEY.set(alias, adapter);
    }
    for (const extension of adapter.extensions) {
        LANGUAGE_BY_EXTENSION.set(extension, adapter);
    }
    for (const filename of adapter.filenames || []) {
        LANGUAGE_BY_FILENAME.set(filename, adapter);
        LANGUAGE_BY_FILENAME.set(filename.toLowerCase(), adapter);
    }
}

function normalizeExtension(ext: string): string {
    const value = ext.trim().toLowerCase();
    if (!value) {
        return '';
    }
    return value.startsWith('.') ? value : `.${value}`;
}

export function normalizeLanguageId(language: string): string {
    const normalized = String(language || '').trim().toLowerCase();
    if (!normalized) {
        return 'text';
    }
    return LANGUAGE_BY_KEY.get(normalized)?.id || normalized;
}

export function getLanguageAdapterByLanguage(language: string): LanguageAdapter | undefined {
    const normalized = String(language || '').trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    return LANGUAGE_BY_KEY.get(normalized);
}

export function getLanguageAdapterByExtension(extension: string): LanguageAdapter | undefined {
    const normalized = normalizeExtension(extension);
    if (!normalized) {
        return undefined;
    }
    return LANGUAGE_BY_EXTENSION.get(normalized);
}

export function getLanguageAdapterByFilename(filename: string): LanguageAdapter | undefined {
    const basename = String(filename || '').trim().split(/[\\/]/).pop() || '';
    if (!basename) {
        return undefined;
    }
    return LANGUAGE_BY_FILENAME.get(basename) || LANGUAGE_BY_FILENAME.get(basename.toLowerCase());
}

export function getLanguageIdFromExtension(extension: string, fallback: string = 'text'): string {
    return getLanguageAdapterByExtension(extension)?.id || fallback;
}

export function getLanguageIdFromFilename(filename: string, fallback: string = 'text'): string {
    const filenameAdapter = getLanguageAdapterByFilename(filename);
    if (filenameAdapter) {
        return filenameAdapter.id;
    }
    const basename = String(filename || '').trim().split(/[\\/]/).pop() || '';
    const extension = basename.includes('.') ? `.${basename.split('.').pop()}` : '';
    return getLanguageIdFromExtension(extension, fallback);
}

export function isLanguageCapabilitySupportedForLanguage(language: string, capability: LanguageCapability): boolean {
    const adapter = getLanguageAdapterByLanguage(language);
    return Boolean(adapter?.capabilities[capability]);
}

export function isLanguageCapabilitySupportedForExtension(extension: string, capability: LanguageCapability): boolean {
    const adapter = getLanguageAdapterByExtension(extension);
    return Boolean(adapter?.capabilities[capability]);
}

export function isLanguageCapabilitySupportedForFilename(filename: string, capability: LanguageCapability): boolean {
    const basename = String(filename || '').trim().split(/[\\/]/).pop() || '';
    const extension = basename.includes('.') ? `.${basename.split('.').pop()}` : '';
    const adapter = getLanguageAdapterByFilename(filename) || getLanguageAdapterByExtension(extension);
    return Boolean(adapter?.capabilities[capability]);
}

export function getSupportedExtensionsForCapability(capability: LanguageCapability): string[] {
    const extensions = new Set<string>();
    for (const adapter of LANGUAGE_ADAPTERS) {
        if (!adapter.capabilities[capability]) {
            continue;
        }
        for (const extension of adapter.extensions) {
            extensions.add(extension);
        }
    }
    return Array.from(extensions).sort((a, b) => a.localeCompare(b));
}

export function getSupportedFilenamesForCapability(capability: LanguageCapability): string[] {
    const filenames = new Set<string>();
    for (const adapter of LANGUAGE_ADAPTERS) {
        if (!adapter.capabilities[capability]) {
            continue;
        }
        for (const filename of adapter.filenames || []) {
            filenames.add(filename);
        }
    }
    return Array.from(filenames).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function getSupportedLanguageIdsForCapability(capability: LanguageCapability): string[] {
    return LANGUAGE_ADAPTERS
        .filter((adapter) => adapter.capabilities[capability])
        .map((adapter) => adapter.id)
        .sort((a, b) => a.localeCompare(b));
}

export function getSupportedLanguageAliasesForCapability(capability: LanguageCapability): string[] {
    const values = new Set<string>();
    for (const adapter of LANGUAGE_ADAPTERS) {
        if (!adapter.capabilities[capability]) {
            continue;
        }
        values.add(adapter.id);
        for (const alias of adapter.aliases) {
            values.add(alias);
        }
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
}
