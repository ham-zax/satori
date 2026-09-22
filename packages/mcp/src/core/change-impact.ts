import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareContractStrings } from "@zokizuan/satori-core";
import type {
    CallGraphEdgeResult,
    CallGraphResponseEnvelope,
    FileOutlineResponseEnvelope,
    CallGraphNodeResult,
} from "./search-types.js";
import { areaForFile } from "./architecture-overview.js";

const execFileAsync = promisify(execFile);

export type ChangeImpactInput = {
    path: string;
    baseRef: string;
    depth: number;
    limit: number;
};

export type ChangeImpactPorts = {
    outline(file: string): Promise<FileOutlineResponseEnvelope>;
    callers(root: string, symbol: CallGraphNodeResult): Promise<CallGraphResponseEnvelope>;
};

type ImpactPathEdge = Readonly<{
    callerSymbolId: string;
    calleeSymbolId: string;
    site: CallGraphEdgeResult["site"];
    strategy: "rule" | "heuristic";
    confidence: number;
    resolutionAuthority?: CallGraphEdgeResult["resolutionAuthority"];
}>;

type ImpactEvidenceClass = "proof_backed" | "heuristic";

type ImpactNode = CallGraphNodeResult & {
    codebaseRoot: string;
    impactClass: "direct" | "transitive";
    evidenceClass: ImpactEvidenceClass;
    distance: number;
    seedSymbolId: string;
    causalPath: ImpactPathEdge[];
};

function isProofBackedImpactEdge(edge: ImpactPathEdge): boolean {
    return edge.resolutionAuthority === "direct_binding"
        || edge.resolutionAuthority === "origin_flow";
}

/** Read-only diff -> current-file symbol seeds -> bounded transitive callers. */
export async function detectChangeImpact(input: ChangeImpactInput, ports: ChangeImpactPorts) {
    const git = async (args: string[]) => (await execFileAsync("git", ["-C", input.path, ...args], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    })).stdout;
    // Resolve the revision separately: revision strings never become options
    // or a pathspec. All subsequent operations use the immutable commit ID.
    const baseCommit = (await git(["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`])).trim();
    const changedFiles = (await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z",
        "--no-renames", "--relative", baseCommit, "--", "."])).split("\0").filter(Boolean).sort();
    const seeds: Array<CallGraphNodeResult & { codebaseRoot: string }> = [];
    const unavailableFiles: Array<{ file: string; reason: string }> = [];
    const warnings = new Set<string>(["IMPACT_GRAPH_ADVISORY", "IMPACT_CURRENT_SYMBOLS_ONLY", "IMPACT_SNAPSHOT_NOT_ATOMIC"]);
    let truncated = changedFiles.length > 50;
    for (const [fileIndex, file] of changedFiles.slice(0, 50).entries()) {
        const outline = await ports.outline(file);
        if (outline.status !== "ok" || !outline.outline) {
            unavailableFiles.push({ file, reason: outline.reason ?? outline.status });
            continue;
        }
        const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative",
            "--unified=0", baseCommit, "--", `:(literal)${file}`]);
        const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({
            start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]),
        }));
        // Deletions, import changes, and changes outside a surviving symbol can
        // affect any declaration in the file. Disclose this file-level fallback.
        const symbols = outline.outline.symbols.filter(symbol => symbol.kind !== "file");
        const overlapping = symbols.filter(symbol => ranges.some(range => range.count > 0
            && symbol.span.startLine <= range.start + range.count - 1 && symbol.span.endLine >= range.start));
        const needsFileSeeds = ranges.length === 0 || ranges.some(range => range.count === 0
            || !symbols.some(symbol => symbol.span.startLine <= range.start && symbol.span.endLine >= range.start + range.count - 1));
        if (needsFileSeeds) warnings.add("IMPACT_FILE_LEVEL_SEEDS");
        const selected = needsFileSeeds ? symbols : overlapping;
        if (outline.hasMore) truncated = true;
        for (const symbol of selected) {
            if (seeds.length >= 50) { truncated = true; break; }
            seeds.push({ codebaseRoot: outline.path, symbolId: symbol.symbolId,
                file: symbol.file, language: symbol.language, symbolLabel: symbol.symbolLabel, span: symbol.span });
        }
        if (seeds.length >= 50) {
            if (fileIndex < changedFiles.length - 1) truncated = true;
            break;
        }
    }
    const seedKeys = new Set(seeds.map(symbol => `${symbol.codebaseRoot}\0${symbol.symbolId}`));
    const impacted = new Map<string, ImpactNode>();
    const uncertainCallReferences = new Map<string, {
        seedSymbolId: string;
        sourceSymbolId?: string;
        sourceSymbolLabel?: string;
        file: string;
        startLine: number;
        endLine?: number;
        decision: "ambiguous" | "unresolved";
        resolutionAuthority: import("@zokizuan/satori-core").ResolutionClaim["resolutionAuthority"];
        construct: import("@zokizuan/satori-core").ResolutionCallConstruct;
        providerId: string;
        providerVersion: string;
        calleeText: string;
    }>();
    const unavailableSeeds: Array<{ symbolId: string; reason: string }> = [];
    for (const seed of seeds) {
        const graph = await ports.callers(seed.codebaseRoot, seed);
        if (graph.status !== "ok") {
            unavailableSeeds.push({ symbolId: seed.symbolId, reason: graph.reason ?? graph.status });
            continue;
        }
        for (const warning of graph.warnings ?? []) {
            warnings.add(warning);
            if (warning === "RELATIONSHIP_TRAVERSAL_LIMIT_REACHED" || warning === "RELATIONSHIP_TRAVERSAL_TRUNCATED") truncated = true;
        }
        for (const reference of graph.exactReferences ?? []) {
            if (
                reference.relationship !== "caller"
                || reference.decision === "resolved"
            ) continue;
            const key = [
                seed.symbolId,
                reference.sourceSymbolId ?? "",
                reference.site.file,
                reference.site.startLine,
                reference.decision,
            ].join("\0");
            uncertainCallReferences.set(key, {
                seedSymbolId: seed.symbolId,
                ...(reference.sourceSymbolId ? { sourceSymbolId: reference.sourceSymbolId } : {}),
                ...(reference.sourceSymbolLabel ? { sourceSymbolLabel: reference.sourceSymbolLabel } : {}),
                file: reference.site.file,
                startLine: reference.site.startLine,
                ...(reference.site.endLine !== undefined ? { endLine: reference.site.endLine } : {}),
                decision: reference.decision,
                resolutionAuthority: reference.resolutionAuthority,
                construct: reference.construct,
                providerId: reference.providerId,
                providerVersion: reference.providerVersion,
                calleeText: reference.calleeText,
            });
        }
        const nodesById = new Map(graph.nodes.map((node) => [node.symbolId, node]));
        const incomingByCallee = new Map<string, CallGraphEdgeResult[]>();
        for (const edge of graph.edges) {
            const incoming = incomingByCallee.get(edge.dstSymbolId) ?? [];
            incoming.push(edge);
            incomingByCallee.set(edge.dstSymbolId, incoming);
        }
        for (const incoming of incomingByCallee.values()) {
            incoming.sort((left, right) => (
                compareContractStrings(left.srcSymbolId, right.srcSymbolId)
                || compareContractStrings(left.site.file, right.site.file)
                || left.site.startLine - right.site.startLine
            ));
        }

        const traversalState = new Map<string, {
            distance: number;
            evidenceClass: ImpactEvidenceClass;
        }>([[seed.symbolId, { distance: 0, evidenceClass: "proof_backed" }]]);
        const queue: Array<{
            symbolId: string;
            distance: number;
            path: ImpactPathEdge[];
            evidenceClass: ImpactEvidenceClass;
        }> = [{
            symbolId: seed.symbolId,
            distance: 0,
            path: [],
            evidenceClass: "proof_backed",
        }];
        while (queue.length > 0) {
            const current = queue.shift()!;
            const bestTraversal = traversalState.get(current.symbolId);
            if (
                !bestTraversal
                || current.distance !== bestTraversal.distance
                || current.evidenceClass !== bestTraversal.evidenceClass
            ) continue;
            if (current.distance >= input.depth) continue;
            for (const edge of incomingByCallee.get(current.symbolId) ?? []) {
                const callerId = edge.srcSymbolId;
                const distance = current.distance + 1;
                const pathEdge: ImpactPathEdge = {
                    callerSymbolId: callerId,
                    calleeSymbolId: current.symbolId,
                    site: edge.site,
                    strategy: edge.strategy ?? (
                        edge.resolutionAuthority === "direct_binding"
                        || edge.resolutionAuthority === "origin_flow"
                            ? "rule"
                            : "heuristic"
                    ),
                    confidence: edge.confidence,
                    ...(edge.resolutionAuthority
                        ? { resolutionAuthority: edge.resolutionAuthority }
                        : {}),
                };
                const causalPath = [...current.path, pathEdge];
                const evidenceClass: ImpactEvidenceClass = (
                    current.evidenceClass === "proof_backed"
                    && isProofBackedImpactEdge(pathEdge)
                ) ? "proof_backed" : "heuristic";
                const existingTraversal = traversalState.get(callerId);
                const shouldAdvanceTraversal = !existingTraversal
                    || distance < existingTraversal.distance
                    || (
                        distance === existingTraversal.distance
                        && evidenceClass === "proof_backed"
                        && existingTraversal.evidenceClass === "heuristic"
                    );
                if (shouldAdvanceTraversal) {
                    traversalState.set(callerId, { distance, evidenceClass });
                    queue.push({ symbolId: callerId, distance, path: causalPath, evidenceClass });
                }

                const caller = nodesById.get(callerId);
                if (!caller) continue;
                const key = `${seed.codebaseRoot}\0${caller.symbolId}`;
                if (seedKeys.has(key)) continue;
                const candidate: ImpactNode = {
                    ...caller,
                    codebaseRoot: seed.codebaseRoot,
                    impactClass: distance === 1 ? "direct" : "transitive",
                    evidenceClass,
                    distance,
                    seedSymbolId: seed.symbolId,
                    causalPath,
                };
                const existing = impacted.get(key);
                if (existing) {
                    const candidateHasShorterPath = candidate.distance < existing.distance;
                    const sameDistance = candidate.distance === existing.distance;
                    const candidateHasStrongerEvidence = sameDistance
                        && candidate.evidenceClass === "proof_backed"
                        && existing.evidenceClass !== "proof_backed";
                    const sameDistanceAndEvidence = sameDistance
                        && candidate.evidenceClass === existing.evidenceClass;
                    if (
                        candidateHasShorterPath
                        || candidateHasStrongerEvidence
                        || (
                            sameDistanceAndEvidence
                            && compareContractStrings(candidate.seedSymbolId, existing.seedSymbolId) < 0
                        )
                    ) {
                        impacted.set(key, candidate);
                    }
                    continue;
                }
                if (impacted.size >= input.limit) {
                    truncated = true;
                    continue;
                }
                impacted.set(key, candidate);
            }
        }
    }
    if (uncertainCallReferences.size > 0) warnings.add("IMPACT_NON_AUTHORITATIVE_CALL_REFERENCES");
    if ([...impacted.values()].some((node) => node.evidenceClass === "heuristic")) {
        warnings.add("IMPACT_HEURISTIC_CALL_PATHS");
    }
    if (truncated) warnings.add("IMPACT_LIMIT_REACHED");

    const impactedValues = [...impacted.values()].sort((a, b) =>
        a.distance - b.distance
        || compareContractStrings(a.file, b.file)
        || a.span.startLine - b.span.startLine
        || compareContractStrings(a.symbolId, b.symbolId));
    const uncertainValues = [...uncertainCallReferences.values()].sort((a, b) =>
        compareContractStrings(a.file, b.file)
        || a.startLine - b.startLine
        || compareContractStrings(a.seedSymbolId, b.seedSymbolId)
        || compareContractStrings(a.sourceSymbolId ?? "", b.sourceSymbolId ?? ""));
    const seedValues = seeds.map((seed) => ({
        ...seed,
        impactClass: "seed" as const,
        distance: 0,
    }));

    const areaRows = new Map<string, {
        area: string;
        seedCount: number;
        directCount: number;
        transitiveCount: number;
        proofBackedDirectCount: number;
        proofBackedTransitiveCount: number;
        heuristicDirectCount: number;
        heuristicTransitiveCount: number;
        uncertainReferenceCount: number;
    }>();
    const areaRow = (file: string) => {
        const area = areaForFile(file);
        const existing = areaRows.get(area) ?? {
            area,
            seedCount: 0,
            directCount: 0,
            transitiveCount: 0,
            proofBackedDirectCount: 0,
            proofBackedTransitiveCount: 0,
            heuristicDirectCount: 0,
            heuristicTransitiveCount: 0,
            uncertainReferenceCount: 0,
        };
        areaRows.set(area, existing);
        return existing;
    };
    for (const seed of seedValues) areaRow(seed.file).seedCount += 1;
    for (const node of impactedValues) {
        const row = areaRow(node.file);
        if (node.impactClass === "direct") {
            row.directCount += 1;
            if (node.evidenceClass === "proof_backed") row.proofBackedDirectCount += 1;
            else row.heuristicDirectCount += 1;
        } else {
            row.transitiveCount += 1;
            if (node.evidenceClass === "proof_backed") row.proofBackedTransitiveCount += 1;
            else row.heuristicTransitiveCount += 1;
        }
    }
    for (const reference of uncertainValues) areaRow(reference.file).uncertainReferenceCount += 1;

    const completenessReasons = new Set<string>(["depth_bound"]);
    if (truncated) completenessReasons.add("limit");
    if (unavailableFiles.length > 0 || unavailableSeeds.length > 0) {
        completenessReasons.add("unavailable_navigation");
    }
    if (uncertainValues.length > 0) completenessReasons.add("uncertain_references");
    const heuristicImpactCount = impactedValues.filter((node) => node.evidenceClass === "heuristic").length;
    if (heuristicImpactCount > 0) completenessReasons.add("heuristic_relationship_paths");
    if ([...warnings].some((warning) => warning.includes("SOURCE_REFERENCE_COVERAGE_PARTIAL"))) {
        completenessReasons.add("source_reference_coverage_partial");
    }

    return {
        status: "ok" as const, path: input.path, baseRef: input.baseRef, baseCommit,
        comparison: "base_to_tracked_worktree" as const,
        depth: input.depth, limit: input.limit, coverage: "partial" as const, truncated,
        completeness: {
            exhaustive: false,
            reasons: [...completenessReasons].sort(),
            changedFileLimit: 50,
            seedLimit: 50,
            traversalDepth: input.depth,
            impactedLimit: input.limit,
            unavailableFileCount: unavailableFiles.length,
            unavailableSeedCount: unavailableSeeds.length,
            uncertainReferenceCount: uncertainValues.length,
            heuristicImpactCount,
        },
        changedFiles,
        seeds: seedValues,
        impacted: impactedValues,
        areaImpact: [...areaRows.values()].sort((a, b) => (
            (b.seedCount + b.directCount + b.transitiveCount) - (a.seedCount + a.directCount + a.transitiveCount)
            || compareContractStrings(a.area, b.area)
        )),
        uncertainCallReferences: uncertainValues,
        unavailableFiles, unavailableSeeds, warnings: [...warnings].sort(),
    };
}
