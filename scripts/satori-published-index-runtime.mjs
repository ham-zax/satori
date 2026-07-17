#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

if (process.env.SATORI_EVAL_PUBLISHED_INDEX !== "1") {
    throw new Error("SATORI_EVAL_PUBLISHED_INDEX=1 is required for the no-sync evaluation runtime.");
}

const entryArg = process.argv[2];
if (typeof entryArg !== "string" || entryArg.length === 0) {
    throw new Error("The exact MCP dist entry path is required as the first argument.");
}

const entryPath = path.resolve(entryArg);
const syncModulePath = path.join(path.dirname(entryPath), "core", "sync.js");
const syncModule = await import(pathToFileURL(syncModulePath).href);
const SyncManager = syncModule.SyncManager;
if (typeof SyncManager !== "function" || typeof SyncManager.prototype.ensureFreshness !== "function") {
    throw new Error(`The exact MCP runtime at '${entryPath}' exposes no patchable SyncManager.`);
}

SyncManager.prototype.ensureFreshness = async function noSyncPublishedIndexFreshness(
    _codebasePath,
    thresholdMs = 60_000,
) {
    const checkedAtMs = Date.now();
    return {
        mode: "skipped_recent",
        checkedAt: new Date(checkedAtMs).toISOString(),
        thresholdMs,
    };
};

process.argv = [process.argv[0], entryPath, ...process.argv.slice(3)];
await import(pathToFileURL(entryPath).href);
