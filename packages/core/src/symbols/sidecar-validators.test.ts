import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_PYTHON_FLOW_HOPS,
    NATIVE_PYTHON_PROVIDER_ID,
    NATIVE_PYTHON_PROVIDER_VERSION,
} from '../relationships/resolution';
import { isResolutionClaim } from './sidecar-validators';

function claim(providerId: string, providerVersion: string, flowHops: number) {
    return {
        providerId,
        providerVersion,
        environmentConfigId: 'fixture-environment',
        sourceFile: 'src/app.ts',
        callSpan: {
            startLine: 1,
            endLine: 1,
            startColumn: 1,
            endColumn: 5,
            startByte: 0,
            endByte: 4,
        },
        decision: 'unresolved',
        relationshipType: 'REFERENCES',
        resolutionAuthority: 'unresolved',
        proofSteps: [{ kind: 'call_site', subject: 'fixture()' }],
        dependencyKeys: ['fixture-dependency'],
        flowHops,
    };
}

test('generic resolution claim validation does not apply the Python-native hop bound', () => {
    assert.equal(
        isResolutionClaim(claim('fixture-typescript-provider', 'v1', MAX_PYTHON_FLOW_HOPS + 10)),
        true,
    );
});

test('Python-native resolution claims retain their bounded-flow safety limit', () => {
    assert.equal(
        isResolutionClaim(claim(
            NATIVE_PYTHON_PROVIDER_ID,
            NATIVE_PYTHON_PROVIDER_VERSION,
            MAX_PYTHON_FLOW_HOPS,
        )),
        true,
    );
    assert.equal(
        isResolutionClaim(claim(
            NATIVE_PYTHON_PROVIDER_ID,
            NATIVE_PYTHON_PROVIDER_VERSION,
            MAX_PYTHON_FLOW_HOPS + 1,
        )),
        false,
    );
});
