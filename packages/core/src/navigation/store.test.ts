import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ResolutionClaim } from '../relationships/resolution';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRegistry } from '../symbols/registry';
import { fileShardName, readSymbolRegistrySidecar } from '../symbols/sidecar-reads';
import { writeRelationshipSidecar, writeSymbolRegistrySidecar } from '../symbols/sidecar-writes';
import { JsonNavigationStore } from './store';

const symbolRegistryManifestHash = 'fixture-symbol-hash';
const callSpan = { startLine: 1, endLine: 1, startColumn: 1, endColumn: 5, startByte: 0, endByte: 4 };

function resolvedClaim(sourceFile: string, sourceInstanceId: string, targetInstanceId: string): ResolutionClaim {
    return {
        providerId: 'fixture-provider',
        providerVersion: 'fixture-v1',
        environmentConfigId: 'fixture-env',
        sourceFile,
        sourceInstanceId,
        callSpan,
        observation: {
            kind: 'call',
            calleeName: 'target',
            calleeText: 'target',
            construct: 'direct_call',
            candidates: [],
        },
        targetInstanceId,
        targetSymbol: targetInstanceId,
        decision: 'resolved',
        relationshipType: 'CALLS',
        resolutionAuthority: 'direct_binding',
        proofSteps: [
            { kind: 'call_site', subject: 'target()', span: callSpan },
            { kind: 'exact_target_definition', subject: targetInstanceId },
        ],
        dependencyKeys: [],
        flowHops: 0,
    };
}

function evidence(claims: ResolutionClaim[]) {
    return { moduleBindings: [], callSites: [], receiverTypeBindings: [], resolutionClaims: claims };
}

async function writePublication(root: string, publicationId: string) {
    const navigationRoot = path.join(root, publicationId, 'navigation');
    await writeRelationshipSidecar({
        normalizedRootPath: root,
        navigationRoot,
        symbolRegistryManifestHash,
        relationshipVersion: 'fixture-version',
        builtAt: new Date(0).toISOString(),
        records: [],
        analysisByFile: new Map([
            ['a.ts', evidence([resolvedClaim('a.ts', 'caller-a', 'target')])],
            ['b.ts', evidence([resolvedClaim('b.ts', 'caller-b', 'target')])],
            ['c.ts', evidence([resolvedClaim('c.ts', 'caller-c', 'other')])],
        ]),
    });
    return { normalizedRootPath: root, publicationId, navigationRoot, expectedSymbolRegistryManifestHash: symbolRegistryManifestHash };
}

async function writeRegistryPublication(root: string, publicationId: string) {
    const input = await writePublication(root, publicationId);
    await writeSymbolRegistrySidecar({
        navigationRoot: input.navigationRoot,
        registry: buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: root,
                rootFingerprint: 'root-fingerprint',
                indexPolicyHash: 'policy-hash',
                languageRouterVersion: 'router-v1',
                extractorVersion: 'extractor-v1',
                relationshipVersion: 'fixture-version',
                builtAt: new Date(0).toISOString(),
                files: [],
            },
            symbols: [],
        }),
    });
    return input;
}

for (const status of ['ok', 'missing', 'corrupt', 'incompatible'] as const) {
    test(`symbol registry sidecar read matches the direct reader for ${status}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
        try {
            const input = status === 'missing'
                ? { normalizedRootPath: root, publicationId: 'publication-a', navigationRoot: path.join(root, 'publication-a', 'navigation') }
                : await writeRegistryPublication(root, 'publication-a');
            if (status === 'corrupt' || status === 'incompatible') {
                fs.writeFileSync(
                    path.join(input.navigationRoot, 'manifest.json'),
                    JSON.stringify(status === 'corrupt' ? {} : { schemaVersion: 'unsupported' }),
                );
            }
            const direct = await readSymbolRegistrySidecar(input);
            assert.equal(direct.status, status);
            assert.deepEqual(await new JsonNavigationStore().getSymbolRegistrySidecarRead(input), direct);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('symbol registry sidecar read shares registry identity only within a publication', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    try {
        const firstInput = await writeRegistryPublication(root, 'publication-a');
        const secondInput = await writeRegistryPublication(root, 'publication-b');
        const store = new JsonNavigationStore();
        const first = await store.getSymbolRegistrySidecarRead(firstInput);
        const repeated = await store.getSymbolRegistrySidecarRead(firstInput);
        const second = await store.getSymbolRegistrySidecarRead(secondInput);
        assert.equal(first.status, 'ok');
        assert.equal(repeated.status, 'ok');
        assert.equal(second.status, 'ok');
        if (first.status !== 'ok' || repeated.status !== 'ok' || second.status !== 'ok') return;
        assert.strictEqual(repeated.registry, first.registry);
        assert.notStrictEqual(second.registry, first.registry);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resident relationship state excludes analysis evidence and evidence queries read only matching shards', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    try {
        const input = await writePublication(root, 'publication-a');
        const store = new JsonNavigationStore();
        const relationships = await store.getRelationships(input);
        assert.equal(relationships.status, 'ok');
        assert.equal('analysisByFile' in relationships, false);

        // Resident state was validated at load. Removing an unrelated shard
        // proves target queries no longer rescan every shard.
        fs.rmSync(path.join(input.navigationRoot, 'relationships', 'by-file', fileShardName('c.ts', symbolRegistryManifestHash)));
        const inbound = await store.getResolutionEvidence({ ...input, symbolInstanceId: 'target' });
        assert.equal(inbound.status, 'ok');
        if (inbound.status !== 'ok') return;
        assert.deepEqual(
            inbound.matches.map((match) => [match.claim.sourceFile, match.matchKind]),
            [['a.ts', 'resolved_target'], ['b.ts', 'resolved_target']],
        );
        const outbound = await store.getResolutionEvidence({ ...input, sourceInstanceId: 'caller-b' });
        assert.equal(outbound.status, 'ok');
        if (outbound.status !== 'ok') return;
        assert.deepEqual(outbound.matches.map((match) => match.claim.sourceFile), ['b.ts']);

        const fileEvidence = await store.getAnalysisEvidenceForFiles({ ...input, files: ['a.ts'] });
        assert.equal(fileEvidence.status, 'ok');
        if (fileEvidence.status !== 'ok') return;
        assert.deepEqual([...fileEvidence.analysisByFile.keys()], ['a.ts']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('all resolution claims stream across shards', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    try {
        const input = await writePublication(root, 'publication-a');
        const claims = await new JsonNavigationStore().getAllResolutionClaims(input);
        assert.equal(claims.status, 'ok');
        if (claims.status !== 'ok') return;
        assert.deepEqual(claims.claims.map((claim) => claim.sourceFile), ['a.ts', 'b.ts', 'c.ts']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Writes a Publication whose `targets` give each file's one claim and record
// target. Files in `linkedFrom` get a hardlink to that Publication's shard, as
// staging links an unchanged shard.
async function writeShardPublication(
    root: string,
    publicationId: string,
    targets: Record<string, string>,
    linkedFrom?: { navigationRoot: string; files: string[] },
) {
    const navigationRoot = path.join(root, publicationId, 'navigation');
    const files = Object.keys(targets).sort();
    await writeRelationshipSidecar({
        normalizedRootPath: root,
        navigationRoot,
        symbolRegistryManifestHash,
        relationshipVersion: 'fixture-version',
        builtAt: new Date(0).toISOString(),
        records: files.map((file) => ({
            sourceKey: `${file}#caller`, targetKey: targets[file]!, type: 'CALLS' as const, file, confidence: 'high' as const,
        })),
        analysisByFile: new Map(files.map((file) => [file, evidence([resolvedClaim(file, `caller-${file}`, targets[file]!)])])),
    });
    for (const file of linkedFrom?.files ?? []) {
        const shard = path.join('relationships', 'by-file', fileShardName(file, symbolRegistryManifestHash));
        fs.rmSync(path.join(navigationRoot, shard));
        fs.linkSync(path.join(linkedFrom!.navigationRoot, shard), path.join(navigationRoot, shard));
    }
    return { normalizedRootPath: root, publicationId, navigationRoot, expectedSymbolRegistryManifestHash: symbolRegistryManifestHash };
}

async function relationshipView(store: JsonNavigationStore, input: Awaited<ReturnType<typeof writeShardPublication>>) {
    const relationships = await store.getRelationships(input);
    assert.equal(relationships.status, 'ok');
    if (relationships.status !== 'ok') throw new Error('unreachable');
    const sourcesOf = async (symbolInstanceId: string) => {
        const evidence = await store.getResolutionEvidence({ ...input, symbolInstanceId });
        assert.equal(evidence.status, 'ok');
        return evidence.status === 'ok' ? evidence.matches.map((match) => match.claim.sourceFile) : [];
    };
    return {
        records: relationships.records,
        warnings: relationships.warnings,
        target: await sourcesOf('target'),
        moved1: await sourcesOf('moved1'),
    };
}

test('relationship shard reuse equals a cold load and reads only shards that changed', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = await writeShardPublication(root, 'publication-a', { 'a.ts': 'target', 'b.ts': 'target', 'c.ts': 'moved1' });
    const second = await writeShardPublication(
        root, 'publication-b', { 'a.ts': 'target', 'b.ts': 'moved1', 'c.ts': 'moved1' },
        { navigationRoot: first.navigationRoot, files: ['a.ts', 'c.ts'] },
    );
    const warm = new JsonNavigationStore();
    assert.equal((await warm.getRelationships(first)).status, 'ok');
    const readFile = t.mock.method(fs.promises, 'readFile');
    assert.equal((await warm.getRelationships(second)).status, 'ok');
    const shardReads = readFile.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((file) => file.includes(`${path.sep}by-file${path.sep}`))
        .map((file) => path.basename(file));
    readFile.mock.restore();
    assert.deepEqual(shardReads, [fileShardName('b.ts', symbolRegistryManifestHash)]);

    const warmView = await relationshipView(warm, second);
    const coldView = await relationshipView(new JsonNavigationStore(), second);
    assert.deepEqual(warmView, coldView);
    assert.deepEqual([warmView.target, warmView.moved1], [['a.ts'], ['b.ts', 'c.ts']]);
});

test('a rewritten shard under an unchanged manifest entry is not reused', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // a.ts keeps its manifest entry (same hash, shard path and counts) and its
    // shard size; only the stat witness shows that the shard was rewritten.
    const first = await writeShardPublication(root, 'publication-a', { 'a.ts': 'target', 'b.ts': 'target' });
    const second = await writeShardPublication(
        root, 'publication-b', { 'a.ts': 'moved1', 'b.ts': 'target' },
        { navigationRoot: first.navigationRoot, files: ['b.ts'] },
    );
    const shard = path.join('relationships', 'by-file', fileShardName('a.ts', symbolRegistryManifestHash));
    assert.equal(fs.statSync(path.join(first.navigationRoot, shard)).size, fs.statSync(path.join(second.navigationRoot, shard)).size);

    const warm = new JsonNavigationStore();
    assert.equal((await warm.getRelationships(first)).status, 'ok');
    const warmView = await relationshipView(warm, second);
    assert.deepEqual(warmView, await relationshipView(new JsonNavigationStore(), second));
    assert.deepEqual([warmView.target, warmView.moved1], [['b.ts'], ['a.ts']]);
});

test('shard reuse retention expiry between batch stat awaits still matches a cold load and clears expired state', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = await writeShardPublication(root, 'publication-a', { 'a.ts': 'target', 'b.ts': 'target', 'c.ts': 'moved1' });
    const second = await writeShardPublication(
        root, 'publication-b', { 'a.ts': 'target', 'b.ts': 'moved1', 'c.ts': 'moved1' },
        { navigationRoot: first.navigationRoot, files: ['a.ts', 'c.ts'] },
    );

    const warm = new JsonNavigationStore({ shardReuseRetentionMs: 15 });
    const firstLoaded = await warm.getRelationships(first);
    assert.equal(firstLoaded.status, 'ok');

    const originalStat = fs.promises.stat.bind(fs.promises);
    let delayedOnce = false;
    t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof fs.promises.stat>) => {
        const result = await originalStat(...args);
        if (!delayedOnce && String(args[0]).includes(`${path.sep}by-file${path.sep}`)) {
            delayedOnce = true;
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return result;
    });

    const warmView = await relationshipView(warm, second);
    assert.equal(delayedOnce, true);
    const coldView = await relationshipView(new JsonNavigationStore(), second);
    assert.deepEqual(warmView, coldView);
    assert.deepEqual([warmView.target, warmView.moved1], [['a.ts'], ['b.ts', 'c.ts']]);

    // Wait past second publication's retention window and verify expired reuse maps do not linger.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const third = await writeShardPublication(
        root, 'publication-c', { 'a.ts': 'target', 'b.ts': 'moved1', 'c.ts': 'moved1' },
        { navigationRoot: second.navigationRoot, files: ['a.ts', 'b.ts', 'c.ts'] },
    );
    const readFile = t.mock.method(fs.promises, 'readFile');
    assert.equal((await warm.getRelationships(third)).status, 'ok');
    const shardReads = readFile.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((file) => file.includes(`${path.sep}by-file${path.sep}`));
    readFile.mock.restore();
    assert.equal(shardReads.length, 3, 'expired shard reuse cache must not remain retained indefinitely');
    assert.deepEqual(await relationshipView(warm, third), await relationshipView(new JsonNavigationStore(), third));
});

test('a newer Publication releases the previous Publication state for the root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-store-'));
    try {
        const first = await writePublication(root, 'publication-a');
        const second = await writePublication(root, 'publication-b');
        const store = new JsonNavigationStore();
        assert.equal((await store.getRelationships(first)).status, 'ok');
        assert.equal(store.hasResidentRelationships(first), true);
        assert.equal((await store.getRelationships(second)).status, 'ok');
        assert.equal(store.hasResidentRelationships(first), false);
        assert.equal(store.hasResidentRelationships(second), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('relationship replacement and LRU eviction release shard reuse timers immediately', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-navigation-lru-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = await writeShardPublication(root, 'publication-a', { 'a.ts': 'target' });
    const replacement = await writeShardPublication(root, 'publication-b', { 'a.ts': 'target' });
    const other = await writeShardPublication(path.join(root, 'other'), 'publication-c', { 'b.ts': 'target' });
    const store = new JsonNavigationStore({ maxRelationshipRoots: 1, idleMs: 0, shardReuseRetentionMs: 60_000 });
    const internalStore = store as unknown as {
        readRelationships(input: typeof first): Promise<{ status: string; shardsByReuseKey?: ReadonlyMap<string, unknown> }>;
    };
    const setTimer = t.mock.method(globalThis, 'setTimeout');
    const clearTimer = t.mock.method(globalThis, 'clearTimeout');
    t.after(() => {
        for (const call of setTimer.mock.calls) clearTimeout(call.result as NodeJS.Timeout);
    });

    const firstState = await internalStore.readRelationships(first);
    assert.equal(firstState.shardsByReuseKey?.size, 1);
    const replacementState = await internalStore.readRelationships(replacement);
    assert.equal(firstState.shardsByReuseKey, undefined);
    assert.ok(clearTimer.mock.calls.some(call => call.arguments[0] === setTimer.mock.calls[0]?.result));

    assert.equal(replacementState.shardsByReuseKey?.size, 1);
    await internalStore.readRelationships(other);
    assert.equal(store.hasResidentRelationships(replacement), false);
    assert.equal(replacementState.shardsByReuseKey, undefined);
    assert.ok(clearTimer.mock.calls.some(call => call.arguments[0] === setTimer.mock.calls[1]?.result));
});

test('getRelationshipManifest validates layout without reading shard bodies and agrees with getRelationships on failures', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-rel-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = await writePublication(root, 'publication-a');
    const store = new JsonNavigationStore();

    const readFile = t.mock.method(fs.promises, 'readFile');
    const first = await store.getRelationshipManifest(input);
    const coldReads = readFile.mock.calls.map((call) => String(call.arguments[0]));
    readFile.mock.restore();

    assert.equal(first.status, 'ok');
    assert.equal(
        coldReads.some((file) => file.includes(`${path.sep}by-file${path.sep}`)),
        false,
        'manifest validation must not read per-file relationship shards',
    );
    assert.equal(store.hasResidentRelationships(input), false);

    // Warm manifest lookup must not touch disk.
    const warmReadFile = t.mock.method(fs.promises, 'readFile');
    const warm = await store.getRelationshipManifest(input);
    const warmReads = warmReadFile.mock.calls.length;
    warmReadFile.mock.restore();
    assert.equal(warm.status, 'ok');
    assert.equal(warmReads, 0);

    // Differential check against full read for manifest hash mismatch.
    const mismatched = { ...input, expectedSymbolRegistryManifestHash: 'wrong-hash' };
    const manifestMismatch = await new JsonNavigationStore().getRelationshipManifest(mismatched);
    const fullMismatch = await new JsonNavigationStore().getRelationships(mismatched);
    assert.equal(manifestMismatch.status, fullMismatch.status);
    assert.equal(manifestMismatch.status, 'incompatible');

    // Differential check: missing shard file in by-file must be rejected as incompatible.
    const byFileDir = path.join(input.navigationRoot, 'relationships', 'by-file');
    const shardNames = fs.readdirSync(byFileDir);
    assert.ok(shardNames.length > 0);
    const removedShardPath = path.join(byFileDir, shardNames[0]!);
    const removedShardBytes = fs.readFileSync(removedShardPath);
    fs.unlinkSync(removedShardPath);
    const missingShardManifest = await new JsonNavigationStore().getRelationshipManifest(input);
    const missingShardFull = await new JsonNavigationStore().getRelationships(input);
    assert.equal(missingShardManifest.status, missingShardFull.status);
    assert.equal(missingShardManifest.status, 'incompatible');
    fs.writeFileSync(removedShardPath, removedShardBytes);

    // Differential check: corrupt manifest.json must report corrupt sourceStatus.
    const manifestPath = path.join(input.navigationRoot, 'relationships', 'manifest.json');
    fs.writeFileSync(manifestPath, '{ malformed');
    const corruptManifest = await new JsonNavigationStore().getRelationshipManifest(input);
    const corruptFull = await new JsonNavigationStore().getRelationships(input);
    assert.equal(corruptManifest.status, corruptFull.status);
    assert.equal(corruptManifest.status !== 'ok' ? corruptManifest.sourceStatus : undefined, 'corrupt');
    assert.equal(corruptFull.status !== 'ok' ? corruptFull.sourceStatus : undefined, 'corrupt');
});
