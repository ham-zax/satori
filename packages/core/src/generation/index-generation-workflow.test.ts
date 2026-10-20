import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSemanticLanguageRegistry } from '../semantic/descriptor';
import { buildSymbolRegistry, SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/registry';
import {
    IndexGenerationWorkflow,
    type IndexGenerationWorkflowPorts,
} from './index-generation-workflow';

type WorkflowInternals = {
    reindexByChangeQueues: Map<string, Promise<void>>;
    runSerializedReindexByChange<T>(canonicalRoot: string, operation: () => Promise<T>): Promise<T>;
};

function getWorkflowInternals(workflow: IndexGenerationWorkflow): WorkflowInternals {
    return workflow as unknown as WorkflowInternals;
}

function createWorkflow(): IndexGenerationWorkflow {
    return new IndexGenerationWorkflow({} as IndexGenerationWorkflowPorts);
}

test('IndexGenerationWorkflow removes serialized reindex queue entries after success and failure', async () => {
    const workflow = createWorkflow();
    const internals = getWorkflowInternals(workflow);

    await internals.runSerializedReindexByChange('/repo', async () => 'completed');
    assert.equal(internals.reindexByChangeQueues.size, 0);

    await assert.rejects(
        () => internals.runSerializedReindexByChange('/repo', async () => {
            throw new Error('reindex failed');
        }),
        /reindex failed/,
    );
    assert.equal(internals.reindexByChangeQueues.size, 0);
});

test('IndexGenerationWorkflow removes the final queue entry after concurrent serialization', async () => {
    const workflow = createWorkflow();
    const internals = getWorkflowInternals(workflow);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve;
    });

    const first = internals.runSerializedReindexByChange('/repo', async () => {
        order.push('first');
        firstStarted();
        await firstReleased;
    });
    await firstStartedPromise;

    const second = internals.runSerializedReindexByChange('/repo', async () => {
        order.push('second');
    });
    assert.equal(internals.reindexByChangeQueues.size, 1);

    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['first', 'second']);
    assert.equal(internals.reindexByChangeQueues.size, 0);
});

import * as crypto from 'node:crypto';

test('stageSymbolRegistryForCompletedIndex fails closed when navigation source drifts', async () => {
    const canonicalRoot = '/mock/repo';
    const filePath = 'src/foo.ts';
    const initialContent = 'export function foo() {}\n';
    const initialHash = crypto.createHash('sha256').update(initialContent, 'utf8').digest('hex');
    const driftedContent = 'export function foo() { return 42; }\n';

    const mockPorts: Partial<IndexGenerationWorkflowPorts> = {
        canonicalizeCodebasePath: (p) => p,
        buildRootFingerprint: () => 'root-fp',
        buildIndexPolicyHash: () => 'policy-hash',
        getLanguageRouterVersion: () => 'router-v1',
        getSymbolExtractorVersion: () => 'extractor-v1',
        getRelationshipVersion: () => 'rel-v1',
        readIndexableFileObservationInsideRoot: async () => ({
            content: driftedContent,
            sourceHash: crypto.createHash('sha256').update(driftedContent, 'utf8').digest('hex'),
        }),
        languageAnalyzer: {
            analyze: async () => ({
                symbols: [],
                moduleBindings: [],
                callSites: [],
                receiverTypeBindings: [],
                pythonFlowFacts: [],
                moduleDocstring: undefined,
            }),
            supportedExtensions: ['.ts'],
            canAnalyze: () => true,
        } as unknown as IndexGenerationWorkflowPorts['languageAnalyzer'],
    };


    const workflow = new IndexGenerationWorkflow(mockPorts as IndexGenerationWorkflowPorts);

    await assert.rejects(
        () => workflow.stageSymbolRegistryForCompletedIndex(
            canonicalRoot,
            'publication-test',
            '/mock/publication-test/navigation',
            [],
            [{
                path: filePath,
                language: 'typescript',
                hash: initialHash,
                symbolCount: 0,
                definitionStatus: 'definitions_present',
            }],
            new Map([[filePath, initialHash]]),
        ),
        /Source changed before navigation publication for 'src\/foo\.ts'\./,
    );
});


test('full file processing reserves progress for relationship resolution', async () => {
    const stopped = new Error('stop after file progress');
    const percentages: number[] = [];
    const ports: Partial<IndexGenerationWorkflowPorts> = {
        embedding: {} as IndexGenerationWorkflowPorts['embedding'],
        vectorDatabase: {
            dropCollection: async () => undefined,
            hasCollection: async () => false,
        } as unknown as IndexGenerationWorkflowPorts['vectorDatabase'],
        canonicalizeCodebasePath: (root) => root,
        getIsHybrid: () => false,
        assertResolvedIndexPolicyRoot: () => undefined,
        setIndexProfileForCodebase: () => undefined,
        resolvePublicationCollectionName: () => 'candidate',
        reserveIndexCandidate: () => undefined,
        prepareCollection: async () => undefined,
        markIndexCandidateCollectionCreated: () => undefined,
        getCodeFiles: async () => ['/mock/repo/app.py'],
        normalizeRelativePathForCodebase: () => 'app.py' as ReturnType<IndexGenerationWorkflowPorts['normalizeRelativePathForCodebase']>,
        processFileList: async (_files, _root, onProgress) => {
            onProgress?.('/mock/repo/app.py', 1, 1);
            throw stopped;
        },
        discardUnpublishedPublication: () => undefined,
        clearIndexCandidate: () => undefined,
    };
    const workflow = new IndexGenerationWorkflow(ports as IndexGenerationWorkflowPorts);
    await assert.rejects(workflow.indexCodebase('/mock/repo', (progress) => {
        percentages.push(progress.percentage);
    }, {
        rootMutationLease: { canonicalRoot: '/mock/repo', operationId: 'candidate' } as never,
        indexPolicy: { profile: 'default' } as never,
    }), (error) => error === stopped);
    assert.equal(percentages.at(-1), 90);
});

for (const readKind of ['auxiliary', 'source'] as const) {
    for (const swapKind of ['file', 'directory'] as const) {
        test(`semantic ${readKind} read rejects a ${swapKind} symlink swap after root resolution`, async (t) => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-semantic-race-'));
            t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
            const root = path.join(directory, 'repo');
            const nested = path.join(root, 'nested');
            const outside = path.join(directory, 'outside');
            fs.mkdirSync(nested, { recursive: true });
            fs.mkdirSync(outside);
            const name = readKind === 'auxiliary' ? 'Cargo.toml' : 'lib.rs';
            const relativePath = `nested/${name}`;
            const filePath = path.join(nested, name);
            // Matching hashes must not authorize reading an out-of-root inode.
            const content = readKind === 'auxiliary' ? '[package]\nname = "test"\n' : 'pub fn example() {}\n';
            fs.writeFileSync(filePath, content);
            fs.writeFileSync(path.join(outside, name), content);
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            const originalRealpath = fsp.realpath;
            let swapped = false;
            t.mock.method(fsp, 'realpath', async (...args: Parameters<typeof fsp.realpath>) => {
                const resolved = await originalRealpath(...args);
                if (!swapped && String(args[0]) === filePath) {
                    swapped = true;
                    if (swapKind === 'file') {
                        fs.unlinkSync(filePath);
                        fs.symlinkSync(path.join(outside, name), filePath);
                    } else {
                        fs.renameSync(nested, path.join(root, 'original'));
                        fs.symlinkSync(outside, nested, 'dir');
                    }
                }
                return resolved;
            });
            let analyzed = false;
            const ports: Partial<IndexGenerationWorkflowPorts> = {
                canonicalizeCodebasePath: (value) => value,
                buildRootFingerprint: () => 'root',
                buildIndexPolicyHash: () => 'policy',
                getLanguageRouterVersion: () => 'router',
                getSymbolExtractorVersion: () => 'extractor',
                getRelationshipVersion: () => 'relationships',
                semanticAnalyzer: {
                    supportsLanguage: (language) => language === 'rust',
                    analyze: async () => {
                        analyzed = true;
                        return { language: 'rust', occurrencesByFile: new Map() };
                    },
                } as IndexGenerationWorkflowPorts['semanticAnalyzer'],
            };
            const workflow = new IndexGenerationWorkflow(ports as IndexGenerationWorkflowPorts);
            const internals = workflow as unknown as {
                collectSemanticAuxiliariesForLanguage(...args: unknown[]): Promise<unknown>;
                rebuildNavigationArtifactsForSyncDelta(...args: unknown[]): Promise<unknown>;
            };
            let operation: Promise<unknown>;
            if (readKind === 'auxiliary') {
                assert.ok(defaultSemanticLanguageRegistry.matchAuxiliaries(relativePath).some((entry) => entry.language === 'rust'));
                operation = internals.collectSemanticAuxiliariesForLanguage(
                    root, 'rust', defaultSemanticLanguageRegistry, new Map([[relativePath, hash]]),
                );
            } else {
                const registry = buildSymbolRegistry({
                    manifest: {
                        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                        normalizedRootPath: root,
                        rootFingerprint: 'root',
                        indexPolicyHash: 'policy',
                        languageRouterVersion: 'router',
                        extractorVersion: 'extractor',
                        relationshipVersion: 'relationships',
                        builtAt: new Date().toISOString(),
                        files: [{ path: relativePath, language: 'rust', hash, symbolCount: 0, definitionStatus: 'definition_free' }],
                    },
                    symbols: [],
                });
                operation = internals.rebuildNavigationArtifactsForSyncDelta(
                    root, registry, [relativePath], [], registry.manifest.files,
                    'previous', path.join(directory, 'previous-navigation'),
                    'next', path.join(directory, 'next-navigation'), new Map(),
                    () => { throw new Error('stop before sidecar staging'); }, undefined,
                    { records: [], analysisByFile: new Map(), providerCoverage: [] },
                );
            }
            const result = await operation.then(() => undefined, (error: unknown) => error);
            assert.equal(swapped, true, 'the race was injected at resolution');
            assert.equal(analyzed, false, 'out-of-root source must not reach the semantic provider');
            assert.ok(result instanceof Error, 'out-of-root auxiliary must not be accepted');
            assert.match(result.message, /inside root|escapes indexed root|non-file|symbolic|delta rebuild|ELOOP/);
        });
    }
}

test('stageSymbolRegistryForCompletedIndex skips semantic source reads when sizes prove a provider limit failure', async () => {
    const stopped = new Error('stop after semantic loop');
    const filePath = 'src/big.cpp';
    const hash = 'hash-big';
    const reads: string[] = [];
    const sizesSeen: number[][] = [];
    let analyzeCalls = 0;
    const warnings: string[] = [];
    const ports: Partial<IndexGenerationWorkflowPorts> = {
        canonicalizeCodebasePath: (p) => p,
        buildRootFingerprint: () => 'root-fp',
        buildIndexPolicyHash: () => 'policy-hash',
        getLanguageRouterVersion: () => 'router-v1',
        getSymbolExtractorVersion: () => 'extractor-v1',
        getRelationshipVersion: () => 'rel-v1',
        readIndexableFileObservationInsideRoot: async (absolutePath: string) => {
            reads.push(absolutePath);
            throw new Error('semantic source must not be re-read');
        },
        semanticAnalyzer: {
            supportsLanguage: (language: string) => language === 'cpp',
            provableLimitFailure: (_language: string, sizes: readonly number[]) => {
                sizesSeen.push([...sizes]);
                return 'session exceeds native source limit';
            },
            analyze: async () => {
                analyzeCalls += 1;
                throw new Error('analyze must not run');
            },
            releaseIdleWorker: async () => {
                throw stopped;
            },
        },
    };
    const workflow = new IndexGenerationWorkflow(ports as IndexGenerationWorkflowPorts);
    const originalWarn = console.warn;
    console.warn = (message: string) => { warnings.push(message); };
    try {
        await assert.rejects(
            () => workflow.stageSymbolRegistryForCompletedIndex(
                '/mock/repo',
                'publication-test',
                '/mock/publication-test/navigation',
                [],
                [{ path: filePath, language: 'cpp', hash, symbolCount: 0, definitionStatus: 'definitions_present' }],
                new Map([[filePath, hash]]),
                undefined,
                new Map([[filePath, { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] }]]),
                undefined,
                [{ path: filePath, sourceHash: hash, sourceStat: { size: 4096, mtimeMs: 1, ctimeMs: 1 } }] as never,
                undefined,
                { releaseSemanticBeforeResolution: true } as never,
            ),
            (error) => error === stopped,
        );
    } finally {
        console.warn = originalWarn;
    }
    assert.deepEqual(reads, []);
    assert.equal(analyzeCalls, 0);
    assert.deepEqual(sizesSeen, [[4096]]);
    assert.ok(warnings.some((message) => message.includes("for 'cpp'") && message.includes('session exceeds native source limit')));
});
