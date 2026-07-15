import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SOURCE_MEASUREMENT_LEDGER_ENV = 'SATORI_SOURCE_MEASUREMENT_LEDGER';
export const SOURCE_MEASUREMENT_ROOT_ENV = 'SATORI_SOURCE_MEASUREMENT_ROOT';

export type SourceIoOwner =
    | 'validation'
    | 'outline'
    | 'graph_site'
    | 'search_evidence'
    | 'continuation';

export type SourceProcessingOwner =
    | 'hashing'
    | 'selector'
    | 'parser'
    | 'extractor'
    | 'graph_site'
    | 'search_evidence';

export type SourceIoBasis = 'descriptor_read' | 'stream_chunk' | 'path_read';
export type SourceObservationOutcome = 'completed' | 'partial' | 'failed';
export type SourceProcessingOutcome = 'success' | 'failed' | 'rejected';
export type SourceProcessingBasis =
    | 'shared_buffer'
    | 'parser_input'
    | 'extractor_input'
    | 'mmap_estimate';

export interface SourceMeasurementObservation {
    observationId: string;
    owner: SourceIoOwner;
    relativeFile: string;
    scanKind: 'complete' | 'partial';
}

export interface SourceIoMetric extends SourceMeasurementObservation {
    readId: string;
    startByte: number;
    endByte: number;
    bytesObtained: number;
    basis: SourceIoBasis;
}

export interface SourceProcessingMetric {
    observationId: string;
    owner: SourceProcessingOwner;
    relativeFile: string;
    inputBytesProcessed: number;
    basis: SourceProcessingBasis;
    outcome: SourceProcessingOutcome;
    durationMs?: number;
}

interface SourceMeasurementOperationInput {
    operation: string;
    ledgerFile?: string;
    rootDir?: string;
}

interface SourceMeasurementScope {
    operation: string;
    operationId: string;
    ledgerFile: string;
    rootDir?: string;
    nextObservation: number;
    nextReadByObservation: Map<string, number>;
    acquisitionBasisByObservation: Map<string, SourceIoBasis>;
    outcomeByObservation: Map<string, SourceObservationOutcome>;
    records: SourceMeasurementLedgerRecord[];
}

interface SourceMeasurementRecordBase {
    schemaVersion: 1;
    operation: string;
    operationId: string;
}

export type SourceMeasurementLedgerRecord = SourceMeasurementRecordBase & (
    | ({ kind: 'source_observation'; logicalBytesRequested: number } & SourceMeasurementObservation)
    | ({ kind: 'source_observation_outcome'; status: SourceObservationOutcome } & SourceMeasurementObservation)
    | ({ kind: 'source_io' } & SourceIoMetric)
    | ({ kind: 'source_processing' } & SourceProcessingMetric)
);

type WithoutRecordBase<T> = T extends SourceMeasurementRecordBase
    ? Omit<T, keyof SourceMeasurementRecordBase>
    : never;
type SourceMeasurementRecordPayload = WithoutRecordBase<SourceMeasurementLedgerRecord>;

const operationStorage = new AsyncLocalStorage<SourceMeasurementScope>();
let nextOperation = 0;

function requireNonEmptyString(value: string, field: string): void {
    if (value.length === 0) {
        throw new Error(`Source measurement ${field} must not be empty.`);
    }
}

function requireNonNegativeInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Source measurement ${field} must be a non-negative safe integer.`);
    }
}

function currentScopeForObservation(observation: SourceMeasurementObservation): SourceMeasurementScope {
    const scope = operationStorage.getStore();
    if (!scope || !observation.observationId.startsWith(`${scope.operationId}:`)) {
        throw new Error('Source measurement observation is outside its operation scope.');
    }
    return scope;
}

function relativeSourceFile(filePath: string, rootDir: string | undefined): string {
    const absoluteFile = path.resolve(filePath);
    if (!rootDir) {
        throw new Error('Source measurement root is required for relative-file accounting.');
    }
    const absoluteRoot = path.resolve(rootDir);
    const relativeFile = path.relative(absoluteRoot, absoluteFile);
    if (
        relativeFile.length === 0
        || relativeFile.startsWith('..')
        || path.isAbsolute(relativeFile)
    ) {
        throw new Error('Measured source file must be a descendant of the measurement root.');
    }
    return relativeFile.replace(/\\/g, '/');
}

function appendRecord(
    scope: SourceMeasurementScope,
    record: SourceMeasurementRecordPayload,
): void {
    scope.records.push({
        schemaVersion: 1,
        operation: scope.operation,
        operationId: scope.operationId,
        ...record,
    } as SourceMeasurementLedgerRecord);
}

function flushScope(scope: SourceMeasurementScope): void {
    if (scope.records.length === 0) {
        return;
    }
    const payload = `${scope.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    fs.appendFileSync(scope.ledgerFile, payload, 'utf8');
}

export async function withSourceMeasurementOperation<T>(
    input: SourceMeasurementOperationInput,
    work: () => Promise<T> | T,
): Promise<T> {
    const ledgerFile = input.ledgerFile ?? process.env[SOURCE_MEASUREMENT_LEDGER_ENV];
    if (!ledgerFile) {
        return await work();
    }

    requireNonEmptyString(input.operation, 'operation');
    nextOperation += 1;
    const scope: SourceMeasurementScope = {
        operation: input.operation,
        operationId: `${process.pid}:operation:${nextOperation}`,
        ledgerFile,
        rootDir: input.rootDir ?? process.env[SOURCE_MEASUREMENT_ROOT_ENV],
        nextObservation: 0,
        nextReadByObservation: new Map(),
        acquisitionBasisByObservation: new Map(),
        outcomeByObservation: new Map(),
        records: [],
    };

    return await operationStorage.run(scope, async () => {
        try {
            return await work();
        } finally {
            flushScope(scope);
        }
    });
}

export function sourceIoOwnerForCurrentOperation(fallback: SourceIoOwner): SourceIoOwner {
    switch (operationStorage.getStore()?.operation) {
        case 'file_outline':
            return 'outline';
        case 'call_graph':
            return 'graph_site';
        case 'search_codebase':
            return 'search_evidence';
        default:
            return fallback;
    }
}

export function beginSourceMeasurementObservation(input: {
    owner: SourceIoOwner;
    filePath: string;
    logicalBytesRequested: number;
    scanKind: 'complete' | 'partial';
}): SourceMeasurementObservation | undefined {
    const scope = operationStorage.getStore();
    if (!scope) {
        return undefined;
    }

    requireNonNegativeInteger(input.logicalBytesRequested, 'logicalBytesRequested');
    scope.nextObservation += 1;
    const observation: SourceMeasurementObservation = {
        observationId: `${scope.operationId}:observation:${scope.nextObservation}`,
        owner: input.owner,
        relativeFile: relativeSourceFile(input.filePath, scope.rootDir),
        scanKind: input.scanKind,
    };
    scope.nextReadByObservation.set(observation.observationId, 0);
    appendRecord(scope, {
        kind: 'source_observation',
        ...observation,
        logicalBytesRequested: input.logicalBytesRequested,
    });
    return observation;
}

export function recordSourceIo(input: {
    observation: SourceMeasurementObservation | undefined;
    startByte: number;
    endByte: number;
    basis: SourceIoBasis;
    readId?: string;
}): string | undefined {
    if (!input.observation) {
        return undefined;
    }
    const scope = currentScopeForObservation(input.observation);
    requireNonNegativeInteger(input.startByte, 'startByte');
    requireNonNegativeInteger(input.endByte, 'endByte');
    if (input.endByte < input.startByte) {
        throw new Error('Source measurement endByte must not precede startByte.');
    }

    const existingBasis = scope.acquisitionBasisByObservation.get(input.observation.observationId);
    if (existingBasis && existingBasis !== input.basis) {
        throw new Error('Source measurement observation used more than one acquisition basis.');
    }
    scope.acquisitionBasisByObservation.set(input.observation.observationId, input.basis);

    const nextRead = (scope.nextReadByObservation.get(input.observation.observationId) ?? 0) + 1;
    scope.nextReadByObservation.set(input.observation.observationId, nextRead);
    const readId = input.readId ?? `read:${nextRead}`;
    requireNonEmptyString(readId, 'readId');
    appendRecord(scope, {
        kind: 'source_io',
        ...input.observation,
        readId,
        startByte: input.startByte,
        endByte: input.endByte,
        bytesObtained: input.endByte - input.startByte,
        basis: input.basis,
    });
    return readId;
}

export function finishSourceMeasurementObservation(input: {
    observation: SourceMeasurementObservation | undefined;
    status: SourceObservationOutcome;
}): void {
    if (!input.observation) {
        return;
    }
    const scope = currentScopeForObservation(input.observation);
    if (scope.outcomeByObservation.has(input.observation.observationId)) {
        throw new Error('Source measurement observation was finalized more than once.');
    }
    scope.outcomeByObservation.set(input.observation.observationId, input.status);
    appendRecord(scope, {
        kind: 'source_observation_outcome',
        ...input.observation,
        status: input.status,
    });
}

export function recordSourceProcessing(input: {
    observation: SourceMeasurementObservation | undefined;
    owner: SourceProcessingOwner;
    inputBytesProcessed: number;
    basis: SourceProcessingBasis;
    outcome: SourceProcessingOutcome;
    durationMs?: number;
}): void {
    if (!input.observation) {
        return;
    }
    const scope = currentScopeForObservation(input.observation);
    requireNonNegativeInteger(input.inputBytesProcessed, 'inputBytesProcessed');
    if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) {
        throw new Error('Source measurement durationMs must be a finite non-negative number.');
    }
    appendRecord(scope, {
        kind: 'source_processing',
        observationId: input.observation.observationId,
        owner: input.owner,
        relativeFile: input.observation.relativeFile,
        inputBytesProcessed: input.inputBytesProcessed,
        basis: input.basis,
        outcome: input.outcome,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    });
}
