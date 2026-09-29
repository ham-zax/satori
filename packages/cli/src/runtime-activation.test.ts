import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { activateAfterRetiringManagedRuntime } from "./runtime-activation.js";
import { buildLauncherScript } from "./managed-launcher-script.mjs";
import type { TerminateResult } from "./terminate.js";

function notRunning(homeDir: string): TerminateResult {
    return {
        action: "terminate",
        status: "not_running",
        stateRoot: path.join(homeDir, ".satori"),
        terminated: [],
        staleRecordCount: 0,
        unverifiedRecordCount: 0,
    };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-runtime-activation-"));
    try {
        await run(homeDir);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
}

function writeActiveLauncher(homeDir: string): void {
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        managedLauncherPath: launcherPath,
        managedEnv: { SATORI_RUNTIME_PROFILE: "connected" },
    }), "utf8");
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 3_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for runtime activation test condition.");
}

function readProcessTitle(pid: number): string {
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
    } catch {
        return "";
    }
}

function writeManagedRuntime(homeDir: string): string {
    const runtimeRoot = path.join(homeDir, ".satori", "mcp-runtime", "@satori-code-mcp@9.9.9");
    const packageRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@satori-code/mcp",
        version: "9.9.9",
    }), "utf8");
    return runtimeRoot;
}

test("activation retires servers on both sides of launcher drain before applying the new runtime", async () => {
    await withTempHome(async (homeDir) => {
        const events: string[] = [];
        let terminateCalls = 0;

        const value = await activateAfterRetiringManagedRuntime({
            homeDir,
            terminateRunner: async () => {
                terminateCalls += 1;
                events.push(`terminate-${terminateCalls}`);
                return notRunning(homeDir);
            },
        }, () => {
            events.push("activate");
            writeActiveLauncher(homeDir);
            return 42;
        });

        assert.equal(value, 42);
        assert.deepEqual(events, ["terminate-1", "terminate-2", "activate", "terminate-3"]);
    });
});

test("activation drains every live managed launcher lease before applying the new runtime", async () => {
    await withTempHome(async (homeDir) => {
        const runtimeRoot = writeManagedRuntime(homeDir);
        const leasesRoot = path.join(homeDir, ".satori", "mcp-runtime", ".leases");
        fs.mkdirSync(leasesRoot, { recursive: true });

        const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
        });
        const closed = once(launcher, "close");
        fs.writeFileSync(path.join(leasesRoot, "live.json"), JSON.stringify({
            formatVersion: 1,
            leaseId: "live",
            pid: launcher.pid,
            runtimeRoot,
            acquiredAt: new Date().toISOString(),
        }), "utf8");

        let activated = false;
        try {
            await activateAfterRetiringManagedRuntime({
                homeDir,
                terminateRunner: async () => notRunning(homeDir),
            }, () => {
                activated = true;
                writeActiveLauncher(homeDir);
            });
            await closed;

            assert.equal(activated, true);
            assert.equal(
                fs.readdirSync(leasesRoot).some((entry) => entry.endsWith(".json")),
                false,
            );
        } finally {
            if (launcher.exitCode === null && launcher.signalCode === null) {
                launcher.kill("SIGTERM");
                await closed;
            }
        }
    });
});

test("activation retires a live launcher from the previous cohort after replacing the stable launcher", {
    skip: process.platform !== "linux" ? "Satori release activation is qualified on Linux/WSL2" : false,
}, async () => {
    await withTempHome(async (homeDir) => {
        const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            managedLauncherPath: launcherPath,
            managedEnv: { SATORI_RUNTIME_PROFILE: "connected", SATORI_TEST_COHORT: "old" },
        }), "utf8");

        const staleLauncher = spawn(process.execPath, [launcherPath], {
            stdio: ["pipe", "ignore", "ignore"],
        });
        const closed = once(staleLauncher, "close");
        try {
            await waitFor(() => readProcessTitle(staleLauncher.pid ?? -1).startsWith("satori-mcp:"));

            await activateAfterRetiringManagedRuntime({
                homeDir,
                terminateRunner: async () => notRunning(homeDir),
            }, () => {
                fs.writeFileSync(launcherPath, buildLauncherScript({
                    command: process.execPath,
                    args: ["-e", "setInterval(() => {}, 1000)"],
                    managedLauncherPath: launcherPath,
                    managedEnv: { SATORI_RUNTIME_PROFILE: "connected", SATORI_TEST_COHORT: "new" },
                }), "utf8");
            });
            await closed;

            assert.notEqual(staleLauncher.signalCode, null);
        } finally {
            if (staleLauncher.exitCode === null && staleLauncher.signalCode === null) {
                staleLauncher.kill("SIGKILL");
                await closed;
            }
        }
    });
});

test("activation fails closed before mutation when server ownership is only partially verified", async () => {
    await withTempHome(async (homeDir) => {
        let activated = false;
        const partial: TerminateResult = {
            action: "terminate",
            status: "partial",
            stateRoot: path.join(homeDir, ".satori"),
            terminated: [],
            staleRecordCount: 0,
            unverifiedRecordCount: 1,
        };

        await assert.rejects(
            activateAfterRetiringManagedRuntime({
                homeDir,
                terminateRunner: async () => partial,
            }, () => {
                activated = true;
            }),
            /ownership is only partially verified/,
        );
        assert.equal(activated, false);
    });
});

test("activation recovers old malformed lease debris but rejects a fresh ambiguous lease", async () => {
    await withTempHome(async (homeDir) => {
        writeManagedRuntime(homeDir);
        const leasesRoot = path.join(homeDir, ".satori", "mcp-runtime", ".leases");
        fs.mkdirSync(leasesRoot, { recursive: true });
        const malformed = path.join(leasesRoot, "malformed.json");
        fs.writeFileSync(malformed, "", "utf8");
        fs.utimesSync(malformed, new Date(0), new Date(0));

        await activateAfterRetiringManagedRuntime({
            homeDir,
            terminateRunner: async () => notRunning(homeDir),
        }, () => {
            writeActiveLauncher(homeDir);
        });
        assert.equal(fs.existsSync(malformed), false);

        fs.writeFileSync(malformed, "", "utf8");
        let activated = false;
        await assert.rejects(
            activateAfterRetiringManagedRuntime({
                homeDir,
                terminateRunner: async () => notRunning(homeDir),
            }, () => {
                activated = true;
            }),
            /managed launcher leases are unverified/,
        );
        assert.equal(activated, false);
    });
});
