import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertNetworkPolicyAllowsEndpoint,
    resolveExecutionPolicy,
} from './execution-profile';

test('missing execution profile resolves to the connected policy', () => {
    assert.deepEqual(resolveExecutionPolicy(undefined), {
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
    });
});

test('offline profile derives the local-only network policy', () => {
    assert.deepEqual(resolveExecutionPolicy('offline'), {
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
    });
});

test('invalid and empty explicit execution profiles fail closed', () => {
    assert.throws(
        () => resolveExecutionPolicy(''),
        /Invalid SATORI_RUNTIME_PROFILE ''/,
    );
    assert.throws(
        () => resolveExecutionPolicy('voyage'),
        /Invalid SATORI_RUNTIME_PROFILE 'voyage'/,
    );
});

test('resolved execution policy is immutable', () => {
    const policy = resolveExecutionPolicy('offline');
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.networkPolicy), true);
});

test('local-only policy accepts loopback endpoints and rejects remote hosts', () => {
    const { networkPolicy } = resolveExecutionPolicy('offline');

    assert.doesNotThrow(() => assertNetworkPolicyAllowsEndpoint(
        networkPolicy,
        'http://127.0.0.1:8080',
        'OPENAI_BASE_URL',
    ));
    assert.doesNotThrow(() => assertNetworkPolicyAllowsEndpoint(
        networkPolicy,
        'http://[::1]:8080',
        'OPENAI_BASE_URL',
    ));
    assert.throws(
        () => assertNetworkPolicyAllowsEndpoint(
            networkPolicy,
            'https://api.example.com',
            'OPENAI_BASE_URL',
        ),
        /loopback HTTP\(S\) endpoint/,
    );
});
