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
    CodebaseSnapshot,
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseSnapshotV3,
    CallGraphSidecarInfo,
    FingerprintSource,
    IndexFingerprint,
} from "../config.js";

function isSearchableStatus(status: CodebaseInfo['status']): boolean {
    return status === 'indexed' || status === 'sync_completed';
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
    reason?: string;
    message?: string;
}

export class SnapshotManager {
    private snapshotFilePath: string;
    private indexedCodebases: string[] = [];
    private indexingCodebases: Map<string, number> = new Map();
    private codebaseFileCount: Map<string, number> = new Map();
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map();
    private runtimeFingerprint: IndexFingerprint;

    constructor(runtimeFingerprint: IndexFingerprint) {
        this.runtimeFingerprint = runtimeFingerprint;
        this.snapshotFilePath = path.join(os.homedir(), '.satori', 'mcp-codebase-snapshot.json');
    }

    public setRuntimeFingerprint(fingerprint: IndexFingerprint): void {
        this.runtimeFingerprint = fingerprint;
    }

    private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return snapshot && snapshot.formatVersion === 'v2';
    }

    private isV3Format(snapshot: any): snapshot is CodebaseSnapshotV3 {
        return snapshot && snapshot.formatVersion === 'v3';
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
                if ('indexedFiles' in info) {
                    this.codebaseFileCount.set(codebasePath, info.indexedFiles);
                }
            }
        }
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

    private loadV1Format(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT] Loading v1 format snapshot');
        this.codebaseInfoMap.clear();

        const now = new Date().toISOString();

        for (const codebasePath of snapshot.indexedCodebases || []) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }

            const info: CodebaseInfoIndexed = {
                status: 'indexed',
                indexedFiles: 0,
                totalChunks: 0,
                indexStatus: 'completed',
                lastUpdated: now,
                indexFingerprint: this.runtimeFingerprint,
                fingerprintSource: 'assumed_v2',
            };
            this.codebaseInfoMap.set(codebasePath, info);
        }

        // v1 indexing states were interrupted by definition
        this.refreshDerivedState();
    }

    private loadV2Format(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT] Loading v2 format snapshot');
        this.codebaseInfoMap.clear();

        for (const [codebasePath, rawInfo] of Object.entries(snapshot.codebases || {})) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }

            const info: CodebaseInfo = this.toAssumedFingerprintInfo(rawInfo as unknown as CodebaseInfo);
            this.codebaseInfoMap.set(codebasePath, info);
        }

        this.refreshDerivedState();
    }

    private loadV3Format(snapshot: CodebaseSnapshotV3): void {
        console.log('[SNAPSHOT] Loading v3 format snapshot');
        this.codebaseInfoMap.clear();

        for (const [codebasePath, info] of Object.entries(snapshot.codebases || {})) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT] Codebase no longer exists, removing: ${codebasePath}`);
                continue;
            }

            this.codebaseInfoMap.set(codebasePath, info);
        }

        this.refreshDerivedState();
    }

    public loadCodebaseSnapshot(): void {
        console.log('[SNAPSHOT] Loading codebase snapshot from:', this.snapshotFilePath);

        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SNAPSHOT] Snapshot file does not exist. Starting with empty codebase list.');
                return;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV3Format(snapshot)) {
                this.loadV3Format(snapshot);
            } else if (this.isV2Format(snapshot)) {
                this.loadV2Format(snapshot);
            } else {
                this.loadV1Format(snapshot);
            }

            // Always persist in v3 format after load/migration.
            this.saveCodebaseSnapshot();
        } catch (error: any) {
            console.error('[SNAPSHOT] Error loading snapshot:', error);
            this.codebaseInfoMap.clear();
            this.refreshDerivedState();
        }
    }

    public saveCodebaseSnapshot(): void {
        try {
            const snapshotDir = path.dirname(this.snapshotFilePath);
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
            }

            const codebases: Record<string, CodebaseInfo> = {};
            for (const [codebasePath, info] of this.codebaseInfoMap.entries()) {
                codebases[codebasePath] = info;
            }

            const snapshot: CodebaseSnapshotV3 = {
                formatVersion: 'v3',
                codebases,
                lastUpdated: new Date().toISOString(),
            };

            fs.writeFileSync(this.snapshotFilePath, JSON.stringify(snapshot, null, 2));
            this.refreshDerivedState();

            console.log(`[SNAPSHOT] Snapshot saved in v3 format. Indexed: ${this.indexedCodebases.length}, Indexing: ${this.indexingCodebases.size}, Failed: ${this.getFailedCodebases().length}, RequiresReindex: ${this.getCodebasesRequiringReindex().length}`);
        } catch (error: any) {
            console.error('[SNAPSHOT] Error saving snapshot:', error);
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

    public getCodebaseStatus(codebasePath: string): 'indexed' | 'indexing' | 'indexfailed' | 'sync_completed' | 'requires_reindex' | 'not_found' {
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
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.refreshDerivedState();
    }

    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' },
        indexFingerprint?: IndexFingerprint,
        fingerprintSource: FingerprintSource = 'verified'
    ): void {
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
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.refreshDerivedState();
    }

    public setCodebaseIndexFailed(codebasePath: string, errorMessage: string, lastAttemptedPercentage?: number): void {
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
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.refreshDerivedState();
    }

    public setCodebaseSyncCompleted(
        codebasePath: string,
        stats: { added: number; removed: number; modified: number },
        indexFingerprint?: IndexFingerprint,
        fingerprintSource: FingerprintSource = 'verified'
    ): void {
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
            fingerprintSource: existing?.fingerprintSource || fingerprintSource,
            callGraphSidecar: existing?.callGraphSidecar,
            indexManifest: existing?.indexManifest,
            ignoreRulesVersion: existing?.ignoreRulesVersion,
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.refreshDerivedState();
    }

    public setCodebaseRequiresReindex(
        codebasePath: string,
        reason: 'legacy_unverified_fingerprint' | 'fingerprint_mismatch' | 'missing_fingerprint',
        message?: string
    ): void {
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
        };
        this.codebaseInfoMap.set(codebasePath, info);
        this.refreshDerivedState();
    }

    public setCodebaseCallGraphSidecar(codebasePath: string, sidecar: CallGraphSidecarInfo): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        this.codebaseInfoMap.set(codebasePath, {
            ...existing,
            callGraphSidecar: sidecar,
            lastUpdated: new Date().toISOString(),
        });
        this.refreshDerivedState();
    }

    public setCodebaseIndexManifest(codebasePath: string, indexedPaths: string[]): void {
        const existing = this.codebaseInfoMap.get(codebasePath);
        if (!existing) {
            return;
        }

        const normalized = Array.from(
            new Set(indexedPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        ).sort();

        this.codebaseInfoMap.set(codebasePath, {
            ...existing,
            indexManifest: {
                indexedPaths: normalized,
                updatedAt: new Date().toISOString(),
            },
            lastUpdated: new Date().toISOString(),
        });
        this.refreshDerivedState();
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

        this.codebaseInfoMap.set(codebasePath, {
            ...existing,
            ignoreRulesVersion: Number.isFinite(version) ? version : existing.ignoreRulesVersion,
            lastUpdated: new Date().toISOString(),
        });
        this.refreshDerivedState();
    }

    public getCodebaseCallGraphSidecar(codebasePath: string): CallGraphSidecarInfo | undefined {
        return this.codebaseInfoMap.get(codebasePath)?.callGraphSidecar;
    }

    public removeCodebaseCompletely(codebasePath: string): void {
        this.codebaseInfoMap.delete(codebasePath);
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
            existing.indexedFiles = fileCount;
            existing.lastUpdated = new Date().toISOString();
            this.codebaseInfoMap.set(codebasePath, existing);
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
