import { getLanguageCapabilityDeclaration } from '../capabilities';
import type { SymbolExtractor } from '../types';

const EXTRACTORS_BY_LANGUAGE = new Map<string, SymbolExtractor>();

function normalizeExtractorLanguageId(languageId: string): string {
    const declaration = getLanguageCapabilityDeclaration(languageId);
    return declaration?.languageId ?? String(languageId || '').trim().toLowerCase();
}

export function registerSymbolExtractor(extractor: SymbolExtractor): void {
    const languageId = normalizeExtractorLanguageId(extractor.languageId);
    if (!languageId) {
        throw new Error('Cannot register a symbol extractor without a language id');
    }
    EXTRACTORS_BY_LANGUAGE.set(languageId, extractor);
}

export function getSymbolExtractorForLanguage(language: string): SymbolExtractor | undefined {
    const languageId = normalizeExtractorLanguageId(language);
    if (!languageId) {
        return undefined;
    }
    return EXTRACTORS_BY_LANGUAGE.get(languageId);
}

export function getRegisteredSymbolExtractorLanguageIds(): string[] {
    return Array.from(EXTRACTORS_BY_LANGUAGE.keys()).sort((a, b) => a.localeCompare(b));
}
