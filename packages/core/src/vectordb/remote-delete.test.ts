import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteCollectionWithVerification } from './remote-delete';

test('deleteCollectionWithVerification stops retrying when the mutation guard fails', async () => {
    let dropCalls = 0;
    let guardCalls = 0;

    await assert.rejects(
        () => deleteCollectionWithVerification({
            hasCollection: async () => true,
            dropCollection: async () => {
                dropCalls += 1;
            },
        }, 'chunks', {
            maxAttempts: 3,
            initialBackoffMs: 0,
            beforeDropAttempt: () => {
                guardCalls += 1;
                if (guardCalls === 2) {
                    throw new Error('mutation lease lost');
                }
            },
        }),
        /mutation lease lost/,
    );

    assert.equal(dropCalls, 1);
    assert.equal(guardCalls, 2);
});
