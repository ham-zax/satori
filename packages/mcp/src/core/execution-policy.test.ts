import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExecutionPolicyAllowsRuntime } from '../config.js';

test('connected profile preserves existing provider and backend combinations', () => {
    assert.doesNotThrow(() => assertExecutionPolicyAllowsRuntime({
        executionProfile: 'connected',
        encoderProvider: 'Ollama',
        vectorStoreProvider: 'Milvus',
    }));
});

test('offline profile accepts only explicit local providers with LanceDB', () => {
    assert.doesNotThrow(() => assertExecutionPolicyAllowsRuntime({
        executionProfile: 'offline',
        encoderProvider: 'Ollama',
        vectorStoreProvider: 'LanceDB',
    }));
    assert.doesNotThrow(() => assertExecutionPolicyAllowsRuntime({
        executionProfile: 'offline',
        encoderProvider: 'Potion',
        vectorStoreProvider: 'LanceDB',
    }));

    assert.throws(
        () => assertExecutionPolicyAllowsRuntime({
            executionProfile: 'offline',
            encoderProvider: 'VoyageAI',
            vectorStoreProvider: 'LanceDB',
        }),
        /offline requires EMBEDDING_PROVIDER=Ollama or Potion/,
    );
    assert.throws(
        () => assertExecutionPolicyAllowsRuntime({
            executionProfile: 'offline',
            encoderProvider: 'Ollama',
            vectorStoreProvider: 'Milvus',
        }),
        /offline requires VECTOR_STORE_PROVIDER=LanceDB/,
    );

    assert.throws(
        () => assertExecutionPolicyAllowsRuntime({
            executionProfile: 'connected',
            encoderProvider: 'Potion',
            vectorStoreProvider: 'LanceDB',
        }),
        /Potion is experimental and requires SATORI_RUNTIME_PROFILE=offline/,
    );
});
