import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManageMaintenanceHandlers } from "./manage-maintenance-handlers.js";
import type { RuntimeOwnersSummary } from "./runtime-owner.js";

async function withTempRepo(fn: (repoPath: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-status-owners-"));
    try {
        const repoPath = path.join(dir, "repo");
        fs.mkdirSync(repoPath);
        await fn(repoPath);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function parseManageEnvelope(response: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
    const text = response.content[0]?.text || "";
    return JSON.parse(text) as Record<string, unknown>;
}

test("handleGetIndexingStatus includes runtimeOwners hint and status line", async () => {
    await withTempRepo(async (repoPath) => {
        const summary: RuntimeOwnersSummary = {
            liveCount: 1,
            versions: ["4.11.15"],
            multiVersion: false,
            registryPath: "/tmp/owners.json",
            owners: [{ pid: 42, satoriVersion: "4.11.15", lastSeenAt: "t", configSource: "env" }],
        };
        let summaryCalls = 0;
        const host = {
            context: { clearIndex: async () => undefined },
            snapshotManager: { removeCodebaseCompletely: () => undefined },
            syncManager: { ensureFreshness: async () => ({ mode: "skipped_recent" as const }) },
            trackedRootReadiness: {
                prepareTrackedRootForRead: async () => ({
                    state: "ready" as const,
                    root: {
                        path: repoPath,
                        info: { status: "indexed" as const, lastUpdated: new Date().toISOString() },
                    },
                }),
                buildMissingLocalCollectionMessage: () => "missing",
            },
            getSnapshotAllCodebases: () => [repoPath],
            getSnapshotIndexedCodebases: () => [repoPath],
            getSnapshotIndexingCodebases: () => [],
            getSnapshotCodebaseStatus: () => "indexed",
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                indexedFiles: 1,
                totalChunks: 1,
                lastUpdated: new Date().toISOString(),
            }),
            getSnapshotCorruptionWarning: () => undefined,
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            recoverStaleIndexingStateIfNeeded: async () => undefined,
            manageResponse: (
                action: string,
                pathValue: string,
                status: string,
                message: string,
                options?: Record<string, unknown>,
            ) => ({
                content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                        tool: "manage_index",
                        action,
                        path: pathValue,
                        status,
                        humanText: message,
                        ...options,
                    }),
                }],
            }),
            buildCreateHint: (p: string) => ({ tool: "manage_index", args: { action: "create", path: p } }),
            buildManageActionBlockedMessage: () => "blocked",
            buildStatusHint: (p: string) => ({ tool: "manage_index", args: { action: "status", path: p } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            markCodebaseCleared: () => undefined,
            resolveCollectionName: () => "col",
            clearIndexingStats: () => undefined,
            saveSnapshotIfSupported: () => undefined,
            unwatchCodebase: async () => undefined,
            refreshSnapshotStateFromDisk: () => undefined,
            buildReindexInstruction: () => "reindex",
            buildCompatibilityStatusLines: () => "",
            buildManageRequiresReindexHints: () => ({}),
            buildSyncHint: (p: string) => ({ tool: "manage_index", args: { action: "sync", path: p } }),
            buildStaleLocalHint: () => ({}),
            buildStaleLocalMessage: () => "stale",
            canSyncStaleLocal: () => false,
            enforceFingerprintGate: () => ({}),
            buildReindexHint: (p: string) => ({ tool: "manage_index", args: { action: "reindex", path: p } }),
            touchWatchedCodebase: async () => undefined,
            manageVectorBackendResponse: () => ({ content: [{ type: "text" as const, text: "{}" }] }),
            getLiveOwnersSummary: async () => {
                summaryCalls += 1;
                return summary;
            },
        };

        const handlers = new ManageMaintenanceHandlers(host as never);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath, detail: "diagnostics" });
        const envelope = parseManageEnvelope(response);

        assert.equal(summaryCalls, 1);
        assert.match(String(envelope.humanText || ""), /Runtime owners: 1 live \(pid=42 satori@4\.11\.15\)/);
        const hints = envelope.hints as Record<string, unknown> | undefined;
        assert.deepEqual(hints?.runtimeOwners, summary);
    });
});

test("handleGetIndexingStatus does not fail when getLiveOwnersSummary returns null", async () => {
    await withTempRepo(async (repoPath) => {
        let ownerSummaryCalls = 0;
        let compatibilityCalls = 0;
        const host = {
            context: { clearIndex: async () => undefined },
            snapshotManager: { removeCodebaseCompletely: () => undefined },
            syncManager: { ensureFreshness: async () => ({ mode: "skipped_recent" as const }) },
            trackedRootReadiness: {
                prepareTrackedRootForRead: async () => ({
                    state: "ready" as const,
                    root: {
                        path: repoPath,
                        info: { status: "indexed" as const, lastUpdated: new Date().toISOString() },
                    },
                }),
                buildMissingLocalCollectionMessage: () => "missing",
            },
            getSnapshotAllCodebases: () => [repoPath],
            getSnapshotIndexedCodebases: () => [repoPath],
            getSnapshotIndexingCodebases: () => [],
            getSnapshotCodebaseStatus: () => "indexed",
            getSnapshotCodebaseInfo: () => ({
                status: "indexed",
                indexedFiles: 1,
                totalChunks: 1,
                lastUpdated: new Date().toISOString(),
            }),
            getSnapshotCorruptionWarning: () => undefined,
            buildRuntimeOwnerConflictResponseIfBlocked: async () => null,
            recoverStaleIndexingStateIfNeeded: async () => undefined,
            manageResponse: (
                action: string,
                pathValue: string,
                status: string,
                message: string,
                options?: Record<string, unknown>,
            ) => ({
                content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                        tool: "manage_index",
                        action,
                        path: pathValue,
                        status,
                        humanText: message,
                        ...options,
                    }),
                }],
            }),
            buildCreateHint: (p: string) => ({ tool: "manage_index", args: { action: "create", path: p } }),
            buildManageActionBlockedMessage: () => "blocked",
            buildStatusHint: (p: string) => ({ tool: "manage_index", args: { action: "status", path: p } }),
            getManageRetryAfterMs: () => 2000,
            buildIndexingMetadata: () => undefined,
            markCodebaseCleared: () => undefined,
            resolveCollectionName: () => "col",
            clearIndexingStats: () => undefined,
            saveSnapshotIfSupported: () => undefined,
            unwatchCodebase: async () => undefined,
            refreshSnapshotStateFromDisk: () => undefined,
            buildReindexInstruction: () => "reindex",
            buildCompatibilityStatusLines: () => {
                compatibilityCalls += 1;
                return "\nCOMPATIBILITY_DIAGNOSTIC";
            },
            buildManageRequiresReindexHints: () => ({}),
            buildSyncHint: (p: string) => ({ tool: "manage_index", args: { action: "sync", path: p } }),
            buildStaleLocalHint: () => ({}),
            buildStaleLocalMessage: () => "stale",
            canSyncStaleLocal: () => false,
            enforceFingerprintGate: () => ({}),
            buildReindexHint: (p: string) => ({ tool: "manage_index", args: { action: "reindex", path: p } }),
            touchWatchedCodebase: async () => undefined,
            manageVectorBackendResponse: () => ({ content: [{ type: "text" as const, text: "{}" }] }),
            getLiveOwnersSummary: async () => {
                ownerSummaryCalls += 1;
                return null;
            },
        };

        const handlers = new ManageMaintenanceHandlers(host as never);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, "ok");
        assert.equal(envelope.detail, "summary");
        assert.equal(ownerSummaryCalls, 0);
        assert.equal(compatibilityCalls, 0);
        assert.equal(envelope.languageCapabilities, undefined);
        assert.deepEqual(Object.keys(envelope.symbolQuality as Record<string, unknown>).sort(), [
            "basis",
            "message",
            "status",
        ]);
        assert.doesNotMatch(String(envelope.humanText || ""), /Runtime owners:/);
        assert.doesNotMatch(String(envelope.humanText || ""), /none live/);
        assert.doesNotMatch(String(envelope.humanText || ""), /COMPATIBILITY_DIAGNOSTIC/);
        assert.equal(Buffer.byteLength(response.content[0]?.text ?? "", "utf8") < 4 * 1024, true);

        const capabilitiesResponse = await handlers.handleGetIndexingStatus({
            path: repoPath,
            detail: "capabilities",
        });
        const capabilitiesEnvelope = parseManageEnvelope(capabilitiesResponse);
        assert.equal(capabilitiesEnvelope.detail, "capabilities");
        assert.ok(capabilitiesEnvelope.languageCapabilities);
        assert.ok((capabilitiesEnvelope.symbolQuality as Record<string, unknown>).languages);
        assert.equal(ownerSummaryCalls, 0);
        assert.equal(compatibilityCalls, 0);
    });
});
