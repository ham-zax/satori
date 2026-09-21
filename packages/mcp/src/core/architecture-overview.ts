import {
    summarizeResolutionConstructCoverage,
    type RelationshipRecord,
    type ResolutionClaim,
    type ResolutionConstructCoverage,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from "@zokizuan/satori-core";
import type { PathCategory } from "./search-constants.js";
import {
    classifyPathCategory,
    normalizeSearchPath,
} from "./search-ranking-policy.js";

export type ArchitectureOverviewScope = "runtime" | "all";

export interface ArchitectureOverviewArea {
    area: string;
    fileCount: number;
    symbolCount: number;
}

export interface ArchitectureOverviewBoundary {
    from: string;
    to: string;
    calls: number;
    highConfidenceCalls: number;
    imports: number;
    highConfidenceImports: number;
    evidenceCount: number;
    highConfidenceEvidenceCount: number;
}

export interface ArchitectureOverviewHotspot {
    symbolId: string;
    label: string;
    file: string;
    language: string;
    callerCount: number;
    highConfidenceCallerCount: number;
    callSiteCount: number;
    highConfidenceCallSiteCount: number;
}

export interface ArchitectureOverviewResult {
    basis: "publication_navigation";
    scope: ArchitectureOverviewScope;
    coverage: {
        publishedFileCount: number;
        symbolCount: number;
        relationshipCount: number;
        includedSymbolCount: number;
        includedRelationshipCount: number;
        excludedSymbolsByCategory: Partial<Record<PathCategory, number>>;
    };
    areas: ArchitectureOverviewArea[];
    boundaries: ArchitectureOverviewBoundary[];
    hotspots: ArchitectureOverviewHotspot[];
    relationshipEvidence: {
        resolutionClaimCount: number;
        resolvedClaimCount: number;
        ambiguousClaimCount: number;
        unresolvedClaimCount: number;
        constructCoverage: ResolutionConstructCoverage[];
    };
}

function normalizeFile(file: string): string {
    return file.replace(/\\/g, "/").replace(/^\/+/, "");
}

function areaForFile(file: string): string {
    const segments = normalizeFile(file).split("/").filter(Boolean);
    if (segments.length === 0) return "(root)";
    if (
        segments.length >= 3
        && ["engine", "backend", "frontend", "platform"].includes(segments[0]!)
        && ["crates", "packages", "services", "apps", "libs"].includes(segments[1]!)
    ) {
        return segments.slice(0, 3).join("/");
    }
    if (
        segments.length >= 2
        && ["src", "lib", "libs", "app", "apps", "packages", "services", "crates", "modules", "tools"].includes(segments[0]!)
    ) {
        return segments.slice(0, 2).join("/");
    }
    return segments[0]!;
}

const NON_RUNTIME_CATEGORIES = new Set<PathCategory>([
    "scriptRuntime",
    "example",
    "fixture",
    "artifact",
    "landing",
    "tests",
    "docs",
    "generated",
]);

function isBenchmarkOrExperimentPath(file: string): boolean {
    const normalized = normalizeSearchPath(file);
    return /(^|\/)(?:experiments?|benchmarks?|benchmark[^/]*)(\/|$)/.test(normalized)
        || /(^|\/)[^/]*benchmark[^/]*\.[^/]+$/.test(normalized);
}

function isArchitectureSupportPath(file: string): boolean {
    const normalized = normalizeSearchPath(file);
    return normalized === "evals"
        || normalized.startsWith("evals/")
        || normalized === "third_party"
        || normalized.startsWith("third_party/")
        || normalized === "tools"
        || normalized.startsWith("tools/");
}

function includeRuntimeFile(file: string): boolean {
    const category = classifyPathCategory(file);
    return !NON_RUNTIME_CATEGORIES.has(category)
        && !isBenchmarkOrExperimentPath(file)
        && !isArchitectureSupportPath(file);
}

function includeSymbol(symbol: SymbolRecord, scope: ArchitectureOverviewScope): boolean {
    if (symbol.kind === "file") return false;
    if (scope === "all") return true;
    return includeRuntimeFile(symbol.file);
}

function increment<K>(map: Map<K, number>, key: K, amount = 1): void {
    map.set(key, (map.get(key) ?? 0) + amount);
}

export function buildArchitectureOverview(input: {
    manifest: SymbolRegistryManifest;
    symbols: readonly SymbolRecord[];
    relationships: readonly RelationshipRecord[];
    resolutionClaims?: readonly ResolutionClaim[];
    scope: ArchitectureOverviewScope;
    limit: number;
}): ArchitectureOverviewResult {
    const includedSymbols = input.symbols.filter((symbol) => includeSymbol(symbol, input.scope));
    const includedIds = new Set(includedSymbols.map((symbol) => symbol.symbolInstanceId));
    const symbolsById = new Map(input.symbols.map((symbol) => [symbol.symbolInstanceId, symbol]));

    const excludedSymbolsByCategory = new Map<PathCategory, number>();
    if (input.scope === "runtime") {
        for (const symbol of input.symbols) {
            if (symbol.kind === "file" || includedIds.has(symbol.symbolInstanceId)) continue;
            increment(excludedSymbolsByCategory, classifyPathCategory(symbol.file));
        }
    }

    const areaFiles = new Map<string, Set<string>>();
    const areaSymbols = new Map<string, number>();
    for (const symbol of includedSymbols) {
        const area = areaForFile(symbol.file);
        const files = areaFiles.get(area) ?? new Set<string>();
        files.add(symbol.file);
        areaFiles.set(area, files);
        increment(areaSymbols, area);
    }

    const boundaryEvidence = new Map<string, {
        from: string;
        to: string;
        calls: number;
        highConfidenceCalls: number;
        imports: number;
        highConfidenceImports: number;
    }>();
    const callersByTarget = new Map<string, Set<string>>();
    const highConfidenceCallersByTarget = new Map<string, Set<string>>();
    const callSitesByTarget = new Map<string, number>();
    const highConfidenceCallSitesByTarget = new Map<string, number>();
    let includedRelationshipCount = 0;

    for (const relationship of input.relationships) {
        if (relationship.type !== "CALLS" && relationship.type !== "IMPORTS") continue;
        const highConfidence = relationship.confidence === "high";

        const source = relationship.sourceInstanceId
            ? symbolsById.get(relationship.sourceInstanceId)
            : undefined;
        const target = relationship.targetInstanceId
            ? symbolsById.get(relationship.targetInstanceId)
            : undefined;

        const sourceFile = source?.file ?? relationship.file;
        const targetFile = target?.file ?? relationship.targetPath;
        if (!sourceFile || !targetFile) continue;

        if (
            input.scope === "runtime"
            && (!includeRuntimeFile(sourceFile) || !includeRuntimeFile(targetFile))
        ) {
            continue;
        }

        includedRelationshipCount += 1;

        const from = areaForFile(sourceFile);
        const to = areaForFile(targetFile);
        if (from !== to) {
            const key = `${from}\u0000${to}`;
            const row = boundaryEvidence.get(key) ?? {
                from,
                to,
                calls: 0,
                highConfidenceCalls: 0,
                imports: 0,
                highConfidenceImports: 0,
            };
            if (relationship.type === "CALLS") {
                row.calls += 1;
                if (highConfidence) row.highConfidenceCalls += 1;
            } else {
                row.imports += 1;
                if (highConfidence) row.highConfidenceImports += 1;
            }
            boundaryEvidence.set(key, row);
        }

        if (
            relationship.type === "CALLS"
            && target?.symbolInstanceId
            && source?.symbolInstanceId
            && (input.scope === "all" || includedIds.has(target.symbolInstanceId))
        ) {
            const callers = callersByTarget.get(target.symbolInstanceId) ?? new Set<string>();
            callers.add(source.symbolInstanceId);
            callersByTarget.set(target.symbolInstanceId, callers);
            increment(callSitesByTarget, target.symbolInstanceId);
            if (highConfidence) {
                const highConfidenceCallers = highConfidenceCallersByTarget.get(target.symbolInstanceId)
                    ?? new Set<string>();
                highConfidenceCallers.add(source.symbolInstanceId);
                highConfidenceCallersByTarget.set(target.symbolInstanceId, highConfidenceCallers);
                increment(highConfidenceCallSitesByTarget, target.symbolInstanceId);
            }
        }
    }

    const scopedClaims = (input.resolutionClaims ?? []).filter((claim) => (
        input.scope === "all" || includeRuntimeFile(claim.sourceFile)
    ));
    const constructCoverage = summarizeResolutionConstructCoverage(scopedClaims, { gapLimit: 10 });
    const limit = Math.max(1, Math.floor(input.limit));
    const areas = [...areaSymbols.entries()]
        .map(([area, symbolCount]) => ({
            area,
            fileCount: areaFiles.get(area)?.size ?? 0,
            symbolCount,
        }))
        .sort((left, right) => (
            right.symbolCount - left.symbolCount
            || right.fileCount - left.fileCount
            || left.area.localeCompare(right.area)
        ))
        .slice(0, limit);

    const boundaries = [...boundaryEvidence.values()]
        .map((row) => ({
            ...row,
            evidenceCount: row.calls + row.imports,
            highConfidenceEvidenceCount: row.highConfidenceCalls + row.highConfidenceImports,
        }))
        .sort((left, right) => (
            right.evidenceCount - left.evidenceCount
            || right.highConfidenceEvidenceCount - left.highConfidenceEvidenceCount
            || right.calls - left.calls
            || left.from.localeCompare(right.from)
            || left.to.localeCompare(right.to)
        ))
        .slice(0, limit);

    const hotspots = [...callersByTarget.entries()]
        .map(([symbolId, callers]) => {
            const symbol = symbolsById.get(symbolId);
            if (!symbol) return undefined;
            return {
                symbolId,
                label: symbol.label,
                file: symbol.file,
                language: symbol.language,
                callerCount: callers.size,
                highConfidenceCallerCount: highConfidenceCallersByTarget.get(symbolId)?.size ?? 0,
                callSiteCount: callSitesByTarget.get(symbolId) ?? 0,
                highConfidenceCallSiteCount: highConfidenceCallSitesByTarget.get(symbolId) ?? 0,
            };
        })
        .filter((row): row is ArchitectureOverviewHotspot => row !== undefined)
        .sort((left, right) => (
            right.callerCount - left.callerCount
            || right.callSiteCount - left.callSiteCount
            || left.file.localeCompare(right.file)
            || left.label.localeCompare(right.label)
        ))
        .slice(0, limit);

    return {
        basis: "publication_navigation",
        scope: input.scope,
        coverage: {
            publishedFileCount: input.manifest.files.length,
            symbolCount: input.symbols.length,
            relationshipCount: input.relationships.length,
            includedSymbolCount: includedSymbols.length,
            includedRelationshipCount,
            excludedSymbolsByCategory: Object.fromEntries(
                [...excludedSymbolsByCategory.entries()].sort(([left], [right]) => left.localeCompare(right)),
            ),
        },
        areas,
        boundaries,
        hotspots,
        relationshipEvidence: {
            resolutionClaimCount: scopedClaims.length,
            resolvedClaimCount: scopedClaims.filter((claim) => claim.decision === "resolved").length,
            ambiguousClaimCount: scopedClaims.filter((claim) => claim.decision === "ambiguous").length,
            unresolvedClaimCount: scopedClaims.filter((claim) => claim.decision === "unresolved").length,
            constructCoverage,
        },
    };
}
