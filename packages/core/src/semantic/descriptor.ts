import fs from 'node:fs';
import path from 'node:path';
import { normalizeLanguageId } from '../language';

export interface SemanticAuxiliaryPattern {
    readonly pattern: string;
    readonly role: string;
}

export interface SemanticLanguageDescriptor {
    readonly language: string;
    readonly canonicalLanguage: string;
    readonly extensions: readonly string[];
    readonly strategy: 'cbm_semantic' | string;
    readonly semanticRevision: string;
    readonly grammar: string;
    readonly auxiliaryFiles: readonly SemanticAuxiliaryPattern[];
    readonly providerId: string;
    readonly providerVersion: string;
    readonly environmentConfigId: string;
}

export interface SemanticAuxiliaryMatch {
    readonly role: string;
    readonly language: string;
}

export interface SemanticLanguageRegistry {
    supportsLanguage(language: string): boolean;
    getDescriptor(language: string): SemanticLanguageDescriptor | undefined;
    getAllSupportedLanguages(): readonly string[];
    getStrategyForLanguage(language: string): string | undefined;
    getAllAuxiliaryPatterns(): readonly { pattern: string; role: string; language: string }[];
    matchAuxiliaries(filePath: string): readonly SemanticAuxiliaryMatch[];
    isAuxiliaryPath(filePath: string): boolean;
}

const ALLOWED_STRATEGIES: ReadonlySet<string> = new Set(['cbm_semantic']);

const ALLOWED_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
    'language',
    'canonicalLanguage',
    'extensions',
    'strategy',
    'semanticRevision',
    'grammar',
    'auxiliaryFiles',
    'providerId',
    'providerVersion',
    'environmentConfigId',
]);

const ALLOWED_AUXILIARY_KEYS: ReadonlySet<string> = new Set(['pattern', 'role']);

export function validateSemanticLanguagesConfig(raw: unknown): { languages: SemanticLanguageDescriptor[] } {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Invalid semantic language configuration: root must be a JSON object`);
    }

    const config = raw as Record<string, unknown>;
    if (!Array.isArray(config.languages) || config.languages.length === 0) {
        throw new Error(`Invalid semantic language configuration: 'languages' must be a non-empty array`);
    }

    const seenCanonicalLanguages = new Set<string>();
    const validatedDescriptors: SemanticLanguageDescriptor[] = [];

    for (let i = 0; i < config.languages.length; i++) {
        const item = config.languages[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`Invalid descriptor at index ${i}: must be a JSON object`);
        }

        const entry = item as Record<string, unknown>;

        // Reject unknown properties
        for (const key of Object.keys(entry)) {
            if (!ALLOWED_DESCRIPTOR_KEYS.has(key)) {
                throw new Error(`Invalid descriptor at index ${i} ('${entry.language ?? i}'): unknown property '${key}'`);
            }
        }

        if (typeof entry.language !== 'string' || entry.language.trim().length === 0) {
            throw new Error(`Invalid descriptor at index ${i}: 'language' must be a non-empty string`);
        }
        if (typeof entry.canonicalLanguage !== 'string' || entry.canonicalLanguage.trim().length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'canonicalLanguage' must be a non-empty string`);
        }

        const canonical = normalizeLanguageId(entry.canonicalLanguage);
        if (seenCanonicalLanguages.has(canonical)) {
            throw new Error(`Duplicate descriptor for canonical language '${canonical}' at index ${i}`);
        }
        seenCanonicalLanguages.add(canonical);

        if (typeof entry.strategy !== 'string' || !ALLOWED_STRATEGIES.has(entry.strategy)) {
            throw new Error(
                `Invalid descriptor '${entry.language}': 'strategy' must be one of [${[...ALLOWED_STRATEGIES].join(', ')}], saw '${entry.strategy}'`,
            );
        }

        if (typeof entry.semanticRevision !== 'string' || entry.semanticRevision.trim().length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'semanticRevision' must be a non-empty string`);
        }
        if (typeof entry.grammar !== 'string' || entry.grammar.trim().length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'grammar' must be a non-empty string`);
        }

        if (!Array.isArray(entry.extensions) || entry.extensions.length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'extensions' must be a non-empty array of file extensions`);
        }
        for (let extIdx = 0; extIdx < entry.extensions.length; extIdx++) {
            const ext = entry.extensions[extIdx];
            if (typeof ext !== 'string' || !/^\.[a-zA-Z0-9_-]+$/.test(ext)) {
                throw new Error(`Invalid descriptor '${entry.language}': extension at index ${extIdx} must match pattern ^\\.[a-zA-Z0-9_-]+$ (e.g. '.go')`);
            }
        }

        if (!Array.isArray(entry.auxiliaryFiles)) {
            throw new Error(`Invalid descriptor '${entry.language}': 'auxiliaryFiles' must be an array`);
        }
        for (let auxIdx = 0; auxIdx < entry.auxiliaryFiles.length; auxIdx++) {
            const aux = entry.auxiliaryFiles[auxIdx];
            if (!aux || typeof aux !== 'object' || Array.isArray(aux)) {
                throw new Error(`Invalid auxiliary file at index ${auxIdx} in '${entry.language}': must be an object`);
            }
            const auxEntry = aux as Record<string, unknown>;
            for (const key of Object.keys(auxEntry)) {
                if (!ALLOWED_AUXILIARY_KEYS.has(key)) {
                    throw new Error(`Invalid auxiliary file at index ${auxIdx} in '${entry.language}': unknown property '${key}'`);
                }
            }
            if (typeof auxEntry.pattern !== 'string' || auxEntry.pattern.trim().length === 0) {
                throw new Error(`Invalid auxiliary file at index ${auxIdx} in '${entry.language}': 'pattern' must be a non-empty string`);
            }
            if (typeof auxEntry.role !== 'string' || auxEntry.role.trim().length === 0) {
                throw new Error(`Invalid auxiliary file at index ${auxIdx} in '${entry.language}': 'role' must be a non-empty string`);
            }
        }

        if (typeof entry.providerId !== 'string' || entry.providerId.trim().length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'providerId' must be a non-empty string`);
        }
        if (typeof entry.providerVersion !== 'string' || entry.providerVersion.trim().length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'providerVersion' must be a non-empty string`);
        }
        if (typeof entry.environmentConfigId !== 'string' || entry.environmentConfigId.trim().length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'environmentConfigId' must be a non-empty string`);
        }

        validatedDescriptors.push(entry as unknown as SemanticLanguageDescriptor);
    }

    return { languages: validatedDescriptors };
}

function matchPattern(filePath: string, pattern: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const base = path.basename(normalized);
    if (pattern.startsWith('**/')) {
        const target = pattern.slice(3);
        return base.toLowerCase() === target.toLowerCase() || normalized.toLowerCase().endsWith('/' + target.toLowerCase());
    }
    return base.toLowerCase() === pattern.toLowerCase() || normalized.toLowerCase().endsWith(pattern.toLowerCase());
}

function resolveDescriptorPath(): string {
    const candidatePaths = [
        path.resolve(__dirname, '../../../assets/semantic-engine/semantic-languages.json'),
        path.resolve(__dirname, '../../assets/semantic-engine/semantic-languages.json'),
        path.resolve(__dirname, '../assets/semantic-engine/semantic-languages.json'),
        path.resolve(__dirname, './assets/semantic-engine/semantic-languages.json'),
    ];
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    throw new Error(`Semantic language descriptor configuration file missing. Searched: ${candidatePaths.join(', ')}`);
}

function loadDefaultLanguagesConfig(): { languages: SemanticLanguageDescriptor[] } {
    const jsonPath = resolveDescriptorPath();
    const content = fs.readFileSync(jsonPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        throw new Error(`Malformed JSON in semantic language descriptor configuration at ${jsonPath}: ${(e as Error).message}`);
    }
    return validateSemanticLanguagesConfig(parsed);
}

export class DefaultSemanticLanguageRegistry implements SemanticLanguageRegistry {
    private readonly descriptorsByLanguage: Map<string, SemanticLanguageDescriptor>;
    private readonly descriptorsByExtension: Map<string, SemanticLanguageDescriptor>;

    constructor(descriptors?: readonly SemanticLanguageDescriptor[]) {
        this.descriptorsByLanguage = new Map();
        this.descriptorsByExtension = new Map();

        const list = descriptors
            ? (descriptors.length > 0 ? validateSemanticLanguagesConfig({ languages: descriptors }).languages : [])
            : loadDefaultLanguagesConfig().languages;

        for (const desc of list) {
            const canonical = normalizeLanguageId(desc.canonicalLanguage || desc.language);
            this.descriptorsByLanguage.set(canonical, desc);
            for (const ext of desc.extensions) {
                this.descriptorsByExtension.set(ext.toLowerCase(), desc);
            }
        }
    }

    supportsLanguage(language: string): boolean {
        const canonical = normalizeLanguageId(language);
        return this.descriptorsByLanguage.has(canonical);
    }

    getDescriptor(language: string): SemanticLanguageDescriptor | undefined {
        const canonical = normalizeLanguageId(language);
        return this.descriptorsByLanguage.get(canonical);
    }

    getAllSupportedLanguages(): readonly string[] {
        return Array.from(this.descriptorsByLanguage.keys());
    }

    getStrategyForLanguage(language: string): string | undefined {
        const desc = this.getDescriptor(language);
        return desc?.strategy ?? (desc ? 'cbm_semantic' : undefined);
    }

    getAllAuxiliaryPatterns(): readonly { pattern: string; role: string; language: string }[] {
        const results: { pattern: string; role: string; language: string }[] = [];
        for (const [lang, desc] of this.descriptorsByLanguage) {
            for (const aux of desc.auxiliaryFiles) {
                results.push({
                    pattern: aux.pattern,
                    role: aux.role,
                    language: lang,
                });
            }
        }
        return results;
    }

    matchAuxiliaries(filePath: string): readonly SemanticAuxiliaryMatch[] {
        const matches: SemanticAuxiliaryMatch[] = [];
        for (const [lang, desc] of this.descriptorsByLanguage) {
            for (const aux of desc.auxiliaryFiles) {
                if (matchPattern(filePath, aux.pattern)) {
                    matches.push({ role: aux.role, language: lang });
                }
            }
        }
        return matches;
    }

    isAuxiliaryPath(filePath: string): boolean {
        return this.matchAuxiliaries(filePath).length > 0;
    }
}

export const defaultSemanticLanguageRegistry: SemanticLanguageRegistry =
    new DefaultSemanticLanguageRegistry();
