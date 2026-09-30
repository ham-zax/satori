/**
 * Observed symbol-quality gauge from registry evidence (F9 Phase 1).
 * Parser outcomes come only from published manifest evidence; no parser is re-run.
 */
import type { StructuralReason } from '../language-analysis/types';
import { getLanguageCapabilityDeclaration } from '../languages/capabilities';
import type { SymbolKind, SymbolRecord, SymbolRegistryManifestFile } from './contracts';
import type { SymbolRegistry } from './registry';
import type { ReadSymbolRegistrySidecarResult } from './sidecar';

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

export interface PublishedStructuralAnalysisSummary {
    completeFiles: number;
    recoveredFiles: number;
    unsupportedFiles: number;
    unknownFiles: number;
    reasons: { reason: StructuralReason; files: number }[];
}

export interface SymbolQualitySummary {
    structuralAnalysis: PublishedStructuralAnalysisSummary;
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
    structuralStatus?: SymbolRegistryManifestFile['structuralStatus'];
    structuralReason?: StructuralReason;
}

export interface SymbolQualitySymbolInput {
    file: string;
    kind: string;
}

/** One summary owner for durable parser evidence in status and search responses. */
export function summarizePublishedStructuralAnalysis(files: readonly SymbolQualityFileInput[]): PublishedStructuralAnalysisSummary {
    const summary: PublishedStructuralAnalysisSummary = {
        completeFiles: 0, recoveredFiles: 0, unsupportedFiles: 0, unknownFiles: 0, reasons: [],
    };
    const reasons = new Map<StructuralReason, number>();
    for (const file of files) {
        if (file.structuralStatus === 'complete') summary.completeFiles++;
        else if (file.structuralStatus === 'recovered') summary.recoveredFiles++;
        else if (file.structuralStatus === 'unsupported') summary.unsupportedFiles++;
        else summary.unknownFiles++;
        if (file.structuralReason) reasons.set(file.structuralReason, (reasons.get(file.structuralReason) ?? 0) + 1);
    }
    summary.reasons = [...reasons].sort(([a], [b]) => compareAsc(a, b)).map(([reason, files]) => ({ reason, files }));
    return summary;
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
        structuralAnalysis: summarizePublishedStructuralAnalysis(input.files),
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
            structuralStatus: file.structuralStatus,
            structuralReason: file.structuralReason,
        })),
        symbols: registry.symbols.map((symbol: SymbolRecord) => ({
            file: symbol.file,
            kind: symbol.kind as SymbolKind | string,
        })),
    });
}

export function unknownSymbolQualitySummary(
    message?: string,
    evidenceAvailability: SymbolQualityEvidenceAvailability = 'missing',
): SymbolQualitySummary {
    return {
        status: 'unknown',
        basis: 'symbol_registry',
        structuralAnalysis: summarizePublishedStructuralAnalysis([]),
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
