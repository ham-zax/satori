import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveOllamaModelIdentity,
    type OllamaIdentityClient,
} from './ollama-model-identity';

const DIGEST = 'a'.repeat(64);

function client(overrides: Partial<OllamaIdentityClient> = {}): OllamaIdentityClient {
    return {
        async list() {
            return {
                models: [{
                    name: 'nomic-embed-text:latest',
                    model: 'nomic-embed-text:latest',
                    digest: DIGEST,
                    size: 274_000_000,
                }],
            };
        },
        async embed() {
            return { embeddings: [[0.25, 0.5, 0.75]] };
        },
        ...overrides,
    };
}

test('Ollama identity resolves the installed artifact and live dimension', async () => {
    const probeInputs: string[] = [];
    const identity = await resolveOllamaModelIdentity({
        model: 'nomic-embed-text',
        client: client({
            async embed(request) {
                probeInputs.push(request.input);
                return { embeddings: [[0.25, 0.5, 0.75]] };
            },
        }),
    });

    assert.deepEqual(identity, {
        configuredModel: 'nomic-embed-text',
        resolvedModel: 'nomic-embed-text:latest',
        artifactDigest: DIGEST,
        artifactSize: 274_000_000,
        dimension: 3,
    });
    assert.equal(Object.isFrozen(identity), true);
    assert.equal(probeInputs.length, 2);
});

test('Ollama identity fails before runtime construction when the model is missing', async () => {
    await assert.rejects(
        resolveOllamaModelIdentity({
            model: 'missing-model',
            client: client(),
        }),
        /is not installed/,
    );
});

test('Ollama identity rejects missing digests and invalid probe vectors', async () => {
    await assert.rejects(
        resolveOllamaModelIdentity({
            model: 'nomic-embed-text',
            client: client({
                async list() {
                    return {
                        models: [{
                            name: 'nomic-embed-text:latest',
                            model: 'nomic-embed-text:latest',
                            digest: '',
                            size: 1,
                        }],
                    };
                },
            }),
        }),
        /no valid local artifact digest/,
    );

    await assert.rejects(
        resolveOllamaModelIdentity({
            model: 'nomic-embed-text',
            client: client({ async embed() { return { embeddings: [[]] }; } }),
        }),
        /invalid or dimensionally unstable probe vectors/,
    );

    let call = 0;
    await assert.rejects(
        resolveOllamaModelIdentity({
            model: 'nomic-embed-text',
            client: client({
                async embed() {
                    call += 1;
                    return { embeddings: [call === 1 ? [1, 2, 3] : [1, 2]] };
                },
            }),
        }),
        /dimensionally unstable probe vectors/,
    );
});
