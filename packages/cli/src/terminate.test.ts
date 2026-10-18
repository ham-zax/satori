import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    formatTerminateText,
    terminateSatoriServers,
} from "./terminate.js";
import { CliError } from "./errors.js";

function withStateRoot(run: (stateRoot: string) => Promise<void>): Promise<void> {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-terminate-"));
    return run(stateRoot).finally(() => {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });
}

test("terminate stops each verified Satori process once across both registries", async () => {
    await withStateRoot(async (stateRoot) => {
        const runtimeDirectory = path.join(stateRoot, "runtime-owner");
        const hostDirectory = path.join(stateRoot, "runtime-host", "identity");
        fs.mkdirSync(runtimeDirectory, { recursive: true });
        fs.mkdirSync(hostDirectory, { recursive: true });
        fs.writeFileSync(path.join(runtimeDirectory, "owners.json"), JSON.stringify({
            formatVersion: "v1",
            updatedAt: "2026-07-26T00:00:00.000Z",
            owners: [{
                ownerId: "owner",
                pid: 41001,
                processStartTime: "100",
            }],
        }));
        fs.writeFileSync(path.join(hostDirectory, "host.json"), JSON.stringify({
            formatVersion: 1,
            protocolVersion: 1,
            hostPid: 41001,
            bootId: "boot-a",
            processStartTime: "100",
        }));

        const live = new Set([41001]);
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const result = await terminateSatoriServers({
            env: { SATORI_STATE_ROOT: stateRoot },
            inspectProcess: (pid) => live.has(pid)
                ? { pid, bootId: "boot-a", processStartTime: "100" }
                : null,
            signalProcess: (pid, signal) => {
                signals.push({ pid, signal });
                live.delete(pid);
            },
        });

        assert.equal(result.status, "terminated");
        assert.deepEqual(signals, [{ pid: 41001, signal: "SIGTERM" }]);
        assert.deepEqual(result.terminated, [{
            pid: 41001,
            sources: ["runtime-owner", "shared-runtime-host"],
        }]);
        assert.equal(result.staleRecordCount, 0);
        assert.equal(result.unverifiedRecordCount, 0);
        assert.match(formatTerminateText(result), /^Satori servers terminated/);
    });
});

test("terminate ignores stale PID records instead of signaling a replacement process", async () => {
    await withStateRoot(async (stateRoot) => {
        const runtimeDirectory = path.join(stateRoot, "runtime-owner");
        fs.mkdirSync(runtimeDirectory, { recursive: true });
        fs.writeFileSync(path.join(runtimeDirectory, "owners.json"), JSON.stringify({
            formatVersion: "v1",
            updatedAt: "2026-07-26T00:00:00.000Z",
            owners: [{
                ownerId: "stale-owner",
                pid: 41002,
                processStartTime: "old-start",
            }],
        }));
        let signalCount = 0;

        const result = await terminateSatoriServers({
            env: { SATORI_STATE_ROOT: stateRoot },
            inspectProcess: (pid) => ({
                pid,
                bootId: "boot-a",
                processStartTime: "replacement-start",
            }),
            signalProcess: () => {
                signalCount += 1;
            },
        });

        assert.equal(result.status, "not_running");
        assert.equal(result.staleRecordCount, 1);
        assert.equal(signalCount, 0);
        assert.equal(formatTerminateText(result), "No Satori servers are running.\n");
    });
});

test("terminate fails closed when process inspection is denied and keeps missing PIDs stale", async () => {
    await withStateRoot(async (stateRoot) => {
        const runtimeDirectory = path.join(stateRoot, "runtime-owner");
        fs.mkdirSync(runtimeDirectory, { recursive: true });
        fs.writeFileSync(path.join(runtimeDirectory, "owners.json"), JSON.stringify({
            formatVersion: "v1",
            updatedAt: "2026-07-26T00:00:00.000Z",
            owners: [{
                ownerId: "inspection-owner",
                pid: 41004,
                processStartTime: "100",
            }],
        }));

        const originalKill = process.kill;
        const realKill = process.kill.bind(process);
        let inspectionCode: "EPERM" | "ESRCH" = "EPERM";
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === 41004 && signal === 0) {
                const error = new Error(inspectionCode === "EPERM" ? "permission denied" : "no such process") as NodeJS.ErrnoException;
                error.code = inspectionCode;
                throw error;
            }
            return realKill(pid, signal);
        }) as typeof process.kill;

        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const options = {
            env: { SATORI_STATE_ROOT: stateRoot },
            signalProcess: (pid: number, signal: NodeJS.Signals) => signals.push({ pid, signal }),
        };
        try {
            await assert.rejects(terminateSatoriServers(options), (error: unknown) => {
                if (!(error instanceof CliError)) return false;
                assert.equal(error.token, "E_TERMINATION_FAILED");
                assert.match(error.message, /Failed to inspect Satori server process pid=41004: permission denied/);
                return true;
            });
            assert.deepEqual(signals, []);

            inspectionCode = "ESRCH";
            const result = await terminateSatoriServers(options);
            assert.equal(result.status, "not_running");
            assert.equal(result.staleRecordCount, 1);
            assert.deepEqual(signals, []);
        } finally {
            process.kill = originalKill;
        }
    });
});

test("terminate reports malformed lifecycle state without signaling an unverified PID", async () => {
    await withStateRoot(async (stateRoot) => {
        const hostDirectory = path.join(stateRoot, "runtime-host", "identity");
        fs.mkdirSync(hostDirectory, { recursive: true });
        fs.writeFileSync(path.join(hostDirectory, "host.json"), "{\"hostPid\":41003}\n");
        let signalCount = 0;

        const result = await terminateSatoriServers({
            env: { SATORI_STATE_ROOT: stateRoot },
            inspectProcess: () => ({
                pid: 41003,
                bootId: "boot-a",
                processStartTime: "100",
            }),
            signalProcess: () => {
                signalCount += 1;
            },
        });

        assert.equal(result.status, "partial");
        assert.equal(result.unverifiedRecordCount, 1);
        assert.equal(signalCount, 0);
        assert.match(formatTerminateText(result), /unverified state/);
    });
});
