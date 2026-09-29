import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { buildLauncherScript } from "./managed-launcher-script.mjs";
import {
    acquireManagedRuntimeMutationLock,
    pruneManagedRuntimeStore,
} from "./managed-runtime-store.js";

type ProcessIdentity = Readonly<{
    pid: number;
    bootId?: string;
    processStartTime?: string;
}>;

async function withTempHome(run: (homeDir: string) => void | Promise<void>): Promise<void> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-runtime-store-"));
    try {
        await run(homeDir);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
}

function writeRuntime(homeDir: string, version: string, suffix = ""): string {
    const runtimeRoot = path.join(
        homeDir,
        ".satori",
        "mcp-runtime",
        `@satori-code-mcp@${version}${suffix}`,
    );
    const packageRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@satori-code/mcp",
        version,
    }), "utf8");
    return runtimeRoot;
}

function packageRoot(runtimeRoot: string): string {
    return path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
}

function processInspector(
    identities: Readonly<Record<number, ProcessIdentity>>,
): (pid: number) => ProcessIdentity | null {
    return (pid) => identities[pid] ?? null;
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 3_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for managed runtime lease state.");
}

test("prunes every valid unreferenced runtime and keeps the current runtime", async () => {
    await withTempHome((homeDir) => {
        const oldOne = writeRuntime(homeDir, "6.1.0");
        const oldTwo = writeRuntime(homeDir, "6.2.0");
        const current = writeRuntime(homeDir, "6.7.0");

        const result = pruneManagedRuntimeStore({
            homeDir,
            currentRuntimeRoot: current,
            inspectProcess: processInspector({}),
        });

        assert.deepEqual(result.warnings, []);
        assert.deepEqual(
            [...result.removedRuntimeRoots].sort(),
            [oldOne, oldTwo].sort(),
        );
        assert.equal(fs.existsSync(oldOne), false);
        assert.equal(fs.existsSync(oldTwo), false);
        assert.equal(fs.existsSync(current), true);
    });
});

test("keeps all roots matching a live runtime owner version", async () => {
    await withTempHome((homeDir) => {
        const liveStable = writeRuntime(homeDir, "6.2.0");
        const liveGeneration = writeRuntime(homeDir, "6.2.0", ".generation-test");
        const stale = writeRuntime(homeDir, "6.3.0");
        const current = writeRuntime(homeDir, "6.7.0");
        const ownersPath = path.join(homeDir, ".satori", "runtime-owner", "owners.json");
        fs.mkdirSync(path.dirname(ownersPath), { recursive: true });
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [{
                pid: 101,
                processStartTime: "start-101",
                satoriVersion: "6.2.0",
            }],
        }), "utf8");

        const result = pruneManagedRuntimeStore({
            homeDir,
            currentRuntimeRoot: current,
            inspectProcess: processInspector({
                101: { pid: 101, processStartTime: "start-101" },
            }),
        });

        assert.deepEqual(result.removedRuntimeRoots, [stale]);
        assert.equal(fs.existsSync(liveStable), true);
        assert.equal(fs.existsSync(liveGeneration), true);
        assert.equal(fs.existsSync(stale), false);
    });
});

test("removes a runtime after its owner process exits", async () => {
    await withTempHome((homeDir) => {
        const stale = writeRuntime(homeDir, "6.2.0");
        const current = writeRuntime(homeDir, "6.7.0");
        const ownersPath = path.join(homeDir, ".satori", "runtime-owner", "owners.json");
        fs.mkdirSync(path.dirname(ownersPath), { recursive: true });
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [{
                pid: 101,
                processStartTime: "start-101",
                satoriVersion: "6.2.0",
            }],
        }), "utf8");

        const result = pruneManagedRuntimeStore({
            homeDir,
            currentRuntimeRoot: current,
            inspectProcess: processInspector({}),
        });

        assert.deepEqual(result.removedRuntimeRoots, [stale]);
        assert.equal(fs.existsSync(stale), false);
    });
});

test("keeps the exact runtime referenced by a live managed launcher lease", async () => {
    await withTempHome((homeDir) => {
        const leased = writeRuntime(homeDir, "6.2.0");
        const staleSameVersion = writeRuntime(homeDir, "6.2.0", ".generation-stale");
        const current = writeRuntime(homeDir, "6.7.0");
        const leasesRoot = path.join(homeDir, ".satori", "mcp-runtime", ".leases");
        fs.mkdirSync(leasesRoot, { recursive: true });
        fs.writeFileSync(path.join(leasesRoot, "lease-201.json"), JSON.stringify({
            formatVersion: 1,
            leaseId: "lease-201",
            pid: 201,
            bootId: "boot-a",
            processStartTime: "start-201",
            runtimeRoot: leased,
            acquiredAt: new Date(0).toISOString(),
        }), "utf8");

        const result = pruneManagedRuntimeStore({
            homeDir,
            currentRuntimeRoot: current,
            inspectProcess: processInspector({
                201: {
                    pid: 201,
                    bootId: "boot-a",
                    processStartTime: "start-201",
                },
            }),
        });

        assert.deepEqual(result.removedRuntimeRoots, [staleSameVersion]);
        assert.equal(fs.existsSync(leased), true);
        assert.equal(fs.existsSync(staleSameVersion), false);
    });
});

test("keeps the runtime referenced by a live shared runtime host", async () => {
    await withTempHome((homeDir) => {
        const hosted = writeRuntime(homeDir, "6.2.0");
        const stale = writeRuntime(homeDir, "6.3.0");
        const current = writeRuntime(homeDir, "6.7.0");
        const metadataPath = path.join(
            homeDir,
            ".satori",
            "runtime-host",
            "host-a",
            "host.json",
        );
        fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
        fs.writeFileSync(metadataPath, JSON.stringify({
            formatVersion: 1,
            hostPid: 301,
            bootId: "boot-a",
            processStartTime: "start-301",
            installedRuntimeRoot: packageRoot(hosted),
        }), "utf8");

        const result = pruneManagedRuntimeStore({
            homeDir,
            currentRuntimeRoot: current,
            inspectProcess: processInspector({
                301: {
                    pid: 301,
                    bootId: "boot-a",
                    processStartTime: "start-301",
                },
            }),
        });

        assert.deepEqual(result.removedRuntimeRoots, [stale]);
        assert.equal(fs.existsSync(hosted), true);
        assert.equal(fs.existsSync(stale), false);
    });
});

test("malformed ownership evidence prevents destructive cleanup", async () => {
    await withTempHome((homeDir) => {
        const stale = writeRuntime(homeDir, "6.2.0");
        const current = writeRuntime(homeDir, "6.7.0");
        const ownersPath = path.join(homeDir, ".satori", "runtime-owner", "owners.json");
        fs.mkdirSync(path.dirname(ownersPath), { recursive: true });
        fs.writeFileSync(ownersPath, "{broken", "utf8");

        const result = pruneManagedRuntimeStore({
            homeDir,
            currentRuntimeRoot: current,
            inspectProcess: processInspector({}),
        });

        assert.deepEqual(result.removedRuntimeRoots, []);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0], /Could not read runtime-owner evidence/);
        assert.equal(fs.existsSync(stale), true);
    });
});

test("never follows an unknown symlink in the managed runtime store", async () => {
    await withTempHome((homeDir) => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "satori-runtime-outside-"));
        try {
            const current = writeRuntime(homeDir, "6.7.0");
            const symlinkPath = path.join(
                homeDir,
                ".satori",
                "mcp-runtime",
                "@satori-code-mcp@6.1.0",
            );
            fs.symlinkSync(outside, symlinkPath, "dir");

            const result = pruneManagedRuntimeStore({
                homeDir,
                currentRuntimeRoot: current,
                inspectProcess: processInspector({}),
            });

            assert.deepEqual(result.removedRuntimeRoots, []);
            assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
            assert.equal(fs.existsSync(outside), true);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

test("managed launcher holds an exact runtime lease for its process lifetime", async () => {
    await withTempHome(async (homeDir) => {
        const current = writeRuntime(homeDir, "6.7.0");
        const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [
                "-e",
                'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
            ],
            managedRuntimeRoot: current,
            shutdownGraceMs: 100,
        }), "utf8");

        const leasesRoot = path.join(homeDir, ".satori", "mcp-runtime", ".leases");
        fs.mkdirSync(leasesRoot, { recursive: true });
        fs.writeFileSync(path.join(leasesRoot, "dead.json"), JSON.stringify({
            formatVersion: 1,
            leaseId: "dead",
            pid: 2_147_483_646,
            runtimeRoot: current,
            acquiredAt: new Date(0).toISOString(),
        }), "utf8");
        const malformedLease = path.join(leasesRoot, "malformed.json");
        fs.writeFileSync(malformedLease, "", "utf8");
        fs.utimesSync(malformedLease, new Date(0), new Date(0));

        const launcher = spawn(process.execPath, [launcherPath], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        const launcherClosed = once(launcher, "close");
        const runtimeReady = once(launcher.stdout, "data");
        try {
            await waitFor(() => (
                fs.existsSync(leasesRoot)
                && fs.readdirSync(leasesRoot).some((entry) => entry.endsWith(".json"))
            ));
            await runtimeReady;
            const leaseFiles = fs.readdirSync(leasesRoot)
                .filter((entry) => entry.endsWith(".json"));
            assert.equal(leaseFiles.length, 1);
            const lease = JSON.parse(
                fs.readFileSync(path.join(leasesRoot, leaseFiles[0]), "utf8"),
            ) as { pid?: unknown; runtimeRoot?: unknown };
            assert.equal(lease.pid, launcher.pid);
            assert.equal(lease.runtimeRoot, current);

            launcher.kill("SIGTERM");
            await launcherClosed;
            pruneManagedRuntimeStore({
                homeDir,
                currentRuntimeRoot: current,
            });
            await waitFor(() => (
                fs.readdirSync(leasesRoot).every((entry) => !entry.endsWith(".json"))
            ));
        } finally {
            if (launcher.exitCode === null && launcher.signalCode === null) {
                launcher.kill("SIGTERM");
                await launcherClosed;
            }
        }
    });
});

test("retired managed launcher cohort cannot reacquire a runtime lease", async () => {
    await withTempHome(async (homeDir) => {
        const current = writeRuntime(homeDir, "6.7.0");
        const activeLauncherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
        fs.mkdirSync(path.dirname(activeLauncherPath), { recursive: true });
        fs.writeFileSync(activeLauncherPath, buildLauncherScript({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            managedRuntimeRoot: current,
            managedEnv: { SATORI_RUNTIME_PROFILE: "connected" },
        }), "utf8");

        const staleLauncherPath = path.join(homeDir, "stale-satori-mcp.js");
        fs.writeFileSync(staleLauncherPath, buildLauncherScript({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            managedRuntimeRoot: current,
            managedEnv: { SATORI_RUNTIME_PROFILE: "voyage" },
        }), "utf8");

        const staleLauncher = spawn(process.execPath, [staleLauncherPath], {
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        staleLauncher.stderr.setEncoding("utf8");
        staleLauncher.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const [exitCode] = await once(staleLauncher, "close") as [number | null, NodeJS.Signals | null];

        assert.equal(exitCode, 1);
        assert.match(stderr, /retired runtime cohort/);
        const leasesRoot = path.join(homeDir, ".satori", "mcp-runtime", ".leases");
        assert.equal(
            fs.existsSync(leasesRoot)
                ? fs.readdirSync(leasesRoot).some((entry) => entry.endsWith(".json"))
                : false,
            false,
        );
    });
});

test("managed runtime mutation lock recovers a stale process owner", async () => {
    await withTempHome((homeDir) => {
        const storageRoot = path.join(homeDir, ".satori", "mcp-runtime");
        const lockPath = path.join(storageRoot, ".mutation.lock");
        fs.mkdirSync(storageRoot, { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({
            formatVersion: 1,
            pid: 401,
            processStartTime: "dead-start",
        }), "utf8");

        const release = acquireManagedRuntimeMutationLock({
            homeDir,
            inspectProcess: processInspector({}),
        });

        assert.equal(fs.existsSync(lockPath), true);
        release();
        assert.equal(fs.existsSync(lockPath), false);
    });
});
