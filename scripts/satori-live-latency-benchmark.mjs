#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
    JsonRpcStdioSession,
    decodeToolResponse,
} from "./satori-useful-context-record.mjs";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_SETTLE_MS = 500;
const DEFAULT_GRAPH_BODY_RANGE = "2913,3533";
const MODES = new Set(["diagnostic", "comparison", "watcher-disabled", "status"]);
const ARTIFACT_FORMAT_VERSION = 1;
const BENCHMARK_ID = "satori-public-read-latency";

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function usage() {
    return [
        "Usage: node scripts/satori-live-latency-benchmark.mjs --repo <root> [options]",
        "Options:",
        "  --mode <diagnostic|comparison|watcher-disabled|status>",
        "                                      Default: comparison",
        "  --output-dir <directory>            Default: <repo>/.satori/benchmarks/live-latency",
        "  --compare-last                     Compare with newest compatible saved artifact",
        "  --label <text>                     Optional filename label",
        "  --command <executable>          MCP executable (default: current Node)",
        "  --command-arg <arg>             Repeat for every MCP argument",
        "  --samples <count>               Samples per diagnostic workload (default: 3)",
        "  --settle-ms <ms>                Delay after exact warm-up (default: 500)",
        "  --startup-timeout-ms <ms>       Default: 30000",
        "  --call-timeout-ms <ms>          Default: 300000",
        "  --close-timeout-ms <ms>         Default: 5000",
        "  --graph-body-range <start,end>  Native comparison body window",
        "  --skip-sync                     Do not run the initial no-change sync",
        "  --dry-run                       Print the expanded configuration only",
    ].join("\n");
}

export function parseArgs(argv) {
    const options = {
        repoRoot: null,
        mode: "comparison",
        outputDir: null,
        compareLast: false,
        label: null,
        command: process.execPath,
        commandArgs: [],
        commandWasExplicit: false,
        sampleCount: DEFAULT_SAMPLE_COUNT,
        settleMs: DEFAULT_SETTLE_MS,
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
        graphBodyRange: DEFAULT_GRAPH_BODY_RANGE,
        skipSync: false,
        dryRun: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${arg}.`);
            return argv[index];
        };
        if (arg === "--repo") {
            options.repoRoot = path.resolve(next());
        } else if (arg === "--mode") {
            options.mode = next();
        } else if (arg === "--output-dir") {
            options.outputDir = path.resolve(next());
        } else if (arg === "--compare-last") {
            options.compareLast = true;
        } else if (arg === "--label") {
            options.label = next();
        } else if (arg === "--command") {
            options.command = next();
            options.commandWasExplicit = true;
        } else if (arg === "--command-arg") {
            options.commandArgs.push(next());
        } else if (arg === "--samples") {
            options.sampleCount = positiveInteger(next(), arg);
        } else if (arg === "--settle-ms") {
            options.settleMs = positiveInteger(next(), arg);
        } else if (arg === "--startup-timeout-ms") {
            options.startupTimeoutMs = positiveInteger(next(), arg);
        } else if (arg === "--call-timeout-ms") {
            options.callTimeoutMs = positiveInteger(next(), arg);
        } else if (arg === "--close-timeout-ms") {
            options.closeTimeoutMs = positiveInteger(next(), arg);
        } else if (arg === "--graph-body-range") {
            options.graphBodyRange = next();
        } else if (arg === "--skip-sync") {
            options.skipSync = true;
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!MODES.has(options.mode)) {
        throw new Error(`Unsupported mode '${options.mode}'.`);
    }
    if (!options.help && !options.repoRoot) {
        throw new Error("--repo is required.");
    }
    if (!/^\d+,\d+$/.test(options.graphBodyRange)) {
        throw new Error("--graph-body-range must use start,end integer syntax.");
    }
    if (options.repoRoot && options.commandArgs.length === 0 && !options.commandWasExplicit) {
        options.commandArgs.push(path.join(options.repoRoot, "packages/mcp/dist/index.js"));
    }
    if (options.repoRoot && !options.outputDir) {
        options.outputDir = path.join(
            options.repoRoot,
            ".satori",
            "benchmarks",
            "live-latency",
        );
    }
    return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function responseText(result) {
    return Array.isArray(result?.content)
        ? result.content
            .filter((entry) => entry?.type === "text")
            .map((entry) => entry.text)
            .join("")
        : "";
}

async function timedTool(session, tool, args) {
    const startedAt = process.hrtime.bigint();
    const result = await session.callTool(tool, args);
    const text = responseText(result);
    return {
        wallMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        responseBytes: Buffer.byteLength(text, "utf8"),
        payload: decodeToolResponse(result),
    };
}

function timedNative(repoRoot, args) {
    const startedAt = process.hrtime.bigint();
    const result = spawnSync("rtk", args, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
    });
    const wallMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (result.status !== 0) {
        throw new Error(`Native command failed (${args.join(" ")}): ${result.stderr}`);
    }
    return {
        wallMs,
        responseBytes: Buffer.byteLength(result.stdout, "utf8"),
    };
}

function summarize(sample) {
    return {
        wallMs: sample.wallMs,
        responseBytes: sample.responseBytes,
        status: sample.payload?.status,
        syncStats: sample.payload?.syncStats,
    };
}

export function summarizeSearch(sample) {
    const debug = sample.payload?.hints?.debugSearch;
    const rerank = debug?.rerank;
    const providerWork = debug?.providerWork;
    const semanticExpansion = debug?.semanticExpansion;
    return {
        ...summarize(sample),
        freshnessMode: sample.payload?.freshnessDecision?.mode,
        warnings: Array.isArray(sample.payload?.warnings)
            ? sample.payload.warnings.map((warning) => warning?.code).filter(Boolean)
            : [],
        readiness: debug?.readiness,
        watcher: debug?.watcher,
        phaseTimingsMs: debug?.phaseTimingsMs,
        route: debug?.route,
        retrieval: debug?.retrieval,
        provider: {
            searchPassCount: sample.payload?.searchPassCount,
            searchPassSuccessCount: sample.payload?.searchPassSuccessCount,
            searchPassFailureCount: sample.payload?.searchPassFailureCount,
            providerWork,
            semanticExpansion,
            rerank: rerank
                ? {
                    attempted: rerank.attempted,
                    applied: rerank.applied,
                    candidatesIn: rerank.candidatesIn,
                    candidatesReranked: rerank.candidatesReranked,
                    familyCount: rerank.familyCount,
                    supplementalCandidates: rerank.supplementalCandidates,
                    candidatePoolCount: rerank.candidatePoolCount,
                    candidateBudget: rerank.candidateBudget,
                    budgetReason: rerank.budgetReason,
                }
                : undefined,
        },
    };
}

function summarizeNavigation(sample) {
    return {
        ...summarize(sample),
        reason: sample.payload?.reason,
        symbolCount: Array.isArray(sample.payload?.symbols)
            ? sample.payload.symbols.length
            : undefined,
        nodeCount: sample.payload?.sidecar?.nodeCount,
        edgeCount: sample.payload?.sidecar?.edgeCount,
    };
}

function observationalStats(samples) {
    const sorted = samples.map((sample) => sample.wallMs).sort((left, right) => left - right);
    return {
        medianMs: sorted[Math.floor(sorted.length / 2)],
        rangeMs: [sorted[0], sorted.at(-1)],
    };
}

function workloadArgs(repoRoot) {
    const searchBase = {
        path: repoRoot,
        scope: "runtime",
        resultMode: "grouped",
        groupBy: "symbol",
        limit: 5,
    };
    return {
        searchBase,
        exact: {
            ...searchBase,
            query: "runExactRegistryFastPath",
        },
        semantic: {
            ...searchBase,
            query: "where is search code behavior handled",
        },
        mutation: {
            ...searchBase,
            query: "how does Satori prevent stale search evidence across a concurrent index mutation boundary",
        },
        graphDiscovery: {
            ...searchBase,
            query: "handleSearchCode",
        },
        architecture: {
            path: repoRoot,
            query: "Satori package architecture core mcp cli runtime responsibilities",
            scope: "mixed",
            resultMode: "grouped",
            groupBy: "file",
            limit: 8,
        },
        outline: {
            path: repoRoot,
            file: "packages/mcp/src/core/handlers.ts",
            resolveMode: "exact",
            symbolLabelExact: "method handleSearchCode",
            limitSymbols: 20,
        },
        readFile: {
            path: path.join(repoRoot, "packages/mcp/src/core/handlers.ts"),
            start_line: 1,
            end_line: 120,
            mode: "plain",
        },
    };
}

export function assertNoChangeSyncPayload(payload) {
    if (payload?.status !== "ok") {
        throw new Error(`Live sync failed: ${JSON.stringify(payload)}`);
    }
    const stats = payload.syncStats;
    const counts = [stats?.added, stats?.removed, stats?.modified];
    if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
        throw new Error("Live sync did not return complete non-negative syncStats.");
    }
    if (counts.some((count) => count !== 0)) {
        throw new Error(
            `Live sync changed the index before measurement: ${JSON.stringify(stats)}`,
        );
    }
}

async function requireNoChangeSync(session, repoRoot, skipSync) {
    if (skipSync) return null;
    const sync = await timedTool(session, "manage_index", { action: "sync", path: repoRoot });
    assertNoChangeSyncPayload(sync.payload);
    return sync;
}

async function runStatus(session, options) {
    const status = await timedTool(session, "manage_index", {
        action: "status",
        path: options.repoRoot,
        detail: "full",
    });
    return { runtime: session.serverInfo, status: summarize(status), payload: status.payload };
}

async function runDiagnostic(session, options) {
    const args = workloadArgs(options.repoRoot);
    const initialStatus = await timedTool(session, "manage_index", {
        action: "status",
        path: options.repoRoot,
        detail: "full",
    });
    if (initialStatus.payload?.status === "requires_reindex") {
        throw new Error("Live status requires reindex; benchmark stopped before mutation.");
    }
    const sync = await requireNoChangeSync(session, options.repoRoot, options.skipSync);
    const exactArgs = { ...args.exact, debugMode: "full" };
    const semanticArgs = { ...args.semantic, debugMode: "full" };
    const warmup = await timedTool(session, "search_codebase", exactArgs);
    if (warmup.payload?.status !== "ok") {
        throw new Error(`Exact warm-up failed: ${JSON.stringify(warmup.payload)}`);
    }
    await delay(options.settleMs);

    const exact = [];
    for (let sample = 0; sample < options.sampleCount; sample += 1) {
        exact.push(await timedTool(session, "search_codebase", exactArgs));
    }
    const semantic = [];
    for (let sample = 0; sample < options.sampleCount; sample += 1) {
        semantic.push(await timedTool(session, "search_codebase", semanticArgs));
    }

    const outlineWarmup = await timedTool(session, "file_outline", args.outline);
    if (outlineWarmup.payload?.status !== "ok") {
        throw new Error(`Outline warm-up failed: ${JSON.stringify(outlineWarmup.payload)}`);
    }
    const outline = [];
    for (let sample = 0; sample < options.sampleCount; sample += 1) {
        outline.push(await timedTool(session, "file_outline", args.outline));
    }

    const concurrentExact = await Promise.all([
        timedTool(session, "search_codebase", exactArgs),
        timedTool(session, "search_codebase", exactArgs),
    ]);
    const target = exact.at(-1)?.payload?.results?.find(
        (result) => result?.target?.symbolId,
    )?.target;
    const openSymbol = target
        ? await timedTool(session, "read_file", {
            path: path.join(options.repoRoot, target.file),
            open_symbol: {
                contractVersion: 2,
                symbolId: target.symbolId,
                context: { preset: "implementation" },
            },
            mode: "annotated",
        })
        : null;
    const graph = target
        ? await timedTool(session, "call_graph", {
            path: options.repoRoot,
            symbolRef: target,
            direction: "both",
            depth: 1,
            limit: 20,
        })
        : null;
    const finalStatus = await timedTool(session, "manage_index", {
        action: "status",
        path: options.repoRoot,
        detail: "diagnostics",
    });

    return {
        runtime: session.serverInfo,
        initialStatus: summarize(initialStatus),
        sync: sync ? summarize(sync) : { skipped: true },
        warmup: summarizeSearch(warmup),
        exact: {
            ...observationalStats(exact),
            samples: exact.map(summarizeSearch),
        },
        semantic: {
            ...observationalStats(semantic),
            samples: semantic.map(summarizeSearch),
        },
        outlineWarmup: summarizeNavigation(outlineWarmup),
        outline: {
            ...observationalStats(outline),
            samples: outline.map(summarizeNavigation),
        },
        concurrentExact: concurrentExact.map(summarizeSearch),
        openSymbol: openSymbol
            ? summarizeNavigation(openSymbol)
            : { skipped: "no exact symbol target" },
        graph: graph
            ? summarizeNavigation(graph)
            : { skipped: "no graph-ready exact target" },
        finalStatus: summarize(finalStatus),
    };
}

async function runWatcherDisabled(session, options) {
    if (process.env.MCP_ENABLE_WATCHER !== "false") {
        throw new Error("watcher-disabled mode requires MCP_ENABLE_WATCHER=false.");
    }
    const args = { ...workloadArgs(options.repoRoot).exact, debugMode: "full" };
    const sync = await requireNoChangeSync(session, options.repoRoot, options.skipSync);
    const warmup = await timedTool(session, "search_codebase", args);
    const sample = await timedTool(session, "search_codebase", args);
    return {
        runtime: session.serverInfo,
        sync: sync ? summarize(sync) : { skipped: true },
        warmup: summarizeSearch(warmup),
        sample: summarizeSearch(sample),
    };
}

async function runComparison(session, options) {
    const args = workloadArgs(options.repoRoot);
    const sync = await requireNoChangeSync(session, options.repoRoot, options.skipSync);
    await timedTool(session, "search_codebase", args.exact);
    await timedTool(session, "file_outline", args.outline);

    const graphWarmupSearch = await timedTool(session, "search_codebase", args.graphDiscovery);
    const graphWarmupTarget = graphWarmupSearch.payload?.results?.find(
        (result) => result?.target?.symbolId && result?.navigation?.graph === "ready",
    )?.target;
    if (!graphWarmupTarget) throw new Error("No graph-ready warm-up target.");
    await timedTool(session, "call_graph", {
        path: options.repoRoot,
        symbolRef: graphWarmupTarget,
        direction: "both",
        depth: 1,
        limit: 20,
    });

    const semantic = await timedTool(session, "search_codebase", args.semantic);
    const mutation = await timedTool(session, "search_codebase", args.mutation);
    const exact = await timedTool(session, "search_codebase", args.exact);
    const exactTarget = exact.payload?.results?.find(
        (result) => result?.target?.symbolId,
    )?.target;
    if (!exactTarget) throw new Error("No exact symbol target for read_file(open_symbol).");
    const callGraph = await timedTool(session, "call_graph", {
        path: options.repoRoot,
        symbolRef: graphWarmupTarget,
        direction: "both",
        depth: 1,
        limit: 20,
    });
    const outline = await timedTool(session, "file_outline", args.outline);
    const openSymbol = await timedTool(session, "read_file", {
        path: path.join(options.repoRoot, exactTarget.file),
        open_symbol: {
            contractVersion: 2,
            symbolId: exactTarget.symbolId,
            context: { preset: "implementation" },
        },
        mode: "annotated",
    });
    const readFile = await timedTool(session, "read_file", args.readFile);
    const architecture = await timedTool(session, "search_codebase", args.architecture);

    const [graphBodyStart, graphBodyEnd] = options.graphBodyRange.split(",");
    const exactSpan = exactTarget.span;
    if (
        !Number.isSafeInteger(exactSpan?.startLine)
        || !Number.isSafeInteger(exactSpan?.endLine)
        || exactSpan.startLine <= 0
        || exactSpan.endLine < exactSpan.startLine
    ) {
        throw new Error("Exact symbol target did not include a valid source span.");
    }
    const native = {
        semantic: timedNative(options.repoRoot, [
            "rg", "-n", "-i", "search_codebase|search.*handler|handle.*search",
            "packages/mcp/src", "--glob", "*.ts", "--glob", "!*.test.ts",
        ]),
        mutation: timedNative(options.repoRoot, [
            "rg", "-n", "-i", "mutation.*(generation|lease)|stale.*(read|evidence)|prepareRead",
            "packages/mcp/src/core", "--glob", "*.ts", "--glob", "!*.test.ts",
        ]),
        exact: timedNative(options.repoRoot, [
            "rg", "-n", "-m", "20", "runExactRegistryFastPath",
            "packages", "--glob", "*.ts",
        ]),
        callGraph: null,
        outline: timedNative(options.repoRoot, [
            "rg", "-n", "-m", "20",
            "class ToolHandlers|handleSearchCode|handleFileOutline|handleCallGraph",
            "packages/mcp/src/core/handlers.ts",
        ]),
        openSymbol: timedNative(options.repoRoot, [
            "sed", "-n", `${exactSpan.startLine},${exactSpan.endLine}p`, exactTarget.file,
        ]),
        readFile: timedNative(options.repoRoot, [
            "sed", "-n", "1,120p", "packages/mcp/src/core/handlers.ts",
        ]),
        architecture: timedNative(options.repoRoot, [
            "rg", "-n", "-i", "-m", "30", "core|mcp|cli|runtime",
            "ARCHITECTURE.md", "packages/core/package.json", "packages/mcp/package.json",
            "packages/cli/package.json", "pnpm-workspace.yaml",
        ]),
    };
    const nativeGraphSearch = timedNative(options.repoRoot, [
        "rg", "-n", "handleSearchCode\\(",
        "packages/mcp/src", "--glob", "*.ts", "--glob", "!*.test.ts",
    ]);
    const nativeGraphBody = timedNative(options.repoRoot, [
        "sed", "-n", `${graphBodyStart},${graphBodyEnd}p`, "packages/mcp/src/core/handlers.ts",
    ]);
    native.callGraph = {
        wallMs: nativeGraphSearch.wallMs + nativeGraphBody.wallMs,
        responseBytes: nativeGraphSearch.responseBytes + nativeGraphBody.responseBytes,
        calls: [nativeGraphSearch, nativeGraphBody],
    };

    const satori = {
        semantic: summarize(semantic),
        mutation: summarize(mutation),
        exact: summarize(exact),
        callGraph: summarize(callGraph),
        outline: summarize(outline),
        openSymbol: summarize(openSymbol),
        readFile: summarize(readFile),
        architecture: summarize(architecture),
    };
    const totals = (samples) => Object.values(samples).reduce(
        (total, sample) => ({
            wallMs: total.wallMs + sample.wallMs,
            responseBytes: total.responseBytes + sample.responseBytes,
        }),
        { wallMs: 0, responseBytes: 0 },
    );
    return {
        runtime: session.serverInfo,
        sync: sync ? summarize(sync) : { skipped: true },
        satori,
        native,
        totals: { satori: totals(satori), native: totals(native) },
        caveats: [
            "Native semantic and architecture rows are bounded lexical task comparators, not semantic-algorithm equivalents.",
            "The native open-symbol row uses the exact source span selected by the Satori result, so it measures direct known-span reading.",
        ],
    };
}

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function runGit(repoRoot, args) {
    const result = spawnSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) return null;
    return result.stdout;
}

function captureRepoProvenance(repoRoot, outputDir) {
    const head = runGit(repoRoot, ["rev-parse", "HEAD"])?.trim() || null;
    const trackedDiff = runGit(repoRoot, ["diff", "--binary", "HEAD"]);
    const stagedDiff = runGit(repoRoot, ["diff", "--cached", "--binary"]);
    const untrackedOutput = runGit(repoRoot, [
        "ls-files", "--others", "--exclude-standard", "-z",
    ]);
    const relativeOutputDir = path.relative(repoRoot, outputDir);
    const outputInsideRepo = relativeOutputDir
        && !relativeOutputDir.startsWith("..")
        && !path.isAbsolute(relativeOutputDir);
    const untrackedFiles = untrackedOutput === null
        ? null
        : untrackedOutput
            .split("\0")
            .filter(Boolean)
            .filter((relativeFile) => !outputInsideRepo
                || (relativeFile !== relativeOutputDir
                    && !relativeFile.startsWith(`${relativeOutputDir}${path.sep}`)))
            .sort()
            .map((relativeFile) => {
                const absoluteFile = path.join(repoRoot, relativeFile);
                const stat = fs.statSync(absoluteFile);
                return stat.isFile()
                    ? {
                        path: relativeFile,
                        bytes: stat.size,
                        sha256: sha256(fs.readFileSync(absoluteFile)),
                    }
                    : { path: relativeFile, type: "non_file" };
            });
    return {
        gitHead: head,
        trackedDiffSha256: trackedDiff === null ? null : sha256(trackedDiff),
        stagedDiffSha256: stagedDiff === null ? null : sha256(stagedDiff),
        untrackedFiles,
    };
}

function compareMetric(current, baseline) {
    if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
        return null;
    }
    return {
        current,
        baseline,
        delta: current - baseline,
        changePercent: ((current - baseline) / baseline) * 100,
        ratio: current / baseline,
    };
}

function compareSamples(current, baseline) {
    return {
        wallMs: compareMetric(current?.wallMs, baseline?.wallMs),
        responseBytes: compareMetric(current?.responseBytes, baseline?.responseBytes),
    };
}

function compareSampleGroups(current, baseline) {
    const keys = Object.keys(current || {}).filter((key) => baseline?.[key]);
    return Object.fromEntries(keys.map((key) => [
        key,
        compareSamples(current[key], baseline[key]),
    ]));
}

export function buildCurrentVsNative(result) {
    if (!result?.satori || !result?.native) return null;
    return {
        workloads: compareSampleGroups(result.satori, result.native),
        totals: compareSamples(result.totals?.satori, result.totals?.native),
    };
}

function diagnosticSamples(result) {
    const medianSample = (entry) => ({ wallMs: entry?.medianMs });
    return {
        exact: medianSample(result?.exact),
        semantic: medianSample(result?.semantic),
        outline: medianSample(result?.outline),
        openSymbol: result?.openSymbol,
        callGraph: result?.graph,
    };
}

export function buildCurrentVsLast(mode, current, previous) {
    if (!previous) return null;
    if (mode === "comparison") {
        return {
            satori: compareSampleGroups(current?.satori, previous?.satori),
            native: compareSampleGroups(current?.native, previous?.native),
            totals: {
                satori: compareSamples(current?.totals?.satori, previous?.totals?.satori),
                native: compareSamples(current?.totals?.native, previous?.totals?.native),
            },
        };
    }
    if (mode === "diagnostic") {
        return compareSampleGroups(diagnosticSamples(current), diagnosticSamples(previous));
    }
    return null;
}

export function readPreviousArtifact(outputDir, workloadIdentity) {
    if (!fs.existsSync(outputDir)) return null;
    const candidates = fs.readdirSync(outputDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(outputDir, file))
        .map((artifactPath) => {
            try {
                return {
                    artifactPath,
                    artifact: JSON.parse(fs.readFileSync(artifactPath, "utf8")),
                };
            } catch {
                return null;
            }
        })
        .filter((candidate) => candidate
            && candidate.artifact?.formatVersion === ARTIFACT_FORMAT_VERSION
            && candidate.artifact?.benchmarkId === BENCHMARK_ID
            && candidate.artifact?.workloadIdentity === workloadIdentity)
        .sort((left, right) => String(right.artifact.recordedAt)
            .localeCompare(String(left.artifact.recordedAt)));
    return candidates[0] || null;
}

function safeFilenamePart(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

export function writeArtifact(outputDir, artifact, label) {
    fs.mkdirSync(outputDir, { recursive: true });
    const timestamp = artifact.recordedAt.replace(/[:.]/g, "-");
    const suffix = label ? `-${safeFilenamePart(label)}` : "";
    const filename = `${timestamp}-${artifact.mode}${suffix}.json`;
    const artifactPath = path.join(outputDir, filename);
    const temporaryPath = path.join(outputDir, `.${filename}.${process.pid}.tmp`);
    fs.writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
    });
    fs.renameSync(temporaryPath, artifactPath);
    return artifactPath;
}

export function describeRun(options) {
    return {
        mode: options.mode,
        repoRoot: options.repoRoot,
        outputDir: options.outputDir,
        compareLast: options.compareLast,
        label: options.label,
        command: options.command,
        commandArgs: options.commandArgs,
        sampleCount: options.sampleCount,
        settleMs: options.settleMs,
        startupTimeoutMs: options.startupTimeoutMs,
        callTimeoutMs: options.callTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
        graphBodyRange: options.graphBodyRange,
        skipSync: options.skipSync,
        workloads: workloadArgs(options.repoRoot),
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (options.dryRun) {
        console.log(JSON.stringify(describeRun(options), null, 2));
        return;
    }

    const configuration = describeRun(options);
    const workloadIdentity = sha256(JSON.stringify({
        mode: options.mode,
        sampleCount: options.sampleCount,
        graphBodyRange: options.graphBodyRange,
        workloads: configuration.workloads,
    }));
    const provenance = captureRepoProvenance(options.repoRoot, options.outputDir);

    const session = new JsonRpcStdioSession({
        command: options.command,
        commandArgs: options.commandArgs,
        cwd: options.repoRoot,
        startupTimeoutMs: options.startupTimeoutMs,
        callTimeoutMs: options.callTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
    });
    try {
        await session.start();
        const result = options.mode === "status"
            ? await runStatus(session, options)
            : options.mode === "comparison"
                ? await runComparison(session, options)
                : options.mode === "watcher-disabled"
                    ? await runWatcherDisabled(session, options)
                    : await runDiagnostic(session, options);
        const previous = options.compareLast
            ? readPreviousArtifact(options.outputDir, workloadIdentity)
            : null;
        const artifact = {
            formatVersion: ARTIFACT_FORMAT_VERSION,
            benchmarkId: BENCHMARK_ID,
            recordedAt: new Date().toISOString(),
            mode: options.mode,
            workloadIdentity,
            configuration,
            provenance,
            result,
            comparisons: {
                currentVsNative: buildCurrentVsNative(result),
                currentVsLast: previous
                    ? {
                        previousArtifact: path.relative(options.outputDir, previous.artifactPath),
                        metrics: buildCurrentVsLast(
                            options.mode,
                            result,
                            previous.artifact.result,
                        ),
                    }
                    : null,
            },
        };
        const artifactPath = writeArtifact(options.outputDir, artifact, options.label);
        console.log(JSON.stringify({ artifactPath, artifact }, null, 2));
    } finally {
        await session.close();
    }
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
