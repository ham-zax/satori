export type LanguageCapability =
    | 'astSplitter'
    | 'symbolMetadata'
    | 'callGraphBuild'
    | 'callGraphQuery'
    | 'fileOutline';

export interface LanguageAdapterCapabilities {
    astSplitter: boolean;
    symbolMetadata: boolean;
    callGraphBuild: boolean;
    callGraphQuery: boolean;
    fileOutline: boolean;
}

export interface LanguageAdapter {
    id: string;
    aliases: string[];
    extensions: string[];
    capabilities: LanguageAdapterCapabilities;
}

const LANGUAGE_ADAPTERS: LanguageAdapter[] = [
    {
        id: 'typescript',
        aliases: ['ts'],
        extensions: ['.ts', '.tsx'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: true,
            callGraphBuild: true,
            callGraphQuery: true,
            fileOutline: true,
        },
    },
    {
        id: 'javascript',
        aliases: ['js'],
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: true,
            callGraphBuild: true,
            callGraphQuery: true,
            fileOutline: true,
        },
    },
    {
        id: 'python',
        aliases: ['py'],
        extensions: ['.py'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: true,
            callGraphBuild: true,
            callGraphQuery: true,
            fileOutline: true,
        },
    },
    {
        id: 'java',
        aliases: [],
        extensions: ['.java'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'cpp',
        aliases: ['c++', 'c'],
        extensions: ['.cpp', '.c', '.h', '.hpp'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'go',
        aliases: [],
        extensions: ['.go'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'rust',
        aliases: ['rs'],
        extensions: ['.rs'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'csharp',
        aliases: ['cs'],
        extensions: ['.cs'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'scala',
        aliases: [],
        extensions: ['.scala'],
        capabilities: {
            astSplitter: true,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'php',
        aliases: [],
        extensions: ['.php'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'ruby',
        aliases: ['rb'],
        extensions: ['.rb'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'swift',
        aliases: [],
        extensions: ['.swift'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'kotlin',
        aliases: ['kt'],
        extensions: ['.kt'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'objective-c',
        aliases: ['objectivec'],
        extensions: ['.m', '.mm'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'jupyter',
        aliases: ['ipynb'],
        extensions: ['.ipynb'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
    {
        id: 'text',
        aliases: ['md', 'markdown'],
        extensions: ['.md', '.markdown'],
        capabilities: {
            astSplitter: false,
            symbolMetadata: false,
            callGraphBuild: false,
            callGraphQuery: false,
            fileOutline: false,
        },
    },
];

const LANGUAGE_BY_KEY = new Map<string, LanguageAdapter>();
const LANGUAGE_BY_EXTENSION = new Map<string, LanguageAdapter>();

for (const adapter of LANGUAGE_ADAPTERS) {
    LANGUAGE_BY_KEY.set(adapter.id, adapter);
    for (const alias of adapter.aliases) {
        LANGUAGE_BY_KEY.set(alias, adapter);
    }
    for (const extension of adapter.extensions) {
        LANGUAGE_BY_EXTENSION.set(extension, adapter);
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

export function getLanguageIdFromExtension(extension: string, fallback: string = 'text'): string {
    return getLanguageAdapterByExtension(extension)?.id || fallback;
}

export function isLanguageCapabilitySupportedForLanguage(language: string, capability: LanguageCapability): boolean {
    const adapter = getLanguageAdapterByLanguage(language);
    return Boolean(adapter?.capabilities[capability]);
}

export function isLanguageCapabilitySupportedForExtension(extension: string, capability: LanguageCapability): boolean {
    const adapter = getLanguageAdapterByExtension(extension);
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

