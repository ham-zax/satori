import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertNetworkPolicyAllowsEndpoint,
    resolveExecutionPolicy,
} from './execution-profile';

test('missing execution profile preserves the legacy connected policy', () => {
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

test('local-only policy accepts loopback Ollama endpoints and rejects remote hosts', () => {
    const { networkPolicy } = resolveExecutionPolicy('offline');

    assert.doesNotThrow(() => assertNetworkPolicyAllowsEndpoint(
        networkPolicy,
        'http://127.0.0.1:11434',
        'OLLAMA_HOST',
    ));
    assert.doesNotThrow(() => assertNetworkPolicyAllowsEndpoint(
        networkPolicy,
        'http://[::1]:11434',
        'OLLAMA_HOST',
    ));
    assert.throws(
        () => assertNetworkPolicyAllowsEndpoint(
            networkPolicy,
            'https://ollama.example.com',
            'OLLAMA_HOST',
        ),
        /loopback HTTP\(S\) endpoint/,
    );
});
