import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSearchQualityEvaluation } from './search-quality-evaluation.js';

const testPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(testPath), '../..');

test('search-quality corpus is hash-bound and produces complete deterministic measurements', async () => {
    const first = await runSearchQualityEvaluation(workspaceRoot);
    const second = await runSearchQualityEvaluation(workspaceRoot);

    assert.equal(first.workloadCount, 19);
    assert.equal(first.results.length, first.workloadCount * first.limits.length);
    assert.match(first.fixtureManifestSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.results, second.results);
    assert.deepEqual(first.summary, second.summary);
    assert.equal(first.results.every((result) => result.status === 'ok'), true);
    assert.equal(first.results.every((result) => result.toolCalls === 1), true);
    assert.equal(
        first.results.every((result) => result.ownerAvailableInInitialSearch === (result.ownerRank !== null)),
        true,
    );
    assert.equal(first.results.every((result) => !Object.hasOwn(result, 'stepsToOwner')), true);

    const splitOwnerResults = first.results.filter((result) => (
        result.workloadId === 'split_owner_relevant_body'
    ));
    assert.equal(splitOwnerResults.length, first.limits.length);
    assert.equal(splitOwnerResults.every((result) => (
        result.provider.rerankedCandidateIds.includes('resilient.tailChunk')
    )), true);
    assert.equal(splitOwnerResults.every((result) => result.ownerRank === 1), true);

    const conceptualWhereIsResults = first.results.filter((result) => (
        result.workloadId === 'conceptual_where_is'
    ));
    assert.equal(conceptualWhereIsResults.length, first.limits.length);
    assert.equal(conceptualWhereIsResults.every((result) => (
        result.routeObservation.selectedRoute === 'conceptual'
        && result.routeObservation.semanticExpansionAttempted
    )), true);
});
