import assert from 'node:assert/strict';
import test from 'node:test';
import { neutralEvidenceFromResolutionClaim } from './semantic-qualification-adapter-helpers.mjs';

test('overload evidence requires both an explicit overload reason and candidates', () => {
    const candidates = { kind: 'candidate_set', subject: 'first|second' };
    const ambiguity = { kind: 'ambiguity', subject: 'multiple_overload_candidates' };
    const normalize = (proofSteps) => neutralEvidenceFromResolutionClaim({ sourceFile: 'call.ts', proofSteps });
    assert.ok(normalize([candidates, ambiguity]).some((atom) => atom.kind === 'overload_candidate'));
    assert.equal(normalize([candidates]).some((atom) => atom.kind === 'overload_candidate'), false);
    assert.equal(normalize([ambiguity]).some((atom) => atom.kind === 'overload_candidate'), false);
    assert.equal(normalize([candidates, { ...ambiguity, subject: 'multiple_executable_targets' }])
        .some((atom) => atom.kind === 'overload_candidate'), false);
});

test('dynamic evidence requires an explicit dynamic abstention reason', () => {
    for (const reason of ['dynamic_receiver', 'dynamic_callee', 'missing_symbol', 'generic_receiver']) {
        const evidence = neutralEvidenceFromResolutionClaim({
            sourceFile: 'call.ts',
            proofSteps: [{ kind: 'unresolved_dependency', subject: reason }],
        });
        assert.equal(evidence.some((atom) => atom.kind === 'dynamic_construct'), reason.startsWith('dynamic_'));
        assert.ok(evidence.some((atom) => atom.kind === 'unresolved_dependency'));
    }
});
