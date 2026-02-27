import * as fs from "fs";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import ignore from "ignore";
import { Context } from "@zokizuan/satori-core";
import { SnapshotManager } from "./snapshot.js";
import { DEFAULT_WATCH_DEBOUNCE_MS } from "../config.js";

interface SyncManagerOptions {
    watchEnabled?: boolean;
    watchDebounceMs?: number;
    now?: () => number;
    onSyncCompleted?: (codebasePath: string, stats: { added: number; removed: number; modified: number; changedFiles: string[] }) => Promise<void> | void;
}

export type FreshnessDecisionMode =
    | 'synced'
    | 'skipped_recent'
    | 'coalesced'
    | 'skipped_indexing'
    | 'skipped_requires_reindex'
    | 'skipped_missing_path'
    | 'reconciled_ignore_change'
    | 'ignore_reload_failed';

export interface FreshnessDecision {
    mode: FreshnessDecisionMode;
    checkedAt: string;
    thresholdMs: number;
    lastSyncAt?: string;
    ageMs?: number;
    stats?: { added: number; removed: number; modified: number };
    ignoreRulesVersion?: number;
    deletedFiles?: number;
    newlyIgnoredFiles?: number;
    addedFiles?: number;
    pendingAdds?: number;
    coalescedEdits?: number;
    durationMs?: number;
    errorMessage?: string;
    fallbackSyncExecuted?: boolean;
    fallbackStats?: { added: number; removed: number; modified: number };
}

interface SyncExecutionOutcome {
    mode: Exclude<FreshnessDecisionMode, 'coalesced' | 'skipped_recent'>;
    stats?: { added: number; removed: number; modified: number; changedFiles: string[] };
}

type WatchSyncReason = 'watch_event' | 'ignore_rules_changed';

interface EnsureFreshnessOptions {
    reason?: 'default' | 'ignore_change';
    coalescedEdits?: number;
    skipIgnoreControlCheck?: boolean;
}

interface IgnoreReloadResult {
    previousMatcher?: ReturnType<typeof ignore>;
    matcher: ReturnType<typeof ignore>;
    version: number;
}

// v1 policy: only root-level control files trigger ignore-rule reconciliation.
const IGNORE_RULE_CONTROL_FILES = new Set(['.satoriignore', '.gitignore']);

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private activeSyncs: Map<string, Promise<SyncExecutionOutcome>> = new Map();
    private lastSyncTimes: Map<string, number> = new Map();
    private backgroundSyncTimer: NodeJS.Timeout | null = null;
    private watcherModeStarted = false;
    private watchEnabled: boolean;
    private watchDebounceMs: number;
    private watchers: Map<string, FSWatcher> = new Map();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private watcherIgnoreMatchers: Map<string, ReturnType<typeof ignore>> = new Map();
    private ignoreRulesVersions: Map<string, number> = new Map();
    private pendingIgnoreChangeEdits: Map<string, number> = new Map();
    private activeIgnoreReconciles: Map<string, Promise<FreshnessDecision>> = new Map();
    private readonly now: () => number;
    private readonly onSyncCompleted?: (codebasePath: string, stats: { added: number; removed: number; modified: number; changedFiles: string[] }) => Promise<void> | void;

    constructor(context: Context, snapshotManager: SnapshotManager, options: SyncManagerOptions = {}) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.watchEnabled = options.watchEnabled === true;
        this.watchDebounceMs = Math.max(1, options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS);
        this.now = options.now || (() => Date.now());
        this.onSyncCompleted = options.onSyncCompleted;
    }

    /**
     * Ensures the codebase is fresh before use.
     * Unified entry point for ALL sync operations (manual, periodic, and on-read).
     */
    public async ensureFreshness(
        codebasePath: string,
        thresholdMs: number = 60000,
        options: EnsureFreshnessOptions = {}
    ): Promise<FreshnessDecision> {
        if (options.reason === 'ignore_change') {
            return this.runIgnoreReconcile(codebasePath, options.coalescedEdits);
        }

        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();

        if (options.skipIgnoreControlCheck !== true) {
            const currentIgnoreControlSignature = await this.computeIgnoreControlSignature(codebasePath);
            const persistedIgnoreControlSignature = this.snapshotManager.getCodebaseIgnoreControlSignature?.(codebasePath);

            if (typeof persistedIgnoreControlSignature === 'string') {
                if (persistedIgnoreControlSignature !== currentIgnoreControlSignature) {
                    return this.runIgnoreReconcile(codebasePath, 1, currentIgnoreControlSignature);
                }
            } else if (
                (this.snapshotManager.getCodebaseStatus(codebasePath) === 'indexed'
                    || this.snapshotManager.getCodebaseStatus(codebasePath) === 'sync_completed')
                && typeof this.snapshotManager.setCodebaseIgnoreControlSignature === 'function'
            ) {
                this.snapshotManager.setCodebaseIgnoreControlSignature(codebasePath, currentIgnoreControlSignature);
                this.snapshotManager.saveCodebaseSnapshot();
            }
        }

        // 1. Coalescing: Join existing in-flight sync
        if (this.activeSyncs.has(codebasePath)) {
            console.log(`[SYNC] 🛡️ Request Coalesced: Attaching to active sync for '${codebasePath}'`);
            await this.activeSyncs.get(codebasePath);
            const lastSync = this.lastSyncTimes.get(codebasePath);
            return {
                mode: 'coalesced',
                checkedAt,
                thresholdMs,
                lastSyncAt: lastSync ? new Date(lastSync).toISOString() : undefined,
                ageMs: lastSync ? Math.max(0, checkedAtMs - lastSync) : undefined,
            };
        }

        // 2. Throttling: Skip if recently synced
        const lastSync = this.lastSyncTimes.get(codebasePath) || 0;
        const timeSince = checkedAtMs - lastSync;
        if (thresholdMs > 0 && timeSince < thresholdMs) {
            console.log(`[SYNC] ⏩ Skipped (Fresh): '${codebasePath}' was synced ${Math.round(timeSince / 1000)}s ago (Threshold: ${thresholdMs / 1000}s)`);
            return {
                mode: 'skipped_recent',
                checkedAt,
                thresholdMs,
                lastSyncAt: lastSync > 0 ? new Date(lastSync).toISOString() : undefined,
                ageMs: lastSync > 0 ? timeSince : undefined,
            };
        }

        // 3. Execution Gate
        // console.log(`[SYNC] 🔄 Triggering Sync for '${codebasePath}' (Threshold: ${thresholdMs}ms)`);

        const syncPromise = (async () => {
            try {
                return await this.syncCodebase(codebasePath);
            } catch (e) {
                // Log and rethrow to allow callers to handle/see failure
                console.error(`[SYNC] Error syncing '${codebasePath}':`, e);
                throw e;
            } finally {
                this.activeSyncs.delete(codebasePath);
            }
        })();

        this.activeSyncs.set(codebasePath, syncPromise);
        const outcome = await syncPromise;
        const lastSyncedAt = this.lastSyncTimes.get(codebasePath);
        return {
            mode: outcome.mode,
            checkedAt,
            thresholdMs,
            lastSyncAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : undefined,
            ageMs: lastSyncedAt ? Math.max(0, checkedAtMs - lastSyncedAt) : undefined,
            stats: outcome.stats ? {
                added: outcome.stats.added,
                removed: outcome.stats.removed,
                modified: outcome.stats.modified
            } : undefined,
        };
    }

    private async runIgnoreReconcile(
        codebasePath: string,
        coalescedEdits: number = 1,
        nextIgnoreControlSignature?: string
    ): Promise<FreshnessDecision> {
        const reconcileKey = this.normalizeReconcileKey(codebasePath);
        const inFlight = this.activeIgnoreReconciles.get(reconcileKey);
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();

        if (inFlight) {
            console.log(`[SYNC] 🛡️ Ignore-rule reconcile coalesced for '${codebasePath}'.`);
            const inFlightResult = await inFlight;
            return {
                ...inFlightResult,
                mode: 'coalesced',
                checkedAt,
            };
        }

        console.log(`[SYNC] 🔁 Ignore control files changed for '${codebasePath}', running reconciliation.`);
        const promise = this.reconcileIgnoreRulesChange(codebasePath, coalescedEdits, nextIgnoreControlSignature);
        this.activeIgnoreReconciles.set(reconcileKey, promise);
        try {
            return await promise;
        } finally {
            this.activeIgnoreReconciles.delete(reconcileKey);
        }
    }

    private async reconcileIgnoreRulesChange(
        codebasePath: string,
        coalescedEdits: number = 1,
        nextIgnoreControlSignature?: string
    ): Promise<FreshnessDecision> {
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();
        const startedAt = checkedAtMs;
        const resolvedIgnoreControlSignature = nextIgnoreControlSignature ?? await this.computeIgnoreControlSignature(codebasePath);

        try {
            if (this.activeSyncs.has(codebasePath)) {
                console.log(`[SYNC] ⏳ Ignore-rule reconcile waiting for in-flight sync '${codebasePath}'`);
                await this.activeSyncs.get(codebasePath);
            }

            const manifestIndexedPaths = typeof this.snapshotManager.getCodebaseIndexedPaths === 'function'
                ? this.snapshotManager.getCodebaseIndexedPaths(codebasePath)
                : [];
            const hasSynchronizer = typeof this.context.hasSynchronizerForCodebase === 'function'
                ? this.context.hasSynchronizerForCodebase(codebasePath)
                : false;
            let indexedPathsBeforeReload = manifestIndexedPaths;
            if (indexedPathsBeforeReload.length === 0 && hasSynchronizer && typeof this.context.getTrackedRelativePaths === 'function') {
                indexedPathsBeforeReload = this.context.getTrackedRelativePaths(codebasePath);
            }
            if (indexedPathsBeforeReload.length === 0 && !hasSynchronizer) {
                throw new Error('missing_manifest_and_synchronizer');
            }

            const { previousMatcher, matcher, version } = await this.reloadIgnoreRulesForCodebase(codebasePath);

            if (typeof this.context.recreateSynchronizerForCodebase === 'function') {
                await this.context.recreateSynchronizerForCodebase(codebasePath);
            }

            // Self-healing delete rule: remove anything currently indexed that new matcher ignores.
            const toDelete = indexedPathsBeforeReload.filter((relativePath) => this.matcherIgnoresRelativePath(matcher, relativePath));
            const retainedPaths = indexedPathsBeforeReload.filter((relativePath) => !this.matcherIgnoresRelativePath(matcher, relativePath));

            if (toDelete.length > 0 && typeof this.context.deleteIndexedPathsByRelativePaths === 'function') {
                await this.context.deleteIndexedPathsByRelativePaths(codebasePath, toDelete);
            }

            if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                this.snapshotManager.setCodebaseIndexManifest(codebasePath, retainedPaths);
            }
            this.snapshotManager.saveCodebaseSnapshot();

            const syncDecision = await this.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });
            const lastSyncAt = syncDecision.lastSyncAt;
            const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : undefined;
            const newlyIgnoredCount = previousMatcher
                ? indexedPathsBeforeReload.filter((relativePath) => !this.matcherIgnoresRelativePath(previousMatcher, relativePath) && this.matcherIgnoresRelativePath(matcher, relativePath)).length
                : toDelete.length;

            if (typeof this.snapshotManager.setCodebaseIgnoreControlSignature === 'function') {
                this.snapshotManager.setCodebaseIgnoreControlSignature(codebasePath, resolvedIgnoreControlSignature);
            }
            this.snapshotManager.saveCodebaseSnapshot();

            return {
                mode: 'reconciled_ignore_change',
                checkedAt,
                thresholdMs: 0,
                lastSyncAt,
                ageMs: lastSyncMs !== undefined ? Math.max(0, this.now() - lastSyncMs) : undefined,
                stats: syncDecision.stats,
                ignoreRulesVersion: version,
                deletedFiles: toDelete.length,
                addedFiles: syncDecision.stats?.added ?? 0,
                pendingAdds: 0,
                coalescedEdits: Math.max(1, coalescedEdits),
                durationMs: Math.max(0, this.now() - startedAt),
                newlyIgnoredFiles: newlyIgnoredCount,
                fallbackSyncExecuted: false,
            };
        } catch (error: any) {
            let fallbackSyncExecuted = false;
            let fallbackStats: { added: number; removed: number; modified: number } | undefined;
            try {
                const fallbackDecision = await this.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });
                fallbackSyncExecuted = true;
                fallbackStats = fallbackDecision.stats;
            } catch {
                // Preserve primary failure metadata even if fallback sync fails.
            }

            return {
                mode: 'ignore_reload_failed',
                checkedAt,
                thresholdMs: 0,
                ignoreRulesVersion: this.ignoreRulesVersions.get(codebasePath),
                coalescedEdits: Math.max(1, coalescedEdits),
                durationMs: Math.max(0, this.now() - startedAt),
                errorMessage: String(error?.message || error || 'unknown_ignore_reload_error'),
                fallbackSyncExecuted,
                fallbackStats,
            };
        }
    }

    private async syncCodebase(codebasePath: string): Promise<SyncExecutionOutcome> {
        if (this.snapshotManager.getCodebaseStatus(codebasePath) === 'indexing') {
            console.log(`[SYNC] ⏭️  Skipping sync for '${codebasePath}' because indexing is active.`);
            return { mode: 'skipped_indexing' };
        }

        if (this.snapshotManager.getCodebaseStatus(codebasePath) === 'requires_reindex') {
            console.log(`[SYNC] ⏭️  Skipping sync for '${codebasePath}' because it requires reindex.`);
            return { mode: 'skipped_requires_reindex' };
        }

        // Async existence check to avoid blocking event loop
        try {
            await fs.promises.access(codebasePath);
        } catch {
            // Path doesn't exist anymore - Clean up snapshot
            console.log(`[SYNC] 🗑️ Codebase '${codebasePath}' no longer exists. Removing from snapshot.`);
            try {
                this.snapshotManager.removeIndexedCodebase(codebasePath);
                this.snapshotManager.saveCodebaseSnapshot();
                await this.unregisterCodebaseWatcher(codebasePath);
            } catch (e) {
                console.error(`[SYNC] Failed to clean snapshot for '${codebasePath}':`, e);
            }
            return { mode: 'skipped_missing_path' };
        }

        try {
            // Incremental sync
            const stats = await this.context.reindexByChange(codebasePath);

            if (typeof this.context.getTrackedRelativePaths === 'function') {
                const trackedPaths = this.context.getTrackedRelativePaths(codebasePath);
                if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                    this.snapshotManager.setCodebaseIndexManifest(codebasePath, trackedPaths);
                }
            }

            // Centralized State Update
            this.lastSyncTimes.set(codebasePath, this.now());

            // Persist Snapshot
            this.snapshotManager.setCodebaseSyncCompleted(codebasePath, stats);
            this.snapshotManager.saveCodebaseSnapshot();

            if (this.onSyncCompleted) {
                await this.onSyncCompleted(codebasePath, {
                    added: stats.added,
                    removed: stats.removed,
                    modified: stats.modified,
                    changedFiles: Array.isArray(stats.changedFiles) ? stats.changedFiles : []
                });
            }

            if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                console.log(`[SYNC] ✅ Sync Result for '${codebasePath}': +${stats.added}, -${stats.removed}, ~${stats.modified}`);
            }
            return { mode: 'synced', stats };
        } catch (error: any) {
            console.error(`[SYNC] Failed to sync '${codebasePath}':`, error);
            throw error; // Let ensureFreshness handle the catch/finally
        }
    }

    public async handleSyncIndex(): Promise<void> {
        const indexedCodebases = this.snapshotManager.getIndexedCodebases();
        if (indexedCodebases.length === 0) return;

        // console.log(`[SYNC-DEBUG] Starting periodic sync via unified gate...`);

        // Execute sequentially to avoid resource spikes, but through the ensureFreshness gate
        for (const codebasePath of indexedCodebases) {
            try {
                // thresholdMs = 0 forces a check (unless coalesced)
                await this.ensureFreshness(codebasePath, 0);
            } catch (e) {
                // Individual codebase failure shouldn't stop the loop
                console.error(`[SYNC] Periodic sync failed for '${codebasePath}':`, e);
            }
        }
    }

    public startBackgroundSync(): void {
        if (this.backgroundSyncTimer) {
            return;
        }

        const run = async () => {
            await this.handleSyncIndex();

            // recursive schedule to prevent overlap
            this.backgroundSyncTimer = setTimeout(run, 3 * 60 * 1000); // 3 minutes
        };

        // Initial delay
        this.backgroundSyncTimer = setTimeout(run, 5000);
    }

    public stopBackgroundSync(): void {
        if (this.backgroundSyncTimer) {
            clearTimeout(this.backgroundSyncTimer);
            this.backgroundSyncTimer = null;
        }
    }

    public getWatchDebounceMs(): number {
        return this.watchDebounceMs;
    }

    private canScheduleWatchSync(codebasePath: string): boolean {
        const status = this.snapshotManager.getCodebaseStatus(codebasePath);
        return status === 'indexed' || status === 'sync_completed';
    }

    private getIgnoreRuleVersion(codebasePath: string): number {
        const current = this.ignoreRulesVersions.get(codebasePath);
        if (Number.isFinite(current)) {
            return Number(current);
        }

        if (typeof this.snapshotManager.getCodebaseInfo === 'function') {
            const info = this.snapshotManager.getCodebaseInfo(codebasePath) as { ignoreRulesVersion?: number } | undefined;
            if (info && Number.isFinite(info.ignoreRulesVersion)) {
                return Number(info.ignoreRulesVersion);
            }
        }

        return 0;
    }

    private async reloadIgnoreRulesForCodebase(codebasePath: string): Promise<IgnoreReloadResult> {
        const previousMatcher = this.watcherIgnoreMatchers.get(codebasePath);

        if (typeof this.context.reloadIgnoreRulesForCodebase === 'function') {
            await this.context.reloadIgnoreRulesForCodebase(codebasePath);
        }

        const matcher = await this.buildIgnoreMatcherForCodebase(codebasePath);
        this.watcherIgnoreMatchers.set(codebasePath, matcher);

        const version = this.getIgnoreRuleVersion(codebasePath) + 1;
        this.ignoreRulesVersions.set(codebasePath, version);
        if (typeof this.snapshotManager.setCodebaseIgnoreRulesVersion === 'function') {
            this.snapshotManager.setCodebaseIgnoreRulesVersion(codebasePath, version);
        }

        return { previousMatcher, matcher, version };
    }

    private async buildIgnoreMatcherForCodebase(codebasePath: string): Promise<ReturnType<typeof ignore>> {
        const matcher = ignore();
        // Context is the single source of truth for effective ignore rules.
        const basePatterns = this.context.getActiveIgnorePatterns?.(codebasePath) || [];
        matcher.add([...new Set(basePatterns)]);
        return matcher;
    }

    private async computeIgnoreControlSignature(codebasePath: string): Promise<string> {
        const signatureParts: string[] = [];

        for (const controlFile of IGNORE_RULE_CONTROL_FILES) {
            const controlPath = path.join(codebasePath, controlFile);
            try {
                const stat = await fs.promises.stat(controlPath);
                if (!stat.isFile()) {
                    signatureParts.push(`${controlFile}:missing`);
                    continue;
                }

                // Round to keep the signature deterministic across fs precision differences.
                signatureParts.push(`${controlFile}:${Math.round(stat.mtimeMs)}:${stat.size}`);
            } catch {
                signatureParts.push(`${controlFile}:missing`);
            }
        }

        return signatureParts.join('|');
    }

    private normalizeReconcileKey(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        const root = path.parse(resolved).root;
        if (resolved === root) {
            return resolved;
        }
        return resolved.replace(/[\\/]+$/, '');
    }

    private normalizeRelativePath(codebasePath: string, candidatePath: string): string {
        return path
            .relative(codebasePath, path.resolve(candidatePath))
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');
    }

    private isIgnoreRuleControlFile(relativePath: string): boolean {
        if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
            return false;
        }
        return IGNORE_RULE_CONTROL_FILES.has(relativePath);
    }

    private matcherIgnoresRelativePath(matcher: ReturnType<typeof ignore>, relativePath: string): boolean {
        const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalized || normalized === '.') {
            return false;
        }
        if (matcher.ignores(normalized)) {
            return true;
        }
        const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
        return matcher.ignores(withSlash);
    }

    private getIgnoreMatcherForCodebase(codebasePath: string): ReturnType<typeof ignore> {
        const existing = this.watcherIgnoreMatchers.get(codebasePath);
        if (existing) {
            return existing;
        }

        const matcher = ignore();
        const patterns = this.context.getActiveIgnorePatterns?.(codebasePath) || [];
        matcher.add(patterns);
        this.watcherIgnoreMatchers.set(codebasePath, matcher);
        return matcher;
    }

    private shouldIgnoreWatchPath(codebasePath: string, candidatePath: string): boolean {
        const relativePath = this.normalizeRelativePath(codebasePath, candidatePath);

        if (!relativePath || relativePath === '.') {
            return false;
        }

        if (relativePath.startsWith('..')) {
            return true;
        }

        if (this.isIgnoreRuleControlFile(relativePath)) {
            return false;
        }

        // Hidden files/directories are intentionally excluded from sync.
        const pathParts = relativePath.split('/');
        if (pathParts.some((part) => part.startsWith('.'))) {
            return true;
        }

        const matcher = this.getIgnoreMatcherForCodebase(codebasePath);
        if (matcher.ignores(relativePath)) {
            return true;
        }

        const withSlash = relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
        return matcher.ignores(withSlash);
    }

    public scheduleWatcherSync(codebasePath: string, reason: WatchSyncReason = 'watch_event'): void {
        if (!this.watchEnabled || !this.watcherModeStarted) {
            return;
        }

        if (!this.canScheduleWatchSync(codebasePath)) {
            console.log(`[SYNC-WATCH] Dropping ${reason} for '${codebasePath}' due to status=${this.snapshotManager.getCodebaseStatus(codebasePath)}`);
            return;
        }

        const activeTimer = this.debounceTimers.get(codebasePath);
        if (activeTimer) {
            clearTimeout(activeTimer);
        }

        if (reason === 'ignore_rules_changed') {
            const current = this.pendingIgnoreChangeEdits.get(codebasePath) || 0;
            this.pendingIgnoreChangeEdits.set(codebasePath, current + 1);
        }

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(codebasePath);
            const coalescedIgnoreEdits = this.pendingIgnoreChangeEdits.get(codebasePath) || 0;
            this.pendingIgnoreChangeEdits.delete(codebasePath);
            try {
                if (coalescedIgnoreEdits > 0) {
                    const decision = await this.ensureFreshness(codebasePath, 0, {
                        reason: 'ignore_change',
                        coalescedEdits: coalescedIgnoreEdits,
                    });
                    if (decision.mode === 'ignore_reload_failed') {
                        console.warn(`[SYNC-WATCH] Ignore-rule reconcile failed for '${codebasePath}': ${decision.errorMessage || 'unknown_error'} (fallbackSyncExecuted=${decision.fallbackSyncExecuted === true})`);
                    } else {
                        console.log(`[SYNC-WATCH] Ignore-rule reconcile completed for '${codebasePath}' (version=${decision.ignoreRulesVersion ?? 'n/a'}, deleted=${decision.deletedFiles ?? 0}, added=${decision.addedFiles ?? 0}, coalesced=${decision.coalescedEdits ?? 1})`);
                    }
                    return;
                }

                await this.ensureFreshness(codebasePath, 0);
            } catch (error: any) {
                console.error(`[SYNC-WATCH] Debounced sync failed for '${codebasePath}':`, error);
            }
        }, this.watchDebounceMs);

        this.debounceTimers.set(codebasePath, timer);
    }

    private async handleWatcherError(codebasePath: string, error: any): Promise<void> {
        const message = String(error?.message || error || '');
        const code = error?.code;
        if (code === 'ENOSPC' || message.includes('ENOSPC')) {
            console.error(`[SYNC-WATCH] ENOSPC detected while watching '${codebasePath}'. Disabling watcher mode and relying on periodic/manual sync.`);
            await this.stopWatcherMode();
            return;
        }

        console.error(`[SYNC-WATCH] Watcher error for '${codebasePath}':`, error);
    }

    public async registerCodebaseWatcher(codebasePath: string): Promise<void> {
        if (!this.watchEnabled || !this.watcherModeStarted) {
            return;
        }

        if (!this.canScheduleWatchSync(codebasePath)) {
            return;
        }

        if (this.watchers.has(codebasePath)) {
            return;
        }

        try {
            const stat = await fs.promises.stat(codebasePath);
            if (!stat.isDirectory()) {
                return;
            }
        } catch {
            return;
        }

        this.watcherIgnoreMatchers.set(
            codebasePath,
            await this.buildIgnoreMatcherForCodebase(codebasePath)
        );

        let watcher: FSWatcher;
        try {
            watcher = chokidar.watch(codebasePath, {
                persistent: true,
                ignoreInitial: true,
                ignored: (watchPath) => this.shouldIgnoreWatchPath(codebasePath, watchPath),
            });
        } catch (error) {
            await this.handleWatcherError(codebasePath, error);
            return;
        }

        const onPathChange = (watchPath: string) => {
            const relativePath = this.normalizeRelativePath(codebasePath, watchPath);
            const reason: WatchSyncReason = this.isIgnoreRuleControlFile(relativePath)
                ? 'ignore_rules_changed'
                : 'watch_event';
            this.scheduleWatcherSync(codebasePath, reason);
        };

        watcher
            .on('add', onPathChange)
            .on('change', onPathChange)
            .on('unlink', onPathChange)
            .on('addDir', onPathChange)
            .on('unlinkDir', onPathChange)
            .on('error', (error) => {
                void this.handleWatcherError(codebasePath, error);
            });

        this.watchers.set(codebasePath, watcher);
        console.log(`[SYNC-WATCH] Watching '${codebasePath}' (debounce=${this.watchDebounceMs}ms)`);
    }

    public async unregisterCodebaseWatcher(codebasePath: string): Promise<void> {
        const timer = this.debounceTimers.get(codebasePath);
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(codebasePath);
        }

        this.watcherIgnoreMatchers.delete(codebasePath);
        this.pendingIgnoreChangeEdits.delete(codebasePath);

        const watcher = this.watchers.get(codebasePath);
        if (!watcher) {
            return;
        }

        this.watchers.delete(codebasePath);
        try {
            await watcher.close();
        } catch (error) {
            console.error(`[SYNC-WATCH] Failed to close watcher for '${codebasePath}':`, error);
        }
    }

    public async refreshWatchersFromSnapshot(): Promise<void> {
        if (!this.watchEnabled || !this.watcherModeStarted) {
            return;
        }

        const indexedCodebases = new Set(this.snapshotManager.getIndexedCodebases());

        for (const watchedPath of Array.from(this.watchers.keys())) {
            if (!indexedCodebases.has(watchedPath)) {
                await this.unregisterCodebaseWatcher(watchedPath);
            }
        }

        for (const codebasePath of indexedCodebases) {
            await this.registerCodebaseWatcher(codebasePath);
        }
    }

    public async startWatcherMode(): Promise<void> {
        if (!this.watchEnabled || this.watcherModeStarted) {
            return;
        }

        this.watcherModeStarted = true;
        await this.refreshWatchersFromSnapshot();
        console.log(`[SYNC-WATCH] Watcher mode enabled.`);
    }

    public async stopWatcherMode(): Promise<void> {
        this.watcherModeStarted = false;

        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.watcherIgnoreMatchers.clear();
        this.pendingIgnoreChangeEdits.clear();
        this.activeIgnoreReconciles.clear();

        const watchers = Array.from(this.watchers.values());
        this.watchers.clear();

        await Promise.all(watchers.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[SYNC-WATCH] Failed to close watcher:', error);
            }
        }));
    }
}
