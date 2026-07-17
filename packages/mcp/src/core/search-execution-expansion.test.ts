import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSearchExpansionDecision } from './search-execution.js';

const defaults = {
    retrievalMode: 'hybrid' as const,
    routeKind: 'conceptual' as const,
    exactRegistryFallback: false,
    operatorConstraintPresent: false,
    explicitRoleCuePresent: false,
    primaryScopedCandidateCount: 3,
    primaryFailed: false,
};

test('semantic expansion is skipped for bounded primary evidence and deterministic routes', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, retrievalMode: 'lexical' }),
        { expand: false, reason: 'lexical_route', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, routeKind: 'structural' }),
        { expand: false, reason: 'deterministic_route_primary', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, explicitRoleCuePresent: true }),
        { expand: false, reason: 'explicit_role_cue', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, primaryScopedCandidateCount: 5 }),
        { expand: false, reason: 'primary_candidate_pool_sufficient', primaryScopedCandidateCount: 5 },
    );
});

test('semantic expansion remains available for ambiguous, constrained, mixed and failed primary passes', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults }),
        { expand: true, reason: 'primary_candidate_pool_small', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, routeKind: 'mixed' }),
        { expand: true, reason: 'mixed_route', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, operatorConstraintPresent: true }),
        { expand: true, reason: 'operator_constraint', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, primaryFailed: true }),
        { expand: true, reason: 'primary_failed_fallback', primaryScopedCandidateCount: 3 },
    );
});

test('semantic expansion does not repeat a terminal provider failure', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({
            ...defaults,
            primaryFailed: true,
            primaryFailureRetryable: false,
        }),
        {
            expand: false,
            reason: 'primary_terminal_provider_failure',
            primaryScopedCandidateCount: 3,
        },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({
            ...defaults,
            primaryFailed: true,
            primaryFailureRetryable: true,
        }),
        { expand: true, reason: 'primary_failed_fallback', primaryScopedCandidateCount: 3 },
    );
});
