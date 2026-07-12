import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
    MutationLeaseCoordinator,
    type MutationLeaseProcessInspector,
    type MutationLeaseProcessSnapshot,
} from "./mutation-lease.js";

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mutation-lease-"));
    return Promise.resolve(fn(dir)).finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

function snapshot(pid: number, processStartTime = `start-${pid}`): MutationLeaseProcessSnapshot {
    return { pid, processStartTime };
}

function inspector(processes: Map<number, MutationLeaseProcessSnapshot>): MutationLeaseProcessInspector {
    return {
        inspect(pid: number) {
            return processes.get(pid) ?? null;
        },
    };
}

function coordinator(
    stateDir: string,
    current: MutationLeaseProcessSnapshot,
    processes: Map<number, MutationLeaseProcessSnapshot>,
    ownerId: string,
): MutationLeaseCoordinator {
    return new MutationLeaseCoordinator({
        stateDir,
        currentProcess: current,
        processInspector: inspector(processes),
        ownerId,
        now: () => 1_000,
    });
}

test("same canonical root blocks a second live owner", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map([
            [101, snapshot(101)],
            [202, snapshot(202)],
        ]);
        const first = coordinator(path.join(tempDir, "state"), snapshot(101), processes, "owner-a");
        const second = coordinator(path.join(tempDir, "state"), snapshot(202), processes, "owner-b");

        const acquired = first.acquire(root, "sync");
        const blocked = second.acquire(root, "clear");

        assert.equal(acquired.acquired, true);
        assert.equal(blocked.acquired, false);
        if (!blocked.acquired) {
            assert.equal(blocked.reason, "mutation_in_progress");
            assert.equal(blocked.activeLease.ownerId, "owner-a");
            assert.equal(blocked.activeLease.action, "sync");
        }
    });
});

test("symlink aliases resolve to the same lease", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        const alias = path.join(tempDir, "repo-alias");
        fs.mkdirSync(root);
        fs.symlinkSync(root, alias, "dir");
        const processes = new Map([
            [101, snapshot(101)],
            [202, snapshot(202)],
        ]);
        const first = coordinator(path.join(tempDir, "state"), snapshot(101), processes, "owner-a");
        const second = coordinator(path.join(tempDir, "state"), snapshot(202), processes, "owner-b");

        assert.equal(first.acquire(alias, "create").acquired, true);
        const blocked = second.acquire(root, "sync");
        assert.equal(blocked.acquired, false);
    });
});

test("different roots can be leased concurrently", async () => {
    await withTempDir((tempDir) => {
        const rootA = path.join(tempDir, "repo-a");
        const rootB = path.join(tempDir, "repo-b");
        fs.mkdirSync(rootA);
        fs.mkdirSync(rootB);
        const processes = new Map([
            [101, snapshot(101)],
            [202, snapshot(202)],
        ]);
        const first = coordinator(path.join(tempDir, "state"), snapshot(101), processes, "owner-a");
        const second = coordinator(path.join(tempDir, "state"), snapshot(202), processes, "owner-b");

        assert.equal(first.acquire(rootA, "sync").acquired, true);
        assert.equal(second.acquire(rootB, "sync").acquired, true);
    });
});

test("active lease inspection reports only a live current owner", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map<number, MutationLeaseProcessSnapshot>([[101, snapshot(101)]]);
        const stateDir = path.join(tempDir, "state");
        const owner = coordinator(stateDir, snapshot(101), processes, "owner-a");
        const observer = coordinator(stateDir, snapshot(202), processes, "observer");
        const acquired = owner.acquire(root, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        assert.deepEqual(observer.getActiveLease(root), acquired.lease);
        processes.delete(101);
        assert.equal(observer.getActiveLease(root), undefined);
    });
});

test("live owner is not evicted based on lease age", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map([
            [101, snapshot(101)],
            [202, snapshot(202)],
        ]);
        const stateDir = path.join(tempDir, "state");
        const first = new MutationLeaseCoordinator({
            stateDir,
            currentProcess: snapshot(101),
            processInspector: inspector(processes),
            ownerId: "owner-a",
            now: () => 1_000,
        });
        const second = new MutationLeaseCoordinator({
            stateDir,
            currentProcess: snapshot(202),
            processInspector: inspector(processes),
            ownerId: "owner-b",
            now: () => 10_000_000_000,
        });

        assert.equal(first.acquire(root, "create").acquired, true);
        assert.equal(second.acquire(root, "clear").acquired, false);
    });
});

test("dead owner replacement increments generation", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map<number, MutationLeaseProcessSnapshot>([[101, snapshot(101)]]);
        const stateDir = path.join(tempDir, "state");
        const first = coordinator(stateDir, snapshot(101), processes, "owner-a");
        const firstResult = first.acquire(root, "create");
        assert.equal(firstResult.acquired, true);
        if (!firstResult.acquired) return;

        processes.delete(101);
        processes.set(202, snapshot(202));
        const second = coordinator(stateDir, snapshot(202), processes, "owner-b");
        const replacement = second.acquire(root, "repair");

        assert.equal(replacement.acquired, true);
        if (replacement.acquired) {
            assert.equal(replacement.lease.generation, firstResult.lease.generation + 1);
        }
    });
});

test("process-start mismatch permits takeover and old owner cannot release it", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map<number, MutationLeaseProcessSnapshot>([[101, snapshot(101, "old-start")]]);
        const stateDir = path.join(tempDir, "state");
        const oldOwner = coordinator(stateDir, snapshot(101, "old-start"), processes, "owner-a");
        const oldLease = oldOwner.acquire(root, "create");
        assert.equal(oldLease.acquired, true);
        if (!oldLease.acquired) return;

        processes.set(101, snapshot(101, "new-start"));
        const replacementOwner = coordinator(stateDir, snapshot(101, "new-start"), processes, "owner-b");
        const replacement = replacementOwner.acquire(root, "sync");
        assert.equal(replacement.acquired, true);
        if (!replacement.acquired) return;

        assert.equal(oldOwner.release(oldLease.lease), false);
        assert.equal(replacementOwner.isCurrent(replacement.lease), true);
        assert.equal(replacementOwner.release(replacement.lease), true);
        assert.equal(replacementOwner.isCurrent(replacement.lease), false);
    });
});

test("publishWhileCurrent executes publication only while the exact lease owns the root lock", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map<number, MutationLeaseProcessSnapshot>([[101, snapshot(101)]]);
        const owner = coordinator(path.join(tempDir, "state"), snapshot(101), processes, "owner-a");
        const acquired = owner.acquire(root, "sync");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let publications = 0;
        owner.publishWhileCurrent(acquired.lease, () => {
            publications += 1;
        });
        assert.equal(publications, 1);
        assert.equal(owner.release(acquired.lease), true);
        assert.throws(
            () => owner.publishWhileCurrent(acquired.lease, () => {
                publications += 1;
            }),
            /no longer current/,
        );
        assert.equal(publications, 1);
    });
});

test("live PID without processStartTime remains fail-closed and blocks takeover", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map<number, MutationLeaseProcessSnapshot>([
            [101, { pid: 101 }],
            [202, { pid: 202 }],
        ]);
        const first = coordinator(path.join(tempDir, "state"), { pid: 101 }, processes, "owner-a");
        const second = coordinator(path.join(tempDir, "state"), { pid: 202 }, processes, "owner-b");

        const acquired = first.acquire(root, "create");
        assert.equal(acquired.acquired, true);
        if (acquired.acquired) {
            assert.equal(acquired.lease.processStartTime, undefined);
            assert.equal("lastHeartbeatAt" in acquired.lease, false);
        }

        const blocked = second.acquire(root, "repair");
        assert.equal(blocked.acquired, false);
        if (!blocked.acquired) {
            assert.equal(blocked.activeLease.pid, 101);
        }
    });
});

test("old acquiredAt never evicts a live owner", async () => {
    await withTempDir((tempDir) => {
        const root = path.join(tempDir, "repo");
        fs.mkdirSync(root);
        const processes = new Map([
            [101, snapshot(101)],
            [202, snapshot(202)],
        ]);
        const first = new MutationLeaseCoordinator({
            stateDir: path.join(tempDir, "state"),
            currentProcess: snapshot(101),
            processInspector: inspector(processes),
            ownerId: "owner-a",
            now: () => 1_000,
        });
        const second = new MutationLeaseCoordinator({
            stateDir: path.join(tempDir, "state"),
            currentProcess: snapshot(202),
            processInspector: inspector(processes),
            ownerId: "owner-b",
            now: () => 1_000_000_000,
        });

        assert.equal(first.acquire(root, "sync").acquired, true);
        const blocked = second.acquire(root, "clear");
        assert.equal(blocked.acquired, false);
    });
});

test("separate processes contend and a reaped owner can be replaced", { timeout: 10_000 }, async () => {
    await withTempDir(async (tempDir) => {
        const root = path.join(tempDir, "repo");
        const stateDir = path.join(tempDir, "state");
        fs.mkdirSync(root);
        const moduleUrl = new URL("./mutation-lease.ts", import.meta.url).href;
        const childBody = `
            const { MutationLeaseCoordinator } = await import(process.argv[1]);
            const result = new MutationLeaseCoordinator({ stateDir: process.argv[3] })
                .acquire(process.argv[2], "sync");
            process.send?.(result);
            setInterval(() => {}, 1_000);
        `;
        let child: ChildProcess | null = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", childBody, moduleUrl, root, stateDir],
            { stdio: ["ignore", "ignore", "inherit", "ipc"] },
        );

        try {
            const [message] = await once(child, "message") as [{ acquired: boolean; lease?: { generation: number } }];
            assert.equal(message.acquired, true);
            assert.ok(message.lease);

            const parent = new MutationLeaseCoordinator({ stateDir });
            const blocked = parent.acquire(root, "clear");
            assert.equal(blocked.acquired, false);
            if (!blocked.acquired) {
                assert.equal(blocked.activeLease.pid, child.pid);
                assert.equal(blocked.activeLease.action, "sync");
            }

            const exitPromise = once(child, "exit");
            child.kill("SIGTERM");
            await exitPromise;
            child = null;

            const replacement = parent.acquire(root, "repair");
            assert.equal(replacement.acquired, true);
            if (replacement.acquired) {
                assert.equal(replacement.lease.generation, message.lease.generation + 1);
                assert.equal(parent.release(replacement.lease), true);
            }
        } finally {
            if (child && child.exitCode === null && child.signalCode === null) {
                const exitPromise = once(child, "exit");
                child.kill("SIGKILL");
                await exitPromise;
            }
        }
    });
});
