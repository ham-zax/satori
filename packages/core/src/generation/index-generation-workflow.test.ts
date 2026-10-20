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

for (const outcome of ['drop fails', 'drop succeeds', 'publish succeeds'] as const) {
    test(`atomic delta candidate receipt: ${outcome}`, async (t) => {
        const canonicalRoot = '/mock/repo';
        const publicationId = 'delta-candidate';
        const candidateCollectionName = 'candidate-collection';
        const lease = { canonicalRoot, operationId: publicationId };
        const calls: string[] = [];
        let receipt: 'reserved' | 'collection_created' | undefined;
        let collectionExists = false;
        const failure = new Error('injected delta payload failure');
        const dropFailure = new Error('injected collection drop failure');
        const warnings: unknown[][] = [];
        t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
        const sourcePublication = {
            id: 'source',
            publication: { navigation: {}, vector: { totalChunks: 1 } },
        };
        const ports: Partial<IndexGenerationWorkflowPorts> = {
            getCurrentPublicationSourceCheckpoint: () => ({ ref: sourcePublication }) as ReturnType<IndexGenerationWorkflowPorts['getCurrentPublicationSourceCheckpoint']>,
            getPublicationNavigation: () => ({ navigationRoot: '/mock/navigation' }) as ReturnType<IndexGenerationWorkflowPorts['getPublicationNavigation']>,
            resolvePublicationCollectionName: () => candidateCollectionName,
            reserveIndexCandidate: (root, collection, mutationLease) => {
                assert.equal(root, canonicalRoot);
                assert.equal(collection, candidateCollectionName);
                assert.equal(mutationLease, lease);
                calls.push('reserve');
                receipt = 'reserved';
            },
            markIndexCandidateCollectionCreated: (root, id, mutationLease) => {
                assert.equal(root, canonicalRoot);
                assert.equal(id, publicationId);
                assert.equal(mutationLease, lease);
                calls.push('mark');
                receipt = 'collection_created';
            },
            clearIndexCandidate: (root, id, mutationLease) => {
                assert.equal(root, canonicalRoot);
                assert.equal(id, publicationId);
                assert.equal(mutationLease, lease);
                calls.push('clear');
                receipt = undefined;
            },
            vectorDatabase: {
                forkCollection: async (source: string, candidate: string) => {
                    assert.equal(source, 'source-collection');
                    assert.equal(candidate, candidateCollectionName);
                    calls.push('fork');
                    collectionExists = true;
                },
                dropCollection: async (collection: string) => {
                    assert.equal(collection, candidateCollectionName);
                    calls.push('drop');
                    if (outcome === 'drop fails') throw dropFailure;
                    collectionExists = false;
                    calls.push('dropped');
                },
            } as unknown as IndexGenerationWorkflowPorts['vectorDatabase'],
            countIndexedPayloadExactly: async () => 1,
            deleteFileChunks: async () => {
                calls.push('payload');
                if (outcome !== 'publish succeeds') throw failure;
            },
            preparePublicationNavigationRoot: () => '/mock/candidate-navigation',
            stagePublicationPackageOwnership: () => undefined,
            stagePublicationSourceCheckpoint: () => undefined,
            isObservedIndexPolicyControlSignatureCurrent: async () => true,
            activatePublication: () => {
                calls.push('activate');
                return { id: publicationId } as ReturnType<IndexGenerationWorkflowPorts['activatePublication']>;
            },
            resolveNavigationObservationToken: () => null,
            registerSynchronizerForPublication: () => undefined,
            collectPublicationGarbage: async () => [],
            discardUnpublishedPublication: () => { calls.push('discard'); },
        };
        const workflow = new IndexGenerationWorkflow(ports as IndexGenerationWorkflowPorts);
        const internals = workflow as unknown as {
            performAtomicDeltaPublication(input: unknown): Promise<unknown>;
            resolveReusableNavigationDeltaState(): unknown;
            rebuildNavigationArtifactsForSyncDelta(): Promise<unknown>;
            verifyPreparedSyncPublication(): Promise<void>;
            buildTask2Publication(): unknown;
        };
        t.mock.method(internals, 'resolveReusableNavigationDeltaState', () => ({
            registry: { manifest: { files: [{ path: 'removed.ts' }] } },
        }));
        t.mock.method(internals, 'rebuildNavigationArtifactsForSyncDelta', async () => ({ candidate: {}, state: {} }));
        t.mock.method(internals, 'verifyPreparedSyncPublication', async () => undefined);
        t.mock.method(internals, 'buildTask2Publication', () => ({ id: publicationId }));
        const operation = internals.performAtomicDeltaPublication({
            codebasePath: canonicalRoot,
            canonicalRoot,
            sourcePublication,
            sourceCollectionName: 'source-collection',
            sealedPolicy: {},
            synchronizerKey: 'source-collection',
            synchronizer: {},
            preparedChanges: {
                changes: { added: [], modified: [], removed: ['removed.ts'] },
                fileHashes: new Map(),
                sourceCheckpoint: { fileStats: [] },
                assertSourceObservationCurrent: async () => undefined,
                commit: async () => { calls.push('commit'); },
            },
            resolutionSourceControls: new Set(),
            packageOwnershipSourceControls: new Set(),
            options: { rootMutationLease: lease },
            resourcePlan: {},
        });

        if (outcome === 'publish succeeds') {
            await operation;
            assert.deepEqual(calls, ['reserve', 'fork', 'mark', 'payload', 'activate', 'commit', 'clear']);
            assert.equal(receipt, undefined);
            assert.equal(collectionExists, true);
        } else {
            await assert.rejects(operation, (error) => error === failure);
            assert.deepEqual(calls, outcome === 'drop fails'
                ? ['reserve', 'fork', 'mark', 'payload', 'discard', 'drop']
                : ['reserve', 'fork', 'mark', 'payload', 'discard', 'drop', 'dropped', 'clear']);
            assert.equal(receipt, outcome === 'drop fails' ? 'collection_created' : undefined);
            assert.equal(collectionExists, outcome === 'drop fails');
        }
        if (outcome === 'drop fails') {
            assert.ok(warnings.some((args) => args.some((arg) => String(arg).includes(dropFailure.message))));
        } else {
            assert.deepEqual(warnings, []);
        }
    });
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

test('full index membership matches array inclusion without repeated linear lookups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-selected-sources-'));
    try {
        for (const { selected, consumed } of [
            { selected: [], consumed: [] },
            { selected: ['a.ts', 'b.ts'], consumed: ['b.ts', 'a.ts'] },
            { selected: ['a.ts', 'a.ts', 'b.ts'], consumed: ['a.ts', 'a.ts'] },
            { selected: ['a.ts'], consumed: ['outside.ts'] },
        ]) {
            let linearLookups = 0;
            // Array map/filter preserve this species through source selection.
            class SelectedPaths extends Array<string> {
                override includes(value: string, fromIndex?: number): boolean {
                    linearLookups++;
                    return super.includes(value, fromIndex);
                }
            }
            const ports: Partial<IndexGenerationWorkflowPorts> = {
                embedding: {} as IndexGenerationWorkflowPorts['embedding'],
                vectorDatabase: {
                    dropCollection: async () => undefined,
                    hasCollection: async () => false,
                } as unknown as IndexGenerationWorkflowPorts['vectorDatabase'],
                canonicalizeCodebasePath: (value) => value,
                getIsHybrid: () => false,
                assertResolvedIndexPolicyRoot: () => undefined,
                setIndexProfileForCodebase: () => undefined,
                resolvePublicationCollectionName: () => 'candidate',
                reserveIndexCandidate: () => undefined,
                prepareCollection: async () => undefined,
                markIndexCandidateCollectionCreated: () => undefined,
                getCodeFiles: async () => new SelectedPaths(...selected.map((name) => path.join(root, name))),
                normalizeRelativePathForCodebase: (_root, filePath) => path.relative(root, filePath) as ReturnType<IndexGenerationWorkflowPorts['normalizeRelativePathForCodebase']>,
                processFileList: async () => ({
                    processedFiles: consumed.length,
                    totalChunks: 0,
                    status: 'limit_reached',
                    symbolRecords: [],
                    symbolManifestFiles: [],
                    analysisByFile: new Map(),
                    sourceFiles: consumed.map((filePath) => ({
                        path: filePath as NonNullable<ReturnType<IndexGenerationWorkflowPorts['normalizeRelativePathForCodebase']>>,
                        sourceHash: 'hash',
                        sourceStat: { size: 1, mtimeMs: 1, ctimeMs: 1 },
                    })),
                    performance: {
                        analysisMs: 0, embeddedInputBytes: 0,
                        logicalEmbeddingRequests: 0, logicalEmbeddingDurationMs: 0,
                        logicalVectorWriteRequests: 0, logicalVectorWriteDurationMs: 0,
                    },
                    payloadSettled: Promise.resolve(),
                }),
                subtractEmbeddingMetrics: () => null,
                subtractVectorWriteMetrics: () => null,
                summarizeVectorWriteMetrics: () => null,
                discardUnpublishedPublication: () => undefined,
                clearIndexCandidate: () => undefined,
            };
            const workflow = new IndexGenerationWorkflow(ports as IndexGenerationWorkflowPorts);
            const operation = workflow.indexCodebase(root, undefined, {
                rootMutationLease: { canonicalRoot: root, operationId: 'candidate' } as never,
                indexPolicy: { profile: 'default' } as never,
                deferPartialPublication: true,
            });
            const expectedRejection = [...new Set(consumed)].some((filePath) => !selected.includes(filePath));
            if (expectedRejection) {
                await assert.rejects(operation, /captured source evidence for a path outside the selected source set/);
            } else {
                const result = await operation;
                assert.deepEqual(result.indexedPaths, consumed);
                assert.equal(result.publication.status, 'staged');
            }
            assert.equal(linearLookups, 0, 'membership must use one compiled Set');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
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
