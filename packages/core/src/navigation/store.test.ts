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
