import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ResolutionClaim } from '../relationships/resolution';
import { fileShardName } from '../symbols/sidecar-reads';
import { writeRelationshipSidecar } from '../symbols/sidecar-writes';
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
