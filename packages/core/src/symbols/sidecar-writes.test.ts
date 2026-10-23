import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from './contracts';
import { buildSymbolRegistry } from './registry';
import { fileShardName, readRelationshipSidecar } from './sidecar-reads';
import { writeRelationshipSidecar, writeSymbolRegistrySidecar } from './sidecar-writes';

test('relationship sidecar preserves skipped semantic source files in provider coverage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-skipped-coverage-'));
    const publicationId = 'fixture-publication';
    const navigationRoot = path.join(root, publicationId, 'navigation');
    const symbolRegistryManifestHash = 'fixture-symbol-hash';
    try {
        await writeRelationshipSidecar({
            normalizedRootPath: root,
            navigationRoot,
            symbolRegistryManifestHash,
            relationshipVersion: 'fixture-version',
            builtAt: new Date(0).toISOString(),
            records: [],
            providerCoverage: [{
                language: 'rust',
                providerId: 'fixture',
                providerVersion: '1',
                status: 'degraded',
                sourceFileCount: 2,
                analyzedSourceFileCount: 1,
                skippedFiles: [
                    { path: 'z.rs', reason: 'source_too_large', bytes: 10 },
                    { path: 'a.rs', reason: 'source_too_large', bytes: 20 },
                ],
            }],
        });
        const read = await readRelationshipSidecar({
            normalizedRootPath: root,
            expectedSymbolRegistryManifestHash: symbolRegistryManifestHash,
            navigationRoot,
            publicationId,
        });
        assert.equal(read.status, 'ok', read.status === 'ok' ? undefined : read.reason);
        assert.deepEqual(read.manifest.providerCoverage[0]?.skippedFiles, [
            { path: 'a.rs', reason: 'source_too_large', bytes: 20 },
            { path: 'z.rs', reason: 'source_too_large', bytes: 10 },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('symbol publication roundtrip preserves parser reasons and legacy unknown evidence', async () => {
    const { buildSymbolRegistry, computeSymbolRegistryManifestHash } = await import('./registry.js');
    const { SYMBOL_REGISTRY_SCHEMA_VERSION } = await import('./contracts.js');
    const { writeSymbolRegistrySidecar } = await import('./sidecar-writes.js');
    const { readSymbolRegistrySidecar } = await import('./sidecar-reads.js');
    const { computeSymbolQualitySummaryFromSidecarRead } = await import('./symbol-quality.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-parser-outcomes-'));
    const navigationRoot = path.join(root, 'fixture', 'navigation');
    try {
        const registry = buildSymbolRegistry({ manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root, rootFingerprint: 'root',
            indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'extractor',
            relationshipVersion: 'relationship', builtAt: new Date(0).toISOString(),
            files: [
                { path: 'a.ts', hash: 'a', language: 'typescript', symbolCount: 0, definitionStatus: 'structural_unavailable', structuralStatus: 'recovered', structuralReason: 'syntax_error' },
                { path: 'legacy.ts', hash: 'b', language: 'typescript', symbolCount: 0, definitionStatus: 'structural_unavailable' },
            ],
        }, symbols: [] });
        const changed = { ...registry.manifest, files: registry.manifest.files.map(file => ({ ...file, structuralReason: file.structuralReason ? 'parser_unavailable' as const : undefined })) };
        assert.notEqual(computeSymbolRegistryManifestHash(registry.manifest), computeSymbolRegistryManifestHash(changed));
        await writeSymbolRegistrySidecar({ registry, navigationRoot });
        const read = await readSymbolRegistrySidecar({ normalizedRootPath: root, publicationId: 'fixture', navigationRoot });
        assert.equal(read.status, 'ok', read.status === 'ok' ? undefined : read.reason);
        assert.deepEqual(computeSymbolQualitySummaryFromSidecarRead(read).structuralAnalysis, {
            completeFiles: 0, recoveredFiles: 1, searchOnlyFiles: 0, unknownFiles: 1,
            reasons: [{ reason: 'syntax_error', files: 1 }],
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const IMMEDIATE_SHARD_FAILURE = 'injected immediate shard write failure';
const GATED_SHARD_FAILURE = 'injected gated shard write failure';

interface ShardWriteFault {
    /** Shard whose write fails as soon as the batch reaches it. */
    immediateFailureShard: string;
    /** Shard whose write fails only after the gate is released. */
    gatedFailureShard: string;
    /** Shard that is written only after the gate is released. */
    gatedWriteShard: string;
}

interface ShardWriteFaultInjection {
    /** Ordered record of the shard writes and of the staging call settlement. */
    events: string[];
    /** Resolves once the immediate shard failure was injected. */
    failureInjected: Promise<void>;
    /** Releases the gated writers. */
    releaseGate: () => void;
}

/**
 * Injects shard write faults through the file system the shard writers use, so
 * one writer can be held behind a gate while a sibling in the same batch
 * fails. The gate is resolved by hand, so the fixture never depends on timing.
 * The cleanup is recorded because it must not start while a writer runs.
 */
function installShardWriteFault(
    t: TestContext,
    fault: ShardWriteFault,
): ShardWriteFaultInjection {
    const events: string[] = [];
    let releaseGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let reportFailure = (): void => undefined;
    const failureInjected = new Promise<void>((resolve) => { reportFailure = resolve; });
    const originalWriteFile = fs.promises.writeFile;
    const originalRm = fs.promises.rm;

    t.mock.method(fs.promises, 'writeFile', async (
        file: Parameters<typeof fs.promises.writeFile>[0],
        data: Parameters<typeof fs.promises.writeFile>[1],
        options?: Parameters<typeof fs.promises.writeFile>[2],
    ): Promise<void> => {
        const target = typeof file === 'string'
            ? file
            : file instanceof URL
                ? file.pathname
                : undefined;
        const shard = target === undefined ? '' : path.basename(target);
        if (shard === fault.immediateFailureShard) {
            reportFailure();
            throw new Error(IMMEDIATE_SHARD_FAILURE);
        }
        if (shard === fault.gatedFailureShard) {
            await gate;
            throw new Error(GATED_SHARD_FAILURE);
        }
        if (shard === fault.gatedWriteShard) {
            await gate;
        }
        await originalWriteFile(file, data, options);
        events.push(`write:${shard}`);
    });

    t.mock.method(fs.promises, 'rm', async (
        target: Parameters<typeof fs.promises.rm>[0],
        options?: Parameters<typeof fs.promises.rm>[1],
    ): Promise<void> => {
        events.push('cleanup:start');
        await originalRm(target, options);
    });

    return { events, failureInjected, releaseGate: () => releaseGate() };
}

/**
 * A failed shard batch must not leave a sibling writer running: the staging
 * call removes the build root when it fails, so a writer that outlives the
 * rejection could write into a removed directory.
 */
async function assertShardBatchSettlesBeforeFailure(
    t: TestContext,
    fault: ShardWriteFault,
    write: () => Promise<unknown>,
    navigationRoot: string,
): Promise<void> {
    const injection = installShardWriteFault(t, fault);
    try {
        const call = write();
        let settled = false;
        call.then(
            () => { settled = true; injection.events.push('settled'); },
            () => { settled = true; injection.events.push('reject'); },
        );

        await injection.failureInjected;
        assert.equal(
            settled,
            false,
            'the staging call must not settle while a shard writer is still pending',
        );

        injection.releaseGate();
        await assert.rejects(call, new RegExp(GATED_SHARD_FAILURE));

        await new Promise((resolve) => setImmediate(resolve));
        const rejectIndex = injection.events.indexOf('reject');
        assert.notEqual(rejectIndex, -1, 'the staging call must reject');
        const cleanupIndex = injection.events.indexOf('cleanup:start');
        assert.notEqual(cleanupIndex, -1, 'a failed staging must clean up the build root');
        const gatedWriteIndex = injection.events.indexOf(`write:${fault.gatedWriteShard}`);
        assert.notEqual(
            gatedWriteIndex,
            -1,
            'the gated writer must finish before the staging call rejects',
        );
        assert.ok(
            gatedWriteIndex < cleanupIndex,
            'the cleanup must not start while a shard writer is still pending',
        );
        assert.ok(
            gatedWriteIndex < rejectIndex,
            'a shard write must not happen after the rejection',
        );
        assert.deepEqual(
            injection.events.filter((event, index) => index > rejectIndex && event.startsWith('write:')),
            [],
            'no shard write may happen after the rejection',
        );
        assert.deepEqual(
            fs.readdirSync(navigationRoot).filter((entry) => entry.startsWith('.satori-tmp-')),
            [],
            'a failed staging must not leave a build root behind',
        );
    } finally {
        injection.releaseGate();
    }
}

test('symbol shard staging settles every started writer before it reports the first failure', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-symbol-shard-batch-'));
    const navigationRoot = path.join(root, 'fixture-publication', 'navigation');
    try {
        const registry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: root,
                rootFingerprint: 'root',
                indexPolicyHash: 'policy',
                languageRouterVersion: 'router',
                extractorVersion: 'extractor',
                relationshipVersion: 'relationship',
                builtAt: new Date(0).toISOString(),
                files: [
                    { path: 'a.ts', hash: 'hash-a', language: 'typescript', symbolCount: 0, definitionStatus: 'definition_free' },
                    { path: 'b.ts', hash: 'hash-b', language: 'typescript', symbolCount: 0, definitionStatus: 'definition_free' },
                    { path: 'c.ts', hash: 'hash-c', language: 'typescript', symbolCount: 0, definitionStatus: 'definition_free' },
                ],
            },
            symbols: [],
        });
        await assertShardBatchSettlesBeforeFailure(
            t,
            {
                immediateFailureShard: fileShardName('b.ts', 'hash-b'),
                gatedFailureShard: fileShardName('a.ts', 'hash-a'),
                gatedWriteShard: fileShardName('c.ts', 'hash-c'),
            },
            () => writeSymbolRegistrySidecar({ registry, navigationRoot }),
            navigationRoot,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('relationship shard staging settles every started writer before it reports the first failure', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-relationship-shard-batch-'));
    const navigationRoot = path.join(root, 'fixture-publication', 'navigation');
    try {
        await assertShardBatchSettlesBeforeFailure(
            t,
            {
                immediateFailureShard: fileShardName('b.ts', 'hash-b'),
                gatedFailureShard: fileShardName('a.ts', 'hash-a'),
                gatedWriteShard: fileShardName('c.ts', 'hash-c'),
            },
            () => writeRelationshipSidecar({
                normalizedRootPath: root,
                navigationRoot,
                symbolRegistryManifestHash: 'fixture-symbol-hash',
                relationshipVersion: 'fixture-version',
                builtAt: new Date(0).toISOString(),
                records: [],
                files: [
                    { path: 'a.ts', hash: 'hash-a', language: 'typescript', symbolCount: 0, definitionStatus: 'definition_free' },
                    { path: 'b.ts', hash: 'hash-b', language: 'typescript', symbolCount: 0, definitionStatus: 'definition_free' },
                    { path: 'c.ts', hash: 'hash-c', language: 'typescript', symbolCount: 0, definitionStatus: 'definition_free' },
                ],
            }),
            navigationRoot,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
