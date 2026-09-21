import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareContractStrings } from "@zokizuan/satori-core";
import type { CallGraphResponseEnvelope, FileOutlineResponseEnvelope, CallGraphNodeResult } from "./search-types.js";

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
    const impacted = new Map<string, CallGraphNodeResult & { codebaseRoot: string }>();
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
        for (const node of graph.nodes) {
            const key = `${seed.codebaseRoot}\0${node.symbolId}`;
            if (seedKeys.has(key) || impacted.has(key)) continue;
            if (impacted.size >= input.limit) { truncated = true; break; }
            impacted.set(key, { ...node, codebaseRoot: seed.codebaseRoot });
        }
    }
    if (uncertainCallReferences.size > 0) warnings.add("IMPACT_NON_AUTHORITATIVE_CALL_REFERENCES");
    if (truncated) warnings.add("IMPACT_LIMIT_REACHED");
    return {
        status: "ok" as const, path: input.path, baseRef: input.baseRef, baseCommit,
        comparison: "base_to_tracked_worktree" as const,
        depth: input.depth, limit: input.limit, coverage: "partial" as const, truncated,
        changedFiles, seeds, impacted: [...impacted.values()].sort((a, b) =>
            compareContractStrings(a.file, b.file) || a.span.startLine - b.span.startLine || compareContractStrings(a.symbolId, b.symbolId)),
        uncertainCallReferences: [...uncertainCallReferences.values()].sort((a, b) =>
            compareContractStrings(a.file, b.file)
            || a.startLine - b.startLine
            || compareContractStrings(a.seedSymbolId, b.seedSymbolId)
            || compareContractStrings(a.sourceSymbolId ?? "", b.sourceSymbolId ?? "")),
        unavailableFiles, unavailableSeeds, warnings: [...warnings].sort(),
    };
}
