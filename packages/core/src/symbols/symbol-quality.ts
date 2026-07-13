/**
 * Observed symbol-quality gauge from registry evidence (F9 Phase 1).
 * Does not claim parser/fallback cause; does not re-run parsers or splitters.
 */
import { getLanguageCapabilityDeclaration } from '../languages/capabilities';
import type { SymbolKind, SymbolRecord, SymbolRegistryManifestFile } from './contracts';
import type { SymbolRegistry } from './registry';
import type { ReadSymbolRegistrySidecarResult } from './sidecar';
import type { NavigationSymbolQualityAggregate } from './sidecar';

export type SymbolQualityStatus =
    | 'symbol_rich'
    | 'mixed'
    | 'symbol_sparse'
    | 'search_only'
    | 'unknown';

export type SymbolQualityBasis = 'symbol_registry';
export type SymbolQualityEvidenceAvailability = 'ready' | 'missing' | 'unverified';

export interface SymbolQualityLanguageBreakdown {
    language: string;
    eligibleFiles: number;
    filesWithNonFileSymbols: number;
    status: SymbolQualityStatus;
}

export interface SymbolQualitySummary {
    status: SymbolQualityStatus;
    basis: SymbolQualityBasis;
    eligibleFiles: number;
    filesWithNonFileSymbols: number;
    fileOwnerOnlyFiles: number;
    nonFileSymbolCount: number;
    languages: SymbolQualityLanguageBreakdown[];
    message: string;
    evidenceAvailability: SymbolQualityEvidenceAvailability;
}

export interface SymbolQualityFileInput {
    path: string;
    language: string;
}

export interface SymbolQualitySymbolInput {
    file: string;
    kind: string;
}

const RICH_THRESHOLD = 0.60;
const MIXED_THRESHOLD = 0.20;

function compareAsc(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRelativePath(value: string): string {
    return value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Languages that product claims can carry non-file symbols.
 * Search-only languages are never treated as symbol_sparse.
 */
export function isLanguageSymbolEligible(language: string): boolean | null {
    const declaration = getLanguageCapabilityDeclaration(language);
    if (!declaration) {
        return null;
    }
    if (declaration.publicClaim === 'search_only') {
        return false;
    }
    if (
        declaration.symbolExtractionCapability !== 'none'
        || declaration.ownerExtractionCapability !== 'none'
    ) {
        return true;
    }
    return false;
}

function statusFromRatio(eligibleFiles: number, filesWithNonFileSymbols: number): SymbolQualityStatus {
    if (eligibleFiles <= 0) {
        return 'unknown';
    }
    const ratio = filesWithNonFileSymbols / eligibleFiles;
    if (ratio >= RICH_THRESHOLD) {
        return 'symbol_rich';
    }
    if (ratio >= MIXED_THRESHOLD) {
        return 'mixed';
    }
    return 'symbol_sparse';
}

function messageForStatus(status: SymbolQualityStatus): string {
    switch (status) {
        case 'symbol_rich':
            return 'Index is searchable and has symbol evidence for most eligible files.';
        case 'mixed':
            return 'Index is searchable with partial symbol evidence on eligible files.';
        case 'symbol_sparse':
            return 'Index is searchable but eligible files mostly lack non-file symbols; treat outline/call_graph as weak navigation evidence.';
        case 'search_only':
            return 'Indexed files are search-only languages; symbol navigation is not expected.';
        case 'unknown':
        default:
            return 'Observed symbol quality unavailable (no compatible registry, empty index, or unclassifiable languages).';
    }
}

function isNonFileKind(kind: string): boolean {
    return kind !== 'file';
}

/**
 * Pure summary from registry file list + symbol records.
 */
export function computeSymbolQualitySummary(input: {
    files: readonly SymbolQualityFileInput[];
    symbols: readonly SymbolQualitySymbolInput[];
}): SymbolQualitySummary {
    const files = input.files.map((file) => ({
        path: normalizeRelativePath(file.path),
        language: String(file.language || '').trim().toLowerCase() || 'unknown',
    }));
    const symbolsByFile = new Map<string, SymbolQualitySymbolInput[]>();
    let nonFileSymbolCount = 0;
    for (const symbol of input.symbols) {
        const file = normalizeRelativePath(symbol.file);
        const list = symbolsByFile.get(file) || [];
        list.push(symbol);
        symbolsByFile.set(file, list);
        if (isNonFileKind(symbol.kind)) {
            nonFileSymbolCount += 1;
        }
    }

    type FileClass = 'eligible' | 'search_only' | 'unclassified';
    const byLanguage = new Map<string, {
        eligibleFiles: number;
        filesWithNonFileSymbols: number;
        searchOnlyFiles: number;
        unclassifiedFiles: number;
    }>();

    let eligibleFiles = 0;
    let filesWithNonFileSymbols = 0;
    let fileOwnerOnlyFiles = 0;
    let searchOnlyFiles = 0;
    let unclassifiedFiles = 0;

    for (const file of files) {
        const eligibility = isLanguageSymbolEligible(file.language);
        const fileSymbols = symbolsByFile.get(file.path) || [];
        const hasNonFile = fileSymbols.some((symbol) => isNonFileKind(symbol.kind));
        let fileClass: FileClass;
        if (eligibility === true) {
            fileClass = 'eligible';
        } else if (eligibility === false) {
            fileClass = 'search_only';
        } else if (hasNonFile) {
            // Undeclared language with non-file symbols: treat as observed-eligible.
            fileClass = 'eligible';
        } else {
            fileClass = 'unclassified';
        }

        const lang = byLanguage.get(file.language) || {
            eligibleFiles: 0,
            filesWithNonFileSymbols: 0,
            searchOnlyFiles: 0,
            unclassifiedFiles: 0,
        };

        if (fileClass === 'eligible') {
            eligibleFiles += 1;
            lang.eligibleFiles += 1;
            if (hasNonFile) {
                filesWithNonFileSymbols += 1;
                lang.filesWithNonFileSymbols += 1;
            } else {
                fileOwnerOnlyFiles += 1;
            }
        } else if (fileClass === 'search_only') {
            searchOnlyFiles += 1;
            lang.searchOnlyFiles += 1;
        } else {
            unclassifiedFiles += 1;
            lang.unclassifiedFiles += 1;
        }
        byLanguage.set(file.language, lang);
    }

    let status: SymbolQualityStatus;
    if (files.length === 0) {
        status = 'unknown';
    } else if (eligibleFiles === 0) {
        if (searchOnlyFiles > 0 && unclassifiedFiles === 0) {
            status = 'search_only';
        } else {
            status = 'unknown';
        }
    } else {
        status = statusFromRatio(eligibleFiles, filesWithNonFileSymbols);
    }

    const languages: SymbolQualityLanguageBreakdown[] = Array.from(byLanguage.entries())
        .map(([language, stats]) => {
            let languageStatus: SymbolQualityStatus;
            if (stats.eligibleFiles > 0) {
                languageStatus = statusFromRatio(stats.eligibleFiles, stats.filesWithNonFileSymbols);
            } else if (stats.searchOnlyFiles > 0 && stats.unclassifiedFiles === 0) {
                languageStatus = 'search_only';
            } else {
                languageStatus = 'unknown';
            }
            return {
                language,
                eligibleFiles: stats.eligibleFiles,
                filesWithNonFileSymbols: stats.filesWithNonFileSymbols,
                status: languageStatus,
            };
        })
        .sort((left, right) => compareAsc(left.language, right.language));

    return {
        status,
        basis: 'symbol_registry',
        eligibleFiles,
        filesWithNonFileSymbols,
        fileOwnerOnlyFiles,
        nonFileSymbolCount,
        languages,
        message: messageForStatus(status),
        evidenceAvailability: 'ready',
    };
}

export function computeSymbolQualitySummaryFromRegistry(registry: SymbolRegistry): SymbolQualitySummary {
    return computeSymbolQualitySummary({
        files: registry.manifest.files.map((file: SymbolRegistryManifestFile) => ({
            path: file.path,
            language: file.language,
        })),
        symbols: registry.symbols.map((symbol: SymbolRecord) => ({
            file: symbol.file,
            kind: symbol.kind as SymbolKind | string,
        })),
    });
}

export function computeSymbolQualitySummaryFromAggregate(
    aggregate: NavigationSymbolQualityAggregate,
): SymbolQualitySummary {
    let eligibleFiles = 0;
    let filesWithNonFileSymbols = 0;
    let fileOwnerOnlyFiles = 0;
    let nonFileSymbolCount = 0;
    let searchOnlyFiles = 0;
    let unclassifiedFiles = 0;
    const languages = aggregate.languages.map((entry) => {
        const eligibility = isLanguageSymbolEligible(entry.language);
        const observedEligible = eligibility === true || (eligibility === null && entry.nonFileSymbolCount > 0);
        if (observedEligible) {
            eligibleFiles += entry.indexedFiles;
            filesWithNonFileSymbols += entry.filesWithNonFileSymbols;
            fileOwnerOnlyFiles += entry.indexedFiles - entry.filesWithNonFileSymbols;
        } else if (eligibility === false) {
            searchOnlyFiles += entry.indexedFiles;
        } else {
            unclassifiedFiles += entry.indexedFiles;
        }
        nonFileSymbolCount += entry.nonFileSymbolCount;
        return {
            language: entry.language,
            eligibleFiles: observedEligible ? entry.indexedFiles : 0,
            filesWithNonFileSymbols: observedEligible ? entry.filesWithNonFileSymbols : 0,
            status: observedEligible
                ? statusFromRatio(entry.indexedFiles, entry.filesWithNonFileSymbols)
                : eligibility === false ? 'search_only' as const : 'unknown' as const,
        };
    });
    const status = aggregate.indexedFileCount === 0
        ? 'unknown'
        : eligibleFiles > 0
            ? statusFromRatio(eligibleFiles, filesWithNonFileSymbols)
            : searchOnlyFiles > 0 && unclassifiedFiles === 0 ? 'search_only' : 'unknown';
    return {
        status,
        basis: 'symbol_registry',
        eligibleFiles,
        filesWithNonFileSymbols,
        fileOwnerOnlyFiles,
        nonFileSymbolCount,
        languages,
        message: messageForStatus(status),
        evidenceAvailability: 'ready',
    };
}

export function unknownSymbolQualitySummary(
    message?: string,
    evidenceAvailability: SymbolQualityEvidenceAvailability = 'missing',
): SymbolQualitySummary {
    return {
        status: 'unknown',
        basis: 'symbol_registry',
        eligibleFiles: 0,
        filesWithNonFileSymbols: 0,
        fileOwnerOnlyFiles: 0,
        nonFileSymbolCount: 0,
        languages: [],
        message: message || messageForStatus('unknown'),
        evidenceAvailability,
    };
}

export function computeSymbolQualitySummaryFromSidecarRead(
    read: ReadSymbolRegistrySidecarResult,
): SymbolQualitySummary {
    if (read.status !== 'ok' || !read.registry) {
        return unknownSymbolQualitySummary(
            read.status === 'missing'
                ? 'Observed symbol quality unavailable (symbol registry missing).'
                : `Observed symbol quality unavailable (${read.reason || 'registry unreadable'}).`,
            read.status === 'missing' ? 'missing' : 'unverified',
        );
    }
    if (read.registry.manifest.files.length === 0) {
        return unknownSymbolQualitySummary('Observed symbol quality unavailable (empty registry).', 'ready');
    }
    return computeSymbolQualitySummaryFromRegistry(read.registry);
}

/** Compact marker for list_codebases / log lines. */
export function formatSymbolQualityMarker(summary: SymbolQualitySummary): string {
    return `symbolQuality=${summary.status}`;
}
