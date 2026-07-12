import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    CodebaseInfo,
    CodebaseInfoIndexFailed,
    CodebaseInfoIndexed,
    CodebaseInfoIndexing,
    CodebaseInfoRequiresReindex,
    CodebaseInfoSyncCompleted,
    CodebaseClearTombstone,
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseSnapshotV3,
    CallGraphSidecarInfo,
    FingerprintSource,
    IndexFingerprint,
    IndexOperationReceipt,
    IndexOperationPhase,
    indexFingerprintsEqual,
    resolveMcpPackageVersion,
    summarizeIndexFingerprint,
} from "../config.js";
import type { RootMutationLease } from "./mutation-lease.js";

export type AccessGateReason = 'legacy_unverified_fingerprint' | 'fingerprint_mismatch' | 'missing_fingerprint' | 'navigation_recovery_failed';
export interface SnapshotCorruptionWarning {
    snapshotPath: string;
    quarantinedPath?: string;
    message: string;
}
type MergeClass = 'searchable' | 'terminal_bad' | 'active';
type SnapshotMetadataField =
    | 'callGraphSidecar'
    | 'indexManifest'
    | 'ignoreRulesVersion'
    | 'ignoreControlSignature';

const OPERATION_PHASE_RANK: Record<IndexOperationPhase, number> = {
    accepted: 0,
    preflight: 1,
    scanning: 2,
    writing: 3,
    proving: 4,
    publishing: 5,
    completed: 6,
    failed: 6,
    blocked: 6,
};

function isTerminalOperationPhase(phase: IndexOperationPhase): boolean {
    return phase === "completed" || phase === "failed" || phase === "blocked";
}

function isSearchableStatus(status: CodebaseInfo['status']): boolean {
    return status === 'indexed' || status === 'sync_completed';
}

function mergeClassForStatus(status: CodebaseInfo["status"]): MergeClass {
    if (status === "indexing") {
        return "active";
    }
    if (status === "indexfailed" || status === "requires_reindex") {
        return "terminal_bad";
    }
    return "searchable";
}

function mergeClassRank(value: MergeClass): number {
    if (value === "active") {
        return 3;
    }
    if (value === "terminal_bad") {
        return 2;
    }
    return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isValidPercentage(value: unknown): value is number {
    return typeof value === "number"
        && Number.isFinite(value)
        && value >= 0
        && value <= 100;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
    if (!isRecord(error)) {
        return undefined;
    }
    return typeof error.code === "string" ? error.code : undefined;
}

function stableSerialize(value: unknown): string {
    return JSON.stringify(value, (_key, nestedValue) => {
        if (Array.isArray(nestedValue)) {
            return nestedValue;
        }
        if (nestedValue && typeof nestedValue === "object") {
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(nestedValue).sort()) {
                sorted[key] = (nestedValue as Record<string, unknown>)[key];
            }
            return sorted;
        }
        return nestedValue;
    });
}

function fingerprintsEqual(a: IndexFingerprint, b: IndexFingerprint): boolean {
    return indexFingerprintsEqual(a, b);
}

function fingerprintSummary(fp: IndexFingerprint): string {
    return summarizeIndexFingerprint(fp);
}

export interface AccessGateResult {
    allowed: boolean;
    changed: boolean;
    reason?: AccessGateReason;
    message?: string;
}

export interface AccessGateOptions {
    mutate?: boolean;
}

export class SnapshotManager {
    private static readonly SNAPSHOT_LOCK_WAIT_MS = 2000;
    private static readonly SNAPSHOT_LOCK_RETRY_MS = 25;
    private static readonly SNAPSHOT_LOCK_STALE_MS = 30_000;
    private static readonly SNAPSHOT_LOCK_METADATALESS_STALE_MS = 5 * 60_000;
    private static readonly INDEXING_STALE_MS = 10 * 60_000;
    private snapshotFilePath: string;
    private indexedCodebases: string[] = [];
    private indexingCodebases: Map<string, number> = new Map();
    private codebaseFileCount: Map<string, number> = new Map();
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map();
    private clearTombstones: Map<string, CodebaseClearTombstone> = new Map();
    private latestOperations: Map<string, IndexOperationReceipt> = new Map();
    private pendingRemovals: Set<string> = new Set();
    private pendingTombstoneRemovals: Set<string> = new Set();
    private pendingLifecycleRoots: Set<string> = new Set();
    private pendingMetadataFields: Map<string, Set<SnapshotMetadataField>> = new Map();
    private isDirty = false;
    private lastLoadedSnapshotStateToken: string | null = null;
    private snapshotCorruptionWarning: SnapshotCorruptionWarning | undefined;
    private runtimeFingerprint: IndexFingerprint;

    private captureMutableState(): {
        codebaseInfoMap: Map<string, CodebaseInfo>;
        clearTombstones: Map<string, CodebaseClearTombstone>;
        latestOperations: Map<string, IndexOperationReceipt>;
        pendingRemovals: Set<string>;
        pendingTombstoneRemovals: Set<string>;
        pendingLifecycleRoots: Set<string>;
        pendingMetadataFields: Map<string, Set<SnapshotMetadataField>>;
        isDirty: boolean;
    } {
        return {
            codebaseInfoMap: structuredClone(this.codebaseInfoMap),
            clearTombstones: structuredClone(this.clearTombstones),
            latestOperations: structuredClone(this.latestOperations),
            pendingRemovals: new Set(this.pendingRemovals),
            pendingTombstoneRemovals: new Set(this.pendingTombstoneRemovals),
            pendingLifecycleRoots: new Set(this.pendingLifecycleRoots),
            pendingMetadataFields: new Map(
                Array.from(this.pendingMetadataFields.entries(), ([root, fields]) => [root, new Set(fields)]),
            ),
            isDirty: this.isDirty,
        };
    }

    private restoreMutableState(checkpoint: ReturnType<SnapshotManager["captureMutableState"]>): void {
        this.codebaseInfoMap = checkpoint.codebaseInfoMap;
        this.clearTombstones = checkpoint.clearTombstones;
        this.latestOperations = checkpoint.latestOperations;
        this.pendingRemovals = checkpoint.pendingRemovals;
        this.pendingTombstoneRemovals = checkpoint.pendingTombstoneRemovals;
        this.pendingLifecycleRoots = checkpoint.pendingLifecycleRoots;
        this.pendingMetadataFields = checkpoint.pendingMetadataFields;
        this.isDirty = checkpoint.isDirty;
        this.refreshDerivedState();
    }

    constructor(runtimeFingerprint: IndexFingerprint) {
        this.runtimeFingerprint = runtimeFingerprint;
        this.snapshotFilePath = path.join(os.homedir(), '.satori', 'mcp-codebase-snapshot.json');
    }

    public setRuntimeFingerprint(fingerprint: IndexFingerprint): void {
        this.runtimeFingerprint = fingerprint;
    }

    private isV2Format(snapshot: unknown): snapshot is CodebaseSnapshotV2 {
        return isRecord(snapshot)
            && snapshot.formatVersion === 'v2'
            && isRecord(snapshot.codebases);
    }

    private isV3Format(snapshot: unknown): snapshot is CodebaseSnapshotV3 {
        return isRecord(snapshot)
            && snapshot.formatVersion === 'v3'
            && isRecord(snapshot.codebases);
    }

    private isV1Format(snapshot: unknown): snapshot is CodebaseSnapshotV1 {
        return isRecord(snapshot)
            && Array.isArray(snapshot.indexedCodebases)
            && (snapshot.lastUpdated === undefined || typeof snapshot.lastUpdated === "string")
            && (snapshot.indexingCodebases === undefined || Array.isArray(snapshot.indexingCodebases) || isRecord(snapshot.indexingCodebases));
    }

    private refreshDerivedState(): void {
        this.indexedCodebases = [];
        this.indexingCodebases = new Map();
        this.codebaseFileCount = new Map();

        for (const [codebasePath, info] of this.codebaseInfoMap.entries()) {
            if (info.status === 'indexing') {
                this.indexingCodebases.set(codebasePath, info.indexingPercentage || 0);
                continue;
            }

            if (isSearchableStatus(info.status)) {
                this.indexedCodebases.push(codebasePath);
                if (info.status === "indexed") {
                    this.codebaseFileCount.set(codebasePath, info.indexedFiles);
                }
            }
        }
        this.indexedCodebases.sort((a, b) => a.localeCompare(b));
    }

    private toAssumedFingerprintInfo(info: CodebaseInfo): CodebaseInfo {
        if (!isSearchableStatus(info.status)) {
            return info;
        }

        return {
            ...info,
            indexFingerprint: info.indexFingerprint || this.runtimeFingerprint,
            fingerprintSource: info.fingerprintSource || 'assumed_v2',
        };
    }

    private markCodebasePresent(codebasePath: string): void {
        this.pendingRemovals.delete(codebasePath);
        this.clearTombstones.delete(codebasePath);
        this.pendingTombstoneRemovals.add(codebasePath);
        this.pendingLifecycleRoots.add(codebasePath);
    }

    private markDirty(): void {
        this.isDirty = true;
    }

    private markMetadataDirty(codebasePath: string, field: SnapshotMetadataField): void {
        const fields = this.pendingMetadataFields.get(codebasePath) ?? new Set<SnapshotMetadataField>();
        fields.add(field);
        this.pendingMetadataFields.set(codebasePath, fields);
        this.markDirty();
    }

    private assertMetadataMutationPreservesDerivedFields(previous: CodebaseInfo, next: CodebaseInfo, operation: string): void {
        if (previous.status !== next.status) {
            throw new Error(`[SNAPSHOT] ${operation} cannot modify status.`);
        }
        if (previous.status === "indexing" && next.status === "indexing" && previous.indexingPercentage !== next.indexingPercentage) {
            throw new Error(`[SNAPSHOT] ${operation} cannot modify indexingPercentage.`);
        }
        if (previous.status === "indexed" && next.status === "indexed" && previous.indexedFiles !== next.indexedFiles) {
            throw new Error(`[SNAPSHOT] ${operation} cannot modify indexedFiles.`);
        }
    }

    private snapshotLockPath(): string {
        return `${this.snapshotFilePath}.lock`;
    }

    private readSnapshotStateToken(): string | null {
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return null;
            }
            const stats = fs.statSync(this.snapshotFilePath, { bigint: true });
            return [
                stats.dev.toString(),
                stats.ino.toString(),
                stats.size.toString(),
                stats.mtimeNs.toString(),
                stats.ctimeNs.toString()
            ].join(":");
        } catch {
            return null;
        }
    }

    private rememberCurrentSnapshotStateToken(): void {
        this.lastLoadedSnapshotStateToken = this.readSnapshotStateToken();
    }

    private parseTimestampMs(value: unknown): number {
        if (typeof value !== "string") {
            return Number.NaN;
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : Number.NaN;
    }

    private pickPreferredInfo(
        localInfo: CodebaseInfo,
        diskInfo: CodebaseInfo,
        localOperation?: IndexOperationReceipt,
        diskOperation?: IndexOperationReceipt,
    ): CodebaseInfo {
        const localGeneration = localOperation?.generation ?? -1;
        const diskGeneration = diskOperation?.generation ?? -1;
        if (localGeneration !== diskGeneration) {
            return localGeneration > diskGeneration ? localInfo : diskInfo;
        }

        if (localOperation && diskOperation) {
            if (localOperation.id !== diskOperation.id) {
                throw new Error(
                    `Conflicting operation ids at generation ${localGeneration} for '${localOperation.canonicalRoot}'.`,
                );
            }
            const localPhaseRank = OPERATION_PHASE_RANK[localOperation.phase];
            const diskPhaseRank = OPERATION_PHASE_RANK[diskOperation.phase];
            if (localPhaseRank !== diskPhaseRank) {
                return localPhaseRank > diskPhaseRank ? localInfo : diskInfo;
            }
        }

        const localStatus = localInfo.status;
        const diskStatus = diskInfo.status;
        const localClass = mergeClassForStatus(localStatus);
        const diskClass = mergeClassForStatus(diskStatus);

        const localMs = this.parseTimestampMs(localInfo.lastUpdated);
        const diskMs = this.parseTimestampMs(diskInfo.lastUpdated);

        const isStaleIndexingRecord = (status: CodebaseInfo["status"], timestampMs: number): boolean => {
            if (status !== "indexing") {
                return false;
            }
            if (!Number.isFinite(timestampMs)) {
                return true;
            }
            return (Date.now() - timestampMs) > SnapshotManager.INDEXING_STALE_MS;
        };

        const localIsStaleIndexing = isStaleIndexingRecord(localStatus, localMs);
        const diskIsStaleIndexing = isStaleIndexingRecord(diskStatus, diskMs);

        if (localClass !== diskClass) {
            if (localStatus === "indexing" || diskStatus === "indexing") {
                // If one side already transitioned out of indexing and is newer, keep that transition.
                if (localStatus !== "indexing"
                    && diskStatus === "indexing"
                    && Number.isFinite(localMs)
                    && Number.isFinite(diskMs)
                    && localMs > diskMs) {
                    return localInfo;
                }
                if (diskStatus !== "indexing"
                    && localStatus === "indexing"
                    && Number.isFinite(localMs)
                    && Number.isFinite(diskMs)
                    && diskMs > localMs) {
                    return diskInfo;
                }

                if (localStatus === "indexing" && localIsStaleIndexing && diskStatus !== "indexing") {
                    return diskInfo;
                }
                if (diskStatus === "indexing" && diskIsStaleIndexing && localStatus !== "indexing") {
                    return localInfo;
                }
            }
            if (localStatus !== "indexing"
                && diskStatus !== "indexing"
                && Number.isFinite(localMs)
                && Number.isFinite(diskMs)) {
                return diskMs > localMs ? diskInfo : localInfo;
            }
            return mergeClassRank(localClass) > mergeClassRank(diskClass) ? localInfo : diskInfo;
        }

        if (localStatus === "indexing" && diskStatus === "indexing") {
            if (localIsStaleIndexing !== diskIsStaleIndexing) {
                return localIsStaleIndexing ? diskInfo : localInfo;
            }
            if (localInfo.indexingPercentage !== diskInfo.indexingPercentage) {
                return localInfo.indexingPercentage > diskInfo.indexingPercentage ? localInfo : diskInfo;
            }
        }

        if (Number.isFinite(localMs) && Number.isFinite(diskMs)) {
            return diskMs > localMs ? diskInfo : localInfo;
        }
        if (Number.isFinite(diskMs) && !Number.isFinite(localMs)) {
            return diskInfo;
        }
        return localInfo;
    }

    private sleepSync(ms: number): boolean {
        if (!Number.isFinite(ms) || ms <= 0) {
            return true;
        }
        try {
            const waitBuffer = new SharedArrayBuffer(4);
            const waitArray = new Int32Array(waitBuffer);
            Atomics.wait(waitArray, 0, 0, ms);
            return true;
        } catch (error) {
            console.warn(`[SNAPSHOT] Atomics.wait unavailable for lock retry; aborting wait path (${errorMessage(error)}).`);
            return false;
        }
    }

    private isSnapshotLockStale(lockPath: string): boolean {
        try {
            const stats = fs.statSync(lockPath);
            const ageMs = Date.now() - stats.mtimeMs;
            return ageMs >= SnapshotManager.SNAPSHOT_LOCK_STALE_MS;
        } catch {
            return false;
        }
    }

    private isSnapshotLockMetadataLessStale(lockPath: string): boolean {
        try {
            const stats = fs.statSync(lockPath);
            const ageMs = Date.now() - stats.mtimeMs;
            return ageMs >= SnapshotManager.SNAPSHOT_LOCK_METADATALESS_STALE_MS;
        } catch {
            return false;
        }
    }

    private readLockMetadata(lockPath: string): { pid?: number } | null {
        try {
            const raw = fs.readFileSync(lockPath, "utf8");
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed)) {
                return null;
            }
            return {
                pid: typeof parsed.pid === "number" ? parsed.pid : undefined
            };
        } catch {
            return null;
        }
    }

    private isPidAlive(pid: number): boolean {
        if (!Number.isFinite(pid) || pid <= 0) {
            return false;
        }
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private shouldBreakStaleLock(lockPath: string): boolean {
        if (!this.isSnapshotLockStale(lockPath)) {
            return false;
        }
        const metadata = this.readLockMetadata(lockPath);
        if (!metadata || metadata.pid === undefined) {
            return this.isSnapshotLockMetadataLessStale(lockPath);
        }
        return !this.isPidAlive(metadata.pid);
    }

    private acquireSnapshotLock(): { fd: number; path: string } | null {
        const lockPath = this.snapshotLockPath();
        const deadline = Date.now() + SnapshotManager.SNAPSHOT_LOCK_WAIT_MS;

        while (Date.now() <= deadline) {
            try {
                const fd = fs.openSync(lockPath, "wx");
                const metadata = {
                    pid: process.pid,
                    acquiredAt: new Date().toISOString(),
                };
                fs.writeFileSync(fd, JSON.stringify(metadata));
                return { fd, path: lockPath };
            } catch (error) {
                if (errorCode(error) !== "EEXIST") {
                    throw error;
                }

                if (this.shouldBreakStaleLock(lockPath)) {
                    try {
                        fs.unlinkSync(lockPath);
                    } catch {
                        // Lock owner might still be active; retry.
                    }
                    const waitedAfterBreak = this.sleepSync(SnapshotManager.SNAPSHOT_LOCK_RETRY_MS);
                    if (!waitedAfterBreak) {
                        return null;
                    }
                    continue;
                }

                const waited = this.sleepSync(SnapshotManager.SNAPSHOT_LOCK_RETRY_MS);
                if (!waited) {
                    return null;
                }
            }
        }

        return null;
    }

    private releaseSnapshotLock(lockHandle: { fd: number; path: string }): void {
        try {
            fs.closeSync(lockHandle.fd);
        } catch {
            // Best-effort close.
        }
        try {
            fs.unlinkSync(lockHandle.path);
        } catch {
            // Best-effort cleanup.
        }
    }

    private isValidIndexFingerprint(value: unknown): value is IndexFingerprint {
        if (!isRecord(value)) {
            return false;
        }
        return (
            typeof value.embeddingProvider === "string"
            && typeof value.embeddingModel === "string"
            && Number.isSafeInteger(value.embeddingDimension)
            && Number(value.embeddingDimension) > 0
            && typeof value.vectorStoreProvider === "string"
            && typeof value.schemaVersion === "string"
            && (value.parserVersion === undefined || typeof value.parserVersion === "string")
            && (value.extractorVersion === undefined || typeof value.extractorVersion === "string")
            && (value.relationshipVersion === undefined || typeof value.relationshipVersion === "string")
        );
    }

    private isValidOperationReceipt(value: unknown, codebasePath: string): value is IndexOperationReceipt {
        if (!isRecord(value) || !isRecord(value.writer)) {
            return false;
        }
        const actions = ["create", "reindex", "sync", "repair", "clear"];
        const phases = ["accepted", "preflight", "scanning", "writing", "proving", "publishing", "completed", "failed", "blocked"];
        return typeof value.id === "string"
            && value.id.length > 0
            && actions.includes(String(value.action))
            && value.canonicalRoot === codebasePath
            && Number.isSafeInteger(value.generation)
            && Number(value.generation) > 0
            && typeof value.acceptedAt === "string"
            && !Number.isNaN(Date.parse(value.acceptedAt))
            && phases.includes(String(value.phase))
            && typeof value.lastDurableTransitionAt === "string"
            && !Number.isNaN(Date.parse(value.lastDurableTransitionAt))
            && Date.parse(value.lastDurableTransitionAt) >= Date.parse(value.acceptedAt)
            && this.isValidIndexFingerprint(value.runtimeFingerprint)
            && typeof value.writer.ownerId === "string"
            && value.writer.ownerId.length > 0
            && Number.isSafeInteger(value.writer.pid)
            && Number(value.writer.pid) > 0
            && typeof value.writer.satoriVersion === "string"
            && value.writer.satoriVersion.length > 0;
    }

    private isValidCodebaseInfoShape(rawInfo: unknown): rawInfo is CodebaseInfo {
        if (!isRecord(rawInfo)) {
            return false;
        }
        if (typeof rawInfo.status !== "string" || typeof rawInfo.lastUpdated !== "string") {
            return false;
        }
        const status = rawInfo.status as CodebaseInfo["status"];
        if (!["indexing", "indexed", "indexfailed", "sync_completed", "requires_reindex"].includes(status)) {
            return false;
        }
        if (rawInfo.indexFingerprint !== undefined && !this.isValidIndexFingerprint(rawInfo.indexFingerprint)) {
            return false;
        }
        if (rawInfo.collectionName !== undefined && typeof rawInfo.collectionName !== "string") {
            return false;
        }
        if (rawInfo.fingerprintSource !== undefined && rawInfo.fingerprintSource !== "verified" && rawInfo.fingerprintSource !== "assumed_v2") {
            return false;
        }
        switch (status) {
            case "indexing":
                return isValidPercentage(rawInfo.indexingPercentage);
            case "indexed":
                return isNonnegativeSafeInteger(rawInfo.indexedFiles)
                    && isNonnegativeSafeInteger(rawInfo.totalChunks)
                    && (rawInfo.indexStatus === "completed" || rawInfo.indexStatus === "limit_reached");
            case "indexfailed":
                return typeof rawInfo.errorMessage === "string";
            case "sync_completed":
                return isNonnegativeSafeInteger(rawInfo.added)
                    && isNonnegativeSafeInteger(rawInfo.removed)
                    && isNonnegativeSafeInteger(rawInfo.modified)
                    && isNonnegativeSafeInteger(rawInfo.totalChanges);
            case "requires_reindex":
                return typeof rawInfo.message === "string";
            default:
                return false;
        }
    }

    private isValidClearTombstoneShape(value: unknown): value is CodebaseClearTombstone {
        return isRecord(value)
            && typeof value.clearedAt === "string"
            && !Number.isNaN(Date.parse(value.clearedAt))
            && (value.collectionName === undefined || typeof value.collectionName === "string");
    }

    private toCodebaseInfo(rawInfo: unknown, sourceLabel: string, codebasePath: string): CodebaseInfo | null {
        if (!this.isValidCodebaseInfoShape(rawInfo)) {
            console.warn(`[SNAPSHOT] Skipping malformed ${sourceLabel} entry for '${codebasePath}'`);
            return null;
        }
        return rawInfo;
    }

    private mapFromV1Snapshot(snapshot: CodebaseSnapshotV1): Map<string, CodebaseInfo> {
        const map = new Map<string, CodebaseInfo>();
        const now = new Date().toISOString();

        for (const codebasePath of snapshot.indexedCodebases || []) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }
            map.set(codebasePath, {
                status: "indexed",
                indexedFiles: 0,
                totalChunks: 0,
                indexStatus: "completed",
                lastUpdated: now,
                indexFingerprint: this.runtimeFingerprint,
                fingerprintSource: "assumed_v2",
            });
        }

        return map;
    }

    private mapFromV2Snapshot(snapshot: CodebaseSnapshotV2): Map<string, CodebaseInfo> {
        const map = new Map<string, CodebaseInfo>();
        for (const [codebasePath, rawInfo] of Object.entries(snapshot.codebases || {})) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }
            const parsed = this.toCodebaseInfo(rawInfo, "v2", codebasePath);
            if (!parsed) {
                continue;
            }
            map.set(codebasePath, this.toAssumedFingerprintInfo(parsed));
        }
        return map;
    }

    private mapFromV3Snapshot(snapshot: CodebaseSnapshotV3): Map<string, CodebaseInfo> {
        const map = new Map<string, CodebaseInfo>();
        for (const [codebasePath, rawInfo] of Object.entries(snapshot.codebases || {})) {
            const parsed = this.toCodebaseInfo(rawInfo, "v3", codebasePath);
            if (!parsed) {
                continue;
            }
            map.set(codebasePath, parsed);
        }
        return map;
    }

    private tombstoneMapFromV3Snapshot(snapshot: CodebaseSnapshotV3): Map<string, CodebaseClearTombstone> {
        const map = new Map<string, CodebaseClearTombstone>();
        if (!isRecord(snapshot.clearTombstones)) {
            return map;
        }
        for (const [codebasePath, rawTombstone] of Object.entries(snapshot.clearTombstones)) {
            if (!this.isValidClearTombstoneShape(rawTombstone)) {
                console.warn(`[SNAPSHOT] Skipping malformed clear tombstone for '${codebasePath}'`);
                continue;
            }
            map.set(codebasePath, rawTombstone);
        }
        return map;
    }

    private operationMapFromV3Snapshot(snapshot: CodebaseSnapshotV3): Map<string, IndexOperationReceipt> {
        const map = new Map<string, IndexOperationReceipt>();
        if (snapshot.latestOperations === undefined) {
            return map;
        }
        if (!isRecord(snapshot.latestOperations)) {
            throw new Error("Snapshot latestOperations must be an object.");
        }
        for (const [codebasePath, rawReceipt] of Object.entries(snapshot.latestOperations)) {
            if (!this.isValidOperationReceipt(rawReceipt, codebasePath)) {
                throw new Error(`Snapshot latest operation is malformed for '${codebasePath}'.`);
            }
            map.set(codebasePath, rawReceipt);
        }
        return map;
    }

    private mapToCodebaseRecord(map: Map<string, CodebaseInfo>): Record<string, CodebaseInfo> {
        const entries = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
        const codebases: Record<string, CodebaseInfo> = {};
        for (const [codebasePath, info] of entries) {
            codebases[codebasePath] = info;
        }
        return codebases;
    }

    private mapToTombstoneRecord(map: Map<string, CodebaseClearTombstone>): Record<string, CodebaseClearTombstone> | undefined {
        if (map.size === 0) {
            return undefined;
        }
        const entries = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
        const tombstones: Record<string, CodebaseClearTombstone> = {};
        for (const [codebasePath, tombstone] of entries) {
            tombstones[codebasePath] = tombstone;
        }
        return tombstones;
    }

    private mapToOperationRecord(map: Map<string, IndexOperationReceipt>): Record<string, IndexOperationReceipt> | undefined {
        if (map.size === 0) {
            return undefined;
        }
        const operations: Record<string, IndexOperationReceipt> = {};
        for (const [codebasePath, receipt] of Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))) {
            operations[codebasePath] = receipt;
        }
        return operations;
    }

    private codebaseRecordsEqual(left: Record<string, CodebaseInfo>, right: Record<string, CodebaseInfo>): boolean {
        return stableSerialize(left) === stableSerialize(right);
    }

    private codebaseRecordEqualsUnknown(left: unknown, right: Record<string, CodebaseInfo>): boolean {
        return stableSerialize(left) === stableSerialize(right);
    }

    private canonicalizeUnknownRecord(record: unknown): Record<string, unknown> {
        if (!isRecord(record)) {
            return {};
        }
        return JSON.parse(stableSerialize(record)) as Record<string, unknown>;
    }

    private readCodebaseMapFromDisk(): Map<string, CodebaseInfo> {
        if (!fs.existsSync(this.snapshotFilePath)) {
            return new Map();
        }

        try {
            const snapshotData = fs.readFileSync(this.snapshotFilePath, "utf8");
            const snapshot: unknown = JSON.parse(snapshotData);

            if (this.isV3Format(snapshot)) {
                return this.mapFromV3Snapshot(snapshot);
            }
            if (this.isV2Format(snapshot)) {
                return this.mapFromV2Snapshot(snapshot);
            }
            if (this.isV1Format(snapshot)) {
                return this.mapFromV1Snapshot(snapshot);
            }
            console.warn("[SNAPSHOT] Persisted snapshot format is malformed; merge will proceed from local in-memory state only.");
            return new Map();
        } catch (error) {
            console.warn("[SNAPSHOT] Unable to read persisted snapshot for merge:", errorMessage(error));
            return new Map();
        }
    }

    private readTombstoneMapFromDisk(): Map<string, CodebaseClearTombstone> {
        if (!fs.existsSync(this.snapshotFilePath)) {
            return new Map();
        }

        try {
            const snapshotData = fs.readFileSync(this.snapshotFilePath, "utf8");
            const snapshot: unknown = JSON.parse(snapshotData);
            if (this.isV3Format(snapshot)) {
                return this.tombstoneMapFromV3Snapshot(snapshot);
            }
        } catch (error) {
            console.warn("[SNAPSHOT] Unable to read persisted clear tombstones for merge:", errorMessage(error));
        }
        return new Map();
    }

    private readOperationMapFromDisk(): Map<string, IndexOperationReceipt> {
        if (!fs.existsSync(this.snapshotFilePath)) {
            return new Map();
        }
        const snapshot: unknown = JSON.parse(fs.readFileSync(this.snapshotFilePath, "utf8"));
        return this.isV3Format(snapshot) ? this.operationMapFromV3Snapshot(snapshot) : new Map();
    }

    private compareOperationAuthority(
        local: IndexOperationReceipt | undefined,
        disk: IndexOperationReceipt | undefined,
    ): number {
        const localGeneration = local?.generation ?? 0;
        const diskGeneration = disk?.generation ?? 0;
        if (localGeneration !== diskGeneration) {
            return localGeneration - diskGeneration;
        }
        if (local && disk && local.id !== disk.id) {
            throw new Error(`Conflicting operation ids at generation ${localGeneration} for '${local.canonicalRoot}'.`);
        }
        return 0;
    }

    private mergeWithPersistedSnapshot(
        persistedOperations: Map<string, IndexOperationReceipt>,
    ): Map<string, CodebaseInfo> {
        const merged = this.readCodebaseMapFromDisk();

        for (const removedPath of this.pendingRemovals) {
            if (this.compareOperationAuthority(
                this.latestOperations.get(removedPath),
                persistedOperations.get(removedPath),
            ) >= 0) {
                merged.delete(removedPath);
            }
        }

        for (const [codebasePath, localInfo] of this.codebaseInfoMap.entries()) {
            const persistedInfo = merged.get(codebasePath);
            if (!persistedInfo) {
                if (this.pendingLifecycleRoots.has(codebasePath)) {
                    merged.set(codebasePath, localInfo);
                }
                continue;
            }
            const lifecycleBase = this.pendingLifecycleRoots.has(codebasePath)
                ? this.pickPreferredInfo(
                    localInfo,
                    persistedInfo,
                    this.latestOperations.get(codebasePath),
                    persistedOperations.get(codebasePath),
                )
                : persistedInfo;
            merged.set(
                codebasePath,
                this.overlayPendingMetadata(codebasePath, lifecycleBase, localInfo),
            );
        }

        return merged;
    }

    private overlayPendingMetadata(
        codebasePath: string,
        lifecycleBase: CodebaseInfo,
        localInfo: CodebaseInfo,
    ): CodebaseInfo {
        const fields = this.pendingMetadataFields.get(codebasePath);
        if (!fields || fields.size === 0) {
            return lifecycleBase;
        }

        const merged: CodebaseInfo = { ...lifecycleBase };
        const localRecord = localInfo as unknown as Record<string, unknown>;
        const lifecycleRecord = lifecycleBase as unknown as Record<string, unknown>;
        const sameIndexGeneration = localInfo.status === lifecycleBase.status
            && localInfo.collectionName === lifecycleBase.collectionName
            && localRecord.indexStatus === lifecycleRecord.indexStatus
            && localRecord.indexedFiles === lifecycleRecord.indexedFiles
            && localRecord.totalChunks === lifecycleRecord.totalChunks
            && localInfo.indexFingerprint !== undefined
            && lifecycleBase.indexFingerprint !== undefined
            && indexFingerprintsEqual(localInfo.indexFingerprint, lifecycleBase.indexFingerprint);
        if (sameIndexGeneration && fields.has('callGraphSidecar')) {
            merged.callGraphSidecar = localInfo.callGraphSidecar
                ? structuredClone(localInfo.callGraphSidecar)
                : undefined;
        }
        if (sameIndexGeneration && fields.has('indexManifest')) {
            merged.indexManifest = localInfo.indexManifest
                ? structuredClone(localInfo.indexManifest)
                : undefined;
        }
        if (fields.has('ignoreRulesVersion')) {
            merged.ignoreRulesVersion = localInfo.ignoreRulesVersion;
        }
        if (fields.has('ignoreControlSignature')) {
            merged.ignoreControlSignature = localInfo.ignoreControlSignature;
        }
        return merged;
    }

    private pickPreferredOperation(local: IndexOperationReceipt, disk: IndexOperationReceipt): IndexOperationReceipt {
        if (local.generation === disk.generation && local.id !== disk.id) {
            throw new Error(`Conflicting operation ids at generation ${local.generation} for '${local.canonicalRoot}'.`);
        }
        if (local.generation !== disk.generation) {
            return local.generation > disk.generation ? local : disk;
        }
        if (isTerminalOperationPhase(local.phase) && isTerminalOperationPhase(disk.phase) && local.phase !== disk.phase) {
            throw new Error(`Conflicting terminal phases for operation '${local.id}' at generation ${local.generation}.`);
        }
        if (OPERATION_PHASE_RANK[local.phase] !== OPERATION_PHASE_RANK[disk.phase]) {
            return OPERATION_PHASE_RANK[local.phase] > OPERATION_PHASE_RANK[disk.phase] ? local : disk;
        }
        const localMs = this.parseTimestampMs(local.lastDurableTransitionAt);
        const diskMs = this.parseTimestampMs(disk.lastDurableTransitionAt);
        if (localMs !== diskMs) {
            return localMs > diskMs ? local : disk;
        }
        return stableSerialize(local) >= stableSerialize(disk) ? local : disk;
    }

    private mergeOperationsWithPersistedSnapshot(
        persisted: Map<string, IndexOperationReceipt>,
    ): Map<string, IndexOperationReceipt> {
        const merged = new Map(persisted);
        for (const [codebasePath, local] of this.latestOperations.entries()) {
            const disk = merged.get(codebasePath);
            merged.set(codebasePath, disk ? this.pickPreferredOperation(local, disk) : local);
        }
        return merged;
    }

    private mergeTombstonesWithPersistedSnapshot(
        persistedOperations: Map<string, IndexOperationReceipt>,
    ): Map<string, CodebaseClearTombstone> {
        const merged = this.readTombstoneMapFromDisk();

        for (const removedPath of this.pendingTombstoneRemovals) {
            if (this.compareOperationAuthority(
                this.latestOperations.get(removedPath),
                persistedOperations.get(removedPath),
            ) >= 0) {
                merged.delete(removedPath);
            }
        }

        for (const [codebasePath, tombstone] of this.clearTombstones.entries()) {
            merged.set(codebasePath, tombstone);
        }

        return merged;
    }

    private reconcileMergedLifecycleState(
        codebases: Map<string, CodebaseInfo>,
        tombstones: Map<string, CodebaseClearTombstone>,
        persistedOperations: Map<string, IndexOperationReceipt>,
    ): void {
        for (const codebasePath of codebases.keys()) {
            const tombstone = tombstones.get(codebasePath);
            if (!tombstone) {
                continue;
            }
            const authority = this.compareOperationAuthority(
                this.latestOperations.get(codebasePath),
                persistedOperations.get(codebasePath),
            );
            if (this.pendingRemovals.has(codebasePath)) {
                if (authority >= 0) {
                    codebases.delete(codebasePath);
                } else {
                    tombstones.delete(codebasePath);
                }
                continue;
            }
            if (this.pendingTombstoneRemovals.has(codebasePath)) {
                if (authority >= 0) {
                    tombstones.delete(codebasePath);
                } else {
                    codebases.delete(codebasePath);
                }
                continue;
            }
            const infoTimestamp = this.parseTimestampMs(codebases.get(codebasePath)?.lastUpdated);
            const clearTimestamp = this.parseTimestampMs(tombstone.clearedAt);
            if (clearTimestamp >= infoTimestamp) {
                codebases.delete(codebasePath);
            } else {
                tombstones.delete(codebasePath);
            }
        }
    }

    private loadV1Format(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT] Loading v1 format snapshot');
        this.codebaseInfoMap = this.mapFromV1Snapshot(snapshot);
        this.clearTombstones.clear();
        this.latestOperations.clear();
        this.refreshDerivedState();
    }

    private loadV2Format(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT] Loading v2 format snapshot');
        this.codebaseInfoMap = this.mapFromV2Snapshot(snapshot);
        this.clearTombstones.clear();
        this.latestOperations.clear();
        this.refreshDerivedState();
    }

    private loadV3Format(snapshot: CodebaseSnapshotV3): void {
        console.log('[SNAPSHOT] Loading v3 format snapshot');
        const codebaseInfoMap = this.mapFromV3Snapshot(snapshot);
        const clearTombstones = this.tombstoneMapFromV3Snapshot(snapshot);
        const latestOperations = this.operationMapFromV3Snapshot(snapshot);
        this.codebaseInfoMap = codebaseInfoMap;
        this.clearTombstones = clearTombstones;
        this.latestOperations = latestOperations;
        this.refreshDerivedState();
    }

    private findLatestQuarantinedSnapshotPath(): string | undefined {
        const snapshotDir = path.dirname(this.snapshotFilePath);
        if (!fs.existsSync(snapshotDir)) {
            return undefined;
        }
        const prefix = `${path.basename(this.snapshotFilePath)}.corrupt-`;
        const candidates = fs.readdirSync(snapshotDir)
            .filter((name) => name.startsWith(prefix))
            .sort();
        const latest = candidates[candidates.length - 1];
        return latest ? path.join(snapshotDir, latest) : undefined;
    }

    private quarantineCorruptSnapshot(
        error: unknown,
        failedSnapshotStateToken: string | null,
    ): { warning: SnapshotCorruptionWarning; replacementChanged: boolean } {
        console.error('[SNAPSHOT] Error loading snapshot:', error);
        const message = errorMessage(error);
        let quarantinedPath = this.findLatestQuarantinedSnapshotPath();
        if (!fs.existsSync(this.snapshotFilePath)) {
            return {
                warning: { snapshotPath: this.snapshotFilePath, quarantinedPath, message },
                replacementChanged: failedSnapshotStateToken !== null,
            };
        }

        let lockHandle: { fd: number; path: string } | null = null;
        const quarantinePath = `${this.snapshotFilePath}.corrupt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
        try {
            lockHandle = this.acquireSnapshotLock();
            if (!lockHandle) {
                return {
                    warning: { snapshotPath: this.snapshotFilePath, quarantinedPath, message },
                    replacementChanged: this.readSnapshotStateToken() !== failedSnapshotStateToken,
                };
            }
            if (
                failedSnapshotStateToken === null
                || this.readSnapshotStateToken() !== failedSnapshotStateToken
            ) {
                return {
                    warning: { snapshotPath: this.snapshotFilePath, quarantinedPath, message },
                    replacementChanged: true,
                };
            }
            fs.renameSync(this.snapshotFilePath, quarantinePath);
            quarantinedPath = quarantinePath;
            console.warn(`[SNAPSHOT] Quarantined corrupt snapshot to ${quarantinePath}`);
        } catch (quarantineError) {
            console.error(`[SNAPSHOT] Failed to quarantine corrupt snapshot: ${errorMessage(quarantineError)}`);
        } finally {
            if (lockHandle) {
                this.releaseSnapshotLock(lockHandle);
            }
        }
        return {
            warning: { snapshotPath: this.snapshotFilePath, quarantinedPath, message },
            replacementChanged: false,
        };
    }

    public loadCodebaseSnapshot(): void {
        this.loadCodebaseSnapshotAttempt(true);
    }

    private loadCodebaseSnapshotAttempt(allowReplacementRetry: boolean): void {
        console.log('[SNAPSHOT] Loading codebase snapshot from:', this.snapshotFilePath);
        const hadRuntimeState = this.codebaseInfoMap.size > 0 || this.clearTombstones.size > 0 || this.latestOperations.size > 0;
        let failedSnapshotStateToken: string | null = null;

        try {
            this.pendingRemovals.clear();
            this.pendingTombstoneRemovals.clear();
            this.pendingLifecycleRoots.clear();
            this.pendingMetadataFields.clear();
            this.isDirty = false;
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SNAPSHOT] Snapshot file does not exist. Starting with empty codebase list.');
                const quarantinedPath = this.findLatestQuarantinedSnapshotPath();
                this.snapshotCorruptionWarning = quarantinedPath
                    ? {
                        snapshotPath: this.snapshotFilePath,
                        quarantinedPath,
                        message: "Snapshot file is missing after a previous corrupt snapshot quarantine.",
                    }
                    : undefined;
                this.codebaseInfoMap.clear();
                this.clearTombstones.clear();
                this.latestOperations.clear();
                this.refreshDerivedState();
                this.lastLoadedSnapshotStateToken = null;
                return;
            }

            failedSnapshotStateToken = this.readSnapshotStateToken();
            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: unknown = JSON.parse(snapshotData);
            let shouldPersist = false;

            if (this.isV3Format(snapshot)) {
                this.snapshotCorruptionWarning = undefined;
                this.loadV3Format(snapshot);
                const loadedRecord = this.mapToCodebaseRecord(this.codebaseInfoMap);
                const persistedRecord = this.canonicalizeUnknownRecord(snapshot.codebases);
                shouldPersist = !this.codebaseRecordEqualsUnknown(persistedRecord, loadedRecord);
            } else if (this.isV2Format(snapshot)) {
                this.snapshotCorruptionWarning = undefined;
                this.loadV2Format(snapshot);
                shouldPersist = true;
            } else if (this.isV1Format(snapshot)) {
                this.snapshotCorruptionWarning = undefined;
                this.loadV1Format(snapshot);
                shouldPersist = true;
            } else {
                const quarantine = this.quarantineCorruptSnapshot(
                    new Error('Snapshot format is malformed'),
                    failedSnapshotStateToken,
                );
                if (quarantine.replacementChanged && allowReplacementRetry) {
                    this.loadCodebaseSnapshotAttempt(false);
                    return;
                }
                this.snapshotCorruptionWarning = quarantine.warning;
                if (!hadRuntimeState) {
                    this.codebaseInfoMap.clear();
                    this.clearTombstones.clear();
                    this.latestOperations.clear();
                }
                this.refreshDerivedState();
                this.isDirty = hadRuntimeState;
                if (hadRuntimeState && !quarantine.replacementChanged) {
                    this.pendingLifecycleRoots = new Set(this.codebaseInfoMap.keys());
                }
                return;
            }

            if (shouldPersist) {
                this.isDirty = true;
                this.saveCodebaseSnapshot(true);
            } else {
                this.rememberCurrentSnapshotStateToken();
            }
        } catch (error) {
            const quarantine = this.quarantineCorruptSnapshot(error, failedSnapshotStateToken);
            if (quarantine.replacementChanged && allowReplacementRetry) {
                this.loadCodebaseSnapshotAttempt(false);
                return;
            }
            this.snapshotCorruptionWarning = quarantine.warning;
            if (!hadRuntimeState) {
                this.codebaseInfoMap.clear();
                this.clearTombstones.clear();
                this.latestOperations.clear();
            }
            this.pendingRemovals.clear();
            this.pendingTombstoneRemovals.clear();
            this.pendingMetadataFields.clear();
            this.refreshDerivedState();
            this.isDirty = hadRuntimeState;
            if (hadRuntimeState && !quarantine.replacementChanged) {
                this.pendingLifecycleRoots = new Set(this.codebaseInfoMap.keys());
            } else {
                this.pendingLifecycleRoots.clear();
            }
            this.lastLoadedSnapshotStateToken = this.readSnapshotStateToken();
        }
    }

    public saveCodebaseSnapshot(forceWrite = false, beforeCommit?: () => void): boolean {
        if (!forceWrite && !this.isDirty && this.pendingRemovals.size === 0 && this.pendingTombstoneRemovals.size === 0) {
            beforeCommit?.();
            return true;
        }

        let lockHandle: { fd: number; path: string } | null = null;
        let tempSnapshotPath: string | null = null;
        let commitGuardError: unknown;
        let commitGuardFailed = false;
        try {
            const snapshotDir = path.dirname(this.snapshotFilePath);
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }

            lockHandle = this.acquireSnapshotLock();
            if (!lockHandle) {
                console.warn(`[SNAPSHOT] Could not acquire snapshot lock within ${SnapshotManager.SNAPSHOT_LOCK_WAIT_MS}ms. Skipping save to avoid cross-process corruption.`);
                return false;
            }

            const persistedOperations = this.readOperationMapFromDisk();
            const mergedCodebaseMap = this.mergeWithPersistedSnapshot(persistedOperations);
            const mergedTombstones = this.mergeTombstonesWithPersistedSnapshot(persistedOperations);
            const mergedOperations = this.mergeOperationsWithPersistedSnapshot(persistedOperations);
            this.reconcileMergedLifecycleState(mergedCodebaseMap, mergedTombstones, persistedOperations);
            const codebases = this.mapToCodebaseRecord(mergedCodebaseMap);

            const snapshot: CodebaseSnapshotV3 = {
                formatVersion: 'v3',
                codebases,
                clearTombstones: this.mapToTombstoneRecord(mergedTombstones),
                latestOperations: this.mapToOperationRecord(mergedOperations),
                lastUpdated: new Date().toISOString(),
            };

            tempSnapshotPath = `${this.snapshotFilePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            fs.writeFileSync(tempSnapshotPath, JSON.stringify(snapshot, null, 2));
            try {
                beforeCommit?.();
            } catch (error) {
                commitGuardFailed = true;
                commitGuardError = error;
                throw error;
            }
            fs.renameSync(tempSnapshotPath, this.snapshotFilePath);
            this.codebaseInfoMap = mergedCodebaseMap;
            this.clearTombstones = mergedTombstones;
            this.latestOperations = mergedOperations;
            this.pendingRemovals.clear();
            this.pendingTombstoneRemovals.clear();
            this.pendingLifecycleRoots.clear();
            this.pendingMetadataFields.clear();
            this.isDirty = false;
            this.refreshDerivedState();
            this.rememberCurrentSnapshotStateToken();

            console.log(`[SNAPSHOT] Snapshot saved in v3 format. Indexed: ${this.indexedCodebases.length}, Indexing: ${this.indexingCodebases.size}, Failed: ${this.getFailedCodebases().length}, RequiresReindex: ${this.getCodebasesRequiringReindex().length}`);
            return true;
        } catch (error) {
            if (commitGuardFailed) {
                throw commitGuardError;
            }
            console.error('[SNAPSHOT] Error saving snapshot:', error);
            return false;
        } finally {
            if (tempSnapshotPath && fs.existsSync(tempSnapshotPath)) {
                try {
                    fs.unlinkSync(tempSnapshotPath);
                } catch {
                    // Best-effort cleanup.
                }
            }
            if (lockHandle) {
                this.releaseSnapshotLock(lockHandle);
            }
        }
    }

    public refreshFromDiskIfChanged(): boolean {
        if (this.isDirty || this.pendingRemovals.size > 0 || this.pendingTombstoneRemovals.size > 0) {
            return false;
        }

        const currentStateToken = this.readSnapshotStateToken();
        if (currentStateToken === this.lastLoadedSnapshotStateToken) {
            return false;
        }

        try {
            const snapshot: unknown = JSON.parse(fs.readFileSync(this.snapshotFilePath, 'utf8'));
            if (!this.isV3Format(snapshot)) {
                throw new Error('Read-time snapshot refresh requires current v3 format.');
            }
            this.loadV3Format(snapshot);
            this.snapshotCorruptionWarning = undefined;
            this.rememberCurrentSnapshotStateToken();
            return true;
        } catch (error) {
            this.snapshotCorruptionWarning = {
                snapshotPath: this.snapshotFilePath,
                message: errorMessage(error),
            };
            this.lastLoadedSnapshotStateToken = currentStateToken;
            return false;
        }
    }

    public getIndexedCodebases(): string[] {
        return [...this.indexedCodebases];
    }

    public getIndexingCodebases(): string[] {
        return Array.from(this.indexingCodebases.keys());
    }

    public getIndexingCodebasesWithProgress(): Map<string, number> {
        return new Map(this.indexingCodebases);
    }

    public getIndexingProgress(codebasePath: string): number | undefined {
        return this.indexingCodebases.get(codebasePath);
    }

    public getCodebaseStatus(codebasePath: string): CodebaseInfo['status'] | 'not_found' {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (!info) return 'not_found';
        return info.status;
    }

    public getCodebaseInfo(codebasePath: string): CodebaseInfo | undefined {
        const info = this.codebaseInfoMap.get(codebasePath);
        return info ? structuredClone(info) : undefined;
    }

    public getLatestOperation(codebasePath: string): IndexOperationReceipt | undefined {
        const receipt = this.latestOperations.get(codebasePath);
        return receipt ? structuredClone(receipt) : undefined;
    }

    public setLatestOperation(codebasePath: string, receipt: IndexOperationReceipt): void {
        if (!this.isValidOperationReceipt(receipt, codebasePath)) {
            throw new Error(`Invalid operation receipt for '${codebasePath}'.`);
        }
        const existing = this.latestOperations.get(codebasePath);
        const preferred = existing ? this.pickPreferredOperation(receipt, existing) : receipt;
        if (preferred !== existing) {
            this.latestOperations.set(codebasePath, structuredClone(preferred));
            this.markDirty();
        }
    }

    public startOperation(lease: RootMutationLease): IndexOperationReceipt {
        const receipt: IndexOperationReceipt = {
            id: lease.operationId,
            action: lease.action,
            canonicalRoot: lease.canonicalRoot,
            generation: lease.generation,
            acceptedAt: lease.acquiredAt,
            phase: "accepted",
            lastDurableTransitionAt: lease.acquiredAt,
            runtimeFingerprint: this.runtimeFingerprint,
            writer: {
                ownerId: lease.ownerId,
                pid: lease.pid,
                satoriVersion: resolveMcpPackageVersion(),
            },
        };
        this.setLatestOperation(lease.canonicalRoot, receipt);
        return receipt;
    }

    public transitionOperation(lease: RootMutationLease, phase: IndexOperationPhase): IndexOperationReceipt {
        const current = this.latestOperations.get(lease.canonicalRoot);
        if (!current || current.id !== lease.operationId || current.generation !== lease.generation) {
            throw new Error(`Operation receipt is no longer current for '${lease.canonicalRoot}'.`);
        }
        if (phase === current.phase) {
            return structuredClone(current);
        }
        if (isTerminalOperationPhase(current.phase)) {
            throw new Error(`Operation '${current.id}' is already terminal with phase '${current.phase}'.`);
        }
        if (!isTerminalOperationPhase(phase) && OPERATION_PHASE_RANK[phase] < OPERATION_PHASE_RANK[current.phase]) {
            throw new Error(`Operation '${current.id}' cannot regress from '${current.phase}' to '${phase}'.`);
        }
        const next: IndexOperationReceipt = {
            ...current,
            phase,
            lastDurableTransitionAt: new Date().toISOString(),
        };
        this.setLatestOperation(lease.canonicalRoot, next);
        return next;
    }

    private requireDurableOperation(
        lease: RootMutationLease,
        phase: IndexOperationPhase,
    ): IndexOperationReceipt {
        const current = this.latestOperations.get(lease.canonicalRoot);
        if (
            !current
            || current.id !== lease.operationId
            || current.generation !== lease.generation
            || current.phase !== phase
        ) {
            throw new Error(
                `Operation '${lease.operationId}' phase '${phase}' did not become durable for '${lease.canonicalRoot}'.`,
            );
        }
        return structuredClone(current);
    }

    public commitOperationPhase(
        lease: RootMutationLease,
        phase: IndexOperationPhase,
        mutateSnapshot?: () => void,
        assertCurrent?: () => void,
    ): IndexOperationReceipt {
        const checkpoint = this.captureMutableState();
        let saveSucceeded = false;
        try {
            assertCurrent?.();
            if (phase === "accepted") {
                this.startOperation(lease);
            } else {
                this.transitionOperation(lease, phase);
            }
            this.requireDurableOperation(lease, phase);
            mutateSnapshot?.();
            if (!this.saveCodebaseSnapshot(false, assertCurrent)) {
                throw new Error(`Failed to persist operation phase '${phase}' for '${lease.canonicalRoot}'.`);
            }
            saveSucceeded = true;
            return this.requireDurableOperation(lease, phase);
        } catch (error) {
            if (!saveSucceeded) {
                this.restoreMutableState(checkpoint);
            }
            throw error;
        }
    }

    /**
     * Persist a lifecycle-only mutation transactionally under an optional fence.
     * Rejected publication must not remain in memory for a later unrelated save.
     */
    public commitCodebaseLifecycleMutation(
        mutateSnapshot: () => void,
        beforeCommit?: () => void,
    ): boolean {
        const checkpoint = this.captureMutableState();
        try {
            beforeCommit?.();
            mutateSnapshot();
            if (!this.saveCodebaseSnapshot(false, beforeCommit)) {
                this.restoreMutableState(checkpoint);
                return false;
            }
            return true;
        } catch (error) {
            this.restoreMutableState(checkpoint);
            throw error;
        }
    }

    public getCodebaseCollectionName(codebasePath: string): string | undefined {
        const collectionName = this.codebaseInfoMap.get(codebasePath)?.collectionName;
        return typeof collectionName === "string" && collectionName.trim().length > 0
            ? collectionName.trim()
            : undefined;
    }

    public getAllCodebases(): Array<{ path: string; info: CodebaseInfo }> {
        return Array.from(this.codebaseInfoMap.entries()).map(([p, info]) => ({
            path: p,
            info: structuredClone(info),
        }));
    }

    public getSnapshotCorruptionWarning(): SnapshotCorruptionWarning | undefined {
        return this.snapshotCorruptionWarning
            ? { ...this.snapshotCorruptionWarning }
            : undefined;
    }

    public markCodebaseCleared(codebasePath: string, collectionName?: string): void {
        this.removeCodebaseCompletely(codebasePath);
        this.clearTombstones.set(codebasePath, {
            clearedAt: new Date().toISOString(),
            collectionName,
        });
        this.pendingTombstoneRemovals.delete(codebasePath);
        this.markDirty();
    }

    public isCodebaseCleared(codebasePath: string, collectionName?: string): boolean {
        const tombstone = this.clearTombstones.get(codebasePath);
        if (!tombstone) {
            return false;
        }
        if (collectionName === undefined || tombstone.collectionName === undefined) {
            return true;
        }
        return tombstone.collectionName === collectionName;
    }

    public getFailedCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexfailed')
            .map(([codebasePath]) => codebasePath);
    }

    public getCodebasesRequiringReindex(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'requires_reindex')
            .map(([codebasePath]) => codebasePath);
    }

    public setCodebaseIndexing(codebasePath: string, progress: number = 0): void {
        this.markCodebasePresent(codebasePath);
        const existing = this.codebaseInfoMap.get(codebasePath);
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString(),
            indexFingerprint: existing?.indexFingerprint,
            fingerprintSource: existing?.fingerprintSource,
            reindexReason: existing?.reindexReason,
            collectionName: existing?.collectionName,
            callGraphSidecar: existing?.callGraphSidecar,
            indexManifest: existing?.indexManifest,
            ignoreRulesVersion: existing?.ignoreRulesVersion,
            ignoreControlSignature: existing?.ignoreControlSignature,
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.markDirty();
        this.refreshDerivedState();
    }

    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' },
        indexFingerprint?: IndexFingerprint,
        fingerprintSource: FingerprintSource = 'verified',
        collectionName?: string
    ): void {
        this.markCodebasePresent(codebasePath);
        const existing = this.codebaseInfoMap.get(codebasePath);
        const resolvedCollectionName = typeof collectionName === "string" && collectionName.trim().length > 0
            ? collectionName.trim()
            : existing?.collectionName;
        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString(),
            collectionName: resolvedCollectionName,
            indexFingerprint: indexFingerprint || this.runtimeFingerprint,
            fingerprintSource,
            callGraphSidecar: existing?.callGraphSidecar,
            indexManifest: existing?.indexManifest,
            ignoreRulesVersion: existing?.ignoreRulesVersion,
            ignoreControlSignature: existing?.ignoreControlSignature,
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.markDirty();
        this.refreshDerivedState();
    }

    public setCodebaseIndexFailed(codebasePath: string, errorMessage: string, lastAttemptedPercentage?: number): void {
        this.markCodebasePresent(codebasePath);
        const existing = this.codebaseInfoMap.get(codebasePath);
        const info: CodebaseInfoIndexFailed = {
            status: 'indexfailed',
            errorMessage,
            lastAttemptedPercentage,
            lastUpdated: new Date().toISOString(),
            collectionName: existing?.collectionName,
            indexFingerprint: existing?.indexFingerprint,
            fingerprintSource: existing?.fingerprintSource,
            callGraphSidecar: existing?.callGraphSidecar,
            indexManifest: existing?.indexManifest,
            ignoreRulesVersion: existing?.ignoreRulesVersion,
            ignoreControlSignature: existing?.ignoreControlSignature,
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.markDirty();
        this.refreshDerivedState();
    }

    public setCodebaseSyncCompleted(
        codebasePath: string,
        stats: { added: number; removed: number; modified: number },
        indexFingerprint?: IndexFingerprint,
        fingerprintSource: FingerprintSource = 'verified',
        collectionName?: string
    ): void {
        this.markCodebasePresent(codebasePath);
        const totalChanges = stats.added + stats.removed + stats.modified;
        const existing = this.codebaseInfoMap.get(codebasePath);
        const resolvedCollectionName = typeof collectionName === "string" && collectionName.trim().length > 0
            ? collectionName.trim()
            : existing?.collectionName;
        const info: CodebaseInfoSyncCompleted = {
            status: 'sync_completed',
            added: stats.added,
            removed: stats.removed,
            modified: stats.modified,
            totalChanges,
            lastUpdated: new Date().toISOString(),
            collectionName: resolvedCollectionName,
            indexFingerprint: indexFingerprint || existing?.indexFingerprint || this.runtimeFingerprint,
            fingerprintSource,
            callGraphSidecar: existing?.callGraphSidecar,
            indexManifest: existing?.indexManifest,
            ignoreRulesVersion: existing?.ignoreRulesVersion,
            ignoreControlSignature: existing?.ignoreControlSignature,
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.markDirty();
        this.refreshDerivedState();
    }

    public setCodebaseRequiresReindex(
        codebasePath: string,
        reason: AccessGateReason,
        message?: string
    ): void {
        this.markCodebasePresent(codebasePath);
        const existing = this.codebaseInfoMap.get(codebasePath);
        const info: CodebaseInfoRequiresReindex = {
            status: 'requires_reindex',
            message: message || 'Index is incompatible with the current runtime fingerprint and must be rebuilt.',
            reindexReason: reason,
            lastUpdated: new Date().toISOString(),
            collectionName: existing?.collectionName,
            indexFingerprint: existing?.indexFingerprint,
            fingerprintSource: existing?.fingerprintSource,
            callGraphSidecar: existing?.callGraphSidecar,
            indexManifest: existing?.indexManifest,
            ignoreRulesVersion: existing?.ignoreRulesVersion,
            ignoreControlSignature: existing?.ignoreControlSignature,
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.markDirty();
        this.refreshDerivedState();
    }

    private recoverCodebaseFromResolvedFingerprintMismatch(codebasePath: string, info: CodebaseInfoRequiresReindex): void {
        const recovered: CodebaseInfoSyncCompleted = {
            status: 'sync_completed',
            added: 0,
            removed: 0,
            modified: 0,
            totalChanges: 0,
            lastUpdated: new Date().toISOString(),
            collectionName: info.collectionName,
            indexFingerprint: info.indexFingerprint,
            fingerprintSource: info.fingerprintSource,
            callGraphSidecar: info.callGraphSidecar,
            indexManifest: info.indexManifest,
            ignoreRulesVersion: info.ignoreRulesVersion,
            ignoreControlSignature: info.ignoreControlSignature,
        };
        this.codebaseInfoMap.set(codebasePath, recovered);
        this.pendingLifecycleRoots.add(codebasePath);
        this.markDirty();
        this.refreshDerivedState();
    }

    public setCodebaseCallGraphSidecar(codebasePath: string, sidecar: CallGraphSidecarInfo): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        const nextInfo: CodebaseInfo = {
            ...existing,
            callGraphSidecar: sidecar,
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseCallGraphSidecar");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markMetadataDirty(codebasePath, 'callGraphSidecar');
    }

    /**
     * Set call-graph sidecar metadata and persist under an optional mutation fence.
     * On save failure or fence rejection, restores the previous in-memory sidecar.
     */
    public commitCodebaseCallGraphSidecar(
        codebasePath: string,
        sidecar: CallGraphSidecarInfo,
        beforeCommit?: () => void,
    ): boolean {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return false;
        }
        const checkpoint = this.captureMutableState();
        try {
            this.setCodebaseCallGraphSidecar(codebasePath, sidecar);
            const saved = this.saveCodebaseSnapshot(false, beforeCommit);
            if (!saved) {
                this.restoreMutableState(checkpoint);
                return false;
            }
            return true;
        } catch (error) {
            this.restoreMutableState(checkpoint);
            throw error;
        }
    }

    public setCodebaseIndexManifest(codebasePath: string, indexedPaths: string[]): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        const normalized = Array.from(
            new Set(indexedPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        ).sort();

        const nextInfo: CodebaseInfo = {
            ...existing,
            indexManifest: {
                indexedPaths: normalized,
                updatedAt: new Date().toISOString(),
            },
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseIndexManifest");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markMetadataDirty(codebasePath, 'indexManifest');
    }

    public getCodebaseIndexedPaths(codebasePath: string): string[] {
        const manifest = this.codebaseInfoMap.get(codebasePath)?.indexManifest;
        if (!manifest || !Array.isArray(manifest.indexedPaths)) {
            return [];
        }
        return manifest.indexedPaths.slice();
    }

    public setCodebaseIgnoreRulesVersion(codebasePath: string, version: number): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        const nextVersion = Number.isFinite(version) && version >= 0 ? Math.trunc(version) : existing.ignoreRulesVersion;
        const nextInfo: CodebaseInfo = {
            ...existing,
            ignoreRulesVersion: nextVersion,
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseIgnoreRulesVersion");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markMetadataDirty(codebasePath, 'ignoreRulesVersion');
    }

    public getCodebaseIgnoreControlSignature(codebasePath: string): string | undefined {
        return this.codebaseInfoMap.get(codebasePath)?.ignoreControlSignature;
    }

    public setCodebaseIgnoreControlSignature(codebasePath: string, signature: string): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        const nextInfo: CodebaseInfo = {
            ...existing,
            ignoreControlSignature: typeof signature === 'string' ? signature : existing.ignoreControlSignature,
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseIgnoreControlSignature");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markMetadataDirty(codebasePath, 'ignoreControlSignature');
    }

    public getCodebaseCallGraphSidecar(codebasePath: string): CallGraphSidecarInfo | undefined {
        const sidecar = this.codebaseInfoMap.get(codebasePath)?.callGraphSidecar;
        return sidecar ? structuredClone(sidecar) : undefined;
    }

    public removeCodebaseCompletely(codebasePath: string): void {
        this.codebaseInfoMap.delete(codebasePath);
        this.pendingRemovals.add(codebasePath);
        this.markDirty();
        this.refreshDerivedState();
    }

    public removeIndexedCodebase(codebasePath: string): void {
        this.removeCodebaseCompletely(codebasePath);
    }

    public addIndexedCodebase(codebasePath: string, fileCount?: number): void {
        this.setCodebaseIndexed(
            codebasePath,
            {
                indexedFiles: fileCount || 0,
                totalChunks: 0,
                status: 'completed'
            },
            this.runtimeFingerprint,
            'verified'
        );
    }

    public removeIndexingCodebase(codebasePath: string): void {
        this.removeCodebaseCompletely(codebasePath);
    }

    public moveFromIndexingToIndexed(codebasePath: string, fileCount?: number): void {
        this.setCodebaseIndexed(
            codebasePath,
            {
                indexedFiles: fileCount || 0,
                totalChunks: 0,
                status: 'completed'
            },
            this.runtimeFingerprint,
            'verified'
        );
    }

    public getIndexedFileCount(codebasePath: string): number | undefined {
        return this.codebaseFileCount.get(codebasePath);
    }

    public setIndexedFileCount(codebasePath: string, fileCount: number): void {
        this.codebaseFileCount.set(codebasePath, fileCount);
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (existing && existing.status === 'indexed') {
            this.codebaseInfoMap.set(codebasePath, {
                ...existing,
                indexedFiles: fileCount,
                lastUpdated: new Date().toISOString(),
            });
            this.pendingLifecycleRoots.add(codebasePath);
            this.markDirty();
        }
        this.refreshDerivedState();
    }

    public getLastSyncResult(codebasePath: string): { added: number; removed: number; modified: number; totalChanges: number; timestamp: string } | undefined {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (info && info.status === 'sync_completed') {
            return {
                added: info.added,
                removed: info.removed,
                modified: info.modified,
                totalChanges: info.totalChanges,
                timestamp: info.lastUpdated
            };
        }
        return undefined;
    }

    public ensureFingerprintCompatibilityOnAccess(
        codebasePath: string,
        options: AccessGateOptions = {},
    ): AccessGateResult {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (!info) {
            return { allowed: true, changed: false };
        }

        if (info.status === 'requires_reindex') {
            if (
                info.reindexReason === 'fingerprint_mismatch'
                && info.indexFingerprint
                && fingerprintsEqual(info.indexFingerprint, this.runtimeFingerprint)
            ) {
                if (options.mutate === false) {
                    return {
                        allowed: false,
                        changed: false,
                        reason: info.reindexReason,
                        message: info.message,
                    };
                }
                this.recoverCodebaseFromResolvedFingerprintMismatch(codebasePath, info);
                return {
                    allowed: true,
                    changed: true,
                };
            }
            return {
                allowed: false,
                changed: false,
                reason: info.reindexReason,
                message: info.message
            };
        }

        if (!isSearchableStatus(info.status)) {
            return { allowed: true, changed: false };
        }

        if (info.fingerprintSource === 'assumed_v2') {
            const message = 'This index was migrated from a legacy snapshot (v2) without a verifiable fingerprint and must be rebuilt before use.';
            if (options.mutate !== false) {
                this.setCodebaseRequiresReindex(codebasePath, 'legacy_unverified_fingerprint', message);
            }
            return {
                allowed: false,
                changed: options.mutate !== false,
                reason: 'legacy_unverified_fingerprint',
                message
            };
        }

        if (!info.indexFingerprint) {
            const message = 'This index has no fingerprint metadata and cannot be validated against the current runtime. Rebuild is required.';
            if (options.mutate !== false) {
                this.setCodebaseRequiresReindex(codebasePath, 'missing_fingerprint', message);
            }
            return {
                allowed: false,
                changed: options.mutate !== false,
                reason: 'missing_fingerprint',
                message
            };
        }

        if (!fingerprintsEqual(info.indexFingerprint, this.runtimeFingerprint)) {
            const message =
                `Index fingerprint mismatch. Indexed with ${fingerprintSummary(info.indexFingerprint)}, ` +
                `current runtime is ${fingerprintSummary(this.runtimeFingerprint)}.`;
            return {
                allowed: false,
                changed: false,
                reason: 'fingerprint_mismatch',
                message
            };
        }

        return { allowed: true, changed: false };
    }
}
