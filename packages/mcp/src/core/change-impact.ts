import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { compareContractStrings } from "@satori-code/core";
import type {
    CallGraphEdgeResult,
    CallGraphResponseEnvelope,
    FileOutlineResponseEnvelope,
    CallGraphNodeResult,
} from "./search-types.js";
import { areaForFile } from "./architecture-overview.js";

const execFileAsync = promisify(execFile);

/** Maximum serialized detect_changes response size (UTF-8 bytes of the MCP JSON payload). */
export const DETECT_CHANGES_RESPONSE_MAX_UTF8_BYTES = 48 * 1024;

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
    // Rename detection reports a moved file once, under its current path, and
    // its per-file diff below runs against the source path, so a pure move
    // produces no hunks and seeds nothing.
    const nameStatus = (await git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z",
        "--find-renames", "--relative", baseCommit, "--", "."])).split("\0").filter(Boolean);
    const renamedFrom = new Map<string, string>();
    const changedFiles: string[] = [];
    for (let index = 0; index < nameStatus.length;) {
        const status = nameStatus[index++]!;
        const file = nameStatus[index++]!;
        if (status.startsWith("R")) {
            const renamedTo = nameStatus[index++]!;
            renamedFrom.set(renamedTo, file);
            changedFiles.push(renamedTo);
        } else {
            changedFiles.push(file);
        }
    }
    changedFiles.sort();
    const seeds: Array<CallGraphNodeResult & { codebaseRoot: string }> = [];
    const seedOmittedFiles: Array<{ file: string; omittedSeedCount: number }> = [];
    const unavailableFiles: Array<{ file: string; reason: string }> = [];
    const warnings = new Set<string>(["IMPACT_GRAPH_ADVISORY", "IMPACT_CURRENT_SYMBOLS_ONLY", "IMPACT_SNAPSHOT_NOT_ATOMIC"]);
    let truncated = changedFiles.length > 50;
    let seedsDroppedByBudget = false;
    const candidatesByFile: Array<{ file: string; candidates: Array<CallGraphNodeResult & { codebaseRoot: string }> }> = [];
    for (const file of changedFiles.slice(0, 50)) {
        const outline = await ports.outline(file);
        if (outline.status !== "ok" || !outline.outline) {
            unavailableFiles.push({ file, reason: outline.reason ?? outline.status });
            continue;
        }
        const source = renamedFrom.get(file);
        const diff = await git(["diff", "--no-ext-diff", "--no-textconv", source ? "--find-renames" : "--no-renames",
            "--relative", "--unified=0", baseCommit, "--", ...(source ? [`:(literal)${source}`] : []), `:(literal)${file}`]);
        const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({
            start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]),
        }));
        // Hunk-precise seeds: every added or changed line seeds the innermost
        // current symbol containing it, so an edit to a class's own lines seeds
        // the class while an edit inside a member seeds only the member. A pure
        // deletion (+count 0) seeds the innermost symbol enclosing both lines
        // around the deletion point; a deletion at a symbol boundary (e.g. a
        // whole removed function) belongs to no current symbol. Hunks that map
        // to no symbol are disclosed; a file whose hunks seed nothing precise
        // falls back to every symbol in the file.
        const symbols = outline.outline.symbols.filter(symbol => symbol.kind !== "file");
        type OutlineSymbol = (typeof symbols)[number];
        const precise: OutlineSymbol[] = [];
        const preciseIds = new Set<string>();
        const addPrecise = (symbol: OutlineSymbol) => {
            if (preciseIds.has(symbol.symbolId)) return;
            preciseIds.add(symbol.symbolId);
            precise.push(symbol);
        };
        const innermostContaining = (first: number, last: number): OutlineSymbol | undefined => {
            const containing = symbols.filter(symbol => symbol.span.startLine <= first && symbol.span.endLine >= last);
            containing.sort((left, right) =>
                ((left.span.endLine - left.span.startLine) - (right.span.endLine - right.span.startLine))
                || (right.span.startLine - left.span.startLine)
                || compareContractStrings(left.symbolId, right.symbolId));
            return containing[0];
        };
        // Outline spans start at the declaration, so a changed doc comment,
        // decorator, attribute or blank line before a member would otherwise
        // seed the whole enclosing class. Such leading trivia belongs to the
        // declaration it precedes when that declaration starts right after it.
        const sourceLines = ranges.some(range => range.count > 0)
            ? (await readFile(path.join(input.path, file), "utf8").catch(() => "")).split(/\r?\n/)
            : [];
        const isLeadingTrivia = (line: number) => {
            const text = sourceLines[line - 1]?.trim();
            return text !== undefined && (text === "" || /^(\/\/|\/\*|\*|#(?![\w$])|@)/.test(text));
        };
        const ownerOfLine = (line: number): OutlineSymbol | undefined => {
            const owner = innermostContaining(line, line);
            if (!isLeadingTrivia(line)) return owner;
            let next = line + 1;
            while (next <= sourceLines.length && isLeadingTrivia(next)) next += 1;
            const declared = innermostContaining(next, next);
            return declared && declared.span.startLine === next && declared !== owner
                && (!owner || owner.span.endLine >= declared.span.endLine)
                ? declared
                : owner;
        };
        let unmappedHunk = false;
        for (const range of ranges) {
            if (range.count === 0) {
                const owner = innermostContaining(range.start, range.start + 1);
                if (owner) addPrecise(owner);
                else unmappedHunk = true;
                continue;
            }
            let mapped = false;
            for (let line = range.start; line < range.start + range.count; line += 1) {
                const owner = ownerOfLine(line);
                if (owner) {
                    addPrecise(owner);
                    mapped = true;
                }
            }
            if (!mapped) unmappedHunk = true;
        }
        // A diff without hunks (pure move, mode change) changed no lines to seed.
        const touchesNoSymbol = ranges.length > 0 && precise.length === 0;
        if (unmappedHunk && !touchesNoSymbol) warnings.add("IMPACT_UNMAPPED_HUNKS");
        const bySpanThenId = (left: OutlineSymbol, right: OutlineSymbol) =>
            left.span.startLine - right.span.startLine
            || left.span.endLine - right.span.endLine
            || compareContractStrings(left.symbolId, right.symbolId);
        if (touchesNoSymbol) warnings.add("IMPACT_FILE_LEVEL_SEEDS");
        const fallback = touchesNoSymbol ? symbols.filter(symbol => !preciseIds.has(symbol.symbolId)) : [];
        if (outline.hasMore) truncated = true;
        candidatesByFile.push({ file, candidates: [...[...precise].sort(bySpanThenId), ...fallback.sort(bySpanThenId)]
            .map(symbol => ({ codebaseRoot: outline.path, symbolId: symbol.symbolId,
                file: symbol.file, language: symbol.language, symbolLabel: symbol.symbolLabel, span: symbol.span })) });
    }
    // Fair allocation: deal the 50-seed budget round-robin across files in
    // changedFiles order so one large file cannot starve the other files.
    const allocatedPerFile = candidatesByFile.map(() => 0);
    for (let round = 0; seeds.length < 50; round++) {
        let progressed = false;
        for (const [index, entry] of candidatesByFile.entries()) {
            if (seeds.length >= 50) break;
            const candidate = entry.candidates[round];
            if (!candidate) continue;
            seeds.push(candidate);
            allocatedPerFile[index] = (allocatedPerFile[index] ?? 0) + 1;
            progressed = true;
        }
        if (!progressed) break;
    }
    for (const [index, entry] of candidatesByFile.entries()) {
        const omittedSeedCount = entry.candidates.length - (allocatedPerFile[index] ?? 0);
        if (omittedSeedCount > 0) {
            seedOmittedFiles.push({ file: entry.file, omittedSeedCount });
            seedsDroppedByBudget = true;
        }
    }
    seedOmittedFiles.sort((left, right) => compareContractStrings(left.file, right.file));
    if (seedsDroppedByBudget) truncated = true;
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
        resolutionAuthority: import("@satori-code/core").ResolutionClaim["resolutionAuthority"];
        construct: import("@satori-code/core").ResolutionCallConstruct;
        providerId: string;
        providerVersion: string;
        calleeText: string;
    }>();
    const unavailableSeeds: Array<{ symbolId: string; reason: string }> = [];
    const warningCounts = new Map<string, number>();
    for (const seed of seeds) {
        const graph = await ports.callers(seed.codebaseRoot, seed);
        if (graph.status !== "ok") {
            unavailableSeeds.push({ symbolId: seed.symbolId, reason: graph.reason ?? graph.status });
            continue;
        }
        for (const warning of graph.warnings ?? []) {
            // Per-seed count warnings (CODE:N) are summed per code so the
            // response carries one entry per code, not one per seed.
            const counted = /^([A-Z_]+):(\d+)$/.exec(warning);
            if (counted) {
                warningCounts.set(counted[1]!, (warningCounts.get(counted[1]!) ?? 0) + Number(counted[2]));
                continue;
            }
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
    for (const [code, count] of warningCounts) warnings.add(`${code}:${count}`);
    if (uncertainCallReferences.size > 0) warnings.add("IMPACT_NON_AUTHORITATIVE_CALL_REFERENCES");
    if ([...impacted.values()].some((node) => node.evidenceClass === "heuristic")) {
        warnings.add("IMPACT_HEURISTIC_CALL_PATHS");
    }

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

    // Area counts are computed from the untrimmed data so trimming below
    // never rewrites the disclosed evidence distribution.
    const areaImpact = [...areaRows.values()].sort((a, b) => (
        (b.seedCount + b.directCount + b.transitiveCount) - (a.seedCount + a.directCount + a.transitiveCount)
        || compareContractStrings(a.area, b.area)
    ));
    const heuristicImpactCount = impactedValues.filter((node) => node.evidenceClass === "heuristic").length;

    // Visible prefix lengths for the byte-budgeted lists; the full arrays
    // stay available for areaImpact and completeness counts above.
    let visibleUncertainCount = uncertainValues.length;
    let visibleImpactedCount = impactedValues.length;
    let visibleSeedCount = seedValues.length;
    let visibleChangedFileCount = changedFiles.length;
    const renderPayload = () => {
        const omitted = {
            changedFiles: changedFiles.length - visibleChangedFileCount,
            impacted: impactedValues.length - visibleImpactedCount,
            uncertainCallReferences: uncertainValues.length - visibleUncertainCount,
            seeds: seedValues.length - visibleSeedCount,
        };
        const finalWarnings = new Set(warnings);
        let finalTruncated = truncated;
        if (omitted.impacted > 0 || omitted.uncertainCallReferences > 0 || omitted.seeds > 0 || omitted.changedFiles > 0) {
            finalTruncated = true;
            finalWarnings.add("IMPACT_RESPONSE_BYTE_LIMIT");
        }
        if (finalTruncated) finalWarnings.add("IMPACT_LIMIT_REACHED");
        const completenessReasons = new Set<string>(["depth_bound"]);
        if (finalTruncated) completenessReasons.add("limit");
        if (seedsDroppedByBudget) completenessReasons.add("seed_limit");
        if (unavailableFiles.length > 0 || unavailableSeeds.length > 0) {
            completenessReasons.add("unavailable_navigation");
        }
        if (uncertainValues.length > 0) completenessReasons.add("uncertain_references");
        if (warnings.has("IMPACT_UNMAPPED_HUNKS")) completenessReasons.add("unmapped_hunks");
        if (heuristicImpactCount > 0) completenessReasons.add("heuristic_relationship_paths");
        if ([...finalWarnings].some((warning) => warning.includes("SOURCE_REFERENCE_COVERAGE_PARTIAL"))) {
            completenessReasons.add("source_reference_coverage_partial");
        }
        return {
            status: "ok" as const, path: input.path, baseRef: input.baseRef, baseCommit,
            comparison: "base_to_tracked_worktree" as const,
            depth: input.depth, limit: input.limit, coverage: "partial" as const, truncated: finalTruncated,
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
            changedFiles: changedFiles.slice(0, visibleChangedFileCount),
            seeds: seedValues.slice(0, visibleSeedCount),
            impacted: impactedValues.slice(0, visibleImpactedCount),
            areaImpact,
            uncertainCallReferences: uncertainValues.slice(0, visibleUncertainCount),
            unavailableFiles, unavailableSeeds, warnings: [...finalWarnings].sort(),
            seedOmittedFiles, omitted,
        };
    };
    const responseFits = (candidate: unknown) =>
        Buffer.byteLength(JSON.stringify(candidate), "utf8") <= DETECT_CHANGES_RESPONSE_MAX_UTF8_BYTES;
    if (!responseFits(renderPayload())) {
        // Shrink in order, longest fitting prefix each (binary searched):
        // uncertainCallReferences, impacted, changedFiles (only the first 50 are
        // analysed), then seeds last, since seeds are the answer itself. Every
        // trim is counted in omitted.
        const longestFittingCount = (total: number, fitsCount: (count: number) => boolean): number => {
            let low = 0;
            let high = total;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                if (fitsCount(mid)) low = mid;
                else high = mid - 1;
            }
            return low;
        };
        const fits = () => responseFits(renderPayload());
        const trimStages: Array<{ total: number; set: (count: number) => void }> = [
            { total: uncertainValues.length, set: (count) => { visibleUncertainCount = count; } },
            { total: impactedValues.length, set: (count) => { visibleImpactedCount = count; } },
            { total: changedFiles.length, set: (count) => { visibleChangedFileCount = count; } },
            { total: seedValues.length, set: (count) => { visibleSeedCount = count; } },
        ];
        for (const stage of trimStages) {
            if (fits()) break;
            const count = longestFittingCount(stage.total, (candidate) => {
                stage.set(candidate);
                return fits();
            });
            stage.set(count);
        }
        // Omitted-count digit growth can overshoot the binary search by a few
        // bytes; close any remaining gap one entry at a time, seeds last.
        const counts = () => [visibleUncertainCount, visibleImpactedCount, visibleChangedFileCount, visibleSeedCount];
        while (!fits()) {
            const stageIndex = counts().findIndex((count) => count > 0);
            if (stageIndex < 0) break;
            trimStages[stageIndex].set(counts()[stageIndex] - 1);
        }
    }
    return renderPayload();
}
