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
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseSnapshotV3,
    CallGraphSidecarInfo,
    FingerprintSource,
    IndexFingerprint,
} from "../config.js";

type AccessGateReason = 'legacy_unverified_fingerprint' | 'fingerprint_mismatch' | 'missing_fingerprint';
type MergeClass = 'searchable' | 'terminal_bad' | 'active';

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
    return typeof value === "object" && value !== null;
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
    return a.embeddingProvider === b.embeddingProvider
        && a.embeddingModel === b.embeddingModel
        && a.embeddingDimension === b.embeddingDimension
        && a.vectorStoreProvider === b.vectorStoreProvider
        && a.schemaVersion === b.schemaVersion;
}

function fingerprintSummary(fp: IndexFingerprint): string {
    return `${fp.embeddingProvider}/${fp.embeddingModel}/${fp.embeddingDimension}/${fp.vectorStoreProvider}/${fp.schemaVersion}`;
}

export interface AccessGateResult {
    allowed: boolean;
    changed: boolean;
    reason?: AccessGateReason;
    message?: string;
}

export class SnapshotManager {
    private static readonly SNAPSHOT_LOCK_WAIT_MS = 2000;
    private static readonly SNAPSHOT_LOCK_RETRY_MS = 25;
    private static readonly SNAPSHOT_LOCK_STALE_MS = 30_000;
    private static readonly INDEXING_STALE_MS = 10 * 60_000;
    private snapshotFilePath: string;
    private indexedCodebases: string[] = [];
    private indexingCodebases: Map<string, number> = new Map();
    private codebaseFileCount: Map<string, number> = new Map();
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map();
    private pendingRemovals: Set<string> = new Set();
    private isDirty = false;
    private runtimeFingerprint: IndexFingerprint;

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
    }

    private markDirty(): void {
        this.isDirty = true;
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

    private parseTimestampMs(value: unknown): number {
        if (typeof value !== "string") {
            return Number.NaN;
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : Number.NaN;
    }

    private pickPreferredInfo(localInfo: CodebaseInfo, diskInfo: CodebaseInfo): CodebaseInfo {
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
                if (localStatus === "indexing" && localIsStaleIndexing && diskStatus !== "indexing") {
                    return diskInfo;
                }
                if (diskStatus === "indexing" && diskIsStaleIndexing && localStatus !== "indexing") {
                    return localInfo;
                }
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
        } catch (error: any) {
            console.warn(`[SNAPSHOT] Atomics.wait unavailable for lock retry; aborting wait path (${error?.message || error}).`);
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
            return true;
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
            } catch (error: any) {
                if (error?.code !== "EEXIST") {
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
            && Number.isFinite(value.embeddingDimension)
            && typeof value.vectorStoreProvider === "string"
            && typeof value.schemaVersion === "string"
        );
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
        if (rawInfo.fingerprintSource !== undefined && rawInfo.fingerprintSource !== "verified" && rawInfo.fingerprintSource !== "assumed_v2") {
            return false;
        }
        switch (status) {
            case "indexing":
                return Number.isFinite(rawInfo.indexingPercentage);
            case "indexed":
                return Number.isFinite(rawInfo.indexedFiles)
                    && Number.isFinite(rawInfo.totalChunks)
                    && (rawInfo.indexStatus === "completed" || rawInfo.indexStatus === "limit_reached");
            case "indexfailed":
                return typeof rawInfo.errorMessage === "string";
            case "sync_completed":
                return Number.isFinite(rawInfo.added)
                    && Number.isFinite(rawInfo.removed)
                    && Number.isFinite(rawInfo.modified)
                    && Number.isFinite(rawInfo.totalChanges);
            case "requires_reindex":
                return typeof rawInfo.message === "string";
            default:
                return false;
        }
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
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }
            const parsed = this.toCodebaseInfo(rawInfo, "v3", codebasePath);
            if (!parsed) {
                continue;
            }
            map.set(codebasePath, parsed);
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
        } catch (error: any) {
            console.warn("[SNAPSHOT] Unable to read persisted snapshot for merge:", error?.message || error);
            return new Map();
        }
    }

    private mergeWithPersistedSnapshot(): Map<string, CodebaseInfo> {
        const merged = this.readCodebaseMapFromDisk();

        for (const removedPath of this.pendingRemovals) {
            merged.delete(removedPath);
        }

        for (const [codebasePath, localInfo] of this.codebaseInfoMap.entries()) {
            const persistedInfo = merged.get(codebasePath);
            if (!persistedInfo) {
                merged.set(codebasePath, localInfo);
                continue;
            }
            merged.set(codebasePath, this.pickPreferredInfo(localInfo, persistedInfo));
        }

        return merged;
    }

    private loadV1Format(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT] Loading v1 format snapshot');
        this.codebaseInfoMap = this.mapFromV1Snapshot(snapshot);
        this.refreshDerivedState();
    }

    private loadV2Format(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT] Loading v2 format snapshot');
        this.codebaseInfoMap = this.mapFromV2Snapshot(snapshot);
        this.refreshDerivedState();
    }

    private loadV3Format(snapshot: CodebaseSnapshotV3): void {
        console.log('[SNAPSHOT] Loading v3 format snapshot');
        this.codebaseInfoMap = this.mapFromV3Snapshot(snapshot);
        this.refreshDerivedState();
    }

    private quarantineCorruptSnapshot(error: unknown): void {
        console.error('[SNAPSHOT] Error loading snapshot:', error);
        if (!fs.existsSync(this.snapshotFilePath)) {
            return;
        }

        let lockHandle: { fd: number; path: string } | null = null;
        const quarantinePath = `${this.snapshotFilePath}.corrupt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
        try {
            lockHandle = this.acquireSnapshotLock();
            if (!lockHandle) {
                try {
                    fs.copyFileSync(this.snapshotFilePath, quarantinePath);
                    console.warn(`[SNAPSHOT] Lock unavailable; copied corrupt snapshot to ${quarantinePath}`);
                } catch (copyError: any) {
                    console.error(`[SNAPSHOT] Failed to preserve corrupt snapshot copy: ${copyError?.message || copyError}`);
                }
                return;
            }
            fs.renameSync(this.snapshotFilePath, quarantinePath);
            console.warn(`[SNAPSHOT] Quarantined corrupt snapshot to ${quarantinePath}`);
        } catch (quarantineError: any) {
            console.error(`[SNAPSHOT] Failed to quarantine corrupt snapshot: ${quarantineError?.message || quarantineError}`);
        } finally {
            if (lockHandle) {
                this.releaseSnapshotLock(lockHandle);
            }
        }
    }

    public loadCodebaseSnapshot(): void {
        console.log('[SNAPSHOT] Loading codebase snapshot from:', this.snapshotFilePath);

        try {
            this.pendingRemovals.clear();
            this.isDirty = false;
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SNAPSHOT] Snapshot file does not exist. Starting with empty codebase list.');
                return;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: unknown = JSON.parse(snapshotData);
            let shouldPersist = false;

            if (this.isV3Format(snapshot)) {
                this.loadV3Format(snapshot);
                const loadedRecord = this.mapToCodebaseRecord(this.codebaseInfoMap);
                const persistedRecord = this.canonicalizeUnknownRecord(snapshot.codebases);
                shouldPersist = !this.codebaseRecordEqualsUnknown(persistedRecord, loadedRecord);
            } else if (this.isV2Format(snapshot)) {
                this.loadV2Format(snapshot);
                shouldPersist = true;
            } else if (this.isV1Format(snapshot)) {
                this.loadV1Format(snapshot);
                shouldPersist = true;
            } else {
                this.quarantineCorruptSnapshot(new Error('Snapshot format is malformed'));
                this.codebaseInfoMap.clear();
                this.refreshDerivedState();
                this.isDirty = false;
                return;
            }

            if (shouldPersist) {
                this.isDirty = true;
                this.saveCodebaseSnapshot(true);
            }
        } catch (error: any) {
            this.quarantineCorruptSnapshot(error);
            this.codebaseInfoMap.clear();
            this.pendingRemovals.clear();
            this.refreshDerivedState();
            this.isDirty = false;
        }
    }

    public saveCodebaseSnapshot(forceWrite = false): void {
        if (!forceWrite && !this.isDirty && this.pendingRemovals.size === 0) {
            return;
        }

        let lockHandle: { fd: number; path: string } | null = null;
        let tempSnapshotPath: string | null = null;
        try {
            const snapshotDir = path.dirname(this.snapshotFilePath);
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }

            lockHandle = this.acquireSnapshotLock();
            if (!lockHandle) {
                console.warn(`[SNAPSHOT] Could not acquire snapshot lock within ${SnapshotManager.SNAPSHOT_LOCK_WAIT_MS}ms. Skipping save to avoid cross-process corruption.`);
                return;
            }

            const mergedCodebaseMap = this.mergeWithPersistedSnapshot();
            const codebases = this.mapToCodebaseRecord(mergedCodebaseMap);

            const snapshot: CodebaseSnapshotV3 = {
                formatVersion: 'v3',
                codebases,
                lastUpdated: new Date().toISOString(),
            };

            tempSnapshotPath = `${this.snapshotFilePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            fs.writeFileSync(tempSnapshotPath, JSON.stringify(snapshot, null, 2));
            fs.renameSync(tempSnapshotPath, this.snapshotFilePath);
            this.codebaseInfoMap = mergedCodebaseMap;
            this.pendingRemovals.clear();
            this.isDirty = false;
            this.refreshDerivedState();

            console.log(`[SNAPSHOT] Snapshot saved in v3 format. Indexed: ${this.indexedCodebases.length}, Indexing: ${this.indexingCodebases.size}, Failed: ${this.getFailedCodebases().length}, RequiresReindex: ${this.getCodebasesRequiringReindex().length}`);
        } catch (error: any) {
            console.error('[SNAPSHOT] Error saving snapshot:', error);
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
        return this.codebaseInfoMap.get(codebasePath);
    }

    public getAllCodebases(): Array<{ path: string; info: CodebaseInfo }> {
        return Array.from(this.codebaseInfoMap.entries()).map(([p, info]) => ({ path: p, info }));
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
        fingerprintSource: FingerprintSource = 'verified'
    ): void {
        this.markCodebasePresent(codebasePath);
        const existing = this.codebaseInfoMap.get(codebasePath);
        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString(),
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
        fingerprintSource: FingerprintSource = 'verified'
    ): void {
        this.markCodebasePresent(codebasePath);
        const totalChanges = stats.added + stats.removed + stats.modified;
        const existing = this.codebaseInfoMap.get(codebasePath);
        const info: CodebaseInfoSyncCompleted = {
            status: 'sync_completed',
            added: stats.added,
            removed: stats.removed,
            modified: stats.modified,
            totalChanges,
            lastUpdated: new Date().toISOString(),
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

    public setCodebaseCallGraphSidecar(codebasePath: string, sidecar: CallGraphSidecarInfo): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        const nextInfo: CodebaseInfo = {
            ...existing,
            callGraphSidecar: sidecar,
            lastUpdated: new Date().toISOString(),
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseCallGraphSidecar");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markDirty();
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
            lastUpdated: new Date().toISOString(),
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseIndexManifest");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markDirty();
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
            lastUpdated: new Date().toISOString(),
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseIgnoreRulesVersion");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markDirty();
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
            lastUpdated: new Date().toISOString(),
        };
        this.assertMetadataMutationPreservesDerivedFields(existing, nextInfo, "setCodebaseIgnoreControlSignature");
        this.codebaseInfoMap.set(codebasePath, nextInfo);
        this.markDirty();
    }

    public getCodebaseCallGraphSidecar(codebasePath: string): CallGraphSidecarInfo | undefined {
        return this.codebaseInfoMap.get(codebasePath)?.callGraphSidecar;
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

    public ensureFingerprintCompatibilityOnAccess(codebasePath: string): AccessGateResult {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (!info) {
            return { allowed: true, changed: false };
        }

        if (info.status === 'requires_reindex') {
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
            this.setCodebaseRequiresReindex(codebasePath, 'legacy_unverified_fingerprint', message);
            return {
                allowed: false,
                changed: true,
                reason: 'legacy_unverified_fingerprint',
                message
            };
        }

        if (!info.indexFingerprint) {
            const message = 'This index has no fingerprint metadata and cannot be validated against the current runtime. Rebuild is required.';
            this.setCodebaseRequiresReindex(codebasePath, 'missing_fingerprint', message);
            return {
                allowed: false,
                changed: true,
                reason: 'missing_fingerprint',
                message
            };
        }

        if (!fingerprintsEqual(info.indexFingerprint, this.runtimeFingerprint)) {
            const message =
                `Index fingerprint mismatch. Indexed with ${fingerprintSummary(info.indexFingerprint)}, ` +
                `current runtime is ${fingerprintSummary(this.runtimeFingerprint)}.`;
            this.setCodebaseRequiresReindex(codebasePath, 'fingerprint_mismatch', message);
            return {
                allowed: false,
                changed: true,
                reason: 'fingerprint_mismatch',
                message
            };
        }

        return { allowed: true, changed: false };
    }
}
