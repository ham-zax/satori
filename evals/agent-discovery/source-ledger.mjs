import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

const SOURCE_IO_OWNERS = new Set([
    "validation",
    "outline",
    "graph_site",
    "search_evidence",
    "continuation",
]);
const SOURCE_PROCESSING_OWNERS = new Set([
    "hashing",
    "selector",
    "parser",
    "extractor",
    "graph_site",
    "search_evidence",
]);
const SOURCE_IO_BASES = new Set(["descriptor_read", "stream_chunk", "path_read"]);
const SOURCE_PROCESSING_BASES = new Set([
    "shared_buffer",
    "parser_input",
    "extractor_input",
    "mmap_estimate",
]);
const SCAN_KINDS = new Set(["complete", "partial"]);
const OBSERVATION_OUTCOMES = new Set(["completed", "partial", "failed"]);
const PROCESSING_OUTCOMES = new Set(["success", "failed", "rejected"]);

function requireNonEmptyString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`source_ledger_invalid_${field}`);
    }
}

function requireNonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`source_ledger_invalid_${field}`);
    }
}

function requireEnumValue(value, allowed, field) {
    if (!allowed.has(value)) {
        throw new Error(`source_ledger_invalid_${field}`);
    }
}

function validateObservationRecord(record) {
    requireNonEmptyString(record.operation, "operation");
    requireNonEmptyString(record.operationId, "operation_id");
    requireNonEmptyString(record.observationId, "observation_id");
    requireNonEmptyString(record.relativeFile, "relative_file");
    requireEnumValue(record.owner, SOURCE_IO_OWNERS, "owner");
    requireEnumValue(record.scanKind, SCAN_KINDS, "scan_kind");
    requireNonNegativeInteger(record.logicalBytesRequested, "logical_bytes_requested");
}

function unionLength(ranges) {
    const sorted = [...ranges].sort((left, right) => (
        left.startByte - right.startByte || left.endByte - right.endByte
    ));
    let total = 0;
    let currentStart = null;
    let currentEnd = null;
    for (const range of sorted) {
        if (currentStart === null) {
            currentStart = range.startByte;
            currentEnd = range.endByte;
        } else if (range.startByte <= currentEnd) {
            currentEnd = Math.max(currentEnd, range.endByte);
        } else {
            total += currentEnd - currentStart;
            currentStart = range.startByte;
            currentEnd = range.endByte;
        }
    }
    return currentStart === null ? 0 : total + currentEnd - currentStart;
}

function validateIoRecord(record) {
    requireNonEmptyString(record.operation, "operation");
    requireNonEmptyString(record.operationId, "operation_id");
    requireNonEmptyString(record.observationId, "observation_id");
    requireNonEmptyString(record.readId, "read_id");
    requireNonEmptyString(record.owner, "owner");
    requireNonEmptyString(record.relativeFile, "relative_file");
    requireEnumValue(record.owner, SOURCE_IO_OWNERS, "owner");
    requireEnumValue(record.scanKind, SCAN_KINDS, "scan_kind");
    requireEnumValue(record.basis, SOURCE_IO_BASES, "io_basis");
    requireNonNegativeInteger(record.startByte, "start_byte");
    requireNonNegativeInteger(record.endByte, "end_byte");
    requireNonNegativeInteger(record.bytesObtained, "bytes_obtained");
    if (record.endByte < record.startByte
        || record.bytesObtained !== record.endByte - record.startByte) {
        throw new Error("source_ledger_invalid_byte_range");
    }
}

function validateObservationOutcomeRecord(record) {
    requireNonEmptyString(record.operation, "operation");
    requireNonEmptyString(record.operationId, "operation_id");
    requireNonEmptyString(record.observationId, "observation_id");
    requireNonEmptyString(record.relativeFile, "relative_file");
    requireEnumValue(record.owner, SOURCE_IO_OWNERS, "owner");
    requireEnumValue(record.scanKind, SCAN_KINDS, "scan_kind");
    requireEnumValue(record.status, OBSERVATION_OUTCOMES, "observation_outcome");
}

function validateProcessingRecord(record) {
    requireNonEmptyString(record.operation, "operation");
    requireNonEmptyString(record.operationId, "operation_id");
    requireNonEmptyString(record.observationId, "observation_id");
    requireNonEmptyString(record.relativeFile, "relative_file");
    requireEnumValue(record.owner, SOURCE_PROCESSING_OWNERS, "processing_owner");
    requireEnumValue(record.basis, SOURCE_PROCESSING_BASES, "processing_basis");
    requireEnumValue(record.outcome, PROCESSING_OUTCOMES, "processing_outcome");
    requireNonNegativeInteger(record.inputBytesProcessed, "input_bytes_processed");
    if (record.durationMs !== undefined
        && (!Number.isFinite(record.durationMs) || record.durationMs < 0)) {
        throw new Error("source_ledger_invalid_duration_ms");
    }
}

function observationKey(record) {
    return record.observationId;
}

function readKey(record) {
    return `${record.observationId}\0${record.readId}`;
}

export function summarizeSourceLedger(records) {
    const observations = new Map();
    const uniqueReads = new Map();
    const basisByObservation = new Map();
    const outcomes = new Map();
    const processing = [];

    for (const record of records) {
        if (record?.schemaVersion !== 1) {
            throw new Error("source_ledger_unsupported_schema");
        }
        if (record.kind === "source_observation") {
            validateObservationRecord(record);
            const key = observationKey(record);
            const existing = observations.get(key);
            if (existing && !isDeepStrictEqual(existing, record)) {
                throw new Error(`source_ledger_corruption:conflicting_observation:${key}`);
            }
            observations.set(key, record);
        } else if (record.kind === "source_observation_outcome") {
            validateObservationOutcomeRecord(record);
            const key = observationKey(record);
            if (outcomes.has(key)) {
                throw new Error(`source_ledger_corruption:duplicate_observation_outcome:${key}`);
            }
            outcomes.set(key, record);
        } else if (record.kind === "source_io") {
            validateIoRecord(record);
            const key = readKey(record);
            const existing = uniqueReads.get(key);
            if (existing && !isDeepStrictEqual(existing, record)) {
                throw new Error(`source_ledger_corruption:conflicting_read:${key}`);
            }
            uniqueReads.set(key, record);
            const sourceKey = observationKey(record);
            const existingBasis = basisByObservation.get(sourceKey);
            if (existingBasis && existingBasis !== record.basis) {
                throw new Error(`source_ledger_corruption:mixed_acquisition_basis:${sourceKey}`);
            }
            basisByObservation.set(sourceKey, record.basis);
        } else if (record.kind === "source_processing") {
            validateProcessingRecord(record);
            processing.push(record);
        } else {
            throw new Error(`source_ledger_unknown_record_kind:${record.kind}`);
        }
    }

    for (const record of uniqueReads.values()) {
        const observation = observations.get(observationKey(record));
        if (!observation) {
            throw new Error(`source_ledger_corruption:missing_observation:${observationKey(record)}`);
        }
        if (
            record.operation !== observation.operation
            || record.operationId !== observation.operationId
            || record.owner !== observation.owner
            || record.relativeFile !== observation.relativeFile
            || record.scanKind !== observation.scanKind
        ) {
            throw new Error(`source_ledger_corruption:read_observation_mismatch:${readKey(record)}`);
        }
    }
    for (const [key, observation] of observations) {
        const outcome = outcomes.get(key);
        if (!outcome) {
            throw new Error(`source_ledger_corruption:missing_observation_outcome:${key}`);
        }
        if (
            outcome.operation !== observation.operation
            || outcome.operationId !== observation.operationId
            || outcome.owner !== observation.owner
            || outcome.relativeFile !== observation.relativeFile
            || outcome.scanKind !== observation.scanKind
        ) {
            throw new Error(`source_ledger_corruption:outcome_observation_mismatch:${key}`);
        }
    }
    for (const key of outcomes.keys()) {
        if (!observations.has(key)) {
            throw new Error(`source_ledger_corruption:missing_observation:${key}`);
        }
    }
    for (const record of processing) {
        const observation = observations.get(observationKey(record));
        if (!observation) {
            throw new Error(`source_ledger_corruption:missing_observation:${observationKey(record)}`);
        }
        if (
            record.operation !== observation.operation
            || record.operationId !== observation.operationId
            || record.relativeFile !== observation.relativeFile
        ) {
            throw new Error(`source_ledger_corruption:processing_observation_mismatch:${observationKey(record)}`);
        }
    }

    const coverageByObservation = [...observations.entries()]
        .map(([key, observation]) => {
            const ranges = [...uniqueReads.values()]
                .filter((record) => observationKey(record) === key)
                .map(({ startByte, endByte }) => ({ startByte, endByte }));
            return {
                operationId: observation.operationId,
                observationId: observation.observationId,
                relativeFile: observation.relativeFile,
                uniqueBytesCovered: unionLength(ranges),
            };
        })
        .sort((left, right) => (
            left.observationId < right.observationId
                ? -1
                : left.observationId > right.observationId ? 1 : 0
        ));
    const coverageByObservationId = new Map(coverageByObservation.map(
        (coverage) => [coverage.observationId, coverage.uniqueBytesCovered],
    ));
    const portableBytesObtained = [...uniqueReads.values()].reduce(
        (total, record) => total + record.bytesObtained,
        0,
    );
    const inputBytesProcessed = processing.reduce(
        (total, record) => total + record.inputBytesProcessed,
        0,
    );

    return {
        status: "measured",
        io: {
            portableBytesObtained,
            uniqueBytesCovered: coverageByObservation.reduce(
                (total, coverage) => total + coverage.uniqueBytesCovered,
                0,
            ),
            readOperations: uniqueReads.size,
            coverageByObservation,
            byBasis: Object.fromEntries([...new Set([...uniqueReads.values()].map((record) => record.basis))]
                .sort()
                .map((basis) => {
                    const reads = [...uniqueReads.values()].filter((record) => record.basis === basis);
                    return [basis, {
                        portableBytesObtained: reads.reduce(
                            (total, record) => total + record.bytesObtained,
                            0,
                        ),
                        readOperations: reads.length,
                    }];
                })),
        },
        workload: {
            logicalSourceBytesRequested: [...observations.values()].reduce(
                (total, record) => total + record.logicalBytesRequested,
                0,
            ),
            completeFileScanCount: [...observations.values()].filter(
                (record) => record.scanKind === "complete"
                    && outcomes.get(record.observationId)?.status === "completed"
                    && coverageByObservationId.get(record.observationId) === record.logicalBytesRequested,
            ).length,
            partialScanCount: [...observations.values()].filter(
                (record) => record.scanKind === "partial",
            ).length,
            incompleteScanCount: [...observations.values()].filter(
                (record) => outcomes.get(record.observationId)?.status !== "completed"
                    || (record.scanKind === "complete"
                        && coverageByObservationId.get(record.observationId) !== record.logicalBytesRequested),
            ).length,
            filesOpened: [...observations.values()].filter((record) => {
                const status = outcomes.get(record.observationId)?.status;
                return status === "completed" || status === "partial";
            }).length,
        },
        processing: {
            inputBytesProcessed,
            eventCount: processing.length,
            byOwner: Object.fromEntries([...new Set(processing.map((record) => record.owner))]
                .sort()
                .map((owner) => [owner, processing
                    .filter((record) => record.owner === owner)
                    .reduce((total, record) => total + record.inputBytesProcessed, 0)])),
            byOutcome: Object.fromEntries([...new Set(processing.map((record) => record.outcome))]
                .sort()
                .map((outcome) => {
                    const events = processing.filter((record) => record.outcome === outcome);
                    return [outcome, {
                        inputBytesProcessed: events.reduce(
                            (total, record) => total + record.inputBytesProcessed,
                            0,
                        ),
                        eventCount: events.length,
                    }];
                })),
        },
    };
}

export function sourceLedgerFileSize(filePath) {
    try {
        return fs.statSync(filePath).size;
    } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
    }
}

export function readSourceLedgerSlice(filePath, startByte) {
    requireNonNegativeInteger(startByte, "slice_start_byte");
    let bytes;
    try {
        bytes = fs.readFileSync(filePath);
    } catch (error) {
        if (error?.code === "ENOENT" && startByte === 0) {
            return { endByte: 0, records: [] };
        }
        throw error;
    }
    if (startByte > bytes.length) {
        throw new Error("source_ledger_slice_start_beyond_end");
    }
    const slice = bytes.subarray(startByte).toString("utf8");
    if (slice.length > 0 && !slice.endsWith("\n")) {
        throw new Error("source_ledger_incomplete_final_record");
    }
    return {
        endByte: bytes.length,
        records: slice
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
    };
}
