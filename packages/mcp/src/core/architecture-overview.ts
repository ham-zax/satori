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
    matchesPublishedPathScope,
    type PublishedPathScope,
} from "./navigation-path-scope.js";
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

export interface ArchitectureOverviewAreaFlow {
    area: string;
    counterpartAreaCount: number;
    calls: number;
    imports: number;
    evidenceCount: number;
    highConfidenceEvidenceCount: number;
}

export interface ArchitectureOverviewEntryCandidate {
    symbolId: string;
    label: string;
    file: string;
    language: string;
    outgoingCallCount: number;
}

export interface ArchitectureOverviewCycle {
    areas: string[];
    boundaryEdgeCount: number;
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
        eligiblePublishedFileCount: number;
        excludedPublishedFileCountByPathScope: number;
        excludedSymbolsByCategory: Partial<Record<PathCategory, number>>;
    };
    areas: ArchitectureOverviewArea[];
    boundaries: ArchitectureOverviewBoundary[];
    fanIn: ArchitectureOverviewAreaFlow[];
    fanOut: ArchitectureOverviewAreaFlow[];
    fanInRule: "cross_area_incoming_calls_and_imports";
    fanOutRule: "cross_area_outgoing_calls_and_imports";
    hotspots: ArchitectureOverviewHotspot[];
    entryCandidates: ArchitectureOverviewEntryCandidate[];
    entryCandidatesTruncated: boolean;
    entryCandidateRule: "outgoing_calls_and_no_incoming_calls_within_scope";
    cycles: ArchitectureOverviewCycle[];
    cyclesTruncated: boolean;
    cycleRule: "strongly_connected_area_boundary_graph";
    pathScope: {
        subtree: string | null;
        excludePaths: string[];
    };
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

export function areaForFile(file: string): string {
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

function includeArchitectureFile(
    file: string,
    scope: ArchitectureOverviewScope,
    pathScope: PublishedPathScope,
): boolean {
    if (!matchesPublishedPathScope(file, pathScope)) return false;
    return scope === "all" || includeRuntimeFile(file);
}

function includeSymbol(
    symbol: SymbolRecord,
    scope: ArchitectureOverviewScope,
    pathScope: PublishedPathScope,
): boolean {
    if (symbol.kind === "file") return false;
    return includeArchitectureFile(symbol.file, scope, pathScope);
}

function increment<K>(map: Map<K, number>, key: K, amount = 1): void {
    map.set(key, (map.get(key) ?? 0) + amount);
}

function buildAreaFlow(
    boundaries: readonly ArchitectureOverviewBoundary[],
    direction: "in" | "out",
    limit: number,
): ArchitectureOverviewAreaFlow[] {
    const byArea = new Map<string, ArchitectureOverviewAreaFlow>();
    for (const boundary of boundaries) {
        const area = direction === "in" ? boundary.to : boundary.from;
        const existing = byArea.get(area) ?? {
            area,
            counterpartAreaCount: 0,
            calls: 0,
            imports: 0,
            evidenceCount: 0,
            highConfidenceEvidenceCount: 0,
        };
        existing.counterpartAreaCount += 1;
        existing.calls += boundary.calls;
        existing.imports += boundary.imports;
        existing.evidenceCount += boundary.evidenceCount;
        existing.highConfidenceEvidenceCount += boundary.highConfidenceEvidenceCount;
        byArea.set(area, existing);
    }
    return [...byArea.values()]
        .sort((left, right) => (
            right.evidenceCount - left.evidenceCount
            || right.highConfidenceEvidenceCount - left.highConfidenceEvidenceCount
            || right.counterpartAreaCount - left.counterpartAreaCount
            || right.calls - left.calls
            || left.area.localeCompare(right.area)
        ))
        .slice(0, limit);
}

function buildAreaCycles(
    boundaries: readonly { from: string; to: string }[],
    limit: number,
): { cycles: ArchitectureOverviewCycle[]; truncated: boolean } {
    const adjacency = new Map<string, Set<string>>();
    for (const boundary of boundaries) {
        const targets = adjacency.get(boundary.from) ?? new Set<string>();
        targets.add(boundary.to);
        adjacency.set(boundary.from, targets);
        if (!adjacency.has(boundary.to)) adjacency.set(boundary.to, new Set());
    }
    const nodes = [...adjacency.keys()].sort();
    let index = 0;
    const indexByNode = new Map<string, number>();
    const lowByNode = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const components: string[][] = [];

    const visit = (node: string): void => {
        indexByNode.set(node, index);
        lowByNode.set(node, index);
        index += 1;
        stack.push(node);
        onStack.add(node);
        for (const next of [...(adjacency.get(node) ?? [])].sort()) {
            if (!indexByNode.has(next)) {
                visit(next);
                lowByNode.set(node, Math.min(lowByNode.get(node)!, lowByNode.get(next)!));
            } else if (onStack.has(next)) {
                lowByNode.set(node, Math.min(lowByNode.get(node)!, indexByNode.get(next)!));
            }
        }
        if (lowByNode.get(node) !== indexByNode.get(node)) return;
        const component: string[] = [];
        while (stack.length > 0) {
            const popped = stack.pop()!;
            onStack.delete(popped);
            component.push(popped);
            if (popped === node) break;
        }
        component.sort();
        if (component.length > 1) components.push(component);
    };
    for (const node of nodes) {
        if (!indexByNode.has(node)) visit(node);
    }

    const cycles = components.map((areas) => {
        const members = new Set(areas);
        const boundaryEdgeCount = boundaries.filter((boundary) => (
            members.has(boundary.from) && members.has(boundary.to)
        )).length;
        return { areas, boundaryEdgeCount };
    }).sort((left, right) => (
        right.areas.length - left.areas.length
        || right.boundaryEdgeCount - left.boundaryEdgeCount
        || left.areas.join("\0").localeCompare(right.areas.join("\0"))
    ));
    return {
        cycles: cycles.slice(0, limit),
        truncated: cycles.length > limit,
    };
}

export function buildArchitectureOverview(input: {
    manifest: SymbolRegistryManifest;
    symbols: readonly SymbolRecord[];
    relationships: readonly RelationshipRecord[];
    resolutionClaims?: readonly ResolutionClaim[];
    scope: ArchitectureOverviewScope;
    limit: number;
    subtree?: string;
    excludePaths?: readonly string[];
}): ArchitectureOverviewResult {
    const pathScope: PublishedPathScope = {
        ...(input.subtree ? { subtree: input.subtree } : {}),
        ...(input.excludePaths ? { excludePaths: input.excludePaths } : {}),
    };
    const includedSymbols = input.symbols.filter((symbol) => includeSymbol(symbol, input.scope, pathScope));
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
    const outgoingCallsBySource = new Map<string, number>();
    const externalIncomingCallTargets = new Set<string>();
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
            !includeArchitectureFile(sourceFile, input.scope, pathScope)
            || !includeArchitectureFile(targetFile, input.scope, pathScope)
        ) {
            continue;
        }

        includedRelationshipCount += 1;
        if (
            relationship.type === "CALLS"
            && source?.symbolInstanceId
            && target?.symbolInstanceId
            && includedIds.has(source.symbolInstanceId)
            && includedIds.has(target.symbolInstanceId)
        ) {
            increment(outgoingCallsBySource, source.symbolInstanceId);
            if (source.symbolInstanceId !== target.symbolInstanceId) {
                externalIncomingCallTargets.add(target.symbolInstanceId);
            }
        }

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
        includeArchitectureFile(claim.sourceFile, input.scope, pathScope)
    ));
    const constructCoverage = summarizeResolutionConstructCoverage(scopedClaims, {
        gapLimit: 10,
        relationships: input.relationships,
    });
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

    const allBoundaries = [...boundaryEvidence.values()]
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
        ));
    const boundaries = allBoundaries.slice(0, limit);
    const fanIn = buildAreaFlow(allBoundaries, "in", limit);
    const fanOut = buildAreaFlow(allBoundaries, "out", limit);

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

    const allEntryCandidates = [...outgoingCallsBySource.entries()]
        .filter(([symbolId]) => !externalIncomingCallTargets.has(symbolId))
        .map(([symbolId, outgoingCallCount]) => {
            const symbol = symbolsById.get(symbolId);
            if (!symbol) return undefined;
            return {
                symbolId,
                label: symbol.label,
                file: symbol.file,
                language: symbol.language,
                outgoingCallCount,
            };
        })
        .filter((row): row is ArchitectureOverviewEntryCandidate => row !== undefined)
        .sort((left, right) => (
            right.outgoingCallCount - left.outgoingCallCount
            || left.file.localeCompare(right.file)
            || left.label.localeCompare(right.label)
            || left.symbolId.localeCompare(right.symbolId)
        ));
    const entryCandidates = allEntryCandidates.slice(0, limit);
    const areaCycles = buildAreaCycles(allBoundaries, limit);
    const eligiblePublishedFileCount = input.manifest.files.filter((file) => (
        matchesPublishedPathScope(file.path, pathScope)
    )).length;

    return {
        basis: "publication_navigation",
        scope: input.scope,
        coverage: {
            publishedFileCount: input.manifest.files.length,
            symbolCount: input.symbols.length,
            relationshipCount: input.relationships.length,
            includedSymbolCount: includedSymbols.length,
            includedRelationshipCount,
            eligiblePublishedFileCount,
            excludedPublishedFileCountByPathScope: input.manifest.files.length - eligiblePublishedFileCount,
            excludedSymbolsByCategory: Object.fromEntries(
                [...excludedSymbolsByCategory.entries()].sort(([left], [right]) => left.localeCompare(right)),
            ),
        },
        areas,
        boundaries,
        fanIn,
        fanOut,
        fanInRule: "cross_area_incoming_calls_and_imports",
        fanOutRule: "cross_area_outgoing_calls_and_imports",
        hotspots,
        entryCandidates,
        entryCandidatesTruncated: allEntryCandidates.length > limit,
        entryCandidateRule: "outgoing_calls_and_no_incoming_calls_within_scope",
        cycles: areaCycles.cycles,
        cyclesTruncated: areaCycles.truncated,
        cycleRule: "strongly_connected_area_boundary_graph",
        pathScope: {
            subtree: input.subtree ?? null,
            excludePaths: [...(input.excludePaths ?? [])].sort(),
        },
        relationshipEvidence: {
            resolutionClaimCount: scopedClaims.length,
            resolvedClaimCount: scopedClaims.filter((claim) => claim.decision === "resolved").length,
            ambiguousClaimCount: scopedClaims.filter((claim) => claim.decision === "ambiguous").length,
            unresolvedClaimCount: scopedClaims.filter((claim) => claim.decision === "unresolved").length,
            constructCoverage,
        },
    };
}
