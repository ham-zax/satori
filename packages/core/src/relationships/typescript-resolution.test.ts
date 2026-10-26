import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeWithOxc } from '../language-analysis/oxc-adapter';
import { analyzeTypeScriptProject } from '../semantic/typescript-compiler-provider';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRecordsForFile, buildSymbolRegistry } from '../symbols/registry';
import { buildTypeScriptResolutionClaims } from './typescript-resolution';

const sources = [
    { path: 'targets.ts', source: `
export function primary() { return 1; }
export class Worker { constructor() {} run() { return 1; } }
export class OtherWorker { run() { return 2; } }
export function overloaded(value: string): string;
export function overloaded(value: number): string;
export function overloaded(value: string | number): string { return String(value); }
` },
    { path: 'caller.ts', source: `
import { primary as alias, Worker, OtherWorker, overloaded } from './targets';
export function caller(dynamic: any, value: any) {
    alias();
    const worker: OtherWorker = new Worker();
    worker.run();
    const directWorker = new Worker();
    directWorker.run();
    new Worker().run();
    overloaded(value);
    dynamic.run();
}
` },
];

function fixture() {
    const sourceFiles = sources.map((file) => ({ ...file, sourceHash: file.path }));
    const evidence = analyzeTypeScriptProject({ language: 'typescript', sourceFiles, auxiliaryFiles: [] });
    const symbols = sources.flatMap((file) => buildSymbolRecordsForFile({
        relativePath: file.path,
        language: 'typescript',
        content: file.source,
        fileHash: file.path,
        extractorVersion: 'test',
        chunks: [],
        extractedSymbols: analyzeWithOxc({
            content: file.source, language: 'typescript', relativePath: file.path,
        }).symbols,
    }));
    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/test', rootFingerprint: 'test', indexPolicyHash: 'test',
            languageRouterVersion: 'test', extractorVersion: 'test', relationshipVersion: 'test',
            builtAt: '2026-10-26T00:00:00.000Z',
            files: sources.map((file) => ({
                path: file.path, hash: file.path, language: 'typescript', symbolCount: 0,
                definitionStatus: 'definitions_present' as const,
            })),
        },
        symbols,
    });
    const convert = (occurrencesByFile = evidence.occurrencesByFile) => buildTypeScriptResolutionClaims({
        registry, environmentConfigId: 'test', providerId: evidence.providerId,
        providerVersion: evidence.providerVersion, occurrencesByFile,
    }).get('caller.ts')!;
    return { evidence, registry, convert };
}

test('compiler binding and allocation proofs survive exact canonical conversion', () => {
    const { evidence, convert } = fixture();
    const calls = evidence.occurrencesByFile.get('caller.ts')!;
    const claims = convert();
    const alias = calls.find((call) => call.calleeText === 'alias')!;
    assert.equal(alias.target?.name, 'primary');
    assert.equal(alias.bindingProofs?.[0].kind, 'relative_import');
    assert.equal(alias.bindingProofs?.[0].subject, 'alias');
    assert.equal(alias.bindingProofs?.[0].detail, './targets');
    const aliasClaim = claims.find((claim) => claim.observation?.calleeText === 'alias')!;
    assert.equal(aliasClaim.resolutionAuthority, 'direct_binding');
    assert.ok(aliasClaim.proofSteps.some((step) => step.kind === 'relative_import'));

    for (const text of ['Worker', 'new Worker().run']) {
        const claim = claims.find((item) => item.observation?.calleeText === text)!;
        assert.equal(claim.decision, 'resolved', text);
        assert.ok(claim.proofSteps.some((step) => step.kind === 'constructor_origin'), text);
    }
    const allocated = claims.find((claim) => claim.observation?.calleeText === 'worker.run')!;
    assert.equal(allocated.resolutionAuthority, 'origin_flow');
    assert.ok(allocated.proofSteps.some((step) => step.kind === 'allocation_origin'));
    const direct = claims.find((claim) => claim.observation?.calleeText === 'directWorker.run')!;
    assert.equal(direct.resolutionAuthority, 'direct_binding');
    assert.ok(direct.proofSteps.some((step) => step.kind === 'constructor_origin'));
    const withoutProof = convert(new Map([['caller.ts', calls.map(({ bindingProofs: _proof, ...call }) => call)]]));
    assert.equal(withoutProof.find((claim) => claim.observation?.calleeText === 'worker.run')?.resolutionAuthority, 'direct_binding');
});

test('ambiguous, dynamic, and unmapped targets retain abstention', () => {
    const { registry, convert } = fixture();
    const claims = convert();
    const overloaded = claims.find((claim) => claim.observation?.calleeText === 'overloaded')!;
    assert.equal(overloaded.decision, 'ambiguous');
    assert.equal(overloaded.targetInstanceId, undefined);
    assert.ok(overloaded.proofSteps.some((step) => step.kind === 'ambiguity'
        && step.subject === 'multiple_overload_candidates'));
    const dynamic = claims.find((claim) => claim.observation?.calleeText === 'dynamic.run')!;
    assert.equal(dynamic.decision, 'unresolved');
    assert.equal(dynamic.resolutionAuthority, 'unsupported');
    assert.equal(dynamic.targetInstanceId, undefined);
    registry.symbolsByFile.set('targets.ts', []);
    const unmapped = convert().find((claim) => claim.observation?.calleeText === 'alias')!;
    assert.equal(unmapped.decision, 'unresolved');
    assert.equal(unmapped.targetInstanceId, undefined);
});
