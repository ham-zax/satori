import test from 'node:test';
import assert from 'node:assert/strict';
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

test('stageSymbolRegistryForCompletedIndex fails closed when source drifts even if analysisByFile is supplied', async () => {
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
        readIndexableFileInsideRoot: async () => driftedContent,
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
        symbolRegistryStateRoot: '/mock/state',
        publishNavigationCandidate: async () => {},
    };


    const workflow = new IndexGenerationWorkflow(mockPorts as IndexGenerationWorkflowPorts);

    const suppliedAnalysisByFile = new Map([
        [filePath, {
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        }],
    ]);

    await assert.rejects(
        () => workflow.stageSymbolRegistryForCompletedIndex(
            canonicalRoot,
            [],
            [{
                path: filePath,
                language: 'typescript',
                hash: initialHash,
                symbolCount: 0,
                definitionStatus: 'definitions_present',
            }],
            undefined,
            suppliedAnalysisByFile,
        ),
        /Source changed before navigation publication for 'src\/foo\.ts'\./,
    );
});

