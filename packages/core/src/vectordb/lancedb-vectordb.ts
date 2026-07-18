import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
    connect,
    Index,
    MatchQuery,
    Operator,
    type Connection,
    type Table,
} from '@lancedb/lancedb';
import {
    Field,
    FixedSizeList,
    Float32,
    Int32,
    Schema,
    Utf8,
} from 'apache-arrow';

import { compareContractStrings } from '../utils/compare-contract-strings';
import { escapeLanceDbStringLiteral, serializeLanceDbFilter } from './filters';
import {
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    type CollectionCreateOptions,
    type CollectionDetails,
    type CollectionForkReceipt,
    type DenseCandidateRequest,
    type IndexedVectorDocument,
    type LexicalCandidateRequest,
    type VectorCandidate,
    type VectorControlRecord,
    type VectorDatabase,
    type VectorDocument,
    type VectorDocumentMetadata,
    type VectorDocumentQuery,
    type VectorFilter,
    type VectorPublicationCapabilities,
    type VectorRecord,
    type VectorStoreBackendInfo,
} from './types';

const CONTROL_TABLE_PREFIX = '__satori_control_';
const DEFAULT_MAX_WRITE_BATCH_SIZE = 512;
const STABLE_TIE_INITIAL_MULTIPLIER = 2;
const STABLE_TIE_MINIMUM_FETCH = 32;
const COLLECTION_IO_CONCURRENCY = 64;

const DATA_FIELDS = [
    'id',
    'content',
    'relativePath',
    'startLine',
    'endLine',
    'fileExtension',
    'metadataJson',
] as const;

type CollectionForkPhysicalStats = Readonly<{
    logicalBytes: number;
    physicallyCopiedBytes: number;
    sharedFiles: number;
    copiedFiles: number;
}>;

function isIndependentlyMutableLanceFile(relativePath: string): boolean {
    return relativePath === path.join('_versions', 'latest_version_hint.json');
}

function structuralSharingError(sourcePath: string, targetPath: string, error: unknown): Error {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : 'unknown';
    return new Error(
        'LanceDB atomic candidate publication requires same-filesystem hard-link support; '
        + `cannot share '${sourcePath}' into '${targetPath}' (${code}). `
        + 'Run a safe full rebuild instead.',
    );
}

async function shareDirectoryForCandidate(
    sourcePath: string,
    targetPath: string,
): Promise<CollectionForkPhysicalStats> {
    await fs.promises.mkdir(targetPath);
    const directories: string[] = [];
    const files: Array<{ sourcePath: string; relativePath: string }> = [];
    const collect = async (sourceDirectory: string, relativeRoot = ''): Promise<void> => {
        const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => compareContractStrings(left.name, right.name))) {
            const sourceEntryPath = path.join(sourceDirectory, entry.name);
            const relativePath = path.join(relativeRoot, entry.name);
            if (entry.isDirectory()) {
                directories.push(relativePath);
                await collect(sourceEntryPath, relativePath);
            } else if (entry.isFile()) {
                files.push({ sourcePath: sourceEntryPath, relativePath });
            } else {
                throw new Error(`LanceDB collection contains unsupported entry '${entry.name}'.`);
            }
        }
    };
    await collect(sourcePath);
    for (const relativePath of directories) {
        await fs.promises.mkdir(path.join(targetPath, relativePath));
    }

    let logicalBytes = 0;
    let physicallyCopiedBytes = 0;
    let sharedFiles = 0;
    let copiedFiles = 0;
    for (let offset = 0; offset < files.length; offset += COLLECTION_IO_CONCURRENCY) {
        const batch = files.slice(offset, offset + COLLECTION_IO_CONCURRENCY);
        const results = await Promise.all(batch.map(async (file) => {
            const sourceStat = await fs.promises.stat(file.sourcePath);
            const targetEntryPath = path.join(targetPath, file.relativePath);
            if (isIndependentlyMutableLanceFile(file.relativePath)) {
                await fs.promises.copyFile(file.sourcePath, targetEntryPath, fs.constants.COPYFILE_FICLONE);
                return { size: sourceStat.size, copied: true };
            }
            try {
                await fs.promises.link(file.sourcePath, targetEntryPath);
            } catch (error) {
                throw structuralSharingError(file.sourcePath, targetEntryPath, error);
            }
            return { size: sourceStat.size, copied: false };
        }));
        for (const result of results) {
            logicalBytes += result.size;
            if (result.copied) {
                physicallyCopiedBytes += result.size;
                copiedFiles += 1;
            } else {
                sharedFiles += 1;
            }
        }
    }
    return {
        logicalBytes,
        physicallyCopiedBytes,
        sharedFiles,
        copiedFiles,
    };
}

async function collectClonePaths(
    rootPath: string,
    files: string[],
    directories: string[],
): Promise<void> {
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareContractStrings(left.name, right.name))) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) await collectClonePaths(entryPath, files, directories);
        else if (entry.isFile()) files.push(entryPath);
    }
    directories.push(rootPath);
}

async function fsyncCandidateTree(rootPath: string): Promise<void> {
    const files: string[] = [];
    const directories: string[] = [];
    await collectClonePaths(rootPath, files, directories);
    const syncPath = async (targetPath: string) => {
        const handle = await fs.promises.open(targetPath, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    };
    const independentlyWrittenFiles: string[] = [];
    for (let offset = 0; offset < files.length; offset += COLLECTION_IO_CONCURRENCY) {
        const batch = files.slice(offset, offset + COLLECTION_IO_CONCURRENCY);
        const stats = await Promise.all(batch.map(async (filePath) => ({
            filePath,
            stat: await fs.promises.stat(filePath),
        })));
        for (const { filePath, stat } of stats) {
            if (stat.nlink === 1) independentlyWrittenFiles.push(filePath);
        }
    }
    for (let offset = 0; offset < independentlyWrittenFiles.length; offset += COLLECTION_IO_CONCURRENCY) {
        await Promise.all(independentlyWrittenFiles.slice(offset, offset + COLLECTION_IO_CONCURRENCY).map(syncPath));
    }
    for (const directory of directories) await syncPath(directory);
    await syncPath(path.dirname(rootPath));
}

type LanceDbPhysicalRow = Record<string, unknown>;

export interface LanceDbConfig {
    /** Absolute installer-owned local database directory. */
    databasePath: string;
    /** Bounds each physical merge without changing the logical write. */
    maxWriteBatchSize?: number;
}

function assertCollectionName(collectionName: string): void {
    if (!/^[A-Za-z0-9_]+$/.test(collectionName)) {
        throw new Error(`Invalid LanceDB collection name '${collectionName}'.`);
    }
    if (collectionName.startsWith(CONTROL_TABLE_PREFIX)) {
        throw new Error(`Collection name '${collectionName}' uses the reserved LanceDB control prefix.`);
    }
}

function collectionFamilyName(collectionName: string): string {
    const generationSeparator = collectionName.indexOf('__gen_');
    return generationSeparator === -1
        ? collectionName
        : collectionName.slice(0, generationSeparator);
}

function controlTableName(collectionName: string): string {
    const family = collectionFamilyName(collectionName);
    return `${CONTROL_TABLE_PREFIX}${crypto.createHash('sha256').update(family, 'utf8').digest('hex')}`;
}

function dataSchema(dimension: number): Schema {
    const vectorItem = new Field('item', new Float32(), false);
    return new Schema([
        new Field('id', new Utf8(), false),
        new Field('vector', new FixedSizeList(dimension, vectorItem), false),
        new Field('content', new Utf8(), false),
        new Field('lexicalText', new Utf8(), false),
        new Field('relativePath', new Utf8(), false),
        new Field('startLine', new Int32(), false),
        new Field('endLine', new Int32(), false),
        new Field('fileExtension', new Utf8(), false),
        new Field('contentHash', new Utf8(), false),
        new Field('metadataJson', new Utf8(), false),
    ]);
}

function controlSchema(): Schema {
    return new Schema([
        new Field('key', new Utf8(), false),
        new Field('collectionName', new Utf8(), false),
        new Field('id', new Utf8(), false),
        new Field('kind', new Utf8(), false),
        new Field('metadataJson', new Utf8(), false),
    ]);
}

function canonicalizeJson(value: unknown, ancestors: Set<object>): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') {
        throw new Error('LanceDB metadata cannot contain bigint values.');
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
    }
    if (typeof value !== 'object') return value;

    if (ancestors.has(value)) {
        throw new Error('LanceDB metadata must not contain cyclic values.');
    }
    ancestors.add(value);
    try {
        const withToJson = value as { toJSON?: () => unknown };
        if (typeof withToJson.toJSON === 'function') {
            return canonicalizeJson(withToJson.toJSON(), ancestors);
        }
        if (Array.isArray(value)) {
            return value.map((entry) => canonicalizeJson(entry, ancestors) ?? null);
        }
        const canonical: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort(compareContractStrings)) {
            const normalized = canonicalizeJson((value as Record<string, unknown>)[key], ancestors);
            if (normalized !== undefined) canonical[key] = normalized;
        }
        return canonical;
    } finally {
        ancestors.delete(value);
    }
}

function serializeMetadata(metadata: VectorDocumentMetadata): string {
    return JSON.stringify(canonicalizeJson(metadata, new Set<object>()));
}

function parseMetadata(value: unknown, context: string): VectorDocumentMetadata {
    if (typeof value !== 'string') {
        throw new Error(`LanceDB ${context} metadata is not a JSON string.`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(`LanceDB ${context} metadata is malformed JSON.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`LanceDB ${context} metadata is not an object.`);
    }
    return parsed as VectorDocumentMetadata;
}

function hashLengthPrefixed(hash: crypto.Hash, value: string): void {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(bytes.length);
    hash.update(length);
    hash.update(bytes);
}

function encodeSearchableRow(indexed: IndexedVectorDocument): LanceDbPhysicalRow {
    const { document, projections } = indexed;
    if (document.id.length === 0) {
        throw new Error('LanceDB searchable document ID must be non-empty.');
    }
    if (document.id === INDEX_COMPLETION_MARKER_DOC_ID) {
        throw new Error(`Searchable document ID '${document.id}' is reserved for a control record.`);
    }
    if (document.fileExtension === INDEX_COMPLETION_MARKER_FILE_EXTENSION) {
        throw new Error(
            `Searchable document '${document.id}' uses reserved control extension '${document.fileExtension}'.`,
        );
    }
    if (!Number.isSafeInteger(document.startLine) || !Number.isSafeInteger(document.endLine)) {
        throw new Error(`LanceDB document '${document.id}' has non-integer line bounds.`);
    }
    if (document.startLine < -2147483648 || document.startLine > 2147483647
        || document.endLine < -2147483648 || document.endLine > 2147483647) {
        throw new Error(`LanceDB document '${document.id}' line bounds exceed Int32 storage.`);
    }
    if (document.vector.length === 0 || document.vector.some((entry) => !Number.isFinite(entry))) {
        throw new Error(`LanceDB document '${document.id}' has an empty or non-finite vector.`);
    }

    const vector = Array.from(new Float32Array(document.vector));
    const metadataJson = serializeMetadata(document.metadata);
    const hash = crypto.createHash('sha256');
    for (const value of [
        document.id,
        document.content,
        projections.embeddingText,
        projections.lexicalText,
        projections.embeddingVersion,
        projections.lexicalVersion,
        document.relativePath,
        String(document.startLine),
        String(document.endLine),
        document.fileExtension,
        metadataJson,
    ]) {
        hashLengthPrefixed(hash, value);
    }
    const vectorBytes = Buffer.allocUnsafe(vector.length * 4);
    vector.forEach((value, index) => vectorBytes.writeFloatLE(value, index * 4));
    hash.update(vectorBytes);

    return {
        id: document.id,
        vector,
        content: document.content,
        lexicalText: projections.lexicalText,
        relativePath: document.relativePath,
        startLine: document.startLine,
        endLine: document.endLine,
        fileExtension: document.fileExtension,
        contentHash: hash.digest('hex'),
        metadataJson,
    };
}

function requiredString(row: LanceDbPhysicalRow, field: string, context: string): string {
    const value = row[field];
    if (typeof value !== 'string') {
        throw new Error(`LanceDB ${context} field '${field}' is not a string.`);
    }
    return value;
}

function requiredNumber(row: LanceDbPhysicalRow, field: string, context: string): number {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`LanceDB ${context} field '${field}' is not a finite number.`);
    }
    return value;
}

function decodeDocument(row: LanceDbPhysicalRow): VectorDocument {
    const id = requiredString(row, 'id', 'document');
    return {
        id,
        vector: [],
        content: requiredString(row, 'content', `document '${id}'`),
        relativePath: requiredString(row, 'relativePath', `document '${id}'`),
        startLine: requiredNumber(row, 'startLine', `document '${id}'`),
        endLine: requiredNumber(row, 'endLine', `document '${id}'`),
        fileExtension: requiredString(row, 'fileExtension', `document '${id}'`),
        metadata: parseMetadata(row.metadataJson, `document '${id}'`),
    };
}

function candidateOrder(left: VectorCandidate, right: VectorCandidate): number {
    return right.score - left.score
        || compareContractStrings(left.document.id, right.document.id);
}

function validateLimit(limit: number, context: string): void {
    if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error(`${context} limit must be a non-negative safe integer.`);
    }
}

function idFilter(ids: readonly string[]): VectorFilter {
    return { kind: 'in', field: 'id', values: ids };
}

function fixedControlFilter(collectionName: string, id?: string): string {
    const collection = `'${escapeLanceDbStringLiteral(collectionName)}'`;
    if (id === undefined) return `collectionName = ${collection}`;
    return `collectionName = ${collection} AND id = '${escapeLanceDbStringLiteral(id)}'`;
}

async function withTable<T>(
    connection: Connection,
    tableName: string,
    operation: (table: Table) => Promise<T>,
): Promise<T> {
    const table = await connection.openTable(tableName);
    try {
        return await operation(table);
    } finally {
        table.close();
    }
}

export class LanceDbVectorDatabase implements VectorDatabase {
    private readonly databasePath: string;
    private readonly maxWriteBatchSize: number;
    private connectionPromise: Promise<Connection> | null = null;
    private closed = false;

    constructor(config: LanceDbConfig) {
        if (!path.isAbsolute(config.databasePath)) {
            throw new Error('LanceDB databasePath must be absolute.');
        }
        if (config.databasePath.includes('\0')) {
            throw new Error('LanceDB databasePath contains a null byte.');
        }
        const maxWriteBatchSize = config.maxWriteBatchSize ?? DEFAULT_MAX_WRITE_BATCH_SIZE;
        if (!Number.isSafeInteger(maxWriteBatchSize) || maxWriteBatchSize < 1) {
            throw new Error('LanceDB maxWriteBatchSize must be a positive safe integer.');
        }
        this.databasePath = path.resolve(config.databasePath);
        this.maxWriteBatchSize = maxWriteBatchSize;
    }

    private getConnection(): Promise<Connection> {
        if (this.closed) throw new Error('LanceDB adapter is closed.');
        if (!this.connectionPromise) {
            this.connectionPromise = connect(this.databasePath, { readConsistencyInterval: 0 })
                .catch((error) => {
                    this.connectionPromise = null;
                    throw error;
                });
        }
        return this.connectionPromise;
    }

    private async tableNames(connection?: Connection): Promise<string[]> {
        const activeConnection = connection ?? await this.getConnection();
        return activeConnection.tableNames();
    }

    private async hasTable(tableName: string, connection?: Connection): Promise<boolean> {
        return (await this.tableNames(connection)).includes(tableName);
    }

    private async createDataTable(collectionName: string, dimension: number): Promise<void> {
        assertCollectionName(collectionName);
        if (!Number.isSafeInteger(dimension) || dimension < 1) {
            throw new Error('LanceDB vector dimension must be a positive safe integer.');
        }
        const connection = await this.getConnection();
        const table = await connection.createEmptyTable(
            collectionName,
            dataSchema(dimension),
            { mode: 'create', existOk: false },
        );
        table.close();
    }

    async createCollection(collectionName: string, dimension: number): Promise<void> {
        await this.createDataTable(collectionName, dimension);
    }

    async createHybridCollection(
        collectionName: string,
        dimension: number,
        _description?: string,
        options?: CollectionCreateOptions,
    ): Promise<void> {
        await this.createDataTable(collectionName, dimension);
        if (!options?.deferIndexBuild) {
            await this.finalizeCollectionForSearch(collectionName);
        }
    }

    async finalizeCollectionForSearch(collectionName: string): Promise<void> {
        assertCollectionName(collectionName);
        const connection = await this.getConnection();
        // Publication finalization only establishes search readiness (FTS).
        // Compaction/optimize is maintenance, not a completion-marker requirement:
        // optimize({ cleanupOlderThan: new Date(0) }) fails to decode real multi-file
        // UTF-8 payloads at scale under @lancedb/lancedb 0.31.x and must not gate
        // searchable publication. Do not fail-soft around optimize on this path.
        await withTable(connection, collectionName, async (table) => {
            await table.createIndex('lexicalText', {
                config: Index.fts({
                    withPosition: true,
                    baseTokenizer: 'simple',
                    maxTokenLength: 255,
                    lowercase: false,
                    stem: false,
                    removeStopWords: false,
                    asciiFolding: false,
                }),
                replace: true,
            });
        });
    }

    async forkCollection(
        sourceCollectionName: string,
        targetCollectionName: string,
    ): Promise<CollectionForkReceipt> {
        assertCollectionName(sourceCollectionName);
        assertCollectionName(targetCollectionName);
        if (sourceCollectionName === targetCollectionName) {
            throw new Error('LanceDB candidate collection must differ from its source collection.');
        }
        const connection = await this.getConnection();
        if (!await this.hasTable(sourceCollectionName, connection)) {
            throw new Error(`Cannot fork missing LanceDB collection '${sourceCollectionName}'.`);
        }
        if (await this.hasTable(targetCollectionName, connection)) {
            throw new Error(`Cannot fork into existing LanceDB collection '${targetCollectionName}'.`);
        }
        const source = await connection.openTable(sourceCollectionName);
        let copiedDocuments: number;
        try {
            copiedDocuments = await source.countRows();
        } finally {
            source.close();
        }
        const sourceUri = path.join(this.databasePath, `${sourceCollectionName}.lance`);
        const targetUri = path.join(this.databasePath, `${targetCollectionName}.lance`);
        try {
            const physical = await shareDirectoryForCandidate(sourceUri, targetUri);
            await fsyncCandidateTree(targetUri);
            const candidate = await connection.openTable(targetCollectionName);
            try {
                if (await candidate.countRows() !== copiedDocuments) {
                    throw new Error('LanceDB candidate collection row count differs from its source generation.');
                }
            } finally {
                candidate.close();
            }
            return {
                sourceCollectionName,
                targetCollectionName,
                strategy: 'filesystem_hardlink_cow',
                copiedDocuments,
                ...physical,
            };
        } catch (error) {
            await fs.promises.rm(targetUri, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }

    async dropCollection(collectionName: string): Promise<void> {
        assertCollectionName(collectionName);
        const connection = await this.getConnection();
        if (await this.hasTable(collectionName, connection)) {
            // Dropping data first is fail-closed: a crash can leave only an orphaned
            // control record, which can never authorize a missing generation table.
            await connection.dropTable(collectionName);
        }

        const controls = controlTableName(collectionName);
        if (!await this.hasTable(controls, connection)) return;
        await withTable(connection, controls, async (table) => {
            await table.delete(fixedControlFilter(collectionName));
            if (await table.countRows() === 0) {
                table.close();
                await connection.dropTable(controls);
            }
        });
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        assertCollectionName(collectionName);
        return this.hasTable(collectionName);
    }

    async listCollections(): Promise<string[]> {
        return (await this.tableNames())
            .filter((name) => !name.startsWith(CONTROL_TABLE_PREFIX))
            .sort(compareContractStrings);
    }

    async listCollectionDetails(): Promise<CollectionDetails[]> {
        return (await this.listCollections()).map((name) => ({ name }));
    }

    getBackendInfo(): VectorStoreBackendInfo {
        return {
            provider: 'lancedb',
            transport: 'embedded',
            address: this.databasePath,
        };
    }

    getPublicationCapabilities(): VectorPublicationCapabilities {
        return { atomicCandidatePublication: 'collection_fork' };
    }

    private async vectorDimension(table: Table): Promise<number> {
        const schema = await table.schema();
        const vectorField = schema.fields.find((field) => field.name === 'vector');
        if (!vectorField || !(vectorField.type instanceof FixedSizeList)) {
            throw new Error(`LanceDB table '${table.name}' has no fixed-size vector column.`);
        }
        return vectorField.type.listSize;
    }

    async writeDocuments(collectionName: string, documents: IndexedVectorDocument[]): Promise<void> {
        assertCollectionName(collectionName);
        if (documents.length === 0) return;
        const rowsById = new Map<string, LanceDbPhysicalRow>();
        for (const indexed of documents) {
            const row = encodeSearchableRow(indexed);
            const id = row.id as string;
            const existing = rowsById.get(id);
            if (existing && !isDeepStrictEqual(existing, row)) {
                throw new Error(`LanceDB logical write contains conflicting rows for document '${id}'.`);
            }
            rowsById.set(id, row);
        }

        const connection = await this.getConnection();
        await withTable(connection, collectionName, async (table) => {
            const dimension = await this.vectorDimension(table);
            for (const row of rowsById.values()) {
                if (!Array.isArray(row.vector) || row.vector.length !== dimension) {
                    throw new Error(
                        `LanceDB document '${String(row.id)}' vector dimension does not match table dimension ${dimension}.`,
                    );
                }
            }

            const rows = [...rowsById.values()];
            for (let offset = 0; offset < rows.length; offset += this.maxWriteBatchSize) {
                const batch = rows.slice(offset, offset + this.maxWriteBatchSize);
                const filter = serializeLanceDbFilter(idFilter(batch.map((row) => row.id as string)));
                const existingRows = await table.query()
                    .where(filter)
                    .select(['id', 'contentHash'])
                    .toArray() as LanceDbPhysicalRow[];
                const hashesById = new Map(existingRows.map((row) => [
                    requiredString(row, 'id', 'existing document'),
                    requiredString(row, 'contentHash', 'existing document'),
                ]));
                const changed = batch.filter((row) => hashesById.get(row.id as string) !== row.contentHash);
                if (changed.length === 0) continue;
                await table.mergeInsert('id')
                    .whenMatchedUpdateAll()
                    .whenNotMatchedInsertAll()
                    .execute(changed);
            }
        });
    }

    private async ensureControlTable(connection: Connection, collectionName: string): Promise<string> {
        const tableName = controlTableName(collectionName);
        if (await this.hasTable(tableName, connection)) return tableName;
        const table = await connection.createEmptyTable(
            tableName,
            controlSchema(),
            { mode: 'create', existOk: true },
        );
        table.close();
        return tableName;
    }

    async insertControl(collectionName: string, record: VectorControlRecord): Promise<void> {
        assertCollectionName(collectionName);
        if (record.id.length === 0 || record.kind.length === 0) {
            throw new Error('LanceDB control record ID and kind must be non-empty.');
        }
        if (
            Object.prototype.hasOwnProperty.call(record.metadata, 'kind')
            && record.metadata.kind !== record.kind
        ) {
            throw new Error(`LanceDB control record '${record.id}' has inconsistent kind fields.`);
        }
        const connection = await this.getConnection();
        if (!await this.hasTable(collectionName, connection)) {
            throw new Error(`Cannot publish LanceDB control record for missing collection '${collectionName}'.`);
        }
        const tableName = await this.ensureControlTable(connection, collectionName);
        const metadataJson = serializeMetadata(record.metadata);
        const current = await this.readControl(connection, collectionName, record.id);
        if (current && current.kind === record.kind && isDeepStrictEqual(current.metadata, record.metadata)) {
            return;
        }

        await withTable(connection, tableName, async (table) => {
            await table.delete(fixedControlFilter(collectionName, record.id));
            const key = crypto.createHash('sha256')
                .update(JSON.stringify([collectionName, record.kind, record.id]), 'utf8')
                .digest('hex');
            await table.mergeInsert('key')
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute([{
                    key,
                    collectionName,
                    id: record.id,
                    kind: record.kind,
                    metadataJson,
                }]);
        });
    }

    private async readControl(
        connection: Connection,
        collectionName: string,
        id: string,
    ): Promise<VectorControlRecord | null> {
        const tableName = controlTableName(collectionName);
        if (!await this.hasTable(tableName, connection)) return null;
        return withTable(connection, tableName, async (table) => {
            const rows = await table.query()
                .where(fixedControlFilter(collectionName, id))
                .select(['id', 'kind', 'metadataJson'])
                .limit(2)
                .toArray() as LanceDbPhysicalRow[];
            if (rows.length === 0) return null;
            if (rows.length > 1) {
                throw new Error(`LanceDB control record '${id}' is duplicated in '${collectionName}'.`);
            }
            const row = rows[0] as LanceDbPhysicalRow;
            const kind = requiredString(row, 'kind', `control record '${id}'`);
            const metadata = parseMetadata(row.metadataJson, `control record '${id}'`);
            if (Object.prototype.hasOwnProperty.call(metadata, 'kind') && metadata.kind !== kind) {
                throw new Error(`LanceDB control record '${id}' has inconsistent kind fields.`);
            }
            return { id: requiredString(row, 'id', `control record '${id}'`), kind, metadata };
        });
    }

    async getControl(collectionName: string, id: string): Promise<VectorControlRecord | null> {
        assertCollectionName(collectionName);
        if (id.length === 0) throw new Error('LanceDB control record ID must be non-empty.');
        const connection = await connect(this.databasePath, { readConsistencyInterval: 0 });
        try {
            return await this.readControl(connection, collectionName, id);
        } finally {
            connection.close();
        }
    }

    async deleteControl(collectionName: string, id: string): Promise<void> {
        assertCollectionName(collectionName);
        if (id.length === 0) throw new Error('LanceDB control record ID must be non-empty.');
        const connection = await this.getConnection();
        const tableName = controlTableName(collectionName);
        if (!await this.hasTable(tableName, connection)) return;
        await withTable(connection, tableName, (table) => table.delete(fixedControlFilter(collectionName, id)).then(() => undefined));
    }

    private async retrieveStableCandidates(
        table: Table,
        limit: number,
        filter: string,
        fetch: (fetchLimit: number) => Promise<VectorCandidate[]>,
        minimumScore?: number,
    ): Promise<VectorCandidate[]> {
        if (limit === 0) return [];
        const rowCount = await table.countRows(filter || undefined);
        if (rowCount === 0) return [];
        let fetchLimit = Math.min(
            rowCount,
            Math.max(limit * STABLE_TIE_INITIAL_MULTIPLIER, STABLE_TIE_MINIMUM_FETCH),
        );

        for (;;) {
            const fetched = (await fetch(fetchLimit)).sort(candidateOrder);
            const accepted = minimumScore === undefined
                ? fetched
                : fetched.filter((candidate) => candidate.score >= minimumScore);
            const boundary = accepted[limit - 1]?.score;
            const worstFetched = fetched[fetched.length - 1]?.score;
            const exhausted = fetched.length < fetchLimit || fetchLimit >= rowCount;
            const crossedBoundary = boundary !== undefined
                && worstFetched !== undefined
                && worstFetched < boundary;
            const crossedMinimum = minimumScore !== undefined
                && worstFetched !== undefined
                && worstFetched < minimumScore;

            if (exhausted || crossedBoundary || crossedMinimum) {
                return accepted.slice(0, limit);
            }
            fetchLimit = Math.min(rowCount, fetchLimit * 2);
        }
    }

    async retrieveDense(collectionName: string, request: DenseCandidateRequest): Promise<VectorCandidate[]> {
        assertCollectionName(collectionName);
        validateLimit(request.limit, 'Dense candidate');
        if (request.minimumScore !== undefined && !Number.isFinite(request.minimumScore)) {
            throw new Error('Dense minimumScore must be finite.');
        }
        if (request.vector.length === 0 || request.vector.some((value) => !Number.isFinite(value))) {
            throw new Error('Dense query vector must be non-empty and finite.');
        }
        const connection = await this.getConnection();
        return withTable(connection, collectionName, async (table) => {
            const dimension = await this.vectorDimension(table);
            if (request.vector.length !== dimension) {
                throw new Error(`Dense query vector dimension does not match table dimension ${dimension}.`);
            }
            const filter = serializeLanceDbFilter(request.filter);
            return this.retrieveStableCandidates(table, request.limit, filter, async (fetchLimit) => {
                let query = table.query()
                    .nearestTo([...request.vector])
                    .distanceType('cosine')
                    .bypassVectorIndex();
                if (filter) query = query.where(filter);
                const rows = await query
                    .select([...DATA_FIELDS, '_distance'])
                    .limit(fetchLimit)
                    .toArray() as LanceDbPhysicalRow[];
                return rows.map((row) => {
                    const distance = requiredNumber(row, '_distance', 'dense candidate');
                    const score = 1 - distance;
                    if (!Number.isFinite(score)) {
                        throw new Error('LanceDB dense candidate has a non-finite cosine score.');
                    }
                    return { document: decodeDocument(row), score };
                });
            }, request.minimumScore);
        });
    }

    async retrieveLexical(collectionName: string, request: LexicalCandidateRequest): Promise<VectorCandidate[]> {
        assertCollectionName(collectionName);
        validateLimit(request.limit, 'Lexical candidate');
        if (request.query.trim().length === 0 || request.limit === 0) return [];
        const connection = await this.getConnection();
        return withTable(connection, collectionName, async (table) => {
            const filter = serializeLanceDbFilter(request.filter);
            return this.retrieveStableCandidates(table, request.limit, filter, async (fetchLimit) => {
                let query = table.query().fullTextSearch(new MatchQuery(
                    request.query,
                    'lexicalText',
                    { operator: request.matchMode === 'any_terms' ? Operator.Or : Operator.And },
                ));
                if (filter) query = query.where(filter);
                const rows = await query
                    .select([...DATA_FIELDS, '_score'])
                    .limit(fetchLimit)
                    .toArray() as LanceDbPhysicalRow[];
                return rows.map((row) => {
                    const score = requiredNumber(row, '_score', 'lexical candidate');
                    return { document: decodeDocument(row), score };
                });
            });
        });
    }

    async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
        assertCollectionName(collectionName);
        if (ids.length === 0) return;
        if (ids.some((id) => id.length === 0 || id === INDEX_COMPLETION_MARKER_DOC_ID)) {
            throw new Error('LanceDB document deletion contains an empty or reserved control ID.');
        }
        const connection = await this.getConnection();
        await withTable(connection, collectionName, async (table) => {
            await table.delete(serializeLanceDbFilter(idFilter(ids)));
        });
    }

    async queryDocuments(collectionName: string, request: VectorDocumentQuery): Promise<VectorRecord[]> {
        assertCollectionName(collectionName);
        if (request.fields.length === 0) {
            throw new Error('LanceDB document query requires at least one output field.');
        }
        if (request.limit !== undefined) validateLimit(request.limit, 'Document query');
        if (request.limit === 0) return [];
        const connection = await this.getConnection();
        return withTable(connection, collectionName, async (table) => {
            const physicalFields = [...new Set(request.fields.map((field) => (
                field === 'metadata' ? 'metadataJson' : field
            )))];
            let query = table.query();
            const filter = serializeLanceDbFilter(request.filter);
            if (filter) query = query.where(filter);
            query = query.orderBy({ columnName: 'id', ascending: true }).select(physicalFields);
            if (request.limit !== undefined) query = query.limit(request.limit);
            const rows = await query.toArray() as LanceDbPhysicalRow[];
            return rows.map((row) => {
                const logical: VectorRecord = {};
                for (const field of request.fields) {
                    if (field === 'metadata') {
                        logical.metadata = parseMetadata(row.metadataJson, 'document query');
                    } else {
                        logical[field] = row[field];
                    }
                }
                return logical;
            });
        });
    }

    async countDocuments(collectionName: string, filter?: VectorFilter): Promise<number> {
        assertCollectionName(collectionName);
        const connection = await this.getConnection();
        return withTable(connection, collectionName, (table) => (
            table.countRows(serializeLanceDbFilter(filter) || undefined)
        ));
    }

    async checkCollectionLimit(): Promise<boolean> {
        return true;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const connectionPromise = this.connectionPromise;
        this.connectionPromise = null;
        if (connectionPromise) (await connectionPromise).close();
    }
}
