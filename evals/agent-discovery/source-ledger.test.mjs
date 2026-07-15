import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    readSourceLedgerSlice,
    sourceLedgerFileSize,
    summarizeSourceLedger,
} from "./source-ledger.mjs";

const observation = {
    schemaVersion: 1,
    kind: "source_observation",
    operation: "read_file",
    operationId: "operation:1",
    observationId: "observation:1",
    owner: "validation",
    relativeFile: "src/owner.ts",
    scanKind: "complete",
    logicalBytesRequested: 4096,
};

const completedOutcome = {
    schemaVersion: 1,
    kind: "source_observation_outcome",
    operation: "read_file",
    operationId: "operation:1",
    observationId: "observation:1",
    owner: "validation",
    relativeFile: "src/owner.ts",
    scanKind: "complete",
    status: "completed",
};

function io(readId, startByte = 0, endByte = 4096) {
    return {
        schemaVersion: 1,
        kind: "source_io",
        operation: "read_file",
        operationId: "operation:1",
        observationId: "observation:1",
        readId,
        owner: "validation",
        relativeFile: "src/owner.ts",
        startByte,
        endByte,
        bytesObtained: endByte - startByte,
        scanKind: "complete",
        basis: "descriptor_read",
    };
}

test("source ledger deduplicates duplicate emissions but counts genuine rereads", () => {
    const summary = summarizeSourceLedger([
        observation,
        completedOutcome,
        io("read:1"),
        io("read:1"),
        io("read:2"),
        {
            schemaVersion: 1,
            kind: "source_processing",
            operation: "read_file",
            operationId: "operation:1",
            observationId: "observation:1",
            owner: "hashing",
            relativeFile: "src/owner.ts",
            inputBytesProcessed: 4096,
            basis: "shared_buffer",
            outcome: "success",
        },
    ]);

    assert.equal(summary.io.portableBytesObtained, 8192);
    assert.equal(summary.io.uniqueBytesCovered, 4096);
    assert.equal(summary.io.readOperations, 2);
    assert.deepEqual(summary.io.byBasis, {
        descriptor_read: { portableBytesObtained: 8192, readOperations: 2 },
    });
    assert.equal(summary.workload.logicalSourceBytesRequested, 4096);
    assert.equal(summary.workload.completeFileScanCount, 1);
    assert.equal(summary.workload.filesOpened, 1);
    assert.equal(summary.processing.inputBytesProcessed, 4096);
    assert.deepEqual(summary.processing.byOutcome, {
        success: { inputBytesProcessed: 4096, eventCount: 1 },
    });
});

test("source ledger rejects conflicting reuse of one observation and read ID", () => {
    assert.throws(
        () => summarizeSourceLedger([
            observation,
            io("read:1"),
            { ...io("read:1"), endByte: 2048, bytesObtained: 2048 },
        ]),
        /source_ledger_corruption:conflicting_read/,
    );
});

test("source ledger composite read identity does not change with operation metadata", () => {
    assert.throws(
        () => summarizeSourceLedger([
            observation,
            io("read:1"),
            { ...io("read:1"), operationId: "operation:2" },
        ]),
        /source_ledger_corruption:conflicting_read/,
    );
});

test("source ledger rejects values outside the frozen owner and basis vocabularies", () => {
    assert.throws(
        () => summarizeSourceLedger([
            observation,
            { ...io("read:1"), basis: "buffer_input" },
        ]),
        /source_ledger_invalid_io_basis/,
    );
    assert.throws(
        () => summarizeSourceLedger([
            { ...observation, owner: "parser" },
        ]),
        /source_ledger_invalid_owner/,
    );
});

test("source ledger reports path convenience reads under their honest basis", () => {
    const summary = summarizeSourceLedger([
        observation,
        completedOutcome,
        { ...io("read:1"), basis: "path_read" },
    ]);
    assert.deepEqual(summary.io.byBasis, {
        path_read: { portableBytesObtained: 4096, readOperations: 1 },
    });
});

test("source ledger keeps byte coverage scoped to each observation", () => {
    const secondObservation = {
        ...observation,
        observationId: "observation:2",
        relativeFile: "src/other.ts",
    };
    const secondRead = {
        ...io("read:1"),
        observationId: "observation:2",
        relativeFile: "src/other.ts",
    };
    const secondOutcome = {
        ...completedOutcome,
        observationId: "observation:2",
        relativeFile: "src/other.ts",
    };
    const summary = summarizeSourceLedger([
        observation,
        secondObservation,
        completedOutcome,
        secondOutcome,
        io("read:1"),
        secondRead,
    ]);

    assert.equal(summary.io.uniqueBytesCovered, 8192);
    assert.equal(summary.io.coverageByObservation.length, 2);
    assert.deepEqual(
        summary.io.coverageByObservation.map((entry) => entry.relativeFile),
        ["src/owner.ts", "src/other.ts"],
    );
});

test("source ledger requires a completed outcome and full coverage for complete scans", () => {
    assert.throws(
        () => summarizeSourceLedger([observation, io("read:1")]),
        /source_ledger_corruption:missing_observation_outcome/,
    );

    const partial = summarizeSourceLedger([
        observation,
        { ...completedOutcome, status: "partial" },
        io("read:1", 0, 2048),
    ]);
    assert.equal(partial.workload.completeFileScanCount, 0);
    assert.equal(partial.workload.incompleteScanCount, 1);
    assert.equal(partial.workload.filesOpened, 1);

    const insufficientCoverage = summarizeSourceLedger([
        observation,
        completedOutcome,
        io("read:1", 0, 2048),
    ]);
    assert.equal(insufficientCoverage.workload.completeFileScanCount, 0);
    assert.equal(insufficientCoverage.workload.incompleteScanCount, 1);

    const failedBeforeAcquisition = summarizeSourceLedger([
        observation,
        { ...completedOutcome, status: "failed" },
    ]);
    assert.equal(failedBeforeAcquisition.workload.completeFileScanCount, 0);
    assert.equal(failedBeforeAcquisition.workload.incompleteScanCount, 1);
    assert.equal(failedBeforeAcquisition.workload.filesOpened, 0);
});

test("source ledger slices complete JSONL records by byte offset", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-source-slice-"));
    const ledgerFile = path.join(directory, "source.jsonl");
    try {
        fs.appendFileSync(ledgerFile, `${JSON.stringify(observation)}\n`);
        const firstEnd = sourceLedgerFileSize(ledgerFile);
        fs.appendFileSync(ledgerFile, `${JSON.stringify(io("read:1"))}\n`);

        const slice = readSourceLedgerSlice(ledgerFile, firstEnd);
        assert.equal(slice.endByte, sourceLedgerFileSize(ledgerFile));
        assert.deepEqual(slice.records, [io("read:1")]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
