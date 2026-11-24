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

function parseTimestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Date.parse(value.trim());
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function isNativeFsTool(toolName) {
    return typeof toolName === "string"
        && !/(?:^|_)satori(?:_|$)|__satori__/.test(toolName)
        && /(?:^|_)(?:read|read_file|grep|find|glob)$/.test(toolName);
}

function resolveInputPath(candidatePath, repoRoot, effectiveCwd = null) {
    if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
        return null;
    }
    const raw = String(candidatePath).trim().replace(/\\/g, "/");
    if (path.posix.isAbsolute(raw)) {
        return resolveCandidateInsideRoot(raw, repoRoot);
    }
    if (effectiveCwd !== null) {
        const cwdResolved = resolveCandidateInsideRoot(effectiveCwd, repoRoot);
        if (!cwdResolved || !cwdResolved.inside) {
            return { inside: false, isRoot: false, relativePath: null };
        }
        const combined = normalizePosixPath(`${canonicalRootPath(effectiveCwd)}/${raw}`);
        return resolveCandidateInsideRoot(combined, repoRoot);
    }
    return resolveCandidateInsideRoot(raw, repoRoot);
}

function inspectInputScope(input, repoRoot, effectiveCwd = null) {
    if (!isRecord(input)) {
        return { outOfRoot: false, explicitSingleFile: null };
    }
    const rootKeys = ["codebaseRoot", "root", "repoRoot"];
    for (const key of rootKeys) {
        if (typeof input[key] === "string" && input[key].trim().length > 0) {
            const resolved = resolveInputPath(input[key], repoRoot, effectiveCwd);
            if (!resolved || !resolved.inside) {
                return { outOfRoot: true, explicitSingleFile: null };
            }
        }
    }

    if (typeof input.filePath === "string" && input.filePath.trim().length > 0) {
        const resolved = resolveInputPath(input.filePath, repoRoot, effectiveCwd);
        if (!resolved || !resolved.inside) {
            return { outOfRoot: true, explicitSingleFile: null };
        }
        return {
            outOfRoot: false,
            explicitSingleFile: resolved.isRoot ? null : resolved.relativePath,
        };
    }

    if (typeof input.path === "string" && input.path.trim().length > 0) {
        const resolved = resolveInputPath(input.path, repoRoot, effectiveCwd);
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
        const resolved = resolveInputPath(input.file, repoRoot, effectiveCwd);
        if (!resolved || !resolved.inside) {
            return { outOfRoot: true, explicitSingleFile: null };
        }
        return {
            outOfRoot: false,
            explicitSingleFile: resolved.isRoot ? null : resolved.relativePath,
        };
    }

    if (isRecord(input.symbolRef) && typeof input.symbolRef.file === "string") {
        const resolved = resolveInputPath(input.symbolRef.file, repoRoot, effectiveCwd);
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

function normalizeAttributedHeaderFile(file, ctx) {
    const singleFile = ctx.scope.explicitSingleFile;
    if (singleFile && file === `${singleFile}/${path.posix.basename(singleFile)}`) {
        return singleFile;
    }
    return file;
}

function extractFileAttributedText(ctx, relativeFile, repoRoot) {
    const { parsedJson, rawOutput, scope } = ctx;
    const matchesFile = (file) => resolveInputPath(file, repoRoot, ctx.effectiveCwd)?.relativePath === relativeFile;
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
            if (typeof parsedJson.source === "string") sections.push(parsedJson.source);
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
        const fileHeader = /^(?:===\s+|---\s+|\*\*\*\s+)?([^\s:]+\.[\w]+)(?::(?:(\d+):(.*))?|-(\d+)-(.*))$/.exec(line);
        if (pathTag || satoriHeader || fileHeader) {
            const rawFile = (pathTag ?? satoriHeader ?? fileHeader)[1];
            const file = normalizeAttributedHeaderFile(rawFile, ctx);
            active = (ctx.rooted || path.posix.isAbsolute(file)) && matchesFile(file);
            numbered = Boolean(satoriHeader);
            const headerCode = fileHeader?.[3] ?? fileHeader?.[5];
            if (active && headerCode) lines.push(headerCode);
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

function evaluateCallContext(toolCall, repoRoot, fixtureRevision, sessionCwd = null) {
    const rawOutput = typeof toolCall.output === "string" ? toolCall.output : "";
    const parsedJson = tryParseJson(rawOutput);
    const effectiveCwd = typeof toolCall.cwd === "string" && toolCall.cwd.trim().length > 0
        ? toolCall.cwd
        : sessionCwd;
    const scope = inspectInputScope(toolCall.input, repoRoot, effectiveCwd);
    const responseScope = inspectInputScope(parsedJson, repoRoot, effectiveCwd);
    const responseRevision = parsedJson?.fixtureRevision ?? parsedJson?.gitRevision;
    const declaredRoot = parsedJson?.codebaseRoot ?? parsedJson?.repoRoot ?? parsedJson?.root;
    const input = toolCall.input;
    const rootedByAbsolute = [input?.codebaseRoot, input?.repoRoot, input?.root, input?.path, input?.filePath,
        input?.file, declaredRoot, parsedJson?.path].some((candidate) => typeof candidate === "string"
        && path.posix.isAbsolute(candidate) && resolveCandidateInsideRoot(candidate, repoRoot)?.inside);
    const nativeTool = isNativeFsTool(toolCall.tool);
    const rootedByNativeRelative = nativeTool && !scope.outOfRoot && (
        [input?.path, input?.filePath, input?.file].some((candidate) => typeof candidate === "string"
            && resolveInputPath(candidate, repoRoot, effectiveCwd)?.inside === true)
        || (effectiveCwd !== null && resolveCandidateInsideRoot(effectiveCwd, repoRoot)?.inside === true)
    );
    const rooted = rootedByAbsolute || rootedByNativeRelative;
    return {
        rawOutput,
        parsedJson,
        scope,
        effectiveCwd,
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

function extractFileAttributedNumberedLines(ctx, relativeFile, repoRoot) {
    const { parsedJson, rawOutput, scope, input } = ctx;
    const matchesFile = (file) => resolveInputPath(file, repoRoot, ctx.effectiveCwd)?.relativePath === relativeFile;
    const pairs = [];
    const pushBlock = (text, startLine) => {
        if (typeof text !== "string" || !Number.isSafeInteger(startLine) || startLine < 1) return;
        const split = text.split(/\r\n|\n|\r/);
        for (let i = 0; i < split.length; i += 1) {
            pairs.push({ line: startLine + i, text: split[i] });
        }
    };

    if (parsedJson !== null) {
        if (!isRecord(parsedJson) || !ctx.rooted) return pairs;
        const responseFile = parsedJson.symbol?.file ?? parsedJson.file ?? parsedJson.path ?? scope.explicitSingleFile;
        if (matchesFile(responseFile)) {
            const jsonStart = Number.isSafeInteger(parsedJson.startLine)
                ? parsedJson.startLine
                : (Number.isSafeInteger(parsedJson.start_line) ? parsedJson.start_line : null);
            if (typeof parsedJson.source === "string" && jsonStart !== null) {
                pushBlock(parsedJson.source, jsonStart);
            } else if (typeof parsedJson.content === "string" && jsonStart !== null) {
                pushBlock(parsedJson.content, jsonStart);
            } else if (typeof parsedJson.code === "string" && jsonStart !== null) {
                pushBlock(parsedJson.code, jsonStart);
            }
            const excerpts = parsedJson.source?.excerpts;
            for (const excerpt of Array.isArray(excerpts) ? excerpts : []) {
                const exStart = Number.isSafeInteger(excerpt?.startLine) ? excerpt.startLine : null;
                if (typeof excerpt?.content === "string" && exStart !== null) {
                    pushBlock(excerpt.content, exStart);
                }
            }
        }
        return pairs;
    }

    let active = ctx.rooted && scope.explicitSingleFile === relativeFile && /(?:^|_)read(?:_file)?$/.test(ctx.tool);
    let numberedOnly = false;
    let implicitNextLine = active && Number.isSafeInteger(input?.offset) && input.offset >= 1
        ? input.offset
        : (active && Number.isSafeInteger(input?.start_line) && input.start_line >= 1 ? input.start_line : null);
    for (const line of rawOutput.split(/\r\n|\n|\r/)) {
        const pathTag = /^<path>(.+)<\/path>$/.exec(line);
        const satoriHeader = /^# (.+?):(\d+)-\d+(?:\s*\||$)/.exec(line);
        const fileHeader = /^(?:===\s+|---\s+|\*\*\*\s+)?([^\s:]+\.[\w]+)(?::(?:(\d+):(.*))?|-(\d+)-(.*))$/.exec(line);
        if (pathTag || satoriHeader || fileHeader) {
            const rawFile = (pathTag ?? satoriHeader ?? fileHeader)[1];
            const file = normalizeAttributedHeaderFile(rawFile, ctx);
            active = (ctx.rooted || path.posix.isAbsolute(file)) && matchesFile(file);
            numberedOnly = Boolean(satoriHeader);
            implicitNextLine = satoriHeader ? Number.parseInt(satoriHeader[2], 10) : null;
            const headerLineNo = fileHeader?.[2] ?? fileHeader?.[4];
            const headerCode = fileHeader?.[3] ?? fileHeader?.[5];
            if (active && headerLineNo && headerCode !== undefined) {
                pairs.push({ line: Number.parseInt(headerLineNo, 10), text: headerCode });
            }
            continue;
        }
        if (!active) continue;
        const explicitNum = /^\s*(?:Line\s+)?(\d+)(?:\|\s?|\s*:\s?)(.*)$/.exec(line);
        if (explicitNum) {
            const lineNo = Number.parseInt(explicitNum[1], 10);
            pairs.push({ line: lineNo, text: explicitNum[2] });
            implicitNextLine = lineNo + 1;
        } else if (!numberedOnly && implicitNextLine !== null) {
            pairs.push({ line: implicitNextLine, text: line });
            implicitNextLine += 1;
        }
    }
    return pairs;
}

function updateBraceDepth(line, state) {
    let depth = state.depth;
    let inBlockComment = state.inBlockComment;
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        const next = line[i + 1];
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (quote !== null) {
            if (ch === "\\") {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "/" && next === "/") break;
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "{") {
            depth += 1;
            state.opened = true;
        } else if (ch === "}") {
            if (depth > 0) depth -= 1;
        }
    }
    state.depth = depth;
    state.inBlockComment = inBlockComment;
}

function spanContainsCallerCall(lines, callerName, targetName, sawDefinition, callTo) {
    let tracking = false;
    let state = { depth: 0, opened: false, inBlockComment: false };
    let headerLookahead = 0;

    for (const rawLine of lines) {
        const line = typeof rawLine === "string" ? rawLine : "";
        if (!tracking) {
            if (sawDefinition(line, callerName)) {
                tracking = true;
                state = { depth: 0, opened: false, inBlockComment: false };
                headerLookahead = 0;
                updateBraceDepth(line, state);
                if (state.opened && callTo(line, targetName) && !sawDefinition(line, targetName)) {
                    return true;
                }
                if (state.opened && state.depth === 0) {
                    tracking = false;
                }
            }
            continue;
        }

        if (!state.opened) {
            headerLookahead += 1;
            if (headerLookahead > 12) {
                tracking = false;
                continue;
            }
        }
        const wasOpened = state.opened;
        const depthBefore = state.depth;
        updateBraceDepth(line, state);
        if ((wasOpened && depthBefore > 0) || state.opened) {
            if (callTo(line, targetName) && !sawDefinition(line, targetName)) {
                return true;
            }
        }
        if (state.opened && state.depth === 0) {
            tracking = false;
        }
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
        `(?:\\b(?:function|def|fn|func)\\s+|(?:^|\\s)(?:(?:public|private|protected|static|readonly|override|async)\\s+)+)${escapeRegex(name)}\\s*\\(`,
        "m",
    ).test(text);
    const callTo = (text, name) => new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(text);
    // Span-tied caller attribution: native text proves caller -> target only
    // when the call site is witnessed inside the caller's braced body (either
    // in one read chunk or across contiguous line-numbered reads without
    // intervening gaps or closing braces). Disjoint file-level co-occurrence
    // no longer credits an unverified caller relation.
    if (relation.relation === "caller") {
        const target = relation.targetSymbol;
        if (!target) return false;
        if (peerText && spanContainsCallerCall(peerText.split(/\r\n|\n|\r/), relation.symbol, target, sawDefinition, callTo)) {
            progress.peerSeen = true;
            progress.siteSeen = true;
            return true;
        }
        const numbered = extractFileAttributedNumberedLines(ctx, relation.file, repoRoot);
        if (numbered.length > 0) {
            if (!progress.observedLines) progress.observedLines = new Map();
            for (const entry of numbered) {
                progress.observedLines.set(entry.line, entry.text);
            }
            const sortedLines = [...progress.observedLines.keys()].sort((a, b) => a - b);
            let run = [];
            let prevLine = null;
            for (const lineNo of sortedLines) {
                if (prevLine !== null && lineNo !== prevLine + 1) {
                    if (run.length > 0 && spanContainsCallerCall(run, relation.symbol, target, sawDefinition, callTo)) {
                        progress.peerSeen = true;
                        progress.siteSeen = true;
                        return true;
                    }
                    run = [];
                }
                run.push(progress.observedLines.get(lineNo));
                prevLine = lineNo;
            }
            if (run.length > 0 && spanContainsCallerCall(run, relation.symbol, target, sawDefinition, callTo)) {
                progress.peerSeen = true;
                progress.siteSeen = true;
                return true;
            }
        }
        return false;
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

function earliestToolTimestamp(tools) {
    let minTs = null;
    for (const toolCall of tools) {
        if (!isRecord(toolCall)) continue;
        for (const candidate of [toolCall.dispatchedAtMs, toolCall.visibleAtMs]) {
            const parsed = parseTimestampMs(candidate);
            if (parsed !== null && (minTs === null || parsed < minTs)) {
                minTs = parsed;
            }
        }
    }
    return minTs;
}

function extractReadCoverage(toolCall, repoRoot, sessionCwd = null) {
    if (toolCall?.status === "error") return null;
    const tool = String(toolCall?.tool ?? "");
    if (!/(?:^|_|__)read(?:_file)?$/.test(tool)) return null;
    const input = isRecord(toolCall?.input) ? toolCall.input : null;
    const effectiveCwd = typeof toolCall?.cwd === "string" && toolCall.cwd.trim().length > 0
        ? toolCall.cwd
        : sessionCwd;
    const parsedJson = tryParseJson(typeof toolCall?.output === "string" ? toolCall.output : "");
    const rawTarget = input?.file ?? input?.filePath ?? input?.path
        ?? parsedJson?.symbol?.file ?? parsedJson?.file ?? parsedJson?.path ?? null;
    const file = formatCompactRepoPath(rawTarget, repoRoot, effectiveCwd);
    if (!file) return null;

    const symbolId = input?.open_symbol?.symbolId ?? parsedJson?.symbol?.symbolId ?? null;
    let range = null;
    if (Number.isFinite(input?.start_line) || Number.isFinite(input?.end_line)) {
        const start = Number.isFinite(input.start_line) ? input.start_line : 1;
        const end = Number.isFinite(input.end_line) ? input.end_line : Number.MAX_SAFE_INTEGER;
        range = [start, end];
    } else if (Number.isFinite(input?.offset) || Number.isFinite(input?.limit)) {
        const start = Number.isFinite(input.offset) ? input.offset : 1;
        const end = Number.isFinite(input.limit) ? start + Math.max(0, input.limit - 1) : Number.MAX_SAFE_INTEGER;
        range = [start, end];
    } else if (Number.isFinite(parsedJson?.startLine) && Number.isFinite(parsedJson?.endLine)) {
        range = [parsedJson.startLine, parsedJson.endLine];
    } else if (Number.isFinite(parsedJson?.symbol?.span?.startLine) && Number.isFinite(parsedJson?.symbol?.span?.endLine)) {
        range = [parsedJson.symbol.span.startLine, parsedJson.symbol.span.endLine];
    } else if (typeof toolCall?.output === "string") {
        const header = /^# .+?:\s*(\d+)-(\d+)(?:\s*\||$)/m.exec(toolCall.output);
        if (header) {
            range = [Number.parseInt(header[1], 10), Number.parseInt(header[2], 10)];
        }
    }
    return { file, symbolId, range };
}

function isRereadOfPriorCoverage(coverage, priorCoverages) {
    if (!coverage || !Array.isArray(priorCoverages) || priorCoverages.length === 0) return false;
    for (const prior of priorCoverages) {
        if (prior.file !== coverage.file) continue;
        if (coverage.symbolId && prior.symbolId && coverage.symbolId === prior.symbolId) return true;
        if (prior.range === null || coverage.range === null) return true;
        if (coverage.range[0] <= prior.range[1] && prior.range[0] <= coverage.range[1]) return true;
    }
    return false;
}

function classifyPostEvidenceTool(toolCall, priorCoverages = null, repoRoot = null, sessionCwd = null) {
    if (toolCall?.status === "error") return "schema_retry";
    const tool = String(toolCall?.tool ?? "");
    if (/(?:^|_|__)file_outline$/.test(tool)) return "outline_check";
    if (/(?:^|_|__)(?:call_graph|find_references)$/.test(tool)) return "relation_check";
    if (/(?:^|_|__)read(?:_file)?$/.test(tool)) {
        if (Array.isArray(priorCoverages) && repoRoot) {
            const coverage = extractReadCoverage(toolCall, repoRoot, sessionCwd);
            return isRereadOfPriorCoverage(coverage, priorCoverages)
                ? "source_reread"
                : "post_evidence_read";
        }
        return "post_evidence_read";
    }
    if (/(?:^|_|__)(?:search_codebase|grep|find|glob)$/.test(tool)) return "search_extra";
    return "other";
}

function formatCompactRepoPath(rawPath, repoRoot, effectiveCwd = null) {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
    const resolved = resolveInputPath(rawPath, repoRoot, effectiveCwd);
    if (resolved?.inside) {
        return resolved.isRoot ? "." : resolved.relativePath;
    }
    return normalizePosixPath(rawPath.trim());
}

function summarizePostEvidenceDetail(toolCall, repoRoot, sessionCwd = null) {
    const truncate = (value, max = 140) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);
    if (toolCall?.status === "error" && typeof toolCall.output === "string" && toolCall.output.trim().length > 0) {
        const firstLine = toolCall.output.trim().split(/\r?\n/, 1)[0];
        return truncate(firstLine);
    }
    const input = isRecord(toolCall?.input) ? toolCall.input : null;
    const effectiveCwd = typeof toolCall?.cwd === "string" && toolCall.cwd.trim().length > 0
        ? toolCall.cwd
        : sessionCwd;
    if (!input) return String(toolCall?.tool ?? "unknown");

    const category = classifyPostEvidenceTool(toolCall);
    const targetPath = formatCompactRepoPath(
        input.file ?? input.filePath ?? input.path ?? input.symbolRef?.file,
        repoRoot,
        effectiveCwd,
    );
    if (category === "source_reread" || category === "post_evidence_read") {
        let range = "";
        if (Number.isFinite(input.start_line) || Number.isFinite(input.end_line)) {
            range = `:${input.start_line ?? ""}..${input.end_line ?? ""}`;
        } else if (Number.isFinite(input.offset) || Number.isFinite(input.limit)) {
            range = ` (offset=${input.offset ?? 1}, limit=${input.limit ?? ""})`;
        }
        const mode = typeof input.mode === "string" ? ` [${input.mode}]` : "";
        return truncate(`${targetPath ?? "file"}${range}${mode}`);
    }
    if (category === "relation_check") {
        const dir = typeof input.direction === "string" ? `${input.direction} ` : "";
        const sym = input.symbolRef?.symbolLabel ?? input.symbolRef?.symbol ?? input.symbolRef?.symbolId ?? "";
        return truncate(`${dir}${sym}${targetPath ? ` (${targetPath})` : ""}`.trim() || String(toolCall?.tool ?? "relation"));
    }
    if (category === "outline_check") {
        return truncate(targetPath ?? String(toolCall?.tool ?? "file_outline"));
    }
    if (category === "search_extra") {
        const query = input.query ?? input.pattern ?? "";
        return truncate(`${query ? `${JSON.stringify(query)}` : ""}${targetPath ? ` in ${targetPath}` : ""}`.trim() || String(toolCall?.tool ?? "search"));
    }
    return truncate(targetPath ?? String(toolCall?.tool ?? "other"));
}

export function scoreEvidenceTrajectory({
    tools,
    task,
    repoRoot,
    fixtureRevision = null,
    expectedFixtureRevision = null,
    evidenceSpec = null,
    coldStartPhases = null,
    sessionStartMs = null,
    sessionCwd = null,
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
    let decisiveToolIndex = null;

    const orderedEntries = normalizedTools.map((toolCall, idx) => ({
        toolCall: toolCall ?? {},
        dispatchIdx: idx,
        ordinal: Number.isSafeInteger(toolCall?.index) && toolCall.index > 0
            ? toolCall.index
            : idx + 1,
        visibleAtMs: parseTimestampMs(toolCall?.visibleAtMs),
        dispatchedAtMs: parseTimestampMs(toolCall?.dispatchedAtMs),
    }));
    const allHaveVisibleTs = orderedEntries.length > 1
        && orderedEntries.every((entry) => entry.visibleAtMs !== null);
    if (allHaveVisibleTs) {
        orderedEntries.sort((left, right) => (
            left.visibleAtMs - right.visibleAtMs || left.dispatchIdx - right.dispatchIdx
        ));
    }
    const reorderedByArrival = orderedEntries.some((entry, idx) => entry.dispatchIdx !== idx);

    for (let idx = 0; idx < orderedEntries.length; idx += 1) {
        const entry = orderedEntries[idx];
        const toolCall = entry.toolCall;
        const ordinal = reorderedByArrival ? idx + 1 : entry.ordinal;
        const ctx = evaluateCallContext(toolCall, canonicalRepo, fixtureRevision, sessionCwd);
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
                const progress = relationProgressByKey.get(requirement.key) ?? { peerSeen: false, siteSeen: false, observedLines: new Map() };
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
            decisiveToolIndex = idx;
        }

        perCallProgress.push({
            index: entry.ordinal,
            arrivalIndex: idx + 1,
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
        ? Math.max(0, orderedEntries.length - (decisiveToolIndex + 1))
        : null;

    const resolvedSessionStartMs = parseTimestampMs(sessionStartMs) ?? earliestToolTimestamp(normalizedTools);
    const decisiveEntry = decisiveToolIndex !== null ? orderedEntries[decisiveToolIndex] : null;
    const decisiveCall = decisiveEntry?.toolCall ?? null;
    const decisiveVisibleAtMs = decisiveEntry?.visibleAtMs ?? null;
    const firstSufficientEvidenceMs = (decisiveCall !== null
        && resolvedSessionStartMs !== null
        && decisiveVisibleAtMs !== null)
        ? Math.max(0, decisiveVisibleAtMs - resolvedSessionStartMs)
        : null;

    let inFlightParallelCalls = null;
    let postEvidenceDispatchedCalls = null;
    let postEvidenceBreakdown = [];
    if (decisiveToolIndex !== null) {
        const subsequentEntries = orderedEntries.slice(decisiveToolIndex + 1);
        if (subsequentEntries.length === 0) {
            inFlightParallelCalls = 0;
            postEvidenceDispatchedCalls = 0;
        } else {
            const priorReadCoverages = [];
            for (let i = 0; i <= decisiveToolIndex; i += 1) {
                const cov = extractReadCoverage(orderedEntries[i].toolCall, canonicalRepo, sessionCwd);
                if (cov) priorReadCoverages.push(cov);
            }
            const decisiveTurnIndex = Number.isSafeInteger(decisiveCall?.turnIndex)
                ? decisiveCall.turnIndex
                : null;
            let inFlightCount = 0;
            let postDispatchedCount = 0;
            const breakdown = [];
            let undetermined = false;

            for (let offset = 0; offset < subsequentEntries.length; offset += 1) {
                const entry = subsequentEntries[offset];
                const call = entry.toolCall;
                const callOrdinal = entry.ordinal;
                const callTurnIndex = Number.isSafeInteger(call.turnIndex) ? call.turnIndex : null;
                const callDispatchedAtMs = entry.dispatchedAtMs;

                let classification = null;
                if (decisiveTurnIndex !== null && callTurnIndex !== null) {
                    classification = callTurnIndex <= decisiveTurnIndex ? "in_flight" : "post_dispatched";
                } else if (callDispatchedAtMs !== null && decisiveVisibleAtMs !== null) {
                    classification = callDispatchedAtMs <= decisiveVisibleAtMs ? "in_flight" : "post_dispatched";
                } else {
                    undetermined = true;
                    break;
                }

                if (classification === "in_flight") {
                    inFlightCount += 1;
                    const cov = extractReadCoverage(call, canonicalRepo, sessionCwd);
                    if (cov) priorReadCoverages.push(cov);
                } else {
                    postDispatchedCount += 1;
                    const category = classifyPostEvidenceTool(call, priorReadCoverages, canonicalRepo, sessionCwd);
                    breakdown.push({
                        index: callOrdinal,
                        turnIndex: callTurnIndex,
                        tool: call.tool ?? null,
                        status: call.status ?? "completed",
                        category,
                        detail: summarizePostEvidenceDetail(call, canonicalRepo, sessionCwd),
                    });
                    const cov = extractReadCoverage(call, canonicalRepo, sessionCwd);
                    if (cov) priorReadCoverages.push(cov);
                }
            }

            if (!undetermined) {
                inFlightParallelCalls = inFlightCount;
                postEvidenceDispatchedCalls = postDispatchedCount;
                postEvidenceBreakdown = breakdown;
            }
        }
    }

    return {
        repoRoot: canonicalRepo,
        fixtureRevision,
        fixtureRevisionVerified,
        taskId: spec.taskId,
        sufficient: firstSufficientEvidenceCall !== null,
        firstSufficientEvidenceCall,
        firstSufficientEvidenceMs,
        callsAfterSufficientEvidence,
        inFlightParallelCalls,
        postEvidenceDispatchedCalls,
        postEvidenceBreakdown,
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
        if (typeof run.passed === "boolean") return run.passed;
        return run.outcome?.strictPassed ?? null;
    }
    if (field === "totalInputTokens") {
        return run.totalInputTokens ?? run.measurements?.apiInputTokens ?? null;
    }
    if (field === "wallTimeMs") {
        return run.wallTimeMs ?? run.measurements?.taskWallTimeMs ?? null;
    }
    if (field === "firstSufficientEvidenceCall") {
        if (run.fidelity?.matched === false || run.fidelityMatched === false) return null;
        if (run.trajectory && run.trajectory.fixtureRevisionVerified !== true) return null;
        return run.firstSufficientEvidenceCall
            ?? run.trajectory?.firstSufficientEvidenceCall
            ?? run.ergonomics?.firstSufficientEvidenceCall
            ?? null;
    }
    if (field === "firstSufficientEvidenceMs") {
        if (run.fidelity?.matched === false || run.fidelityMatched === false) return null;
        if (run.trajectory && run.trajectory.fixtureRevisionVerified !== true) return null;
        return run.firstSufficientEvidenceMs
            ?? run.trajectory?.firstSufficientEvidenceMs
            ?? run.ergonomics?.firstSufficientEvidenceMs
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
    const fidelityOk = list.every((run) => run?.fidelity?.matched !== false && run?.fidelityMatched !== false);
    return {
        count: list.length,
        fidelityOk,
        strictObserved: list.every((run) => typeof extractRunMetric(run, "strictPassed") === "boolean"),
        strictPassRate: list.length > 0 ? passedCount / list.length : 0,
        totalInputTokens: median(list.map((run) => extractRunMetric(run, "totalInputTokens"))),
        wallTimeMs: median(list.map((run) => extractRunMetric(run, "wallTimeMs"))),
        firstSufficientEvidenceCall: median(
            list.map((run) => extractRunMetric(run, "firstSufficientEvidenceCall")),
        ),
        firstSufficientEvidenceMs: median(
            list.map((run) => extractRunMetric(run, "firstSufficientEvidenceMs")),
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
        maxFirstSufficientEvidenceMsRatio: armPolicy.maxFirstSufficientEvidenceMsRatio ?? null,
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

    const fidelityOk = control.fidelityOk && treatment.fidelityOk;
    if (!fidelityOk) {
        failureReasons.push("transcript_fidelity_mismatch");
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

    const firstSufficientEvidenceMsRatio = ratio(
        treatment.firstSufficientEvidenceMs,
        control.firstSufficientEvidenceMs,
    );
    const firstSufficientEvidenceMsOk = thresholds.maxFirstSufficientEvidenceMsRatio === null
        ? true
        : (firstSufficientEvidenceMsRatio !== null
            && firstSufficientEvidenceMsRatio <= thresholds.maxFirstSufficientEvidenceMsRatio);
    if (!firstSufficientEvidenceMsOk) {
        failureReasons.push(
            firstSufficientEvidenceMsRatio === null
                ? "sufficient_evidence_time_unobserved"
                : "sufficient_evidence_time_regression",
        );
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
            firstSufficientEvidenceMsRatio,
            visibleToolBytesRatio,
        },
        checks: {
            fidelity: fidelityOk,
            strictPassRate: strictPassRateOk,
            totalInputTokens: totalInputTokensOk,
            wallTimeMs: wallTimeMsOk,
            firstSufficientEvidenceCall: firstSufficientEvidenceCallOk,
            firstSufficientEvidenceMs: firstSufficientEvidenceMsOk,
            visibleToolBytes: visibleToolBytesOk,
        },
        failureReasons,
    };
}

function parseJsonlEvents(jsonlText) {
    return String(jsonlText)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

function extractPiContentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
}

function isPiEventStream(events) {
    return Array.isArray(events) && events.some((event) => isRecord(event) && (
        event.type === "session"
        || event.type === "tool_execution_start"
        || event.type === "tool_execution_end"
        || (event.type === "message_end" && event.message?.role === "toolResult")
    ));
}

export function extractPiToolCalls(piEvents) {
    const events = typeof piEvents === "string"
        ? parseJsonlEvents(piEvents)
        : (Array.isArray(piEvents) ? piEvents : []);
    let sessionStartMs = null;
    let earliestFallbackMs = null;
    let sessionCwd = null;
    let currentTurnIndex = 0;
    let sawTurnStart = false;
    let currentTurnAssistantTs = null;
    const records = [];
    const byToolCallId = new Map();

    const recordEarliest = (ts) => {
        if (ts !== null && (earliestFallbackMs === null || ts < earliestFallbackMs)) {
            earliestFallbackMs = ts;
        }
    };

    for (const event of events) {
        if (!isRecord(event)) continue;
        const eventTs = parseTimestampMs(event.timestamp ?? event.message?.timestamp);
        recordEarliest(eventTs);

        if (event.type === "session") {
            if (eventTs !== null) sessionStartMs = eventTs;
            if (typeof event.cwd === "string" && event.cwd.trim().length > 0) {
                sessionCwd = event.cwd.trim();
            }
            continue;
        }
        if (event.type === "turn_start") {
            sawTurnStart = true;
            currentTurnIndex += 1;
            currentTurnAssistantTs = null;
            continue;
        }
        if (event.type === "turn_end") {
            continue;
        }
        if ((event.type === "message_start" || event.type === "message_end") && event.message?.role === "assistant") {
            if (eventTs !== null) currentTurnAssistantTs = eventTs;
            continue;
        }
        if (event.type === "tool_execution_start") {
            const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
            const explicitDispatchTs = parseTimestampMs(event.timestamp);
            const turnIndex = Number.isSafeInteger(event.turnIndex)
                ? event.turnIndex
                : (sawTurnStart ? currentTurnIndex : null);
            const record = {
                index: records.length + 1,
                tool: event.toolName ?? null,
                status: "completed",
                input: isRecord(event.args) ? event.args : (event.args ?? null),
                output: "",
                visibleBytes: 0,
                turnIndex,
                dispatchedAtMs: explicitDispatchTs ?? currentTurnAssistantTs,
                visibleAtMs: null,
                durationMs: null,
                _hasExplicitDispatchTs: explicitDispatchTs !== null,
                _hasMessageEnd: false,
            };
            records.push(record);
            if (toolCallId !== null) byToolCallId.set(toolCallId, record);
            continue;
        }
        if (event.type === "tool_execution_end") {
            const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
            let record = toolCallId !== null ? byToolCallId.get(toolCallId) : null;
            if (!record) {
                record = {
                    index: records.length + 1,
                    tool: event.toolName ?? null,
                    status: "completed",
                    input: null,
                    output: "",
                    visibleBytes: 0,
                    turnIndex: sawTurnStart ? currentTurnIndex : null,
                    dispatchedAtMs: currentTurnAssistantTs,
                    visibleAtMs: null,
                    durationMs: null,
                    _hasExplicitDispatchTs: false,
                    _hasMessageEnd: false,
                };
                records.push(record);
                if (toolCallId !== null) byToolCallId.set(toolCallId, record);
            }
            if (Number.isFinite(event.durationMs)) {
                record.durationMs = event.durationMs;
            }
            if (!record._hasMessageEnd) {
                const output = extractPiContentText(event.result?.content);
                const isError = Boolean(event.isError);
                record.output = output;
                record.visibleBytes = Buffer.byteLength(output, "utf8");
                record.status = isError ? "error" : "completed";
                if (eventTs !== null) {
                    record.visibleAtMs = eventTs;
                }
            }
            if (!record._hasExplicitDispatchTs && record.visibleAtMs !== null && Number.isFinite(record.durationMs)) {
                record.dispatchedAtMs = record.visibleAtMs - record.durationMs;
            }
            continue;
        }
        if (event.type === "message_end" && event.message?.role === "toolResult") {
            const msg = event.message;
            const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : null;
            let record = toolCallId !== null ? byToolCallId.get(toolCallId) : null;
            if (!record) {
                record = {
                    index: records.length + 1,
                    tool: msg.toolName ?? null,
                    status: "completed",
                    input: null,
                    output: "",
                    visibleBytes: 0,
                    turnIndex: sawTurnStart ? currentTurnIndex : null,
                    dispatchedAtMs: currentTurnAssistantTs,
                    visibleAtMs: null,
                    durationMs: null,
                    _hasExplicitDispatchTs: false,
                    _hasMessageEnd: false,
                };
                records.push(record);
                if (toolCallId !== null) byToolCallId.set(toolCallId, record);
            }
            const output = extractPiContentText(msg.content);
            const isError = Boolean(msg.isError);
            const visibleAtMs = parseTimestampMs(event.timestamp ?? msg.timestamp);
            record.output = output;
            record.visibleBytes = Buffer.byteLength(output, "utf8");
            record.status = isError ? "error" : "completed";
            record.visibleAtMs = visibleAtMs;
            record._hasMessageEnd = true;
            if (Number.isFinite(msg.durationMs) && record.durationMs === null) {
                record.durationMs = msg.durationMs;
            }
            if (!record._hasExplicitDispatchTs && visibleAtMs !== null && Number.isFinite(record.durationMs)) {
                record.dispatchedAtMs = visibleAtMs - record.durationMs;
            }
        }
    }

    const tools = records.map(({ _hasExplicitDispatchTs, _hasMessageEnd, ...clean }) => clean);
    const extractedVisibleBytes = tools.reduce((sum, call) => sum + (call.visibleBytes ?? 0), 0);
    return {
        sessionStartMs: sessionStartMs ?? earliestFallbackMs,
        sessionCwd,
        turnCount: currentTurnIndex,
        toolCallCount: tools.length,
        extractedVisibleBytes,
        tools,
    };
}
export function replayResultRecord({
    result,
    task,
    repoRoot,
    evidenceSpec = null,
    fixture,
    fixtureRevision = undefined,
    expectedFixtureRevision = undefined,
    hostEvents = [],
    piEvents = null,
}) {
    if (!isRecord(result)) {
        throw new Error("ergonomics_scorer_invalid_result_record");
    }
    const resolvedTask = task ?? DEFAULT_TASKS_BY_ID.get(result.taskId);
    if (!resolvedTask && !evidenceSpec) {
        throw new Error(`ergonomics_scorer_unknown_task:${result.taskId}`);
    }

    const resolvedPiEvents = piEvents !== null && piEvents !== undefined
        ? (typeof piEvents === "string" ? parseJsonlEvents(piEvents) : (Array.isArray(piEvents) ? piEvents : []))
        : (isPiEventStream(hostEvents) ? hostEvents : null);
    const piExtracted = resolvedPiEvents ? extractPiToolCalls(resolvedPiEvents) : null;

    const resolvedRepoRoot = repoRoot
        ?? result.environment?.repoRoot
        ?? fixture?.repoRoot
        ?? piExtracted?.sessionCwd;
    for (const recordedRoot of [result.environment?.repoRoot, fixture?.repoRoot, piExtracted?.sessionCwd]) {
        if (recordedRoot != null && canonicalRootPath(recordedRoot) !== canonicalRootPath(resolvedRepoRoot)) {
            throw new Error("ergonomics_scorer_fixture_root_mismatch");
        }
    }

    if (fixtureRevision !== undefined && fixtureRevision !== null
        && result.environment?.gitRevision != null
        && fixtureRevision !== result.environment.gitRevision) {
        throw new Error("ergonomics_scorer_fixture_revision_mismatch");
    }
    if (expectedFixtureRevision !== undefined && expectedFixtureRevision !== null
        && fixture?.gitRevision != null
        && expectedFixtureRevision !== fixture.gitRevision) {
        throw new Error("ergonomics_scorer_fixture_revision_mismatch");
    }
    const resolvedFixtureRevision = fixtureRevision ?? result.environment?.gitRevision ?? null;
    const resolvedExpectedFixtureRevision = expectedFixtureRevision ?? fixture?.gitRevision ?? null;

    const hostCalls = piExtracted
        ? []
        : hostEvents.filter((event) => event?.type === "tool_use"
            && event.sessionID === result.harness?.sessionId && typeof event.part?.tool === "string");
    const tools = piExtracted
        ? piExtracted.tools
        : Array.isArray(result.tools)
            ? result.tools
            : Array.isArray(result.harness?.toolCalls)
                ? result.harness.toolCalls.map((call, idx) => ({
                    index: idx + 1,
                    tool: call.operation ?? call.tool,
                    status: call.status,
                    input: call.input ?? null,
                    output: typeof call.output === "string" ? call.output : matchingHostOutput(call, hostCalls[idx]),
                    visibleBytes: call.visibleResultBytes ?? call.visibleBytes ?? null,
                    dispatchedAtMs: call.dispatchedAtMs ?? call.startedAtMs ?? null,
                    visibleAtMs: call.visibleAtMs ?? call.endedAtMs ?? null,
                }))
                : [];

    let fidelity = null;
    if (piExtracted) {
        const recordedToolCallCount = typeof result.toolCalls === "number"
            ? result.toolCalls
            : (Array.isArray(result.harness?.toolCalls) ? result.harness.toolCalls.length : null);
        const recordedVisibleBytes = extractRunMetric(result, "visibleToolBytes");
        const toolCallCountMatches = recordedToolCallCount === null
            ? null
            : piExtracted.toolCallCount === recordedToolCallCount;
        const visibleBytesMatches = recordedVisibleBytes === null
            ? null
            : piExtracted.extractedVisibleBytes === recordedVisibleBytes;
        const mismatches = [];
        if (toolCallCountMatches === false) {
            mismatches.push(`tool_call_count_mismatch:extracted=${piExtracted.toolCallCount},recorded=${recordedToolCallCount}`);
        }
        if (visibleBytesMatches === false) {
            mismatches.push(`visible_bytes_mismatch:extracted=${piExtracted.extractedVisibleBytes},recorded=${recordedVisibleBytes}`);
        }
        fidelity = {
            source: "pi_events",
            extractedToolCallCount: piExtracted.toolCallCount,
            recordedToolCallCount,
            toolCallCountMatches,
            extractedVisibleBytes: piExtracted.extractedVisibleBytes,
            recordedVisibleBytes,
            visibleBytesMatches,
            matched: mismatches.length === 0,
            mismatches,
        };
    }

    const trajectory = scoreEvidenceTrajectory({
        tools,
        task: resolvedTask,
        repoRoot: resolvedRepoRoot,
        fixtureRevision: resolvedFixtureRevision,
        expectedFixtureRevision: resolvedExpectedFixtureRevision,
        evidenceSpec,
        coldStartPhases: result.measurements?.coldStartPhases ?? null,
        sessionStartMs: piExtracted?.sessionStartMs ?? result.harness?.sessionStartMs ?? null,
        sessionCwd: piExtracted?.sessionCwd ?? null,
    });
    const fidelityFailed = fidelity?.matched === false;
    const strictGrade = isRecord(result.grade)
        ? result.grade
        : (typeof result.passed === "boolean"
            ? {
                passed: result.passed,
                failureReasons: Array.isArray(result.failureReasons) ? result.failureReasons : [],
            }
            : null);
    const outcome = classifyAnswerOutcome({
        agentResult: result.agentResult,
        expected: resolvedTask?.expected ?? evidenceSpec,
        strictGrade,
    });

    return {
        runId: result.runId ?? null,
        taskId: result.taskId ?? resolvedTask?.id ?? null,
        arm: result.arm ?? null,
        strictPassed: fidelityFailed ? false : outcome.strictPassed,
        totalInputTokens: extractRunMetric(result, "totalInputTokens"),
        wallTimeMs: extractRunMetric(result, "wallTimeMs"),
        visibleToolBytes: extractRunMetric(result, "visibleToolBytes"),
        firstSufficientEvidenceCall: fidelityFailed ? null : trajectory.firstSufficientEvidenceCall,
        firstSufficientEvidenceMs: fidelityFailed ? null : trajectory.firstSufficientEvidenceMs,
        inFlightParallelCalls: fidelityFailed ? null : trajectory.inFlightParallelCalls,
        postEvidenceDispatchedCalls: fidelityFailed ? null : trajectory.postEvidenceDispatchedCalls,
        postEvidenceBreakdown: fidelityFailed ? [] : trajectory.postEvidenceBreakdown,
        fidelity,
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

function readCliFlag(argv, flagName) {
    const idx = argv.indexOf(flagName);
    if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) {
        return argv[idx + 1];
    }
    const prefix = `${flagName}=`;
    const eqArg = argv.find((arg) => arg.startsWith(prefix));
    return eqArg ? eqArg.slice(prefix.length) : undefined;
}

function main(argv) {
    const resultArg = readCliFlag(argv, "--result");
    if (!resultArg) {
        process.stderr.write(
            "Usage: node ergonomics-scorer.mjs --result <path-to-result.json> [--pi-events <events.jsonl>] [--repo <repoRoot>] [--fixture-revision <rev>] [--expected-fixture-revision <rev>]\n",
        );
        process.exitCode = 1;
        return;
    }
    const resultPath = path.resolve(resultArg);
    const repoRoot = readCliFlag(argv, "--repo");
    const piEventsArg = readCliFlag(argv, "--pi-events");
    const fixtureRevision = readCliFlag(argv, "--fixture-revision");
    const expectedFixtureRevision = readCliFlag(argv, "--expected-fixture-revision");

    const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const manifestPath = path.join(path.dirname(resultPath), "run-manifest.json");
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;

    let piEvents = null;
    let hostEvents = [];
    if (piEventsArg) {
        piEvents = parseJsonlEvents(fs.readFileSync(path.resolve(piEventsArg), "utf8"));
    } else {
        const eventsPath = resultPath.replace(/\.result\.json$/, ".opencode-events.jsonl");
        hostEvents = eventsPath !== resultPath && fs.existsSync(eventsPath)
            ? parseJsonlEvents(fs.readFileSync(eventsPath, "utf8"))
            : [];
    }

    const summary = replayResultRecord({
        result: parsed,
        repoRoot,
        task: manifest?.taskManifest?.tasks?.find((item) => item.id === parsed.taskId),
        fixture: manifest ? { repoRoot: manifest.repoRoot, gitRevision: manifest.repositoryIdentity?.gitRevision } : undefined,
        fixtureRevision,
        expectedFixtureRevision,
        hostEvents,
        piEvents,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2));
}
