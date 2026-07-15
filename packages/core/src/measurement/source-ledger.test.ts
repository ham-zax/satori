import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    beginSourceMeasurementObservation,
    finishSourceMeasurementObservation,
    recordSourceIo,
    recordSourceProcessing,
    sourceIoOwnerForCurrentOperation,
    withSourceMeasurementOperation,
    type SourceMeasurementLedgerRecord,
} from './source-ledger';

function readLedger(filePath: string): SourceMeasurementLedgerRecord[] {
    return fs.readFileSync(filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as SourceMeasurementLedgerRecord);
}

test('source measurement is a no-op when no ledger is configured', async () => {
    const previousLedger = process.env.SATORI_SOURCE_MEASUREMENT_LEDGER;
    delete process.env.SATORI_SOURCE_MEASUREMENT_LEDGER;
    try {
        const result = await withSourceMeasurementOperation({ operation: 'read_file' }, async () => {
            const observation = beginSourceMeasurementObservation({
                owner: 'validation',
                filePath: '/unmeasured/source.ts',
                logicalBytesRequested: 10,
                scanKind: 'complete',
            });
            assert.equal(observation, undefined);
            assert.equal(recordSourceIo({
                observation,
                startByte: 0,
                endByte: 10,
                basis: 'descriptor_read',
            }), undefined);
            finishSourceMeasurementObservation({ observation, status: 'completed' });
            return 'unchanged';
        });

        assert.equal(result, 'unchanged');
    } finally {
        if (previousLedger === undefined) {
            delete process.env.SATORI_SOURCE_MEASUREMENT_LEDGER;
        } else {
            process.env.SATORI_SOURCE_MEASUREMENT_LEDGER = previousLedger;
        }
    }
});

test('source measurement records duplicate emissions and genuine rereads distinctly', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-ledger-'));
    const ledgerFile = path.join(directory, 'source.jsonl');
    const sourceFile = path.join(directory, 'src', 'owner.ts');
    fs.mkdirSync(path.dirname(sourceFile));
    fs.writeFileSync(sourceFile, 'abcd', 'utf8');

    try {
        await withSourceMeasurementOperation({
            operation: 'file_outline',
            ledgerFile,
            rootDir: directory,
        }, async () => {
            assert.equal(sourceIoOwnerForCurrentOperation('validation'), 'outline');
            const observation = beginSourceMeasurementObservation({
                owner: sourceIoOwnerForCurrentOperation('validation'),
                filePath: sourceFile,
                logicalBytesRequested: 4,
                scanKind: 'complete',
            });
            recordSourceIo({
                observation,
                startByte: 0,
                endByte: 4,
                basis: 'descriptor_read',
                readId: 'read:1',
            });
            recordSourceIo({
                observation,
                startByte: 0,
                endByte: 4,
                basis: 'descriptor_read',
                readId: 'read:1',
            });
            recordSourceIo({
                observation,
                startByte: 0,
                endByte: 4,
                basis: 'descriptor_read',
                readId: 'read:2',
            });
            finishSourceMeasurementObservation({
                observation,
                status: 'completed',
            });
            recordSourceProcessing({
                observation,
                owner: 'hashing',
                inputBytesProcessed: 4,
                basis: 'shared_buffer',
                outcome: 'success',
            });
        });

        const records = readLedger(ledgerFile);
        assert.equal(records.length, 6);
        assert.deepEqual(records.map((record) => record.kind), [
            'source_observation',
            'source_io',
            'source_io',
            'source_io',
            'source_observation_outcome',
            'source_processing',
        ]);
        assert.equal(records[0].relativeFile, 'src/owner.ts');
        assert.equal(records[0].owner, 'outline');
        assert.equal(records[1].observationId, records[2].observationId);
        assert.equal(records[1].readId, records[2].readId);
        assert.notEqual(records[2].readId, records[3].readId);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('source measurement rejects mixed acquisition bases within one observation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-basis-'));
    const ledgerFile = path.join(directory, 'source.jsonl');
    const sourceFile = path.join(directory, 'owner.ts');
    fs.writeFileSync(sourceFile, 'abcd', 'utf8');

    try {
        await assert.rejects(
            () => withSourceMeasurementOperation({
                operation: 'read_file',
                ledgerFile,
                rootDir: directory,
            }, async () => {
                const observation = beginSourceMeasurementObservation({
                    owner: 'validation',
                    filePath: sourceFile,
                    logicalBytesRequested: 4,
                    scanKind: 'complete',
                });
                recordSourceIo({
                    observation,
                    startByte: 0,
                    endByte: 2,
                    basis: 'descriptor_read',
                });
                recordSourceIo({
                    observation,
                    startByte: 2,
                    endByte: 4,
                    basis: 'stream_chunk',
                });
            }),
            /more than one acquisition basis/,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
