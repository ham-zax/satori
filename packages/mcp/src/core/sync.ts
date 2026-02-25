import * as fs from "fs";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import ignore from "ignore";
import { Context } from "@zokizuan/satori-core";
import { SnapshotManager } from "./snapshot.js";

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
    | 'skipped_requires_reindex'
    | 'skipped_missing_path';

export interface FreshnessDecision {
    mode: FreshnessDecisionMode;
    checkedAt: string;
    thresholdMs: number;
    lastSyncAt?: string;
    ageMs?: number;
    stats?: { added: number; removed: number; modified: number };
}

interface SyncExecutionOutcome {
    mode: Exclude<FreshnessDecisionMode, 'coalesced' | 'skipped_recent'>;
    stats?: { added: number; removed: number; modified: number; changedFiles: string[] };
}

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
    private readonly now: () => number;
    private readonly onSyncCompleted?: (codebasePath: string, stats: { added: number; removed: number; modified: number; changedFiles: string[] }) => Promise<void> | void;

    constructor(context: Context, snapshotManager: SnapshotManager, options: SyncManagerOptions = {}) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.watchEnabled = options.watchEnabled === true;
        this.watchDebounceMs = Math.max(1, options.watchDebounceMs ?? 5000);
        this.now = options.now || (() => Date.now());
        this.onSyncCompleted = options.onSyncCompleted;
    }

    /**
     * Ensures the codebase is fresh before use.
     * Unified entry point for ALL sync operations (manual, periodic, and on-read).
     */
    public async ensureFreshness(codebasePath: string, thresholdMs: number = 60000): Promise<FreshnessDecision> {
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();

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

    private async syncCodebase(codebasePath: string): Promise<SyncExecutionOutcome> {
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

    private canScheduleWatchSync(codebasePath: string): boolean {
        const status = this.snapshotManager.getCodebaseStatus(codebasePath);
        return status === 'indexed' || status === 'sync_completed';
    }

    private async loadRepoIgnorePatterns(codebasePath: string): Promise<string[]> {
        try {
            const entries = await fs.promises.readdir(codebasePath, { withFileTypes: true });
            const ignoreFiles = entries
                .filter((entry) => entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('ignore'))
                .map((entry) => path.join(codebasePath, entry.name));

            if (ignoreFiles.length === 0) {
                return [];
            }

            const collected: string[] = [];
            for (const ignoreFile of ignoreFiles) {
                try {
                    const patterns = await Context.getIgnorePatternsFromFile(ignoreFile);
                    collected.push(...patterns);
                } catch {
                    // ignore file parse failures should not break watcher startup
                }
            }

            return collected;
        } catch {
            return [];
        }
    }

    private async buildIgnoreMatcherForCodebase(codebasePath: string): Promise<ReturnType<typeof ignore>> {
        const matcher = ignore();
        const basePatterns = this.context.getActiveIgnorePatterns?.() || [];
        const repoPatterns = await this.loadRepoIgnorePatterns(codebasePath);
        matcher.add([...new Set([...basePatterns, ...repoPatterns])]);
        return matcher;
    }

    private getIgnoreMatcherForCodebase(codebasePath: string): ReturnType<typeof ignore> {
        const existing = this.watcherIgnoreMatchers.get(codebasePath);
        if (existing) {
            return existing;
        }

        const matcher = ignore();
        const patterns = this.context.getActiveIgnorePatterns?.() || [];
        matcher.add(patterns);
        this.watcherIgnoreMatchers.set(codebasePath, matcher);
        return matcher;
    }

    private shouldIgnoreWatchPath(codebasePath: string, candidatePath: string): boolean {
        const relativePath = path
            .relative(codebasePath, path.resolve(candidatePath))
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');

        if (!relativePath || relativePath === '.') {
            return false;
        }

        if (relativePath.startsWith('..')) {
            return true;
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

    public scheduleWatcherSync(codebasePath: string, reason: string = 'watch_event'): void {
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

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(codebasePath);
            try {
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

        const onPathChange = () => this.scheduleWatcherSync(codebasePath, 'watch_event');

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
