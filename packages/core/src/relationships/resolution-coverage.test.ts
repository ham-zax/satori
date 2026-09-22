import assert from 'node:assert/strict';
import test from 'node:test';

import type { RelationshipRecord } from '../symbols';
import type { ResolutionClaim } from './resolution';
import { summarizeResolutionConstructCoverage } from './resolution-coverage';

const callSpan = {
    startLine: 4,
    endLine: 4,
    startByte: 42,
    endByte: 53,
    startColumn: 4,
    endColumn: 15,
};

function unresolvedClaim(overrides: Partial<ResolutionClaim> = {}): ResolutionClaim {
    return {
        providerId: 'fixture-provider',
        providerVersion: 'fixture-v1',
        environmentConfigId: 'fixture-env',
        sourceFile: 'src/client.ts',
        sourceInstanceId: 'caller-id',
        callSpan,
        observation: {
            kind: 'call',
            calleeName: 'pump',
            calleeText: 'this.pump',
            receiverText: 'this',
            receiverType: 'this',
            construct: 'dynamic_receiver',
            candidates: [],
        },
        decision: 'unresolved',
        relationshipType: 'REFERENCES',
        resolutionAuthority: 'unresolved',
        proofSteps: [
            { kind: 'call_site', subject: 'this.pump', span: callSpan },
            { kind: 'unresolved_dependency', subject: 'generic_receiver' },
        ],
        dependencyKeys: ['fixture-dependency'],
        flowHops: 0,
        ...overrides,
    };
}

test('construct coverage reconciles an unresolved semantic claim with an authoritative call at the exact site', () => {
    const relationship = {
        sourceKey: 'caller-key',
        sourceInstanceId: 'caller-id',
        targetKey: 'target-key',
        targetInstanceId: 'target-id',
        type: 'CALLS',
        file: 'src/client.ts',
        span: callSpan,
        confidence: 'high',
        resolutionAuthority: 'direct_binding',
    } as RelationshipRecord;

    const [coverage] = summarizeResolutionConstructCoverage(
        [unresolvedClaim()],
        { relationships: [relationship] },
    );

    assert.ok(coverage);
    assert.equal(coverage.status, 'ready');
    assert.equal(coverage.observedCount, 1);
    assert.equal(coverage.resolvedCount, 1);
    assert.equal(coverage.unresolvedCount, 0);
    assert.equal(coverage.gapCount, 0);
    assert.deepEqual(coverage.gapSpans, []);
});

test('unsupported non-repository calls do not reduce repository construct coverage', () => {
    const claim = unresolvedClaim({
        sourceInstanceId: undefined,
        observation: {
            kind: 'call',
            calleeName: 'now',
            calleeText: 'performance.now',
            receiverText: 'performance',
            receiverType: 'Performance',
            construct: 'typed_member_call',
            candidates: [],
        },
        resolutionAuthority: 'unsupported',
        proofSteps: [
            { kind: 'call_site', subject: 'performance.now', span: callSpan },
            { kind: 'unresolved_dependency', subject: 'target_not_indexable' },
        ],
    });

    const [coverage] = summarizeResolutionConstructCoverage([claim]);

    assert.ok(coverage);
    assert.equal(coverage.status, 'unsupported');
    assert.equal(coverage.observedCount, 1);
    assert.equal(coverage.resolvedCount, 0);
    assert.equal(coverage.unsupportedCount, 1);
    assert.equal(coverage.unresolvedCount, 0);
    assert.equal(coverage.gapCount, 0);
    assert.deepEqual(coverage.gapSpans, []);
});
