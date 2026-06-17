import { getLanguageCapabilityDeclaration } from '../capabilities';
import type { SymbolExtractor } from '../types';

const BUILTIN_EXTRACTORS_BY_LANGUAGE = new Map<string, SymbolExtractor>();
const CUSTOM_EXTRACTORS_BY_LANGUAGE = new Map<string, SymbolExtractor>();

function normalizeExtractorLanguageId(languageId: string): string {
    const declaration = getLanguageCapabilityDeclaration(languageId);
    return declaration?.languageId ?? String(languageId || '').trim().toLowerCase();
}

function registerExtractor(target: Map<string, SymbolExtractor>, extractor: SymbolExtractor): void {
    const languageId = normalizeExtractorLanguageId(extractor.languageId);
    if (!languageId) {
        throw new Error('Cannot register a symbol extractor without a language id');
    }
    target.set(languageId, { ...extractor, languageId });
}

export function registerSymbolExtractor(extractor: SymbolExtractor): void {
    registerExtractor(CUSTOM_EXTRACTORS_BY_LANGUAGE, extractor);
}

export function registerBuiltInSymbolExtractor(extractor: SymbolExtractor): void {
    registerExtractor(BUILTIN_EXTRACTORS_BY_LANGUAGE, extractor);
}

export function getSymbolExtractorForLanguage(language: string): SymbolExtractor | undefined {
    const languageId = normalizeExtractorLanguageId(language);
    if (!languageId) {
        return undefined;
    }
    return CUSTOM_EXTRACTORS_BY_LANGUAGE.get(languageId) || BUILTIN_EXTRACTORS_BY_LANGUAGE.get(languageId);
}

export function getRegisteredSymbolExtractorLanguageIds(): string[] {
    return Array.from(new Set([
        ...BUILTIN_EXTRACTORS_BY_LANGUAGE.keys(),
        ...CUSTOM_EXTRACTORS_BY_LANGUAGE.keys(),
    ])).sort((a, b) => a.localeCompare(b));
}

export function clearSymbolExtractorRegistryForTests(): void {
    CUSTOM_EXTRACTORS_BY_LANGUAGE.clear();
}
