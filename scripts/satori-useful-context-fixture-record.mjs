#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateTaskSuite } from "./satori-useful-context.mjs";
import {
    JsonRpcStdioSession,
    callAndDecode,
    extractCompletedOperationProof,
    hashTaskSuite,
    recordPhase,
    recorderNodeMetadata,
    replaceRepoRoot,
    requireOutputOutsideRoot,
} from "./satori-useful-context-record.mjs";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function usage() {
    return [
        "Usage: node scripts/satori-useful-context-fixture-record.mjs --tasks <tasks.json> --fixture-template <dir> [options]",
        "Options:",
        "  --out <observations.json>",
        "  --command <executable>          MCP command (default: managed launcher)",
        "  --command-arg <arg>             Repeat for each MCP command argument",
        "  --startup-timeout-ms <ms>",
        "  --call-timeout-ms <ms>",
        "  --close-timeout-ms <ms>",
        "  --ready-timeout-ms <ms>",
    ].join("\n");
}

export function parseFixtureArgs(argv) {
    const options = {
        tasksFile: null,
        fixtureTemplate: null,
        outFile: null,
        command: process.env.SATORI_MCP_COMMAND || path.join(os.homedir(), ".satori", "bin", "satori-mcp.js"),
        commandArgs: [],
        startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
        readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value after ${arg}.`);
            return argv[index];
        };
        if (arg === "--") continue;
        if (arg === "--tasks") options.tasksFile = path.resolve(next());
        else if (arg === "--fixture-template") options.fixtureTemplate = path.resolve(next());
        else if (arg === "--out") options.outFile = path.resolve(next());
        else if (arg === "--command") options.command = next();
        else if (arg === "--command-arg") options.commandArgs.push(next());
        else if (arg === "--startup-timeout-ms") options.startupTimeoutMs = positiveInteger(next(), arg);
        else if (arg === "--call-timeout-ms") options.callTimeoutMs = positiveInteger(next(), arg);
        else if (arg === "--close-timeout-ms") options.closeTimeoutMs = positiveInteger(next(), arg);
        else if (arg === "--ready-timeout-ms") options.readyTimeoutMs = positiveInteger(next(), arg);
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (!options.help && (!options.tasksFile || !options.fixtureTemplate)) {
        throw new Error("Both --tasks and --fixture-template are required.");
    }
    return options;
}

function validateRelativeFile(file, label) {
    if (typeof file !== "string" || file.length === 0 || path.isAbsolute(file)) {
        throw new Error(`${label} must be a non-empty repository-relative path.`);
    }
    const normalized = file.replaceAll("\\", "/");
    if (normalized.split("/").includes("..") || normalized.startsWith("/")) {
        throw new Error(`${label} must stay inside the fixture root.`);
    }
    return normalized;
}

export function validateFixtureMutations(rawSuite, validatedSuite) {
    const byId = new Map(rawSuite.tasks.map((task) => [task.id, task]));
    return new Map(validatedSuite.tasks.map((task) => {
        const rawMutations = byId.get(task.id)?.fixture?.mutations ?? [];
        if (!Array.isArray(rawMutations)) {
            throw new Error(`Task '${task.id}' fixture.mutations must be an array.`);
        }
        const mutations = rawMutations.map((raw, index) => {
            if (!isRecord(raw) || raw.type !== "replace") {
                throw new Error(`Task '${task.id}' fixture.mutations[${index}] supports only type='replace'.`);
            }
            if (typeof raw.from !== "string" || raw.from.length === 0 || typeof raw.to !== "string" || raw.to.length === 0) {
                throw new Error(`Task '${task.id}' fixture replacement values must be non-empty strings.`);
            }
            return {
                type: "replace",
                file: validateRelativeFile(raw.file, `Task '${task.id}' fixture mutation file`),
                from: raw.from,
                to: raw.to,
            };
        });
        return [task.id, mutations];
    }));
}

function initializeFixtureRepo(template, fixtureRoot) {
    const pending = [template];
    while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const candidate = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Fixture template must not contain symbolic links: ${path.relative(template, candidate)}`);
            }
            if (entry.isDirectory()) pending.push(candidate);
        }
    }
    fs.cpSync(template, fixtureRoot, { recursive: true, errorOnExist: true, force: false });
    const commands = [
        ["init", "-q"],
        ["add", "--all"],
        ["-c", "user.name=Satori Fixture", "-c", "user.email=fixture@satori.invalid", "commit", "-qm", "fixture baseline"],
    ];
    for (const args of commands) {
        const result = spawnSync("git", args, { cwd: fixtureRoot, encoding: "utf8" });
        if (result.status !== 0) {
            throw new Error(`Failed to initialize fixture Git repository: ${result.stderr.trim() || "git failed"}.`);
        }
    }
}

function applyMutations(fixtureRoot, mutations) {
    const root = fs.realpathSync(fixtureRoot);
    for (const mutation of mutations) {
        const target = path.resolve(root, mutation.file);
        const relative = path.relative(root, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error("Fixture mutation resolved outside the isolated root.");
        }
        const targetStat = fs.lstatSync(target);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
            throw new Error(`Fixture mutation target '${mutation.file}' must be a regular file.`);
        }
        const verifiedTarget = fs.realpathSync(target);
        const verifiedRelative = path.relative(root, verifiedTarget);
        if (verifiedRelative.startsWith("..") || path.isAbsolute(verifiedRelative)) {
            throw new Error("Fixture mutation resolved outside the isolated root.");
        }
        const source = fs.readFileSync(verifiedTarget, "utf8");
        const occurrences = source.split(mutation.from).length - 1;
        if (occurrences !== 1) {
            throw new Error(`Fixture mutation '${mutation.file}' expected exactly one source match; found ${occurrences}.`);
        }
        fs.writeFileSync(verifiedTarget, source.replace(mutation.from, mutation.to));
    }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitUntilReady(session, fixtureRoot, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const { payload } = await callAndDecode(session, {
            tool: "manage_index",
            args: { action: "status", path: fixtureRoot },
        });
        if (payload.status === "ok") return payload;
        if (["error", "blocked", "requires_reindex"].includes(payload.status)) {
            throw new Error(`Fixture index did not become ready (status=${payload.status}, reason=${payload.reason || "unknown"}).`);
        }
        if (Date.now() >= deadline) {
            throw new Error(`Fixture index did not become ready within ${timeoutMs}ms.`);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

function addStaleRecoveryEvidence(task, cold, warm, syncProof) {
    if (task.queryClass !== "stale_recovery") return;
    const staleDetected = syncProof?.status === "ok"
        && syncProof?.operation?.action === "sync"
        && syncProof?.operation?.phase === "completed"
        && Number.isInteger(syncProof?.syncStats?.modified)
        && syncProof.syncStats.modified >= 1;
    const ownerRecovered = (observation) => observation.status === "ok"
        && observation.results.some((result) => result.file === task.expected.ownerFile
            && result.symbol === task.expected.ownerSymbol);
    const recovered = staleDetected && ownerRecovered(cold) && ownerRecovered(warm);
    for (const observation of [cold, warm]) {
        observation.staleIndexDetected = staleDetected;
        observation.recoverySucceeded = recovered;
    }
}

export async function recordFixtureSuite(rawSuite, options) {
    const validated = validateTaskSuite(rawSuite);
    const mutations = validateFixtureMutations(rawSuite, validated);
    const template = fs.realpathSync(options.fixtureTemplate);
    const observations = [];
    const taskRuns = [];
    let serverInfo;

    for (const unexpandedTask of validated.tasks) {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-useful-context-fixture-"));
        let session;
        let createAttempted = false;
        let clearSucceeded = false;
        let primaryError;
        const cleanupErrors = [];
        try {
            initializeFixtureRepo(template, fixtureRoot);
            const task = replaceRepoRoot(unexpandedTask, fixtureRoot);
            session = new JsonRpcStdioSession({ ...options, cwd: fixtureRoot });
            await session.start();
            if (serverInfo && JSON.stringify(serverInfo) !== JSON.stringify(session.serverInfo)) {
                throw new Error(`MCP serverInfo changed during fixture recording for task '${task.id}'.`);
            }
            serverInfo = structuredClone(session.serverInfo);
            createAttempted = true;
            const created = await callAndDecode(session, {
                tool: "manage_index",
                args: { action: "create", path: fixtureRoot },
            });
            if (["error", "blocked", "requires_reindex"].includes(created.payload.status)) {
                throw new Error(`Fixture create was refused (status=${created.payload.status}).`);
            }
            const ready = await waitUntilReady(session, fixtureRoot, options.readyTimeoutMs);
            let indexProof = extractCompletedOperationProof(ready, fixtureRoot, "create");
            let preparationSyncStats;
            if (task.queryClass === "dirty_owner") {
                const prepared = (await callAndDecode(session, {
                    tool: "manage_index",
                    args: { action: "sync", path: fixtureRoot },
                })).payload;
                if (prepared.status !== "ok"
                    || prepared.syncStats?.added !== 0
                    || prepared.syncStats?.removed !== 0
                    || prepared.syncStats?.modified !== 0) {
                    throw new Error(`Task '${task.id}' could not establish a no-change freshness preparation.`);
                }
                indexProof = extractCompletedOperationProof(prepared, fixtureRoot, "sync");
                preparationSyncStats = structuredClone(prepared.syncStats);
            }
            applyMutations(fixtureRoot, mutations.get(task.id) || []);
            let staleSyncProof;
            if (task.queryClass === "stale_recovery") {
                staleSyncProof = (await callAndDecode(session, {
                    tool: "manage_index",
                    args: { action: "sync", path: fixtureRoot },
                })).payload;
                if (staleSyncProof.status !== "ok") {
                    throw new Error(`Fixture stale recovery sync failed (status=${staleSyncProof.status || "unknown"}).`);
                }
                indexProof = extractCompletedOperationProof(staleSyncProof, fixtureRoot, "sync");
                preparationSyncStats = structuredClone(staleSyncProof.syncStats);
            }
            const cold = await recordPhase(session, task, "cold", fixtureRoot);
            if (task.queryClass === "dirty_owner") {
                const ownerFound = cold.results.some((result) => result.file === task.expected.ownerFile
                    && result.symbol === task.expected.ownerSymbol);
                if (cold.status !== "ok" || !ownerFound || cold.response?.freshnessDecision?.mode !== "skipped_recent") {
                    throw new Error(`Task '${task.id}' did not prove bounded dirty-file overlay with freshnessDecision.mode='skipped_recent'.`);
                }
            }
            const warm = await recordPhase(session, task, "warm", fixtureRoot);
            const finalStatus = (await callAndDecode(session, {
                tool: "manage_index",
                args: { action: "status", path: fixtureRoot },
            })).payload;
            const finalProof = extractCompletedOperationProof(finalStatus, fixtureRoot, indexProof.action);
            if (finalStatus.status !== "ok" || JSON.stringify(finalProof) !== JSON.stringify(indexProof)) {
                throw new Error(`Task '${task.id}' index generation or operation proof drifted during measured calls.`);
            }
            addStaleRecoveryEvidence(task, cold, warm, staleSyncProof);
            observations.push(cold, warm);
            taskRuns.push({
                taskId: task.id,
                indexProof,
                ...(preparationSyncStats ? { syncStats: preparationSyncStats } : {}),
            });
        } catch (error) {
            primaryError = error;
        } finally {
            if (session && createAttempted) {
                try {
                    const cleared = await callAndDecode(session, {
                        tool: "manage_index",
                        args: { action: "clear", path: fixtureRoot },
                    });
                    clearSucceeded = cleared.payload.status === "ok";
                } catch (error) {
                    clearSucceeded = false;
                    cleanupErrors.push(`clear failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (session) {
                try {
                    await session.close();
                } catch (error) {
                    cleanupErrors.push(`runtime close failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (!createAttempted || clearSucceeded) {
                fs.rmSync(fixtureRoot, { recursive: true, force: true });
            } else {
                cleanupErrors.push(`isolated root retained for operator cleanup: ${fixtureRoot}`);
            }
        }
        if (primaryError || cleanupErrors.length > 0) {
            const messages = [
                ...(primaryError ? [`fixture run failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`] : []),
                ...cleanupErrors,
            ];
            throw new Error(messages.join("; "));
        }
    }
    return {
        version: 1,
        metadata: {
            fixtureIsolated: true,
            taskSuiteSha256: hashTaskSuite(rawSuite),
            serverInfo,
            node: recorderNodeMetadata(),
            taskRuns,
        },
        observations,
    };
}

function containingCheckoutRoot(template) {
    const result = spawnSync("git", ["-C", template, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim().length > 0
        ? fs.realpathSync(result.stdout.trim())
        : fs.realpathSync(template);
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseFixtureArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return null;
    }
    if (!fs.statSync(options.fixtureTemplate).isDirectory()) {
        throw new Error("Fixture template must be a directory.");
    }
    requireOutputOutsideRoot(options.outFile, containingCheckoutRoot(options.fixtureTemplate), "Fixture recorder");
    const suite = JSON.parse(fs.readFileSync(options.tasksFile, "utf8"));
    const output = await recordFixtureSuite(suite, options);
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (options.outFile) fs.writeFileSync(options.outFile, serialized);
    else process.stdout.write(serialized);
    return output;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`satori-useful-context-fixture-record: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
        process.exitCode = 1;
    }
}
