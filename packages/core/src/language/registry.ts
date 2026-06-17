import {
    getLanguageCapabilityDeclaration,
    getLanguageCapabilityDeclarations,
    type CapabilityStatus,
    type LanguageCapabilityDeclaration,
} from '../languages';

export {
    getLanguageCapabilityDeclaration,
    getLanguageCapabilityDeclarations,
};

export type {
    CapabilityStatus,
    LanguageCapabilityDeclaration,
};

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

function isEnabled(status: CapabilityStatus): boolean {
    return status !== 'none';
}

function isProductionReady(status: CapabilityStatus): boolean {
    return status === 'production_ready';
}

function toAdapterCapabilities(declaration: LanguageCapabilityDeclaration): LanguageAdapterCapabilities {
    const symbolReady = isProductionReady(declaration.symbolExtractionCapability);
    const callsReady = isProductionReady(declaration.callsCapability);
    return {
        search: isEnabled(declaration.searchEligibility),
        astSplitter: isProductionReady(declaration.parserCapability),
        symbols: symbolReady,
        symbolMetadata: symbolReady,
        owner: isProductionReady(declaration.ownerExtractionCapability),
        imports: isProductionReady(declaration.importExportCapability),
        callGraph: callsReady,
        callGraphBuild: callsReady,
        callGraphQuery: callsReady,
        fileOutline: symbolReady,
        testLinks: isProductionReady(declaration.testReferenceCapability),
    };
}

function toLanguageAdapter(declaration: LanguageCapabilityDeclaration): LanguageAdapter {
    return {
        id: declaration.languageId,
        aliases: [...declaration.aliases],
        extensions: [...declaration.extensions],
        ...(declaration.filenames ? { filenames: [...declaration.filenames] } : {}),
        capabilities: toAdapterCapabilities(declaration),
    };
}

const LANGUAGE_ADAPTERS: LanguageAdapter[] = getLanguageCapabilityDeclarations().map(toLanguageAdapter);

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
