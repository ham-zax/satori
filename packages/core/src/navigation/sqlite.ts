import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    buildSymbolRegistry,
    computeSymbolRegistryManifestHash,
    isRelationshipManifest,
    isRelationshipRecord,
    isSymbolRecord,
    isSymbolRegistryManifest,
    resolveNavigationSidecarRoot,
    resolveCurrentNavigationGeneration,
    resolveOwnerSymbolForChunk,
} from '../symbols';
import type {
    RelationshipManifest,
    RelationshipRecord,
    RelationshipType,
    SymbolRecord,
    SymbolRegistryManifest,
    SymbolSpan,
} from '../symbols';
import { JsonNavigationStore } from './store';
import type {
    NavigationCompatibilityInput,
    NavigationCompatibilityState,
    NavigationOwnerForSpanInput,
    NavigationOwnerForSpanResult,
    NavigationRegistryState,
    NavigationRelationshipsQueryInput,
    NavigationRelationshipsState,
    NavigationStore,
    NavigationStoreInput,
    NavigationSymbolByInstanceIdInput,
    NavigationSymbolByInstanceIdResult,
    NavigationSymbolCandidatesByKeyInput,
    NavigationSymbolCandidatesByKeyResult,
    NavigationSymbolsByFileInput,
    NavigationSymbolsByFileResult,
} from './store';

const NAVIGATION_SQLITE_FILE_NAME = 'navigation.sqlite';
const NAVIGATION_SQLITE_SCHEMA_VERSION = 'navigation_sqlite_v3';

type DatabaseSync = import('node:sqlite').DatabaseSync;
type DatabaseSyncConstructor = typeof import('node:sqlite').DatabaseSync;

type RelationshipStatus = NavigationRelationshipsState['status'] | 'not_checked';

type ManifestRow = {
    key: string;
    value: string;
};

type FileRow = {
    path: string;
    hash: string;
    language: string;
    symbol_count: number;
};

type SymbolRow = {
    symbol_instance_id: string;
    symbol_key: string;
    file_path: string;
    language: string;
    kind: SymbolRecord['kind'];
    name: string;
    qualified_name: string;
    label: string;
    start_line: number;
    end_line: number;
    start_byte: number | null;
    end_byte: number | null;
    start_column: number | null;
    end_column: number | null;
    parent_key: string | null;
    parent_qualified_name_path_json: string;
    exported: number | null;
    file_hash: string;
    extractor_version: string;
    ontology_tags_json: string | null;
};

type RelationshipRow = {
    source_key: string;
    source_instance_id: string | null;
    target_key: string | null;
    target_instance_id: string | null;
    target_path: string | null;
    type: RelationshipType;
    file_path: string;
    start_line: number | null;
    end_line: number | null;
    start_byte: number | null;
    end_byte: number | null;
    start_column: number | null;
    end_column: number | null;
    confidence: RelationshipRecord['confidence'];
};

type SqliteRegistryPayload = Extract<NavigationRegistryState, { status: 'ok' }>;

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRelativeFilePath(filePath: string): string {
    return filePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function buildFailure(rootPath: string, reason: string, status: 'missing' | 'incompatible') {
    return {
        status,
        rootPath,
        reason,
    } as const;
}

function compareManifestFiles(a: SymbolRegistryManifest['files'][number], b: SymbolRegistryManifest['files'][number]): number {
    if (a.path !== b.path) {
        return compareStrings(a.path, b.path);
    }
    if (a.hash !== b.hash) {
        return compareStrings(a.hash, b.hash);
    }
    if (a.language !== b.language) {
        return compareStrings(a.language, b.language);
    }
    return a.symbolCount - b.symbolCount;
}

function compareSymbols(a: SymbolRecord, b: SymbolRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    if (a.span.startLine !== b.span.startLine) return a.span.startLine - b.span.startLine;
    if (a.span.endLine !== b.span.endLine) return a.span.endLine - b.span.endLine;
    if ((a.span.startByte || 0) !== (b.span.startByte || 0)) return (a.span.startByte || 0) - (b.span.startByte || 0);
    if ((a.span.endByte || 0) !== (b.span.endByte || 0)) return (a.span.endByte || 0) - (b.span.endByte || 0);
    if (a.kind !== b.kind) return compareStrings(a.kind, b.kind);
    if (a.qualifiedName !== b.qualifiedName) return compareStrings(a.qualifiedName, b.qualifiedName);
    return compareStrings(a.symbolInstanceId, b.symbolInstanceId);
}

function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    const aStart = a.span?.startLine ?? 0;
    const bStart = b.span?.startLine ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.span?.endLine ?? 0;
    const bEnd = b.span?.endLine ?? 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    if (a.type !== b.type) return compareStrings(a.type, b.type);
    const aSource = a.sourceInstanceId || a.sourceKey;
    const bSource = b.sourceInstanceId || b.sourceKey;
    if (aSource !== bSource) return compareStrings(aSource, bSource);
    const aTarget = a.targetInstanceId || a.targetKey || a.targetPath || '';
    const bTarget = b.targetInstanceId || b.targetKey || b.targetPath || '';
    return compareStrings(aTarget, bTarget);
}

function matchesType(record: RelationshipRecord, types?: RelationshipType[]): boolean {
    return !types || types.length === 0 || types.includes(record.type);
}

function matchesSourceSelector(record: RelationshipRecord, input: NavigationRelationshipsQueryInput): boolean {
    if (input.sourceInstanceId && record.sourceInstanceId !== input.sourceInstanceId) {
        return false;
    }
    if (input.sourceKey && record.sourceKey !== input.sourceKey) {
        return false;
    }
    return Boolean(input.sourceInstanceId || input.sourceKey);
}

function matchesTargetSelector(record: RelationshipRecord, input: NavigationRelationshipsQueryInput): boolean {
    if (input.targetInstanceId && record.targetInstanceId !== input.targetInstanceId) {
        return false;
    }
    if (input.targetKey && record.targetKey !== input.targetKey) {
        return false;
    }
    return Boolean(input.targetInstanceId || input.targetKey);
}

function serializeForParity(value: unknown): string {
    return JSON.stringify(value);
}

function relationshipRecordKey(record: RelationshipRecord): string {
    return serializeForParity({
        file: record.file,
        span: record.span || null,
        type: record.type,
        sourceKey: record.sourceKey,
        sourceInstanceId: record.sourceInstanceId || null,
        targetKey: record.targetKey || null,
        targetInstanceId: record.targetInstanceId || null,
        targetPath: record.targetPath || null,
        confidence: record.confidence,
    });
}

function symbolRecordKey(symbol: SymbolRecord | null): string {
    if (!symbol) {
        return 'null';
    }
    return serializeForParity({
        symbolKey: symbol.symbolKey,
        symbolInstanceId: symbol.symbolInstanceId,
        language: symbol.language,
        kind: symbol.kind,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        label: symbol.label,
        file: symbol.file,
        span: symbol.span,
        parentKey: symbol.parentKey || null,
        parentQualifiedNamePath: symbol.parentQualifiedNamePath,
        exported: symbol.exported ?? null,
        fileHash: symbol.fileHash,
        extractorVersion: symbol.extractorVersion,
        ontologyTags: symbol.ontologyTags || [],
    });
}

let cachedDatabaseSyncConstructor: DatabaseSyncConstructor | null = null;

function getDatabaseSyncConstructor(): DatabaseSyncConstructor {
    if (cachedDatabaseSyncConstructor) {
        return cachedDatabaseSyncConstructor;
    }

    try {
        const nodeSqlite = require('node:sqlite') as { DatabaseSync?: DatabaseSyncConstructor };
        if (typeof nodeSqlite.DatabaseSync !== 'function') {
            throw new Error('node:sqlite did not expose DatabaseSync');
        }
        cachedDatabaseSyncConstructor = nodeSqlite.DatabaseSync;
        return cachedDatabaseSyncConstructor;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            `node:sqlite is unavailable in this Node runtime. Navigation SQLite remains optional; continue with JSON sidecars or upgrade Node. Cause: ${reason}`
        );
    }
}

function openDatabase(sqlitePath: string): DatabaseSync {
    const DatabaseSync = getDatabaseSyncConstructor();
    return new DatabaseSync(sqlitePath);
}

function closeDatabase(database: DatabaseSync | undefined): void {
    try {
        database?.close();
    } catch {
        // Best-effort cleanup for additive navigation cache writes.
    }
}

function ensureManifestValue(manifest: Map<string, string>, key: string, rootPath: string): string | ReturnType<typeof buildFailure> {
    const value = manifest.get(key);
    if (value === undefined) {
        return buildFailure(rootPath, `navigation sqlite manifest is missing ${key}`, 'incompatible');
    }
    return value;
}

function parseJsonValue<T>(raw: string, rootPath: string, key: string): T | ReturnType<typeof buildFailure> {
    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        return buildFailure(
            rootPath,
            `navigation sqlite manifest ${key} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            'incompatible'
        );
    }
}

function rowSpan(row: {
    start_line: number | null;
    end_line: number | null;
    start_byte: number | null;
    end_byte: number | null;
    start_column: number | null;
    end_column: number | null;
}): SymbolSpan | undefined {
    if (row.start_line === null || row.end_line === null) {
        return undefined;
    }
    return {
        startLine: row.start_line,
        endLine: row.end_line,
        ...(row.start_byte !== null ? { startByte: row.start_byte } : {}),
        ...(row.end_byte !== null ? { endByte: row.end_byte } : {}),
        ...(row.start_column !== null ? { startColumn: row.start_column } : {}),
        ...(row.end_column !== null ? { endColumn: row.end_column } : {}),
    };
}

function symbolFromRow(row: SymbolRow, rootPath: string): SymbolRecord | ReturnType<typeof buildFailure> {
    const parentQualifiedNamePathRaw = parseJsonValue<string[]>(row.parent_qualified_name_path_json, rootPath, 'parent_qualified_name_path_json');
    if ('status' in parentQualifiedNamePathRaw) {
        return parentQualifiedNamePathRaw;
    }
    if (!Array.isArray(parentQualifiedNamePathRaw) || !parentQualifiedNamePathRaw.every((entry) => typeof entry === 'string')) {
        return buildFailure(rootPath, 'navigation sqlite symbol row has invalid parentQualifiedNamePath', 'incompatible');
    }
    const ontologyTagsRaw = row.ontology_tags_json === null
        ? []
        : parseJsonValue<string[]>(row.ontology_tags_json, rootPath, 'ontology_tags_json');
    if ('status' in ontologyTagsRaw) {
        return ontologyTagsRaw;
    }
    if (!Array.isArray(ontologyTagsRaw) || !ontologyTagsRaw.every((entry) => typeof entry === 'string')) {
        return buildFailure(rootPath, 'navigation sqlite symbol row has invalid ontologyTags', 'incompatible');
    }
    const symbol: SymbolRecord = {
        symbolKey: row.symbol_key,
        symbolInstanceId: row.symbol_instance_id,
        language: row.language,
        kind: row.kind,
        name: row.name,
        qualifiedName: row.qualified_name,
        label: row.label,
        file: row.file_path,
        span: {
            startLine: row.start_line,
            endLine: row.end_line,
            ...(row.start_byte !== null ? { startByte: row.start_byte } : {}),
            ...(row.end_byte !== null ? { endByte: row.end_byte } : {}),
            ...(row.start_column !== null ? { startColumn: row.start_column } : {}),
            ...(row.end_column !== null ? { endColumn: row.end_column } : {}),
        },
        ...(row.parent_key ? { parentKey: row.parent_key } : {}),
        parentQualifiedNamePath: parentQualifiedNamePathRaw,
        ...(row.exported !== null ? { exported: row.exported === 1 } : {}),
        fileHash: row.file_hash,
        extractorVersion: row.extractor_version,
        ...(ontologyTagsRaw.length > 0 ? { ontologyTags: ontologyTagsRaw as SymbolRecord['ontologyTags'] } : {}),
    };
    return isSymbolRecord(symbol)
        ? symbol
        : buildFailure(rootPath, 'navigation sqlite symbol row violates the symbol record contract', 'incompatible');
}

function relationshipFromRow(row: RelationshipRow, rootPath: string): RelationshipRecord | ReturnType<typeof buildFailure> {
    const relationship: RelationshipRecord = {
        sourceKey: row.source_key,
        ...(row.source_instance_id ? { sourceInstanceId: row.source_instance_id } : {}),
        ...(row.target_key ? { targetKey: row.target_key } : {}),
        ...(row.target_instance_id ? { targetInstanceId: row.target_instance_id } : {}),
        ...(row.target_path ? { targetPath: row.target_path } : {}),
        type: row.type,
        file: row.file_path,
        ...(rowSpan(row) ? { span: rowSpan(row)! } : {}),
        confidence: row.confidence,
    };
    return isRelationshipRecord(relationship)
        ? relationship
        : buildFailure(rootPath, 'navigation sqlite relationship row violates the relationship record contract', 'incompatible');
}

function readManifestMap(database: DatabaseSync): Map<string, string> {
    const rows = database.prepare('SELECT key, value FROM navigation_manifest ORDER BY key').all() as ManifestRow[];
    return new Map(rows.map((row) => [row.key, row.value]));
}

function insertManifestValue(database: DatabaseSync, key: string, value: string): void {
    database.prepare('INSERT INTO navigation_manifest(key, value) VALUES (?, ?)').run(key, value);
}

function contentDigest(value: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function symbolContentDigest(symbols: SymbolRecord[]): string {
    return contentDigest([...symbols].sort(compareSymbols).map((symbol) => [
        symbol.symbolInstanceId,
        symbol.symbolKey,
        symbol.file,
        symbol.language,
        symbol.kind,
        symbol.name,
        symbol.qualifiedName,
        symbol.label,
        symbol.span.startLine,
        symbol.span.endLine,
        symbol.span.startByte ?? null,
        symbol.span.endByte ?? null,
        symbol.span.startColumn ?? null,
        symbol.span.endColumn ?? null,
        symbol.parentKey ?? null,
        symbol.parentQualifiedNamePath,
        symbol.exported ?? null,
        symbol.fileHash,
        symbol.extractorVersion,
        symbol.ontologyTags ?? [],
    ]));
}

function relationshipContentDigest(records: RelationshipRecord[]): string {
    return contentDigest([...records].sort(compareRelationshipRecords).map((record) => [
        record.sourceKey,
        record.sourceInstanceId ?? null,
        record.targetKey ?? null,
        record.targetInstanceId ?? null,
        record.targetPath ?? null,
        record.type,
        record.file,
        record.span?.startLine ?? null,
        record.span?.endLine ?? null,
        record.span?.startByte ?? null,
        record.span?.endByte ?? null,
        record.span?.startColumn ?? null,
        record.span?.endColumn ?? null,
        record.confidence,
    ]));
}

function createSchema(database: DatabaseSync): void {
    database.exec(`
        CREATE TABLE navigation_manifest(
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE files(
            path TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            language TEXT NOT NULL,
            symbol_count INTEGER NOT NULL
        );
        CREATE TABLE symbols(
            symbol_instance_id TEXT PRIMARY KEY,
            symbol_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            language TEXT NOT NULL,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            qualified_name TEXT NOT NULL,
            label TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            start_byte INTEGER,
            end_byte INTEGER,
            start_column INTEGER,
            end_column INTEGER,
            parent_key TEXT,
            parent_qualified_name_path_json TEXT NOT NULL,
            exported INTEGER,
            file_hash TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            ontology_tags_json TEXT
        );
        CREATE TABLE relationships(
            id INTEGER PRIMARY KEY,
            source_key TEXT NOT NULL,
            source_instance_id TEXT,
            target_key TEXT,
            target_instance_id TEXT,
            target_path TEXT,
            type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            start_line INTEGER,
            end_line INTEGER,
            start_byte INTEGER,
            end_byte INTEGER,
            start_column INTEGER,
            end_column INTEGER,
            confidence TEXT NOT NULL
        );
        CREATE INDEX idx_symbols_key ON symbols(symbol_key);
        CREATE INDEX idx_symbols_file_span ON symbols(file_path, start_line, end_line);
        CREATE INDEX idx_relationship_source ON relationships(source_instance_id, type);
        CREATE INDEX idx_relationship_target ON relationships(target_instance_id, type);
        CREATE INDEX idx_relationship_file ON relationships(file_path, type);
    `);
}

function readExistingRegistryState(input: NavigationStoreInput, rootPath: string): NavigationRegistryState {
    const sqlitePath = resolveNavigationSqlitePath(input.stateRoot, input.normalizedRootPath);
    if (!fs.existsSync(sqlitePath)) {
        return buildFailure(rootPath, 'navigation sqlite database is missing', 'missing');
    }

    let database: DatabaseSync | undefined;
    try {
        database = openDatabase(sqlitePath);
        const manifest = readManifestMap(database);
        const schemaVersion = ensureManifestValue(manifest, 'schema_version', rootPath);
        if (typeof schemaVersion !== 'string') {
            return schemaVersion;
        }
        if (schemaVersion !== NAVIGATION_SQLITE_SCHEMA_VERSION) {
            return buildFailure(rootPath, `navigation sqlite schema is incompatible: ${schemaVersion}`, 'incompatible');
        }
        const generationMismatch = validateStoredGenerationIdentity(manifest, input, rootPath);
        if (generationMismatch) return generationMismatch;

        const rawManifest = ensureManifestValue(manifest, 'registry_manifest_json', rootPath);
        if (typeof rawManifest !== 'string') {
            return rawManifest;
        }
        const parsedManifest = parseJsonValue<SymbolRegistryManifest>(rawManifest, rootPath, 'registry_manifest_json');
        if ('status' in parsedManifest) {
            return parsedManifest;
        }
        if (!isSymbolRegistryManifest(parsedManifest)) {
            return buildFailure(rootPath, 'navigation sqlite registry manifest is invalid or incompatible', 'incompatible');
        }

        const storedManifestHash = ensureManifestValue(manifest, 'registry_manifest_hash', rootPath);
        if (typeof storedManifestHash !== 'string') {
            return storedManifestHash;
        }
        const computedManifestHash = computeSymbolRegistryManifestHash(parsedManifest);
        if (storedManifestHash !== computedManifestHash) {
            return buildFailure(rootPath, 'navigation sqlite registry manifest hash does not match manifest', 'incompatible');
        }

        const fileRows = database.prepare(`
            SELECT path, hash, language, symbol_count
            FROM files
            ORDER BY path ASC
        `).all() as FileRow[];
        const manifestFiles = [...parsedManifest.files].sort(compareManifestFiles);
        if (fileRows.length !== manifestFiles.length) {
            return buildFailure(rootPath, 'navigation sqlite files table does not match registry manifest', 'incompatible');
        }
        for (let index = 0; index < fileRows.length; index += 1) {
            const row = fileRows[index];
            const manifestFile = manifestFiles[index];
            if (!manifestFile || row.path !== manifestFile.path || row.hash !== manifestFile.hash || row.language !== manifestFile.language || row.symbol_count !== manifestFile.symbolCount) {
                return buildFailure(rootPath, 'navigation sqlite files table does not match registry manifest', 'incompatible');
            }
        }

        const symbolRows = database.prepare(`
            SELECT
                symbol_instance_id,
                symbol_key,
                file_path,
                language,
                kind,
                name,
                qualified_name,
                label,
                start_line,
                end_line,
                start_byte,
                end_byte,
                start_column,
                end_column,
                parent_key,
                parent_qualified_name_path_json,
                exported,
                file_hash,
                extractor_version,
                ontology_tags_json
            FROM symbols
            ORDER BY file_path ASC, start_line ASC, end_line ASC, kind ASC, qualified_name ASC, symbol_instance_id ASC
        `).all() as SymbolRow[];
        const symbols: SymbolRecord[] = [];
        const manifestFilesByPath = new Map(parsedManifest.files.map((file) => [file.path, file]));
        const observedSymbolCounts = new Map<string, number>();
        for (const row of symbolRows) {
            const symbol = symbolFromRow(row, rootPath);
            if ('status' in symbol) {
                return symbol;
            }
            const manifestFile = manifestFilesByPath.get(symbol.file);
            if (
                !manifestFile
                || symbol.fileHash !== manifestFile.hash
                || symbol.language !== manifestFile.language
            ) {
                return buildFailure(rootPath, 'navigation sqlite symbol row does not match its manifest file', 'incompatible');
            }
            observedSymbolCounts.set(symbol.file, (observedSymbolCounts.get(symbol.file) ?? 0) + 1);
            symbols.push(symbol);
        }
        for (const manifestFile of parsedManifest.files) {
            if ((observedSymbolCounts.get(manifestFile.path) ?? 0) !== manifestFile.symbolCount) {
                return buildFailure(rootPath, 'navigation sqlite symbol counts do not match registry manifest', 'incompatible');
            }
        }
        if (manifest.get('symbol_content_hash') !== symbolContentDigest(symbols)) {
            return buildFailure(rootPath, 'navigation sqlite symbol content hash does not match stored rows', 'incompatible');
        }

        const registry = buildSymbolRegistry({
            manifest: parsedManifest,
            symbols,
        });
        return {
            status: 'ok',
            rootPath,
            manifestHash: storedManifestHash,
            registryManifestHash: storedManifestHash,
            registry,
            warnings: registry.warnings,
        };
    } catch (error) {
        return buildFailure(rootPath, error instanceof Error ? error.message : String(error), 'incompatible');
    } finally {
        closeDatabase(database);
    }
}

function readRelationshipStateFromSqlite(input: NavigationRelationshipsQueryInput, rootPath: string): NavigationRelationshipsState {
    const sqlitePath = resolveNavigationSqlitePath(input.stateRoot, input.normalizedRootPath);
    if (!fs.existsSync(sqlitePath)) {
        return buildFailure(rootPath, 'navigation sqlite database is missing', 'missing');
    }

    let database: DatabaseSync | undefined;
    try {
        database = openDatabase(sqlitePath);
        const manifest = readManifestMap(database);
        const schemaVersion = ensureManifestValue(manifest, 'schema_version', rootPath);
        if (typeof schemaVersion !== 'string') {
            return schemaVersion;
        }
        if (schemaVersion !== NAVIGATION_SQLITE_SCHEMA_VERSION) {
            return buildFailure(rootPath, `navigation sqlite schema is incompatible: ${schemaVersion}`, 'incompatible');
        }
        const generationMismatch = validateStoredGenerationIdentity(manifest, input, rootPath);
        if (generationMismatch) return generationMismatch;

        const relationshipStatusRaw = ensureManifestValue(manifest, 'relationship_status', rootPath);
        if (typeof relationshipStatusRaw !== 'string') {
            return relationshipStatusRaw;
        }
        if (relationshipStatusRaw === 'missing' || relationshipStatusRaw === 'incompatible') {
            const reason = manifest.get('relationship_reason') || 'relationship sidecar was unavailable during sqlite import';
            return buildFailure(rootPath, reason, relationshipStatusRaw);
        }
        if (relationshipStatusRaw !== 'ok') {
            return buildFailure(rootPath, `navigation sqlite relationship status is incompatible: ${relationshipStatusRaw}`, 'incompatible');
        }

        const expectedManifestHash = input.expectedSymbolRegistryManifestHash || manifest.get('registry_manifest_hash');
        if (!expectedManifestHash) {
            return buildFailure(rootPath, 'navigation sqlite registry manifest hash is missing', 'incompatible');
        }

        const rawRelationshipManifest = ensureManifestValue(manifest, 'relationship_manifest_json', rootPath);
        if (typeof rawRelationshipManifest !== 'string') {
            return rawRelationshipManifest;
        }
        const parsedRelationshipManifest = parseJsonValue<RelationshipManifest>(rawRelationshipManifest, rootPath, 'relationship_manifest_json');
        if ('status' in parsedRelationshipManifest) {
            return parsedRelationshipManifest;
        }
        if (!isRelationshipManifest(parsedRelationshipManifest)) {
            return buildFailure(rootPath, 'navigation sqlite relationship manifest is invalid or incompatible', 'incompatible');
        }
        if (parsedRelationshipManifest.symbolRegistryManifestHash !== expectedManifestHash) {
            return buildFailure(rootPath, 'relationship manifest hash does not match symbol registry manifest hash', 'incompatible');
        }

        const rawWarnings = manifest.get('relationship_warnings_json') || '[]';
        const parsedWarnings = parseJsonValue<string[]>(rawWarnings, rootPath, 'relationship_warnings_json');
        if ('status' in parsedWarnings) {
            return parsedWarnings;
        }
        if (!Array.isArray(parsedWarnings) || !parsedWarnings.every((entry) => typeof entry === 'string')) {
            return buildFailure(rootPath, 'navigation sqlite relationship warnings are invalid', 'incompatible');
        }

        const relationshipRows = database.prepare(`
            SELECT
                source_key,
                source_instance_id,
                target_key,
                target_instance_id,
                target_path,
                type,
                file_path,
                start_line,
                end_line,
                start_byte,
                end_byte,
                start_column,
                end_column,
                confidence
            FROM relationships
            ORDER BY file_path ASC, start_line ASC, end_line ASC, type ASC, source_key ASC, target_key ASC, target_instance_id ASC, target_path ASC
        `).all() as RelationshipRow[];

        const relationshipFiles = new Set(parsedRelationshipManifest.files.map((file) => file.path));
        const expectedRelationshipCounts = new Map(parsedRelationshipManifest.files.map((file) => [file.path, file.relationshipCount]));
        const observedRelationshipCounts = new Map<string, number>();
        const validatedRelationships: RelationshipRecord[] = [];
        for (const row of relationshipRows) {
            const relationship = relationshipFromRow(row, rootPath);
            if ('status' in relationship) {
                return relationship;
            }
            if (!relationshipFiles.has(relationship.file)) {
                return buildFailure(rootPath, 'navigation sqlite relationship row references a file outside its manifest', 'incompatible');
            }
            observedRelationshipCounts.set(
                relationship.file,
                (observedRelationshipCounts.get(relationship.file) ?? 0) + 1,
            );
            validatedRelationships.push(relationship);
        }
        for (const [filePath, expectedCount] of expectedRelationshipCounts) {
            if ((observedRelationshipCounts.get(filePath) ?? 0) !== expectedCount) {
                return buildFailure(rootPath, 'navigation sqlite relationship counts do not match relationship manifest', 'incompatible');
            }
        }
        if (manifest.get('relationship_content_hash') !== relationshipContentDigest(validatedRelationships)) {
            return buildFailure(rootPath, 'navigation sqlite relationship content hash does not match stored rows', 'incompatible');
        }

        const direction = input.direction || 'both';
        const records = validatedRelationships
            .filter((record) => {
                if (!matchesType(record, input.types)) {
                    return false;
                }
                if (direction === 'callees') {
                    return matchesSourceSelector(record, input);
                }
                if (direction === 'callers') {
                    return matchesTargetSelector(record, input);
                }
                const hasSelector = Boolean(
                    input.sourceInstanceId
                    || input.sourceKey
                    || input.targetInstanceId
                    || input.targetKey
                );
                if (!hasSelector) {
                    return true;
                }
                return matchesSourceSelector(record, input) || matchesTargetSelector(record, input);
            })
            .sort(compareRelationshipRecords);

        return {
            status: 'ok',
            rootPath,
            manifest: parsedRelationshipManifest,
            records,
            warnings: [...new Set(parsedWarnings)].sort(compareStrings),
        };
    } catch (error) {
        return buildFailure(rootPath, error instanceof Error ? error.message : String(error), 'incompatible');
    } finally {
        closeDatabase(database);
    }
}

export function resolveNavigationSqlitePath(stateRoot: string | undefined, normalizedRootPath: string): string {
    return path.join(resolveNavigationSidecarRoot(stateRoot, normalizedRootPath), NAVIGATION_SQLITE_FILE_NAME);
}

function validateStoredGenerationIdentity(
    manifest: Map<string, string>,
    input: NavigationStoreInput,
    rootPath: string,
): ReturnType<typeof buildFailure> | null {
    try {
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath),
            'current.json',
        );
        const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
        if (
            manifest.get('navigation_generation_id') !== pointer.generationId
            || manifest.get('registry_manifest_hash') !== pointer.symbolRegistryManifestHash
            || manifest.get('relationship_manifest_hash') !== pointer.relationshipManifestHash
        ) {
            return buildFailure(rootPath, 'navigation sqlite generation does not match the active navigation pointer', 'incompatible');
        }
        return null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return manifest.get('navigation_generation_id') === 'standalone'
                ? null
                : buildFailure(rootPath, 'navigation sqlite is not bound to an active generation', 'incompatible');
        }
        return buildFailure(rootPath, `cannot validate navigation sqlite generation: ${error instanceof Error ? error.message : String(error)}`, 'incompatible');
    }
}

export interface ImportNavigationToSqliteInput extends NavigationStoreInput {
    sourceStore?: NavigationStore;
    beforePublish?: () => void;
}

export interface ImportNavigationToSqliteResult {
    rootPath: string;
    sqlitePath: string;
    registryManifestHash: string;
    symbolCount: number;
    relationshipCount: number;
    relationshipStatus: RelationshipStatus;
}

export async function importNavigationToSqlite(input: ImportNavigationToSqliteInput): Promise<ImportNavigationToSqliteResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    const sqlitePath = resolveNavigationSqlitePath(input.stateRoot, input.normalizedRootPath);
    const sourceStore = input.sourceStore || new JsonNavigationStore();
    const activeGeneration = await resolveCurrentNavigationGeneration(input.stateRoot, input.normalizedRootPath);
    const registryState = await sourceStore.getManifest(input);
    if (registryState.status !== 'ok') {
        throw new Error(`Cannot import navigation sqlite without a compatible registry: ${registryState.reason}`);
    }

    const compatibility = await sourceStore.getCompatibilityState({
        normalizedRootPath: input.normalizedRootPath,
        stateRoot: input.stateRoot,
        expectedSymbolRegistryManifestHash: registryState.manifestHash,
    });

    const temporarySqlitePath = `${sqlitePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.mkdir(path.dirname(sqlitePath), { recursive: true });
    await fs.promises.rm(temporarySqlitePath, { force: true }).catch(() => undefined);

    let database: DatabaseSync | undefined;
    try {
        database = openDatabase(temporarySqlitePath);
        createSchema(database);
        database.exec('BEGIN');

        insertManifestValue(database, 'schema_version', NAVIGATION_SQLITE_SCHEMA_VERSION);
        insertManifestValue(database, 'normalized_root_path', registryState.registry.manifest.normalizedRootPath);
        insertManifestValue(database, 'registry_manifest_hash', registryState.manifestHash);
        insertManifestValue(database, 'navigation_generation_id', activeGeneration?.generationId ?? 'standalone');
        insertManifestValue(database, 'relationship_manifest_hash', activeGeneration?.relationshipManifestHash ?? 'standalone');
        insertManifestValue(database, 'registry_manifest_json', JSON.stringify(registryState.registry.manifest));
        insertManifestValue(database, 'symbol_content_hash', symbolContentDigest(registryState.registry.symbols));
        insertManifestValue(database, 'imported_at', new Date().toISOString());

        const insertFile = database.prepare(`
            INSERT INTO files(path, hash, language, symbol_count)
            VALUES (?, ?, ?, ?)
        `);
        for (const file of [...registryState.registry.manifest.files].sort(compareManifestFiles)) {
            insertFile.run(file.path, file.hash, file.language, file.symbolCount);
        }

        const insertSymbol = database.prepare(`
            INSERT INTO symbols(
                symbol_instance_id,
                symbol_key,
                file_path,
                language,
                kind,
                name,
                qualified_name,
                label,
                start_line,
                end_line,
                start_byte,
                end_byte,
                start_column,
                end_column,
                parent_key,
                parent_qualified_name_path_json,
                exported,
                file_hash,
                extractor_version,
                ontology_tags_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const symbol of [...registryState.registry.symbols].sort(compareSymbols)) {
            insertSymbol.run(
                symbol.symbolInstanceId,
                symbol.symbolKey,
                symbol.file,
                symbol.language,
                symbol.kind,
                symbol.name,
                symbol.qualifiedName,
                symbol.label,
                symbol.span.startLine,
                symbol.span.endLine,
                symbol.span.startByte ?? null,
                symbol.span.endByte ?? null,
                symbol.span.startColumn ?? null,
                symbol.span.endColumn ?? null,
                symbol.parentKey ?? null,
                JSON.stringify(symbol.parentQualifiedNamePath),
                symbol.exported === undefined ? null : symbol.exported ? 1 : 0,
                symbol.fileHash,
                symbol.extractorVersion,
                symbol.ontologyTags ? JSON.stringify(symbol.ontologyTags) : null
            );
        }

        const relationshipState = compatibility.relationships;
        if (relationshipState.status === 'ok') {
            insertManifestValue(database, 'relationship_status', 'ok');
            insertManifestValue(database, 'relationship_reason', '');
            insertManifestValue(database, 'relationship_manifest_json', JSON.stringify(relationshipState.manifest));
            insertManifestValue(database, 'relationship_warnings_json', JSON.stringify(relationshipState.warnings));
            insertManifestValue(database, 'relationship_content_hash', relationshipContentDigest(relationshipState.records));

            const insertRelationship = database.prepare(`
                INSERT INTO relationships(
                    source_key,
                    source_instance_id,
                    target_key,
                    target_instance_id,
                    target_path,
                    type,
                    file_path,
                    start_line,
                    end_line,
                    start_byte,
                    end_byte,
                    start_column,
                    end_column,
                    confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const record of [...relationshipState.records].sort(compareRelationshipRecords)) {
                insertRelationship.run(
                    record.sourceKey,
                    record.sourceInstanceId ?? null,
                    record.targetKey ?? null,
                    record.targetInstanceId ?? null,
                    record.targetPath ?? null,
                    record.type,
                    record.file,
                    record.span?.startLine ?? null,
                    record.span?.endLine ?? null,
                    record.span?.startByte ?? null,
                    record.span?.endByte ?? null,
                    record.span?.startColumn ?? null,
                    record.span?.endColumn ?? null,
                    record.confidence
                );
            }
        } else {
            insertManifestValue(database, 'relationship_status', relationshipState.status);
            insertManifestValue(database, 'relationship_reason', relationshipState.reason);
            insertManifestValue(database, 'relationship_manifest_json', JSON.stringify(null));
            insertManifestValue(database, 'relationship_warnings_json', JSON.stringify([]));
            insertManifestValue(database, 'relationship_content_hash', '');
        }

        database.exec('COMMIT');
        closeDatabase(database);
        database = undefined;

        input.beforePublish?.();
        await fs.promises.rename(temporarySqlitePath, sqlitePath);

        return {
            rootPath,
            sqlitePath,
            registryManifestHash: registryState.manifestHash,
            symbolCount: registryState.registry.symbols.length,
            relationshipCount: relationshipState.status === 'ok' ? relationshipState.records.length : 0,
            relationshipStatus: relationshipState.status,
        };
    } catch (error) {
        try {
            database?.exec('ROLLBACK');
        } catch {
            // Ignore rollback failures from partially initialized temp databases.
        }
        throw error;
    } finally {
        closeDatabase(database);
        await fs.promises.rm(temporarySqlitePath, { force: true }).catch(() => undefined);
    }
}

export class SQLiteNavigationStore implements NavigationStore {
    public async getManifest(input: NavigationStoreInput): Promise<NavigationRegistryState> {
        return readExistingRegistryState(input, resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath));
    }

    public async getSymbolsByFile(input: NavigationSymbolsByFileInput): Promise<NavigationSymbolsByFileResult> {
        const registryState = await this.getManifest(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbols: registryState.registry.symbolsByFile.get(normalizeRelativeFilePath(input.file)) || [],
        };
    }

    public async getSymbolByInstanceId(input: NavigationSymbolByInstanceIdInput): Promise<NavigationSymbolByInstanceIdResult> {
        const registryState = await this.getManifest(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbol: registryState.registry.symbolsByInstanceId.get(input.symbolInstanceId) || null,
        };
    }

    public async getSymbolCandidatesByKey(input: NavigationSymbolCandidatesByKeyInput): Promise<NavigationSymbolCandidatesByKeyResult> {
        const registryState = await this.getManifest(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbols: registryState.registry.symbolsByKey.get(input.symbolKey) || [],
        };
    }

    public async findOwnerForSpan(input: NavigationOwnerForSpanInput): Promise<NavigationOwnerForSpanResult> {
        const registryState = await this.getManifest(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        const symbols = registryState.registry.symbolsByFile.get(normalizeRelativeFilePath(input.file)) || [];
        if (symbols.length === 0) {
            return {
                ...registryState,
                owner: null,
            };
        }

        try {
            const owner = resolveOwnerSymbolForChunk({
                chunk: {
                    content: '',
                    metadata: {
                        startLine: input.span.startLine,
                        endLine: input.span.endLine,
                        ...(input.span.startByte !== undefined ? { startByte: input.span.startByte } : {}),
                        ...(input.span.endByte !== undefined ? { endByte: input.span.endByte } : {}),
                        ...(input.span.startColumn !== undefined ? { startColumn: input.span.startColumn } : {}),
                        ...(input.span.endColumn !== undefined ? { endColumn: input.span.endColumn } : {}),
                        filePath: normalizeRelativeFilePath(input.file),
                    },
                },
                symbols,
            });
            return {
                ...registryState,
                owner,
            };
        } catch {
            return {
                ...registryState,
                owner: null,
            };
        }
    }

    public async getRelationships(input: NavigationRelationshipsQueryInput): Promise<NavigationRelationshipsState> {
        return readRelationshipStateFromSqlite(input, resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath));
    }

    public async getCompatibilityState(input: NavigationCompatibilityInput): Promise<NavigationCompatibilityState> {
        const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
        const registry = await this.getManifest(input);
        const expectedManifestHash = input.expectedSymbolRegistryManifestHash
            || (registry.status === 'ok' ? registry.manifestHash : undefined);

        if (!expectedManifestHash) {
            return {
                rootPath,
                registry,
                relationships: {
                    status: 'not_checked',
                    rootPath,
                    reason: 'symbol registry is unavailable; relationship compatibility was not checked',
                },
            };
        }

        const relationships = await this.getRelationships({
            normalizedRootPath: input.normalizedRootPath,
            stateRoot: input.stateRoot,
            expectedSymbolRegistryManifestHash: expectedManifestHash,
        });

        return {
            rootPath,
            registry,
            relationships,
        };
    }
}

export interface ValidateNavigationStoreParityInput extends NavigationStoreInput {
    referenceStore?: NavigationStore;
    candidateStore?: NavigationStore;
}

export interface ValidateNavigationStoreParityResult {
    ok: boolean;
    mismatches: string[];
}

function sameFailure(left: Exclude<NavigationRegistryState, SqliteRegistryPayload>, right: Exclude<NavigationRegistryState, SqliteRegistryPayload>): boolean {
    return left.status === right.status && left.reason === right.reason;
}

export async function validateNavigationStoreParity(input: ValidateNavigationStoreParityInput): Promise<ValidateNavigationStoreParityResult> {
    const referenceStore = input.referenceStore || new JsonNavigationStore();
    const candidateStore = input.candidateStore || new SQLiteNavigationStore();
    const mismatches: string[] = [];

    const referenceRegistry = await referenceStore.getManifest(input);
    const candidateRegistry = await candidateStore.getManifest(input);
    if (referenceRegistry.status !== candidateRegistry.status) {
        mismatches.push(`registry_status:${referenceRegistry.status}:${candidateRegistry.status}`);
        return { ok: false, mismatches };
    }
    if (referenceRegistry.status !== 'ok' || candidateRegistry.status !== 'ok') {
        if (!sameFailure(referenceRegistry as Exclude<NavigationRegistryState, SqliteRegistryPayload>, candidateRegistry as Exclude<NavigationRegistryState, SqliteRegistryPayload>)) {
            mismatches.push('registry_failure_mismatch');
        }
        return { ok: mismatches.length === 0, mismatches };
    }

    if (referenceRegistry.manifestHash !== candidateRegistry.manifestHash) {
        mismatches.push('registry_manifest_hash');
    }
    if (serializeForParity([...referenceRegistry.registry.manifest.files].sort(compareManifestFiles)) !== serializeForParity([...candidateRegistry.registry.manifest.files].sort(compareManifestFiles))) {
        mismatches.push('registry_manifest_files');
    }

    const manifestFiles = [...referenceRegistry.registry.manifest.files].sort(compareManifestFiles);
    for (const file of manifestFiles) {
        const referenceByFile = await referenceStore.getSymbolsByFile({ ...input, file: file.path });
        const candidateByFile = await candidateStore.getSymbolsByFile({ ...input, file: file.path });
        if (referenceByFile.status !== 'ok' || candidateByFile.status !== 'ok') {
            mismatches.push(`symbols_by_file_status:${file.path}`);
            continue;
        }
        const referenceKeys = referenceByFile.symbols.map(symbolRecordKey);
        const candidateKeys = candidateByFile.symbols.map(symbolRecordKey);
        if (serializeForParity(referenceKeys) !== serializeForParity(candidateKeys)) {
            mismatches.push(`symbols_by_file:${file.path}`);
        }
    }

    for (const symbol of [...referenceRegistry.registry.symbols].sort(compareSymbols)) {
        const referenceByInstance = await referenceStore.getSymbolByInstanceId({ ...input, symbolInstanceId: symbol.symbolInstanceId });
        const candidateByInstance = await candidateStore.getSymbolByInstanceId({ ...input, symbolInstanceId: symbol.symbolInstanceId });
        if (referenceByInstance.status !== 'ok' || candidateByInstance.status !== 'ok') {
            mismatches.push(`symbol_by_instance_status:${symbol.symbolInstanceId}`);
        } else if (
            symbolRecordKey(referenceByInstance.symbol || null) !== symbolRecordKey(candidateByInstance.symbol || null)
        ) {
            mismatches.push(`symbol_by_instance:${symbol.symbolInstanceId}`);
        }

        const referenceCandidates = await referenceStore.getSymbolCandidatesByKey({ ...input, symbolKey: symbol.symbolKey });
        const candidateCandidates = await candidateStore.getSymbolCandidatesByKey({ ...input, symbolKey: symbol.symbolKey });
        if (referenceCandidates.status !== 'ok' || candidateCandidates.status !== 'ok') {
            mismatches.push(`symbol_candidates_status:${symbol.symbolKey}`);
        } else {
            const referenceCandidateKeys = [...referenceCandidates.symbols].sort(compareSymbols).map(symbolRecordKey);
            const candidateCandidateKeys = [...candidateCandidates.symbols].sort(compareSymbols).map(symbolRecordKey);
            if (serializeForParity(referenceCandidateKeys) !== serializeForParity(candidateCandidateKeys)) {
                mismatches.push(`symbol_candidates:${symbol.symbolKey}`);
            }
        }

        const referenceOwner = await referenceStore.findOwnerForSpan({ ...input, file: symbol.file, span: symbol.span });
        const candidateOwner = await candidateStore.findOwnerForSpan({ ...input, file: symbol.file, span: symbol.span });
        if (referenceOwner.status !== 'ok' || candidateOwner.status !== 'ok') {
            mismatches.push(`owner_for_span_status:${symbol.symbolInstanceId}`);
        } else if ((referenceOwner.owner?.symbolInstanceId || null) !== (candidateOwner.owner?.symbolInstanceId || null)) {
            mismatches.push(`owner_for_span:${symbol.symbolInstanceId}`);
        }
    }

    const referenceRelationships = await referenceStore.getRelationships({
        ...input,
        expectedSymbolRegistryManifestHash: referenceRegistry.manifestHash,
    });
    const candidateRelationships = await candidateStore.getRelationships({
        ...input,
        expectedSymbolRegistryManifestHash: referenceRegistry.manifestHash,
    });
    if (referenceRelationships.status !== candidateRelationships.status) {
        mismatches.push(`relationship_status:${referenceRelationships.status}:${candidateRelationships.status}`);
    } else if (referenceRelationships.status === 'ok' && candidateRelationships.status === 'ok') {
        const referenceKeys = [...referenceRelationships.records].sort(compareRelationshipRecords).map(relationshipRecordKey);
        const candidateKeys = [...candidateRelationships.records].sort(compareRelationshipRecords).map(relationshipRecordKey);
        if (serializeForParity(referenceKeys) !== serializeForParity(candidateKeys)) {
            mismatches.push('relationship_records');
        }
        if (serializeForParity(referenceRelationships.warnings) !== serializeForParity(candidateRelationships.warnings)) {
            mismatches.push('relationship_warnings');
        }
    } else if (referenceRelationships.status !== 'ok' && candidateRelationships.status !== 'ok' && referenceRelationships.reason !== candidateRelationships.reason) {
        mismatches.push('relationship_reason');
    }

    return {
        ok: mismatches.length === 0,
        mismatches,
    };
}
