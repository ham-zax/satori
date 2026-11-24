#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS_FILE = path.join(SCRIPT_DIR, "evaluator-tasks.json");

export const SUPPORTED_ARMS = Object.freeze(["native", "satori", "hybrid"]);

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePosixPath(value) {
    return path.posix.normalize(String(value).replace(/\\/g, "/"));
}

function canonicalRootPath(repoRoot) {
    if (typeof repoRoot !== "string" || repoRoot.trim().length === 0) {
        throw new Error("ergonomics_scorer_invalid_repo_root");
    }
    const normalized = normalizePosixPath(repoRoot.trim());
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function normalizeRelativeRepoPath(value) {
    return normalizePosixPath(String(value).trim()).replace(/^\.\//, "").replace(/^\/+/, "");
}

function resolveCandidateInsideRoot(candidatePath, repoRoot) {
    if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
        return null;
    }
    const raw = String(candidatePath).trim().replace(/\\/g, "/");
    if (path.posix.isAbsolute(raw)) {
        const normalized = normalizePosixPath(raw);
        if (normalized === repoRoot) {
            return { inside: true, isRoot: true, relativePath: "" };
        }
        if (normalized.startsWith(`${repoRoot}/`)) {
            return {
                inside: true,
                isRoot: false,
                relativePath: normalized.slice(repoRoot.length + 1),
            };
        }
        return { inside: false, isRoot: false, relativePath: null };
    }
    const combined = normalizePosixPath(`${repoRoot}/${raw}`);
    if (combined === repoRoot) {
        return { inside: true, isRoot: true, relativePath: "" };
    }
    if (combined.startsWith(`${repoRoot}/`)) {
        return {
            inside: true,
            isRoot: false,
            relativePath: combined.slice(repoRoot.length + 1),
        };
    }
    return { inside: false, isRoot: false, relativePath: null };
}

function stableJson(value, seen = new WeakSet()) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJson(entry, seen)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(",")}}`;
}

function canonicalReportedSymbol(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    const segments = trimmed.split(".");
    if (!segments.every((segment) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment))) {
        return null;
    }
    return segments.at(-1);
}

function loadDefaultTasksManifest() {
    try {
        return JSON.parse(fs.readFileSync(DEFAULT_TASKS_FILE, "utf8"));
    } catch {
        return { tasks: [] };
    }
}

const DEFAULT_MANIFEST = loadDefaultTasksManifest();
const DEFAULT_TASKS_BY_ID = new Map(
    (DEFAULT_MANIFEST.tasks ?? []).map((task) => [task.id, task]),
);

const BUILTIN_STATEMENT_PROFILES = Object.freeze({
    "known-exact-target": Object.freeze({
        ownerFile: "packages/mcp/src/core/search-exact-fast-path.ts",
        ownerSymbol: "runExactRegistryFastPath",
        requiredStatements: Object.freeze([
            Object.freeze({
                id: "owner_definition",
                description: "Owning symbol definition runExactRegistryFastPath",
                patterns: Object.freeze(["runExactRegistryFastPath"]),
            }),
            Object.freeze({
                id: "checks_eligibility",
                description: "Eligibility check via isExactRegistryEligible(input, host)",
                patterns: Object.freeze(["isExactRegistryEligible(input, host)"]),
            }),
            Object.freeze({
                id: "requires_navigation_authority",
                description: "Navigation authority guard input.navigationAuthority !== \"valid\"",
                patterns: Object.freeze(['input.navigationAuthority !== "valid"']),
            }),
            Object.freeze({
                id: "exact_match_resolver",
                description: "Exact registry lookup call findExactRegistryMatch(",
                patterns: Object.freeze(["findExactRegistryMatch("]),
            }),
            Object.freeze({
                id: "avoids_semantic_and_rerank",
                description: "Handled exact hit bypasses semantic passes and reranking",
                patterns: Object.freeze([
                    "semanticPassesUsed: []",
                    "rerankApplied: false",
                ]),
            }),
        ]),
    }),
    "unknown-freshness-reuse": Object.freeze({
        ownerFile: "packages/mcp/src/core/search-frontdoor.ts",
        ownerSymbol: "runSearchFrontDoor",
        requiredStatements: Object.freeze([
            Object.freeze({
                id: "owner_definition",
                description: "Owning symbol definition runSearchFrontDoor",
                patterns: Object.freeze(["runSearchFrontDoor"]),
            }),
            Object.freeze({
                id: "serves_previous_generation_during_sync",
                description: "Active-sync branch serving pinned previous generation",
                patterns: Object.freeze([
                    "servePreviousGeneration",
                    "served_previous_generation",
                ]),
            }),
            Object.freeze({
                id: "freshness_blocked_stops_before_second_proof",
                description: "Freshness blocking branch excluding skipped_requires_reindex",
                patterns: Object.freeze([
                    "buildFreshnessBlockedSearchPayload",
                    "skipped_requires_reindex",
                ]),
            }),
            Object.freeze({
                id: "second_readiness_proof_after_freshness",
                description: "Second readiness proof call preparePostFreshnessTrackedRootRead(",
                patterns: Object.freeze(["preparePostFreshnessTrackedRootRead("]),
            }),
            Object.freeze({
                id: "stable_root_identity_guard",
                description: "Tracked root identity guard before proceeding",
                patterns: Object.freeze([
                    "Tracked root identity changed during search freshness validation.",
                ]),
            }),
        ]),
    }),
});

export function buildBuiltinEvidenceProfiles() {
    const profiles = {};
    for (const [taskId, statementProfile] of Object.entries(BUILTIN_STATEMENT_PROFILES)) {
        const manifestTask = DEFAULT_TASKS_BY_ID.get(taskId);
        profiles[taskId] = {
            taskId,
            ownerFile: manifestTask?.expected?.ownerFile ?? statementProfile.ownerFile,
            ownerSymbol: manifestTask?.expected?.ownerSymbol ?? statementProfile.ownerSymbol,
            ownerSpan: manifestTask?.expected?.ownerSpan ?? null,
            requiredStatements: statementProfile.requiredStatements,
            requiredRelations: (manifestTask?.expected?.requiredRelations ?? []).map((relation) => ({
                ...relation,
                targetSymbol: manifestTask?.expected?.ownerSymbol ?? statementProfile.ownerSymbol,
            })),
            taskFacts: manifestTask?.expected?.taskFacts ?? null,
        };
    }
    return profiles;
}

export function resolveEvidenceSpec({ task, evidenceSpec } = {}) {
    if (isRecord(evidenceSpec)) {
        const ownerFile = evidenceSpec.ownerFile ?? task?.expected?.ownerFile;
        const ownerSymbol = evidenceSpec.ownerSymbol ?? task?.expected?.ownerSymbol;
        const rawStatements = Array.isArray(evidenceSpec.requiredStatements)
            ? evidenceSpec.requiredStatements
            : [];
        const requiredStatements = rawStatements.length > 0
            ? rawStatements
            : (ownerSymbol
                ? [{
                    id: "owner_body",
                    description: `Verified body of ${ownerSymbol}`,
                    patterns: [ownerSymbol, "{"],
                    requireNonSignatureBody: true,
                }]
                : []);
        const rawRelations = Array.isArray(evidenceSpec.requiredRelations)
            ? evidenceSpec.requiredRelations
            : (task?.expected?.requiredRelations ?? []);
        return {
            taskId: evidenceSpec.taskId ?? task?.id ?? null,
            ownerFile: ownerFile ? normalizeRelativeRepoPath(ownerFile) : null,
            ownerSymbol: ownerSymbol ?? null,
            ownerSpan: evidenceSpec.ownerSpan ?? task?.expected?.ownerSpan ?? null,
            requiredStatements,
            requiredRelations: rawRelations.map((relation) => ({
                ...relation,
                file: normalizeRelativeRepoPath(relation.file),
                targetSymbol: relation.targetSymbol ?? ownerSymbol ?? null,
            })),
        };
    }

    if (isRecord(task?.evidenceSpec)) {
        return resolveEvidenceSpec({ task, evidenceSpec: task.evidenceSpec });
    }

    const taskId = task?.id ?? null;
    const builtin = taskId ? BUILTIN_STATEMENT_PROFILES[taskId] : null;
    const manifestTask = taskId ? DEFAULT_TASKS_BY_ID.get(taskId) : null;
    const expected = isRecord(task?.expected) ? task.expected : manifestTask?.expected;
    if (!isRecord(expected)) {
        throw new Error("ergonomics_scorer_missing_evidence_spec");
    }

    const ownerFile = normalizeRelativeRepoPath(expected.ownerFile);
    const ownerSymbol = expected.ownerSymbol;
    const matchesBuiltinOwner = Boolean(
        builtin
        && normalizeRelativeRepoPath(builtin.ownerFile) === ownerFile
        && builtin.ownerSymbol === ownerSymbol,
    );

    const requiredStatements = Array.isArray(expected.requiredStatements)
        ? expected.requiredStatements
        : matchesBuiltinOwner
            ? builtin.requiredStatements
            : [{
                id: "owner_body",
                description: `Verified body of ${ownerSymbol}`,
                patterns: [ownerSymbol, "{"],
                requireNonSignatureBody: true,
            }];

    const requiredRelations = (expected.requiredRelations ?? []).map((relation) => ({
        ...relation,
        file: normalizeRelativeRepoPath(relation.file),
        targetSymbol: relation.targetSymbol ?? ownerSymbol ?? null,
    }));

    return {
        taskId,
        ownerFile,
        ownerSymbol,
        ownerSpan: expected.ownerSpan ?? null,
        requiredStatements,
        requiredRelations,
    };
}

function tryParseJson(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function inspectInputScope(input, repoRoot) {
    if (!isRecord(input)) {
        return { outOfRoot: false, explicitSingleFile: null };
    }
    const rootKeys = ["codebaseRoot", "root", "repoRoot"];
    for (const key of rootKeys) {
        if (typeof input[key] === "string" && input[key].trim().length > 0) {
            const resolved = resolveCandidateInsideRoot(input[key], repoRoot);
            if (!resolved || !resolved.inside) {
                return { outOfRoot: true, explicitSingleFile: null };
            }
        }
    }

    if (typeof input.filePath === "string" && input.filePath.trim().length > 0) {
        const resolved = resolveCandidateInsideRoot(input.filePath, repoRoot);
        if (!resolved || !resolved.inside) {
            return { outOfRoot: true, explicitSingleFile: null };
        }
        return {
            outOfRoot: false,
            explicitSingleFile: resolved.isRoot ? null : resolved.relativePath,
        };
    }

    if (typeof input.path === "string" && input.path.trim().length > 0) {
        const resolved = resolveCandidateInsideRoot(input.path, repoRoot);
        if (!resolved || !resolved.inside) {
            return { outOfRoot: true, explicitSingleFile: null };
        }
        const isFilePathInput = !resolved.isRoot && /\.[A-Za-z0-9]+$/.test(resolved.relativePath);
        return {
            outOfRoot: false,
            explicitSingleFile: isFilePathInput ? resolved.relativePath : null,
        };
    }

    if (typeof input.file === "string" && input.file.trim().length > 0) {
        const resolved = resolveCandidateInsideRoot(input.file, repoRoot);
        if (!resolved || !resolved.inside) {
            return { outOfRoot: true, explicitSingleFile: null };
        }
        return {
            outOfRoot: false,
            explicitSingleFile: resolved.isRoot ? null : resolved.relativePath,
        };
    }

    if (isRecord(input.symbolRef) && typeof input.symbolRef.file === "string") {
        const resolved = resolveCandidateInsideRoot(input.symbolRef.file, repoRoot);
        if (!resolved || !resolved.inside) {
            return { outOfRoot: true, explicitSingleFile: null };
        }
    }

    return { outOfRoot: false, explicitSingleFile: null };
}

function isFileOutlinePayload(toolName, parsedJson) {
    if (typeof toolName === "string" && /(?:^|_|__)file_outline$/.test(toolName)) return true;
    if (!isRecord(parsedJson)) return false;
    return (
        parsedJson.kind === "file_outline"
        || (Array.isArray(parsedJson.symbols)
            && !Array.isArray(parsedJson.results)
            && !Array.isArray(parsedJson.edges)
            && !Array.isArray(parsedJson.references)
            && typeof parsedJson.code !== "string"
            && typeof parsedJson.content !== "string")
    );
}

function extractSymbolIdentifierFromLabel(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    const direct = canonicalReportedSymbol(trimmed);
    if (direct) return direct;
    const stripped = trimmed
        .replace(/^(?:(?:export|default|declare|abstract|async|public|private|protected|static|readonly)\s+)*/i, "")
        .replace(/^(?:function|method|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|constructor)\s+/i, "")
        .replace(/[<(].*$/, "")
        .trim();
    return canonicalReportedSymbol(stripped);
}

function extractFileAttributedText(ctx, relativeFile, repoRoot) {
    const { parsedJson, rawOutput, scope } = ctx;
    const matchesFile = (file) => resolveCandidateInsideRoot(file, repoRoot)?.relativePath === relativeFile;
    if (parsedJson !== null) {
        if (!isRecord(parsedJson) || !ctx.rooted) return "";
        const sections = [];
        for (const result of Array.isArray(parsedJson.results) ? parsedJson.results : []) {
            const file = result?.target?.file ?? result?.file ?? result?.relativePath;
            if (matchesFile(file)) sections.push(result.preview ?? result.content);
        }
        const hydrated = parsedJson.hydratedExactSource;
        if (matchesFile(hydrated?.file) && hydrated.sourceAuthority === "publication_hash_matched") {
            sections.push(hydrated.content);
        }
        const responseFile = parsedJson.symbol?.file ?? parsedJson.file ?? parsedJson.path ?? scope.explicitSingleFile;
        if (matchesFile(responseFile)) {
            sections.push(parsedJson.code, parsedJson.content);
            const excerpts = parsedJson.source?.excerpts;
            for (const excerpt of Array.isArray(excerpts) ? excerpts : []) sections.push(excerpt?.content);
        }
        return sections.filter((text) => typeof text === "string").join("\n");
    }

    // Native grep and line-numbered read outputs establish an explicit file
    // frame. A new header closes the previous frame, even for another root.
    const lines = [];
    let active = ctx.rooted && scope.explicitSingleFile === relativeFile && /(?:^|_)read(?:_file)?$/.test(ctx.tool);
    let numbered = false;
    for (const line of rawOutput.split(/\r\n|\n|\r/)) {
        const pathTag = /^<path>(.+)<\/path>$/.exec(line);
        const satoriHeader = /^# (.+?):\d+-\d+(?:\s*\||$)/.exec(line);
        const fileHeader = /^(?:===\s+|---\s+|\*\*\*\s+)?([^\s:]+\.[\w]+):(?:(\d+):(.*))?$/.exec(line);
        if (pathTag || satoriHeader || fileHeader) {
            const file = (pathTag ?? satoriHeader ?? fileHeader)[1];
            active = (ctx.rooted || path.posix.isAbsolute(file)) && matchesFile(file);
            numbered = Boolean(satoriHeader);
            if (active && fileHeader?.[3]) lines.push(fileHeader[3]);
        } else if (active && (!numbered || /^\d+\| /.test(line))) {
            lines.push(line.replace(/^\s*(?:Line \d+:|\d+(?:\||:))\s?/, ""));
        }
    }
    return lines.join("\n");
}

function hasNonSignatureBody(text, symbolName) {
    if (!symbolName) return false;
    const escaped = escapeRegex(symbolName);
    const sigMatch = text.match(new RegExp(`\\b${escaped}\\s*\\(`));
    if (!sigMatch || sigMatch.index === undefined) return false;
    const afterSig = text.slice(sigMatch.index);
    let depth = 1;
    let parameterEnd = afterSig.indexOf("(");
    while (depth > 0 && ++parameterEnd < afterSig.length) {
        if (afterSig[parameterEnd] === "(") depth += 1;
        if (afterSig[parameterEnd] === ")") depth -= 1;
    }
    if (depth > 0) return false;
    const openBrace = afterSig.indexOf("{", parameterEnd + 1);
    const terminator = afterSig.indexOf(";", parameterEnd + 1);
    if (openBrace === -1 || (terminator !== -1 && terminator < openBrace)) return false;
    const body = afterSig.slice(openBrace + 1).trim();
    const meaningfulLines = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "}");
    return meaningfulLines.length >= 2;
}

function matchesPattern(text, pattern) {
    if (pattern instanceof RegExp) {
        return pattern.test(text);
    }
    if (typeof pattern === "string") {
        return text.includes(pattern);
    }
    return false;
}

function evaluateCallContext(toolCall, repoRoot, fixtureRevision) {
    const rawOutput = typeof toolCall.output === "string" ? toolCall.output : "";
    const parsedJson = tryParseJson(rawOutput);
    const scope = inspectInputScope(toolCall.input, repoRoot);
    const responseScope = inspectInputScope(parsedJson, repoRoot);
    const responseRevision = parsedJson?.fixtureRevision ?? parsedJson?.gitRevision;
    const declaredRoot = parsedJson?.codebaseRoot ?? parsedJson?.repoRoot ?? parsedJson?.root;
    const input = toolCall.input;
    const rooted = [input?.codebaseRoot, input?.repoRoot, input?.root, input?.path, input?.filePath,
        input?.file, declaredRoot, parsedJson?.path].some((candidate) => typeof candidate === "string"
        && path.posix.isAbsolute(candidate) && resolveCandidateInsideRoot(candidate, repoRoot)?.inside);
    return {
        rawOutput,
        parsedJson,
        scope,
        input: toolCall.input,
        rooted,
        tool: toolCall.tool ?? "",
        outlineOnly: isFileOutlinePayload(toolCall.tool, parsedJson),
        eligible: !scope.outOfRoot && !responseScope.outOfRoot
            && (declaredRoot === undefined || resolveCandidateInsideRoot(declaredRoot, repoRoot)?.isRoot === true)
            && (responseRevision === undefined || responseRevision === fixtureRevision)
            && (toolCall.status == null || toolCall.status === "completed")
            && (parsedJson?.status == null || ["ok", "success"].includes(parsedJson.status)),
    };
}

function updateStatementProgress(ctx, statement, defaultFile, repoRoot, progressState) {
    if (!ctx.eligible || ctx.outlineOnly) return false;
    const targetFile = statement.file
        ? normalizeRelativeRepoPath(statement.file)
        : defaultFile;
    if (!targetFile) return false;

    if (ctx.scope.explicitSingleFile !== null && ctx.scope.explicitSingleFile !== targetFile) {
        return false;
    }

    const attributedText = extractFileAttributedText(ctx, targetFile, repoRoot);
    if (!attributedText) return false;

    const patterns = Array.isArray(statement.patterns) ? statement.patterns : [];
    const anyOf = Array.isArray(statement.anyOf) ? statement.anyOf : [];
    for (let i = 0; i < patterns.length; i += 1) {
        if (!progressState.matchedPatterns.has(i) && matchesPattern(attributedText, patterns[i])) {
            progressState.matchedPatterns.add(i);
        }
    }
    if (anyOf.length > 0 && !progressState.matchedAnyOf && anyOf.some((pattern) => matchesPattern(attributedText, pattern))) {
        progressState.matchedAnyOf = true;
    }
    if (statement.requireNonSignatureBody && !progressState.nonSignatureBodySeen) {
        const symbol = statement.symbol ?? patterns.find((entry) => typeof entry === "string");
        if (!ctx.outlineOnly && hasNonSignatureBody(attributedText, symbol)) {
            progressState.nonSignatureBodySeen = true;
        }
    }

    if (patterns.length > 0 && progressState.matchedPatterns.size < patterns.length) {
        return false;
    }
    if (anyOf.length > 0 && !progressState.matchedAnyOf) {
        return false;
    }
    if (statement.requireNonSignatureBody && !progressState.nonSignatureBodySeen) {
        return false;
    }
    return true;
}

function structuredGraphWitnessesRelation(ctx, relation, repoRoot, ownerFile, ownerSiteSeen) {
    const response = ctx.parsedJson;
    if (!isRecord(response) || !ctx.rooted || !ownerFile || !relation.targetSymbol) return false;
    const isFile = (file, expected) => resolveCandidateInsideRoot(file, repoRoot)?.relativePath === expected;
    const matches = (node, symbol, file) => isRecord(node)
        && isFile(node.file, file)
        && [node.name, node.symbol, node.symbolLabel, node.label, node.qualifiedName]
            .some((label) => extractSymbolIdentifierFromLabel(label) === symbol);
    const nodes = new Map((Array.isArray(response.nodes) ? response.nodes : [])
        .filter((node) => isRecord(node) && typeof node.symbolId === "string")
        .map((node) => [node.symbolId, node]));
    const hasSite = (edge, file) => edge.siteProvenance !== "symbol_start_fallback"
        && isRecord(edge.site) && isFile(edge.site.file, file)
        && Number.isSafeInteger(edge.site.startLine ?? edge.site.line)
        && (edge.site.startLine ?? edge.site.line) > 0;
    const caller = relation.relation === "caller";
    for (const edge of Array.isArray(response.edges) ? response.edges : []) {
        if (!isRecord(edge) || (edge.kind !== undefined && edge.kind !== "call")) continue;
        const src = nodes.get(edge.srcSymbolId);
        const dst = nodes.get(edge.dstSymbolId);
        if (matches(caller ? src : dst, relation.symbol, relation.file)
            && matches(caller ? dst : src, relation.targetSymbol, ownerFile)
            && hasSite(edge, caller ? relation.file : ownerFile)) return true;
        // Early transcripts used endpoint names and carried the peer file on
        // the edge. A callee-side coordinate needs a separate caller-site witness.
        const target = ctx.input?.symbolRef;
        if (!edge.srcSymbolId && !edge.dstSymbolId
            && matches(target, relation.targetSymbol, ownerFile)
            && isFile(edge.file, relation.file)
            && extractSymbolIdentifierFromLabel(caller ? edge.src : edge.dst) === relation.symbol
            && extractSymbolIdentifierFromLabel(caller ? edge.dst : edge.src) === relation.targetSymbol
            && (hasSite(edge, caller ? relation.file : ownerFile)
                || (!caller && ownerSiteSeen && hasSite(edge, relation.file)))) return true;
    }
    return false;
}

function callSatisfiesRelation(ctx, relation, repoRoot, ownerFile, progress) {
    if (!ctx.eligible || ctx.outlineOnly) return false;
    if (structuredGraphWitnessesRelation(ctx, relation, repoRoot, ownerFile, progress.siteSeen)) return true;
    const peerText = extractFileAttributedText(ctx, relation.file, repoRoot);
    const ownerText = ownerFile === relation.file
        ? peerText
        : extractFileAttributedText(ctx, ownerFile, repoRoot);
    const sawDefinition = (text, name) => new RegExp(
        `\\b(?:function|def|fn|func)\\s+${escapeRegex(name)}\\s*\\(`,
    ).test(text);
    const callTo = (text, name) => new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(text);
    if (relation.relation === "caller") {
        const target = relation.targetSymbol;
        return Boolean(target && sawDefinition(peerText, relation.symbol)
            && callTo(peerText, target) && !sawDefinition(peerText, target));
    }
    if (Array.isArray(relation.sitePatterns) && relation.sitePatterns.length > 0) {
        progress.siteSeen ||= relation.sitePatterns.some((pattern) => matchesPattern(ownerText, pattern));
    } else {
        progress.siteSeen ||= callTo(ownerText, relation.symbol);
    }
    progress.peerSeen ||= ownerFile === relation.file || sawDefinition(peerText, relation.symbol);
    return progress.siteSeen && progress.peerSeen;
}

function normalizeColdStartPhases(coldStartPhases) {
    if (!isRecord(coldStartPhases)) return null;
    const keys = ["launchToToolsMs", "firstSearchMs", "firstPublicationMs"];
    const hasAny = keys.some((key) => Number.isFinite(coldStartPhases[key]));
    if (!hasAny) return null;
    return {
        launchToToolsMs: Number.isFinite(coldStartPhases.launchToToolsMs)
            ? coldStartPhases.launchToToolsMs
            : null,
        firstSearchMs: Number.isFinite(coldStartPhases.firstSearchMs)
            ? coldStartPhases.firstSearchMs
            : null,
        firstPublicationMs: Number.isFinite(coldStartPhases.firstPublicationMs)
            ? coldStartPhases.firstPublicationMs
            : null,
    };
}

export function scoreEvidenceTrajectory({
    tools,
    task,
    repoRoot,
    fixtureRevision = null,
    expectedFixtureRevision = null,
    evidenceSpec = null,
    coldStartPhases = null,
}) {
    const canonicalRepo = canonicalRootPath(repoRoot);
    const spec = resolveEvidenceSpec({ task, evidenceSpec });
    const pinnedRevision = expectedFixtureRevision ?? evidenceSpec?.fixtureRevision ?? task?.fixtureRevision ?? null;
    const fixtureRevisionVerified = pinnedRevision !== null && fixtureRevision === pinnedRevision;
    const revisionMatches = pinnedRevision === null || fixtureRevisionVerified;
    const normalizedTools = Array.isArray(tools) ? tools : [];

    const requirements = [
        ...spec.requiredStatements.map((statement) => ({
            key: `statement:${statement.id}`,
            id: statement.id,
            kind: "statement",
            detail: statement.description ?? statement.id,
            spec: statement,
        })),
        ...spec.requiredRelations.map((relation) => ({
            key: `relation:${relation.relation}:${relation.symbol}`,
            id: `${relation.relation}:${relation.symbol}`,
            kind: "relation",
            detail: `${relation.relation} ${relation.symbol} in ${relation.file}`,
            spec: relation,
        })),
    ];

    const satisfiedByKey = new Map();
    const statementProgressByKey = new Map();
    const relationProgressByKey = new Map();
    const perCallProgress = [];
    let firstSufficientEvidenceCall = null;

    for (let idx = 0; idx < normalizedTools.length; idx += 1) {
        const toolCall = normalizedTools[idx] ?? {};
        const ordinal = Number.isSafeInteger(toolCall.index) && toolCall.index > 0
            ? toolCall.index
            : idx + 1;
        const ctx = evaluateCallContext(toolCall, canonicalRepo, fixtureRevision);
        ctx.eligible &&= revisionMatches;
        const newlySatisfied = [];

        for (const requirement of requirements) {
            if (satisfiedByKey.has(requirement.key)) continue;
            let ok = false;
            if (requirement.kind === "statement") {
                let progressState = statementProgressByKey.get(requirement.key);
                if (!progressState) {
                    progressState = {
                        matchedPatterns: new Set(),
                        matchedAnyOf: false,
                        nonSignatureBodySeen: false,
                    };
                    statementProgressByKey.set(requirement.key, progressState);
                }
                ok = updateStatementProgress(ctx, requirement.spec, spec.ownerFile, canonicalRepo, progressState);
            } else {
                const progress = relationProgressByKey.get(requirement.key) ?? { peerSeen: false, siteSeen: false };
                relationProgressByKey.set(requirement.key, progress);
                ok = callSatisfiesRelation(ctx, requirement.spec, canonicalRepo, spec.ownerFile, progress);
            }
            if (ok) {
                satisfiedByKey.set(requirement.key, {
                    id: requirement.id,
                    kind: requirement.kind,
                    satisfiedAtCall: ordinal,
                    tool: toolCall.tool ?? null,
                    detail: requirement.detail,
                });
                newlySatisfied.push(requirement.key);
            }
        }

        const sufficientNow = requirements.length > 0
            && satisfiedByKey.size === requirements.length;
        if (sufficientNow && firstSufficientEvidenceCall === null) {
            firstSufficientEvidenceCall = ordinal;
        }

        perCallProgress.push({
            index: ordinal,
            tool: toolCall.tool ?? null,
            newlySatisfied,
            cumulativeSatisfied: satisfiedByKey.size,
            totalRequired: requirements.length,
            sufficient: sufficientNow,
        });
    }

    const deliveredRequirements = requirements
        .filter((requirement) => satisfiedByKey.has(requirement.key))
        .map((requirement) => satisfiedByKey.get(requirement.key));
    const missingRequirements = requirements
        .filter((requirement) => !satisfiedByKey.has(requirement.key))
        .map((requirement) => ({
            id: requirement.id,
            kind: requirement.kind,
            detail: requirement.detail,
        }));

    const callsAfterSufficientEvidence = firstSufficientEvidenceCall !== null
        ? Math.max(0, normalizedTools.length - firstSufficientEvidenceCall)
        : null;

    return {
        repoRoot: canonicalRepo,
        fixtureRevision,
        fixtureRevisionVerified,
        taskId: spec.taskId,
        sufficient: firstSufficientEvidenceCall !== null,
        firstSufficientEvidenceCall,
        callsAfterSufficientEvidence,
        totalToolCalls: normalizedTools.length,
        deliveredRequirements,
        missingRequirements,
        perCallProgress,
        coldStartPhases: normalizeColdStartPhases(coldStartPhases),
    };
}

const NON_SCHEMA_FAILURE_PREFIXES = Object.freeze([
    "invalid_result",
    "agent_status:",
    "missing_answer",
    "tool_budget_exceeded",
    "model_visible_tool_result_exceeded_32768_bytes",
    "forbidden_",
    "native_",
    "invalid_satori_first_search",
    "coverage_tool_order_violation",
    "result_parse_error:",
    "model_mismatch:",
    "missing_tool_definitions:",
]);

function isNonSchemaFailureReason(reason) {
    return NON_SCHEMA_FAILURE_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function coercePrimitiveToExpectedShape(actual, expectedValue, pathLabel, coercions) {
    if (typeof expectedValue === "boolean") {
        if (typeof actual === "boolean") return actual;
        if (typeof actual === "string") {
            const normalized = actual.trim().toLowerCase();
            if (normalized === "true") {
                coercions.push(pathLabel);
                return true;
            }
            if (normalized === "false") {
                coercions.push(pathLabel);
                return false;
            }
        }
        return actual;
    }
    if (typeof expectedValue === "number") {
        if (typeof actual === "number") return actual;
        if (typeof actual === "string" && /^-?\d+(?:\.\d+)?$/.test(actual.trim())) {
            coercions.push(pathLabel);
            return Number(actual.trim());
        }
        return actual;
    }
    if (expectedValue === null) {
        if (actual === null) return null;
        if (typeof actual === "string" && actual.trim().toLowerCase() === "null") {
            coercions.push(pathLabel);
            return null;
        }
        return actual;
    }
    return actual;
}

export function classifyAnswerOutcome({ agentResult, expected, strictGrade = null }) {
    const strictPassed = strictGrade ? Boolean(strictGrade.passed) : false;
    const strictFailureReasons = Array.isArray(strictGrade?.failureReasons)
        ? [...strictGrade.failureReasons]
        : [];

    if (strictPassed) {
        return {
            strictPassed: true,
            coercedPassed: true,
            answerSchemaOnlyFailure: false,
            codeFactFailure: false,
            schemaCoercions: [],
            codeFactMismatches: [],
        };
    }

    if (strictFailureReasons.some(isNonSchemaFailureReason)) {
        return {
            strictPassed: false,
            coercedPassed: false,
            answerSchemaOnlyFailure: false,
            codeFactFailure: true,
            schemaCoercions: [],
            codeFactMismatches: strictFailureReasons.filter(isNonSchemaFailureReason),
        };
    }

    if (!isRecord(agentResult) || agentResult.status !== "success" || !isRecord(agentResult.answer) || !isRecord(expected)) {
        return {
            strictPassed: false,
            coercedPassed: false,
            answerSchemaOnlyFailure: false,
            codeFactFailure: true,
            schemaCoercions: [],
            codeFactMismatches: ["invalid_or_unsuccessful_agent_result"],
        };
    }

    const answer = agentResult.answer;
    const schemaCoercions = [];
    const codeFactMismatches = [];

    // 1. ownerFile
    if (typeof answer.ownerFile === "string" && typeof expected.ownerFile === "string") {
        const normalizedActualFile = normalizeRelativeRepoPath(answer.ownerFile);
        const normalizedExpectedFile = normalizeRelativeRepoPath(expected.ownerFile);
        if (normalizedActualFile !== normalizedExpectedFile) {
            codeFactMismatches.push("ownerFile");
        } else if (answer.ownerFile !== expected.ownerFile) {
            schemaCoercions.push("ownerFile");
        }
    } else {
        codeFactMismatches.push("ownerFile");
    }

    // 2. ownerSymbol
    if (canonicalReportedSymbol(answer.ownerSymbol) !== expected.ownerSymbol) {
        codeFactMismatches.push("ownerSymbol");
    }

    // 3. ownerSpan
    if (isRecord(answer.ownerSpan) && isRecord(expected.ownerSpan)) {
        const coercedStart = coercePrimitiveToExpectedShape(
            answer.ownerSpan.startLine,
            expected.ownerSpan.startLine,
            "ownerSpan.startLine",
            schemaCoercions,
        );
        const coercedEnd = coercePrimitiveToExpectedShape(
            answer.ownerSpan.endLine,
            expected.ownerSpan.endLine,
            "ownerSpan.endLine",
            schemaCoercions,
        );
        if (coercedStart !== expected.ownerSpan.startLine || coercedEnd !== expected.ownerSpan.endLine) {
            codeFactMismatches.push("ownerSpan");
        }
    } else if (expected.ownerSpan !== undefined) {
        codeFactMismatches.push("ownerSpan");
    }

    // 4. requiredRelations
    for (const relation of expected.requiredRelations ?? []) {
        const matched = Array.isArray(answer.relatedSymbols)
            && answer.relatedSymbols.some((candidate) => {
                if (!isRecord(candidate)) return false;
                if (canonicalReportedSymbol(candidate.symbol) !== relation.symbol) return false;
                if (candidate.relation !== relation.relation) return false;
                if (typeof candidate.file !== "string") return false;
                const normCandidateFile = normalizeRelativeRepoPath(candidate.file);
                const normRelationFile = normalizeRelativeRepoPath(relation.file);
                if (normCandidateFile !== normRelationFile) return false;
                if (candidate.file !== relation.file) {
                    schemaCoercions.push(`relatedSymbols.${relation.symbol}.file`);
                }
                return true;
            });
        if (!matched) {
            codeFactMismatches.push(`relation:${relation.relation}:${relation.symbol}`);
        }
    }

    // 5. taskFacts
    if (isRecord(expected.taskFacts)) {
        if (!isRecord(answer.taskFacts)) {
            codeFactMismatches.push("taskFacts");
        } else {
            const expectedKeys = Object.keys(expected.taskFacts);
            const actualKeys = Object.keys(answer.taskFacts);
            if (stableJson(expectedKeys.slice().sort()) !== stableJson(actualKeys.slice().sort())) {
                codeFactMismatches.push("taskFacts.keys");
            } else {
                for (const key of expectedKeys) {
                    const coercedValue = coercePrimitiveToExpectedShape(
                        answer.taskFacts[key],
                        expected.taskFacts[key],
                        `taskFacts.${key}`,
                        schemaCoercions,
                    );
                    if (stableJson(coercedValue) !== stableJson(expected.taskFacts[key])) {
                        codeFactMismatches.push(`taskFacts.${key}`);
                    }
                }
            }
        }
    }

    const coercedPassed = codeFactMismatches.length === 0;
    const answerSchemaOnlyFailure = !strictPassed && coercedPassed && schemaCoercions.length > 0;
    const codeFactFailure = !strictPassed && !answerSchemaOnlyFailure;

    return {
        strictPassed: false,
        coercedPassed,
        answerSchemaOnlyFailure,
        codeFactFailure,
        schemaCoercions: [...new Set(schemaCoercions)],
        codeFactMismatches: [...new Set(codeFactMismatches)],
    };
}

function median(values) {
    if (values.length === 0 || !values.every((value) => Number.isFinite(value) && value >= 0)) return null;
    return values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function extractRunMetric(run, field) {
    if (!isRecord(run)) return null;
    if (field === "strictPassed") {
        if (typeof run.strictPassed === "boolean") return run.strictPassed;
        if (typeof run.grade?.passed === "boolean") return run.grade.passed;
        return run.outcome?.strictPassed ?? null;
    }
    if (field === "totalInputTokens") {
        return run.totalInputTokens ?? run.measurements?.apiInputTokens ?? null;
    }
    if (field === "wallTimeMs") {
        return run.wallTimeMs ?? run.measurements?.taskWallTimeMs ?? null;
    }
    if (field === "firstSufficientEvidenceCall") {
        if (run.trajectory && run.trajectory.fixtureRevisionVerified !== true) return null;
        return run.firstSufficientEvidenceCall
            ?? run.trajectory?.firstSufficientEvidenceCall
            ?? run.ergonomics?.firstSufficientEvidenceCall
            ?? null;
    }
    if (field === "visibleToolBytes") {
        return run.visibleToolBytes ?? run.measurements?.visibleToolResultBytes ?? null;
    }
    return null;
}

function summarizeArmRuns(runs) {
    const list = Array.isArray(runs) ? runs : [];
    const passedCount = list.filter((run) => extractRunMetric(run, "strictPassed") === true).length;
    return {
        count: list.length,
        strictObserved: list.every((run) => typeof extractRunMetric(run, "strictPassed") === "boolean"),
        strictPassRate: list.length > 0 ? passedCount / list.length : 0,
        totalInputTokens: median(list.map((run) => extractRunMetric(run, "totalInputTokens"))),
        wallTimeMs: median(list.map((run) => extractRunMetric(run, "wallTimeMs"))),
        firstSufficientEvidenceCall: median(
            list.map((run) => extractRunMetric(run, "firstSufficientEvidenceCall")),
        ),
        visibleToolBytes: median(list.map((run) => extractRunMetric(run, "visibleToolBytes"))),
    };
}

export function evaluateErgonomicsGate({
    controlRuns,
    treatmentRuns,
    armPolicy = {},
}) {
    const arm = armPolicy.arm ?? treatmentRuns?.[0]?.arm ?? "satori";
    if (!SUPPORTED_ARMS.includes(arm)) {
        throw new Error(`ergonomics_gate_unsupported_arm:${arm}`);
    }
    const scriptedFirstCall = Boolean(armPolicy.scriptedFirstCall ?? false);
    const requireUnscriptedFirstCall = Boolean(armPolicy.requireUnscriptedFirstCall ?? false);

    const thresholds = {
        minStrictPassRateDelta: armPolicy.minStrictPassRateDelta ?? 0,
        minStrictPassRate: armPolicy.minStrictPassRate ?? null,
        maxInputTokensRatio: armPolicy.maxInputTokensRatio ?? 1.10,
        maxWallTimeRatio: armPolicy.maxWallTimeRatio ?? 1.10,
        maxFirstSufficientEvidenceCallRatio: armPolicy.maxFirstSufficientEvidenceCallRatio ?? 1.0,
        requireSufficientEvidenceImprovement: Boolean(
            armPolicy.requireSufficientEvidenceImprovement ?? false,
        ),
        maxVisibleToolBytesRatio: armPolicy.maxVisibleToolBytesRatio ?? 1.15,
    };

    const control = summarizeArmRuns(controlRuns);
    const treatment = summarizeArmRuns(treatmentRuns);
    const failureReasons = [];

    if (control.count === 0) failureReasons.push("empty_control_runs");
    if (treatment.count === 0) failureReasons.push("empty_treatment_runs");
    if (requireUnscriptedFirstCall && scriptedFirstCall) {
        failureReasons.push("scripted_first_call_disallowed");
    }

    const strictPassRateDelta = treatment.strictPassRate - control.strictPassRate;
    const strictPassRateOk = control.strictObserved && treatment.strictObserved
        && strictPassRateDelta >= thresholds.minStrictPassRateDelta
        && (thresholds.minStrictPassRate === null
            || treatment.strictPassRate >= thresholds.minStrictPassRate);
    if (!strictPassRateOk) {
        failureReasons.push("strict_pass_rate_regression");
    }

    const ratio = (treatVal, ctrlVal) => (
        Number.isFinite(treatVal) && Number.isFinite(ctrlVal) && ctrlVal > 0
            ? treatVal / ctrlVal
            : null
    );

    const totalInputTokensRatio = ratio(treatment.totalInputTokens, control.totalInputTokens);
    const totalInputTokensOk = totalInputTokensRatio !== null
        && totalInputTokensRatio <= thresholds.maxInputTokensRatio;
    if (!totalInputTokensOk) {
        failureReasons.push(totalInputTokensRatio === null ? "input_tokens_unobserved" : "input_tokens_regression");
    }

    const wallTimeMsRatio = ratio(treatment.wallTimeMs, control.wallTimeMs);
    const wallTimeMsOk = wallTimeMsRatio !== null && wallTimeMsRatio <= thresholds.maxWallTimeRatio;
    if (!wallTimeMsOk) {
        failureReasons.push(wallTimeMsRatio === null ? "wall_time_unobserved" : "wall_time_regression");
    }

    const firstSufficientEvidenceCallRatio = ratio(
        treatment.firstSufficientEvidenceCall,
        control.firstSufficientEvidenceCall,
    );
    const firstSufficientEvidenceCallOk = (
        firstSufficientEvidenceCallRatio !== null
        && (
            firstSufficientEvidenceCallRatio <= thresholds.maxFirstSufficientEvidenceCallRatio
            && (!thresholds.requireSufficientEvidenceImprovement
                || firstSufficientEvidenceCallRatio < 1.0)
        )
    );
    if (!firstSufficientEvidenceCallOk) {
        failureReasons.push(firstSufficientEvidenceCallRatio === null ? "sufficient_evidence_unobserved" : "sufficient_evidence_calls_regression");
    }

    const visibleToolBytesRatio = ratio(treatment.visibleToolBytes, control.visibleToolBytes);
    const visibleToolBytesOk = visibleToolBytesRatio !== null && visibleToolBytesRatio <= thresholds.maxVisibleToolBytesRatio;
    if (!visibleToolBytesOk) {
        failureReasons.push(visibleToolBytesRatio === null ? "visible_tool_bytes_unobserved" : "visible_tool_bytes_regression");
    }

    return {
        passed: failureReasons.length === 0,
        arm,
        scriptedFirstCall,
        thresholds,
        control,
        treatment,
        ratios: {
            strictPassRateDelta,
            totalInputTokensRatio,
            wallTimeMsRatio,
            firstSufficientEvidenceCallRatio,
            visibleToolBytesRatio,
        },
        checks: {
            strictPassRate: strictPassRateOk,
            totalInputTokens: totalInputTokensOk,
            wallTimeMs: wallTimeMsOk,
            firstSufficientEvidenceCall: firstSufficientEvidenceCallOk,
            visibleToolBytes: visibleToolBytesOk,
        },
        failureReasons,
    };
}

export function replayResultRecord({ result, task, repoRoot, evidenceSpec = null, fixture, hostEvents = [] }) {
    if (!isRecord(result)) {
        throw new Error("ergonomics_scorer_invalid_result_record");
    }
    const resolvedTask = task ?? DEFAULT_TASKS_BY_ID.get(result.taskId);
    if (!resolvedTask && !evidenceSpec) {
        throw new Error(`ergonomics_scorer_unknown_task:${result.taskId}`);
    }
    const resolvedRepoRoot = repoRoot
        ?? result.environment?.repoRoot
        ?? fixture?.repoRoot;
    for (const recordedRoot of [result.environment?.repoRoot, fixture?.repoRoot]) {
        if (recordedRoot !== undefined && canonicalRootPath(recordedRoot) !== canonicalRootPath(resolvedRepoRoot)) {
            throw new Error("ergonomics_scorer_fixture_root_mismatch");
        }
    }
    const hostCalls = hostEvents.filter((event) => event?.type === "tool_use"
        && event.sessionID === result.harness?.sessionId && typeof event.part?.tool === "string");
    const tools = Array.isArray(result.tools)
        ? result.tools
        : Array.isArray(result.harness?.toolCalls)
            ? result.harness.toolCalls.map((call, idx) => ({
                index: idx + 1,
                tool: call.operation ?? call.tool,
                status: call.status,
                input: call.input ?? null,
                output: typeof call.output === "string" ? call.output : matchingHostOutput(call, hostCalls[idx]),
                visibleBytes: call.visibleResultBytes ?? call.visibleBytes ?? null,
            }))
            : [];

    const trajectory = scoreEvidenceTrajectory({
        tools,
        task: resolvedTask,
        repoRoot: resolvedRepoRoot,
        fixtureRevision: result.environment?.gitRevision ?? null,
        expectedFixtureRevision: fixture?.gitRevision ?? null,
        evidenceSpec,
        coldStartPhases: result.measurements?.coldStartPhases ?? null,
    });
    const outcome = classifyAnswerOutcome({
        agentResult: result.agentResult,
        expected: resolvedTask?.expected ?? evidenceSpec,
        strictGrade: result.grade ?? null,
    });

    return {
        runId: result.runId ?? null,
        taskId: result.taskId ?? resolvedTask?.id ?? null,
        arm: result.arm ?? null,
        strictPassed: outcome.strictPassed,
        totalInputTokens: extractRunMetric(result, "totalInputTokens"),
        wallTimeMs: extractRunMetric(result, "wallTimeMs"),
        visibleToolBytes: extractRunMetric(result, "visibleToolBytes"),
        firstSufficientEvidenceCall: trajectory.firstSufficientEvidenceCall,
        trajectory,
        outcome,
    };
}

function matchingHostOutput(call, event) {
    const part = event?.part;
    const output = part?.state?.output;
    if (part?.tool !== (call.operation ?? call.tool)
        || stableJson(part?.state?.input) !== stableJson(call.input)
        || typeof output !== "string"
        || Buffer.byteLength(output, "utf8") !== call.visibleResultBytes) return "";
    return output;
}

function main(argv) {
    const fileArgIndex = argv.indexOf("--result");
    if (fileArgIndex === -1 || !argv[fileArgIndex + 1]) {
        process.stderr.write("Usage: node ergonomics-scorer.mjs --result <path-to-result.json> [--repo <repoRoot>]\n");
        process.exitCode = 1;
        return;
    }
    const resultPath = path.resolve(argv[fileArgIndex + 1]);
    const repoArgIndex = argv.indexOf("--repo");
    const repoRoot = repoArgIndex !== -1 ? argv[repoArgIndex + 1] : undefined;
    const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const manifestPath = path.join(path.dirname(resultPath), "run-manifest.json");
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
    const eventsPath = resultPath.replace(/\.result\.json$/, ".opencode-events.jsonl");
    const hostEvents = eventsPath !== resultPath && fs.existsSync(eventsPath)
        ? fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse)
        : [];
    const summary = replayResultRecord({
        result: parsed,
        repoRoot,
        task: manifest?.taskManifest?.tasks?.find((item) => item.id === parsed.taskId),
        fixture: manifest ? { repoRoot: manifest.repoRoot, gitRevision: manifest.repositoryIdentity?.gitRevision } : undefined,
        hostEvents,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2));
}
