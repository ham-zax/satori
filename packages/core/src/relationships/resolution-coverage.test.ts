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

function resolvedClaim(targetInstanceId = 'target-a'): ResolutionClaim {
    return unresolvedClaim({
        targetInstanceId,
        targetSymbol: 'pump',
        decision: 'resolved',
        relationshipType: 'CALLS',
        resolutionAuthority: 'direct_binding',
        proofSteps: [
            { kind: 'call_site', subject: 'this.pump', span: callSpan },
            { kind: 'exact_target_definition', subject: targetInstanceId },
        ],
        dependencyKeys: [],
    });
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

test('publication-backed resolved coverage requires the authoritative target at the exact site', () => {
    const claim = resolvedClaim('target-a');
    const relationship = {
        sourceKey: 'caller-key',
        sourceInstanceId: 'caller-id',
        targetKey: 'target-key-b',
        targetInstanceId: 'target-b',
        type: 'CALLS',
        file: 'src/client.ts',
        span: callSpan,
        confidence: 'high',
        resolutionAuthority: 'direct_binding',
    } as RelationshipRecord;

    const [unmatched] = summarizeResolutionConstructCoverage([claim], { relationships: [relationship] });
    assert.ok(unmatched);
    assert.equal(unmatched.status, 'partial');
    assert.equal(unmatched.resolvedCount, 0);
    assert.equal(unmatched.withheldResolvedCount, 1);
    assert.equal(unmatched.gapCount, 1);
    assert.equal(unmatched.gapSpans[0]?.decision, 'resolved');

    const [matched] = summarizeResolutionConstructCoverage([claim], {
        relationships: [{ ...relationship, targetKey: 'target-key-a', targetInstanceId: 'target-a' }],
    });
    assert.ok(matched);
    assert.equal(matched.status, 'ready');
    assert.equal(matched.resolvedCount, 1);
    assert.equal(matched.withheldResolvedCount, undefined);
    assert.equal(matched.gapCount, 0);

    const [standalone] = summarizeResolutionConstructCoverage([claim]);
    assert.ok(standalone);
    assert.equal(standalone.status, 'ready');
    assert.equal(standalone.resolvedCount, 1);
    assert.equal(standalone.withheldResolvedCount, undefined);
    assert.equal(standalone.gapCount, 0);
});

test('standalone non-resolved observations remain unresolved or ambiguous gaps', () => {
    const ambiguous = unresolvedClaim({
        decision: 'ambiguous',
        resolutionAuthority: 'ambiguous',
        observation: {
            kind: 'call',
            calleeName: 'pump',
            calleeText: 'this.pump',
            receiverText: 'this',
            receiverType: 'this',
            construct: 'dynamic_receiver',
            candidates: [{
                file: 'src/target.ts',
                span: callSpan,
                name: 'pump',
                symbolInstanceId: 'candidate-id',
            }],
        },
        proofSteps: [
            { kind: 'call_site', subject: 'this.pump', span: callSpan },
            { kind: 'ambiguity', subject: 'candidate-id' },
        ],
    });

    const [coverage] = summarizeResolutionConstructCoverage([unresolvedClaim(), ambiguous]);
    assert.ok(coverage);
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.resolvedCount, 0);
    assert.equal(coverage.unresolvedCount, 1);
    assert.equal(coverage.ambiguousCount, 1);
    assert.equal(coverage.gapCount, 2);
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
