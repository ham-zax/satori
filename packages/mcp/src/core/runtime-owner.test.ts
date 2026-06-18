import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexFingerprint } from '../config.js';
import {
    RuntimeOwnerRegistry,
    buildRuntimeOwnerIdentity,
    type ProcessInspector,
    type ProcessSnapshot,
    type RuntimeOwnerRecord,
} from './runtime-owner.js';

const FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
};

function withTempState<T>(fn: (stateDir: string) => Promise<T> | T): Promise<T> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-runtime-owner-'));
    return Promise.resolve(fn(stateDir)).finally(() => {
        fs.rmSync(stateDir, { recursive: true, force: true });
    });
}

function snapshot(pid: number, overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
    return {
        pid,
        ppid: overrides.ppid ?? 10,
        cmd: overrides.cmd ?? `/usr/bin/node /tmp/satori-${pid}.js`,
        cwd: overrides.cwd ?? `/tmp/repo-${pid}`,
        processStartTime: overrides.processStartTime ?? `start-${pid}`,
    };
}

function inspector(processes: Map<number, ProcessSnapshot>): ProcessInspector {
    return {
        inspect(pid: number) {
            return processes.get(pid) ?? null;
        }
    };
}

function writeOwners(stateDir: string, owners: RuntimeOwnerRecord[]): void {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'owners.json'), JSON.stringify({
        formatVersion: 'v1',
        updatedAt: new Date(0).toISOString(),
        owners,
    }, null, 2));
}

function ownerRecord(
    pid: number,
    identity = buildRuntimeOwnerIdentity({
        satoriVersion: '4.11.5',
        runtimeFingerprint: FINGERPRINT,
        configSource: 'env',
        configSummary: {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-large',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'hybrid_v3',
            milvusEndpoint: 'http://milvus.local',
            rankerModel: 'rerank-2.5',
        }
    }),
    process = snapshot(pid)
): RuntimeOwnerRecord {
    return {
        ownerId: `owner-${pid}`,
        pid,
        ppid: process.ppid ?? 10,
        cmd: process.cmd ?? `/usr/bin/node /tmp/satori-${pid}.js`,
        cwd: process.cwd ?? `/tmp/repo-${pid}`,
        startedAt: new Date(1_000).toISOString(),
        lastSeenAt: new Date(1_000).toISOString(),
        satoriVersion: identity.satoriVersion,
        runtimeFingerprint: identity.runtimeFingerprint,
        runtimeOwnerIdentityHash: identity.hash,
        configSource: identity.configSource,
        processStartTime: process.processStartTime,
    };
}

test('runtime owner startup registers current owner and prunes dead owner', async () => {
    await withTempState((stateDir) => {
        const current = snapshot(101);
        const dead = ownerRecord(202);
        writeOwners(stateDir, [dead]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: buildRuntimeOwnerIdentity({
                satoriVersion: '4.11.5',
                runtimeFingerprint: FINGERPRINT,
                configSource: 'env',
                configSummary: {
                    embeddingProvider: 'VoyageAI',
                    embeddingModel: 'voyage-4-large',
                    embeddingDimension: 1024,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'hybrid_v3',
                    milvusEndpoint: 'http://milvus.local',
                    rankerModel: 'rerank-2.5',
                }
            }),
            processInspector: inspector(new Map([[101, current]])),
            currentProcess: current,
            now: () => 2_000,
        });

        const registered = registry.registerCurrentOwner();
        const owners = registry.readOwnersForDebug();

        assert.equal(registered.pid, 101);
        assert.deepEqual(owners.map((owner) => owner.pid), [101]);
    });
});

test('same runtime owner identity does not block mutation', async () => {
    await withTempState((stateDir) => {
        const other = snapshot(202);
        const current = snapshot(101);
        const identity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, identity, other)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity,
            processInspector: inspector(new Map([[101, current], [202, other]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        const result = registry.checkMutation('create', '/repo');
        assert.equal(result.blocked, false);
    });
});

test('current owner startedAt stays stable while lastSeenAt updates', async () => {
    await withTempState((stateDir) => {
        let clock = 2_000;
        const current = snapshot(101);
        const identity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity,
            processInspector: inspector(new Map([[101, current]])),
            currentProcess: current,
            now: () => clock,
        });

        registry.registerCurrentOwner();
        const initial = registry.readOwnersForDebug()[0];
        clock = 9_000;
        assert.equal(registry.checkMutation('sync', '/repo').blocked, false);
        const updated = registry.readOwnersForDebug()[0];

        assert.equal(updated.startedAt, initial.startedAt);
        assert.notEqual(updated.lastSeenAt, initial.lastSeenAt);
    });
});

test('different runtime fingerprint blocks create reindex sync and clear', async () => {
    await withTempState((stateDir) => {
        const other = snapshot(202);
        const current = snapshot(101);
        const otherFingerprint: IndexFingerprint = {
            ...FINGERPRINT,
            embeddingModel: 'voyage-code-3',
        };
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: otherFingerprint,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-code-3',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const currentIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, otherIdentity, other)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: currentIdentity,
            processInspector: inspector(new Map([[101, current], [202, other]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        for (const action of ['create', 'reindex', 'sync', 'clear'] as const) {
            const result = registry.checkMutation(action, '/repo');
            assert.equal(result.blocked, true, action);
            assert.equal(result.reason, 'runtime_owner_conflict');
            assert.equal(result.conflictingOwners?.[0]?.pid, 202);
            assert.deepEqual(result.conflictingOwners?.[0]?.conflictReasons, ['runtimeFingerprint', 'runtimeOwnerIdentityHash']);
        }
    });
});

test('different Satori version blocks mutation', async () => {
    await withTempState((stateDir) => {
        const other = snapshot(202);
        const current = snapshot(101);
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.10.0',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const currentIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, otherIdentity, other)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: currentIdentity,
            processInspector: inspector(new Map([[101, current], [202, other]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        const result = registry.checkMutation('sync', '/repo');
        assert.equal(result.blocked, true);
        assert.deepEqual(result.conflictingOwners?.[0]?.conflictReasons, ['satoriVersion', 'runtimeOwnerIdentityHash']);
    });
});

test('different config identity blocks mutation even with matching fingerprint', async () => {
    await withTempState((stateDir) => {
        const other = snapshot(202);
        const current = snapshot(101);
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'https://cluster-a.example',
                rankerModel: 'rerank-2.5',
            }
        });
        const currentIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'https://cluster-b.example',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, otherIdentity, other)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: currentIdentity,
            processInspector: inspector(new Map([[101, current], [202, other]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        const result = registry.checkMutation('reindex', '/repo');
        assert.equal(result.blocked, true);
        assert.deepEqual(result.conflictingOwners?.[0]?.conflictReasons, ['runtimeOwnerIdentityHash']);
    });
});

test('PID reuse is pruned instead of treated as a live Satori owner', async () => {
    await withTempState((stateDir) => {
        const reusedPid = snapshot(202, {
            cmd: '/usr/bin/bash',
            cwd: '/tmp/other',
            ppid: 99,
            processStartTime: 'new-process',
        });
        const originalOwnerProcess = snapshot(202, {
            cmd: '/usr/bin/node /tmp/old-satori.js',
            cwd: '/tmp/repo-202',
            ppid: 10,
            processStartTime: 'old-process',
        });
        const current = snapshot(101);
        const identity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, identity, originalOwnerProcess)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity,
            processInspector: inspector(new Map([[101, current], [202, reusedPid]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        assert.deepEqual(registry.readOwnersForDebug().map((owner) => owner.pid), [101]);
        assert.equal(registry.checkMutation('sync', '/repo').blocked, false);
    });
});

test('PID existence alone is not enough fallback identity evidence', async () => {
    await withTempState((stateDir) => {
        const originalOwnerProcess = {
            pid: 202,
            ppid: 10,
            cmd: '/usr/bin/node /tmp/old-satori.js',
            cwd: '/tmp/repo-202',
            processStartTime: '',
        };
        const current = snapshot(101);
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.10.0',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const currentIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, otherIdentity, originalOwnerProcess)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: currentIdentity,
            processInspector: inspector(new Map([[101, current], [202, { pid: 202 }]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        assert.deepEqual(registry.readOwnersForDebug().map((owner) => owner.pid), [101]);
        assert.equal(registry.checkMutation('sync', '/repo').blocked, false);
    });
});

test('matching fallback command evidence keeps live owner when processStartTime is unavailable', async () => {
    await withTempState((stateDir) => {
        const otherRegistered = {
            pid: 202,
            ppid: 10,
            cmd: '/usr/bin/node /tmp/satori.js',
            processStartTime: '',
        };
        const otherCurrent = {
            pid: 202,
            ppid: 10,
            cmd: '/usr/bin/node /tmp/satori.js',
        };
        const current = snapshot(101);
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.10.0',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const currentIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, otherIdentity, otherRegistered)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: currentIdentity,
            processInspector: inspector(new Map([[101, current], [202, otherCurrent]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        const result = registry.checkMutation('create', '/repo');
        assert.equal(result.blocked, true);
        assert.equal(result.conflictingOwners?.[0]?.pid, 202);
    });
});

test('matching processStartTime keeps live owner despite cmd formatting drift', async () => {
    await withTempState((stateDir) => {
        const otherRegistered = snapshot(202, {
            cmd: '/usr/bin/node /tmp/satori.js',
            cwd: '/tmp/repo-202',
            ppid: 10,
            processStartTime: 'same-process',
        });
        const otherCurrent = snapshot(202, {
            cmd: 'node /tmp/satori.js',
            cwd: '/different/cwd/string',
            ppid: 99,
            processStartTime: 'same-process',
        });
        const current = snapshot(101);
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.10.0',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const currentIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        writeOwners(stateDir, [ownerRecord(202, otherIdentity, otherRegistered)]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: currentIdentity,
            processInspector: inspector(new Map([[101, current], [202, otherCurrent]])),
            currentProcess: current,
            now: () => 2_000,
        });
        registry.registerCurrentOwner();

        const result = registry.checkMutation('create', '/repo');
        assert.equal(result.blocked, true);
        assert.equal(result.conflictingOwners?.[0]?.pid, 202);
    });
});

test('stale owner records are pruned and do not block mutation', async () => {
    await withTempState((stateDir) => {
        const other = snapshot(202);
        const current = snapshot(101);
        const otherFingerprint: IndexFingerprint = {
            ...FINGERPRINT,
            embeddingModel: 'voyage-code-3',
        };
        const otherIdentity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: otherFingerprint,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-code-3',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const stale = ownerRecord(202, otherIdentity, other);
        stale.lastSeenAt = new Date(0).toISOString();
        writeOwners(stateDir, [stale]);

        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: buildRuntimeOwnerIdentity({
                satoriVersion: '4.11.5',
                runtimeFingerprint: FINGERPRINT,
                configSource: 'env',
                configSummary: {
                    embeddingProvider: 'VoyageAI',
                    embeddingModel: 'voyage-4-large',
                    embeddingDimension: 1024,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'hybrid_v3',
                    milvusEndpoint: 'http://milvus.local',
                    rankerModel: 'rerank-2.5',
                }
            }),
            processInspector: inspector(new Map([[101, current], [202, other]])),
            currentProcess: current,
            now: () => 2_000,
            staleMs: 100,
        });
        registry.registerCurrentOwner();

        assert.deepEqual(registry.readOwnersForDebug().map((owner) => owner.pid), [101]);
        assert.equal(registry.checkMutation('create', '/repo').blocked, false);
    });
});

test('corrupt owners file is quarantined during startup registration', async () => {
    await withTempState((stateDir) => {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'owners.json'), '{not-json');
        const current = snapshot(101);
        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: buildRuntimeOwnerIdentity({
                satoriVersion: '4.11.5',
                runtimeFingerprint: FINGERPRINT,
                configSource: 'env',
                configSummary: {
                    embeddingProvider: 'VoyageAI',
                    embeddingModel: 'voyage-4-large',
                    embeddingDimension: 1024,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'hybrid_v3',
                    milvusEndpoint: 'http://milvus.local',
                    rankerModel: 'rerank-2.5',
                }
            }),
            processInspector: inspector(new Map([[101, current]])),
            currentProcess: current,
            now: () => 2_000,
        });

        registry.registerCurrentOwner();

        const files = fs.readdirSync(stateDir);
        assert.equal(files.some((file) => file.startsWith('owners.json.corrupt-')), true);
        assert.deepEqual(registry.readOwnersForDebug().map((owner) => owner.pid), [101]);
    });
});

test('corrupt owners file fails closed during mutation check', async () => {
    await withTempState((stateDir) => {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'owners.json'), '{not-json');
        const current = snapshot(101);
        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: buildRuntimeOwnerIdentity({
                satoriVersion: '4.11.5',
                runtimeFingerprint: FINGERPRINT,
                configSource: 'env',
                configSummary: {
                    embeddingProvider: 'VoyageAI',
                    embeddingModel: 'voyage-4-large',
                    embeddingDimension: 1024,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'hybrid_v3',
                    milvusEndpoint: 'http://milvus.local',
                    rankerModel: 'rerank-2.5',
                }
            }),
            processInspector: inspector(new Map([[101, current]])),
            currentProcess: current,
            now: () => 2_000,
        });

        const result = registry.checkMutation('sync', '/repo');

        assert.equal(result.blocked, true);
        assert.equal(result.reason, 'runtime_owner_conflict');
        assert.match(result.message || '', /could not be validated/i);
    });
});

test('metadata-less stale lock is not broken at the normal stale threshold', async () => {
    await withTempState((stateDir) => {
        fs.mkdirSync(stateDir, { recursive: true });
        const lockPath = path.join(stateDir, 'owners.lock');
        fs.writeFileSync(lockPath, '');
        const staleDate = new Date(Date.now() - 31_000);
        fs.utimesSync(lockPath, staleDate, staleDate);

        const current = snapshot(101);
        const registry = new RuntimeOwnerRegistry({
            stateDir,
            identity: buildRuntimeOwnerIdentity({
                satoriVersion: '4.11.5',
                runtimeFingerprint: FINGERPRINT,
                configSource: 'env',
                configSummary: {
                    embeddingProvider: 'VoyageAI',
                    embeddingModel: 'voyage-4-large',
                    embeddingDimension: 1024,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'hybrid_v3',
                    milvusEndpoint: 'http://milvus.local',
                    rankerModel: 'rerank-2.5',
                }
            }),
            processInspector: inspector(new Map([[101, current]])),
            currentProcess: current,
            now: () => 2_000,
            lockWaitMs: 5,
            lockRetryMs: 1,
        });

        assert.throws(() => registry.registerCurrentOwner(), /Timed out acquiring runtime owner registry lock/);
        assert.equal(fs.existsSync(lockPath), true);
    });
});

test('two startup simulations keep owners.json valid and preserve both live owners', async () => {
    await withTempState((stateDir) => {
        const identity = buildRuntimeOwnerIdentity({
            satoriVersion: '4.11.5',
            runtimeFingerprint: FINGERPRINT,
            configSource: 'env',
            configSummary: {
                embeddingProvider: 'VoyageAI',
                embeddingModel: 'voyage-4-large',
                embeddingDimension: 1024,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
                milvusEndpoint: 'http://milvus.local',
                rankerModel: 'rerank-2.5',
            }
        });
        const first = snapshot(101);
        const second = snapshot(202);
        const processes = new Map([[101, first], [202, second]]);

        new RuntimeOwnerRegistry({
            stateDir,
            identity,
            processInspector: inspector(processes),
            currentProcess: first,
            now: () => 2_000,
        }).registerCurrentOwner();

        new RuntimeOwnerRegistry({
            stateDir,
            identity,
            processInspector: inspector(processes),
            currentProcess: second,
            now: () => 2_100,
        }).registerCurrentOwner();

        const raw = fs.readFileSync(path.join(stateDir, 'owners.json'), 'utf8');
        const parsed = JSON.parse(raw);
        assert.deepEqual(parsed.owners.map((owner: RuntimeOwnerRecord) => owner.pid).sort((a: number, b: number) => a - b), [101, 202]);
    });
});
