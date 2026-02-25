import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";
import { Context, COLLECTION_LIMIT_MESSAGE } from "@zokizuan/satori-core";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "../utils.js";
import { SyncManager } from "./sync.js";
import { IndexFingerprint } from "../config.js";

const COLLECTION_LIMIT_PATTERNS = [
    /exceeded the limit number of collections/i,
    /collection limit/i,
    /too many collections/i,
    /quota.*collection/i,
];

const SATORI_COLLECTION_PREFIXES = ['code_chunks_', 'hybrid_code_chunks_'];
const ZILLIZ_FREE_TIER_COLLECTION_LIMIT = 5;

interface CandidateCollection {
    name: string;
    createdAt?: string;
    codebasePath?: string;
    isTargetCollection: boolean;
}

interface CollectionDetailsView {
    name: string;
    createdAt?: string;
}

interface VectorStoreBackendInfoView {
    provider: 'milvus' | 'zilliz';
    transport: 'grpc' | 'rest';
    address?: string;
}

function collectErrorFragments(
    value: unknown,
    output: string[],
    visited: Set<unknown>,
    depth: number = 0
): void {
    if (value === null || value === undefined || depth > 4 || output.length >= 8) {
        return;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            output.push(trimmed);
        }
        return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        output.push(String(value));
        return;
    }

    if (value instanceof Error) {
        collectErrorFragments(value.message, output, visited, depth + 1);
        collectErrorFragments((value as any).cause, output, visited, depth + 1);
        return;
    }

    if (typeof value !== "object") {
        return;
    }

    if (visited.has(value)) {
        return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorFragments(item, output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
        return;
    }

    const record = value as Record<string, unknown>;
    const priorityKeys = ["message", "reason", "detail", "details", "error", "msg", "code", "error_code"];
    for (const key of priorityKeys) {
        if (key in record) {
            collectErrorFragments(record[key], output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
    }

    for (const nestedValue of Object.values(record)) {
        collectErrorFragments(nestedValue, output, visited, depth + 1);
        if (output.length >= 8) {
            return;
        }
    }
}

function formatUnknownError(error: unknown): string {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return COLLECTION_LIMIT_MESSAGE;
    }

    const fragments: string[] = [];
    collectErrorFragments(error, fragments, new Set());
    const deduped = Array.from(new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean)));
    if (deduped.length > 0) {
        return deduped.slice(0, 3).join(" | ");
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function isCollectionLimitError(error: unknown): boolean {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    const message = formatUnknownError(error);
    if (message === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    return COLLECTION_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private runtimeFingerprint: IndexFingerprint;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;

    constructor(context: Context, snapshotManager: SnapshotManager, syncManager: SyncManager, runtimeFingerprint: IndexFingerprint) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.syncManager = syncManager;
        this.runtimeFingerprint = runtimeFingerprint;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private buildReindexInstruction(codebasePath: string, detail?: string): string {
        const detailLine = detail ? `${detail}\n\n` : '';
        return `${detailLine}Error: The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt.\nNext step: call manage_index with {\"action\":\"create\",\"path\":\"${codebasePath}\",\"force\":true}.`;
    }

    private getMatchingBlockedRoot(absolutePath: string): { path: string; message?: string } | null {
        const blocked = this.snapshotManager
            .getAllCodebases()
            .filter((entry) => entry.info.status === 'requires_reindex');
        if (blocked.length === 0) {
            return null;
        }

        blocked.sort((a, b) => b.path.length - a.path.length);
        const match = blocked.find((entry) => absolutePath === entry.path || absolutePath.startsWith(`${entry.path}${path.sep}`));
        if (!match) {
            return null;
        }

        const message = 'message' in match.info ? match.info.message : undefined;
        return {
            path: match.path,
            message
        };
    }

    private enforceFingerprintGate(codebasePath: string): { blockedResponse?: any } {
        const gate = this.snapshotManager.ensureFingerprintCompatibilityOnAccess(codebasePath);
        if (!gate.allowed) {
            if (gate.changed) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            return {
                blockedResponse: {
                    content: [{
                        type: "text",
                        text: this.buildReindexInstruction(codebasePath, gate.message)
                    }],
                    isError: true
                }
            };
        }

        if (gate.changed) {
            this.snapshotManager.saveCodebaseSnapshot();
        }

        return {};
    }

    private buildSearchExcludeMatcher(
        excludePatterns: any,
        effectiveRoot: string,
        absoluteSearchPath: string
    ): { matcher?: ReturnType<typeof ignore>; warning?: string } {
        if (!Array.isArray(excludePatterns) || excludePatterns.length === 0) {
            return {};
        }

        const rawPatterns = excludePatterns
            .filter((v: any) => typeof v === 'string')
            .map((v: string) => v.trim())
            .filter((v: string) => v.length > 0);
        if (rawPatterns.length === 0) {
            return {};
        }

        const unique: string[] = [];
        const seen = new Set<string>();
        for (const p of rawPatterns) {
            if (!seen.has(p)) {
                seen.add(p);
                unique.push(p);
            }
        }

        const searchRel = path
            .relative(effectiveRoot, absoluteSearchPath)
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        const needsSubdirPrefix = searchRel.length > 0 && effectiveRoot !== absoluteSearchPath;
        const normalizedPatterns: string[] = [];
        const invalidPatterns: string[] = [];
        for (const rawPattern of unique) {
            let pattern = rawPattern.replace(/\\/g, '/').trim();
            if (!pattern) {
                continue;
            }

            const isNegation = pattern.startsWith('!');
            if (isNegation) {
                pattern = pattern.slice(1);
            }

            const anchored = pattern.startsWith('/');
            pattern = pattern.replace(/^\.\/+/, '').replace(/^\/+/, '');
            if (!pattern) {
                invalidPatterns.push(rawPattern);
                continue;
            }

            if (needsSubdirPrefix && !anchored) {
                pattern = `${searchRel}/${pattern}`.replace(/\/+/g, '/');
            }

            normalizedPatterns.push(isNegation ? `!${pattern}` : pattern);
        }

        if (normalizedPatterns.length === 0) {
            return {
                warning: invalidPatterns.length > 0
                    ? `Note: excludePatterns ignored (invalid patterns): ${JSON.stringify(invalidPatterns)}.`
                    : undefined
            };
        }

        try {
            const matcher = ignore();
            matcher.add(normalizedPatterns);
            return {
                matcher,
                warning: invalidPatterns.length > 0
                    ? `Note: excludePatterns partially applied. Ignored (invalid patterns): ${JSON.stringify(invalidPatterns)}.`
                    : undefined
            };
        } catch (error: any) {
            const parseError = error?.message || String(error);
            const invalidNote = invalidPatterns.length > 0
                ? ` Ignored patterns: ${JSON.stringify(invalidPatterns)}.`
                : '';
            return {
                warning: `Note: excludePatterns ignored due to invalid pattern syntax: ${parseError}.${invalidNote}`
            };
        }
    }

    private applySearchExcludeMatcher(
        searchResults: any[],
        matcher: ReturnType<typeof ignore> | undefined
    ): any[] {
        if (!matcher || searchResults.length === 0) {
            return searchResults;
        }

        return searchResults.filter((result: any) => {
            if (!result || typeof result.relativePath !== 'string') {
                return true;
            }

            const normalizedPath = result.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!normalizedPath || normalizedPath.startsWith('..')) {
                return true;
            }

            return !matcher.ignores(normalizedPath);
        });
    }

    private normalizeBreadcrumbs(breadcrumbs: unknown): string[] {
        if (!Array.isArray(breadcrumbs)) {
            return [];
        }
        return breadcrumbs
            .filter((crumb): crumb is string => typeof crumb === 'string')
            .map((crumb) => crumb.trim())
            .filter((crumb) => crumb.length > 0)
            .slice(-2);
    }

    private getBreadcrumbMergeKey(breadcrumbs: unknown): string {
        return this.normalizeBreadcrumbs(breadcrumbs).join(' > ');
    }

    private formatScopeLine(breadcrumbs: unknown): string {
        const normalized = this.normalizeBreadcrumbs(breadcrumbs);

        if (normalized.length === 0) {
            return '';
        }

        const joined = normalized.join(' > ');
        const capped = joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
        return `   🧬 Scope: ${capped}\n`;
    }

    private getVectorStore(): any {
        return this.context.getVectorStore() as any;
    }

    private isSatoriCodeCollection(collectionName: string): boolean {
        return SATORI_COLLECTION_PREFIXES.some((prefix) => collectionName.startsWith(prefix));
    }

    private getVectorBackendInfo(): VectorStoreBackendInfoView | null {
        const vectorDb = this.getVectorStore();
        if (typeof vectorDb.getBackendInfo !== 'function') {
            return null;
        }

        try {
            const info = vectorDb.getBackendInfo();
            if (!info || typeof info !== 'object') {
                return null;
            }

            if (info.provider !== 'milvus' && info.provider !== 'zilliz') {
                return null;
            }

            if (info.transport !== 'grpc' && info.transport !== 'rest') {
                return null;
            }

            return {
                provider: info.provider,
                transport: info.transport,
                address: typeof info.address === 'string' ? info.address : undefined,
            };
        } catch {
            return null;
        }
    }

    private isZillizBackend(): boolean {
        const backendInfo = this.getVectorBackendInfo();
        return backendInfo?.provider === 'zilliz';
    }

    private async listCollectionDetailsWithFallback(vectorDb: any): Promise<CollectionDetailsView[]> {
        if (typeof vectorDb.listCollectionDetails === 'function') {
            const details = await vectorDb.listCollectionDetails();
            if (Array.isArray(details)) {
                return details
                    .filter((detail): detail is CollectionDetailsView => Boolean(detail && typeof detail.name === 'string' && detail.name.length > 0))
                    .map((detail) => ({
                        name: detail.name,
                        createdAt: detail.createdAt,
                    }));
            }
        }

        const names = await vectorDb.listCollections();
        if (!Array.isArray(names)) {
            return [];
        }

        return names
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
            .map((name) => ({ name }));
    }

    private parseCodebaseFromMetadata(metadataValue: unknown): string | undefined {
        if (typeof metadataValue !== 'string' || metadataValue.trim().length === 0) {
            return undefined;
        }

        try {
            const metadata = JSON.parse(metadataValue);
            const codebasePath = metadata?.codebasePath;
            return typeof codebasePath === 'string' && codebasePath.trim().length > 0
                ? codebasePath
                : undefined;
        } catch {
            return undefined;
        }
    }

    private async resolveCollectionCodebasePath(
        vectorDb: any,
        collectionName: string,
        byCollectionName: Map<string, string>
    ): Promise<string | undefined> {
        const knownPath = byCollectionName.get(collectionName);
        if (knownPath) {
            return knownPath;
        }

        try {
            const results = await vectorDb.query(collectionName, '', ['metadata'], 1);
            if (!Array.isArray(results) || results.length === 0) {
                return undefined;
            }

            return this.parseCodebaseFromMetadata(results[0]?.metadata);
        } catch {
            return undefined;
        }
    }

    private formatCollectionTimestamp(createdAt?: string): string {
        if (!createdAt) {
            return '[unknown]';
        }

        const timestamp = Date.parse(createdAt);
        if (!Number.isFinite(timestamp)) {
            return createdAt;
        }

        return new Date(timestamp).toISOString();
    }

    private async buildZillizCollectionLimitGuidance(targetCodebasePath: string): Promise<string> {
        const targetCollectionName = this.context.resolveCollectionName(targetCodebasePath);
        const vectorDb = this.getVectorStore();
        const collectionDetails = await this.listCollectionDetailsWithFallback(vectorDb);
        const codeCollections = collectionDetails.filter((detail) => this.isSatoriCodeCollection(detail.name));

        const trackedCodebases = this.snapshotManager.getAllCodebases().map((entry) => entry.path);
        const byCollectionName = new Map<string, string>();
        for (const codebasePath of trackedCodebases) {
            byCollectionName.set(this.context.resolveCollectionName(codebasePath), codebasePath);
        }

        const candidates: CandidateCollection[] = [];
        for (const detail of codeCollections) {
            const codebasePath = await this.resolveCollectionCodebasePath(vectorDb, detail.name, byCollectionName);
            candidates.push({
                name: detail.name,
                createdAt: detail.createdAt,
                codebasePath,
                isTargetCollection: detail.name === targetCollectionName,
            });
        }

        candidates.sort((a, b) => {
            const aTime = a.createdAt ? Date.parse(a.createdAt) : NaN;
            const bTime = b.createdAt ? Date.parse(b.createdAt) : NaN;
            const aValid = Number.isFinite(aTime);
            const bValid = Number.isFinite(bTime);
            if (aValid && bValid) {
                return aTime - bTime;
            }
            if (aValid) return -1;
            if (bValid) return 1;
            return a.name.localeCompare(b.name);
        });

        const oldestName = candidates.length > 0 ? candidates[0].name : undefined;
        const newestName = candidates.length > 1 ? candidates[candidates.length - 1].name : oldestName;
        const lines = candidates.map((candidate, index) => {
            const codebaseInfo = candidate.codebasePath ? candidate.codebasePath : '[unknown]';
            const labels: string[] = [];
            if (candidate.name === oldestName) labels.push('oldest');
            if (candidate.name === newestName) labels.push('newest');
            if (candidate.isTargetCollection) labels.push('target');
            const labelText = labels.length > 0 ? ` [${labels.join(', ')}]` : '';
            return `${index + 1}. ${candidate.name}${labelText} | codebase: ${codebaseInfo} | created: ${this.formatCollectionTimestamp(candidate.createdAt)}`;
        });

        const suggestions = lines.length > 0
            ? lines.join('\n')
            : 'No Satori-managed collections were discovered.';

        return `${COLLECTION_LIMIT_MESSAGE}

Reason: Zilliz free-tier clusters are capped at ${ZILLIZ_FREE_TIER_COLLECTION_LIMIT} collections, and this cluster has no remaining collection slots.
Target codebase: '${targetCodebasePath}'
Target collection: '${targetCollectionName}'

Current Satori-managed collections (oldest -> newest):
${suggestions}

To continue, choose one collection from the list and retry:
manage_index {"action":"create","path":"${targetCodebasePath}","zillizDropCollection":"<collection_name>"}

Agent instructions:
1. Show this list to the user and ask which collection to delete.
2. Do not auto-delete without explicit user confirmation.
3. Retry create with zillizDropCollection set to the exact chosen collection name.`;
    }

    private async buildCollectionLimitMessage(targetCodebasePath: string): Promise<string> {
        if (!this.isZillizBackend()) {
            return COLLECTION_LIMIT_MESSAGE;
        }

        try {
            return await this.buildZillizCollectionLimitGuidance(targetCodebasePath);
        } catch (error) {
            console.warn(`[INDEX-VALIDATION] Failed to build Zilliz collection guidance: ${formatUnknownError(error)}`);
            return COLLECTION_LIMIT_MESSAGE;
        }
    }

    private async clearAllCollectionsForForceReindex(codebasePath: string): Promise<string[]> {
        const vectorDb = this.getVectorStore();
        const resolvedCollectionName = this.context.resolveCollectionName(codebasePath);
        const hash = resolvedCollectionName.split('_').pop();

        const candidateNames = new Set<string>();
        if (hash) {
            candidateNames.add(`code_chunks_${hash}`);
            candidateNames.add(`hybrid_code_chunks_${hash}`);
        }
        candidateNames.add(resolvedCollectionName);

        try {
            const cloudCollections = await this.listCollectionDetailsWithFallback(vectorDb);
            for (const collection of cloudCollections) {
                if (!this.isSatoriCodeCollection(collection.name)) {
                    continue;
                }
                if (hash && collection.name.endsWith(`_${hash}`)) {
                    candidateNames.add(collection.name);
                }
            }
        } catch (error) {
            console.warn(`[FORCE-REINDEX] Failed to list cloud collections while preparing cleanup: ${formatUnknownError(error)}`);
        }

        const droppedCollections: string[] = [];
        for (const candidateName of candidateNames) {
            try {
                if (await vectorDb.hasCollection(candidateName)) {
                    await vectorDb.dropCollection(candidateName);
                    droppedCollections.push(candidateName);
                }
            } catch (error) {
                console.warn(`[FORCE-REINDEX] Failed to drop collection '${candidateName}': ${formatUnknownError(error)}`);
            }
        }

        // Ensure local Merkle/snapshot state is cleared for this codebase.
        try {
            await this.context.clearIndex(codebasePath);
        } catch (error) {
            console.warn(`[FORCE-REINDEX] Failed to clear local sync snapshot for '${codebasePath}': ${formatUnknownError(error)}`);
        }

        return droppedCollections;
    }

    private async dropZillizCollectionForCreate(collectionName: string): Promise<{ droppedCodebasePath?: string }> {
        const trimmedName = collectionName.trim();
        if (trimmedName.length === 0) {
            throw new Error('zillizDropCollection must be a non-empty string.');
        }

        if (!this.isSatoriCodeCollection(trimmedName)) {
            throw new Error(`zillizDropCollection '${trimmedName}' is not a Satori-managed collection (expected prefix ${SATORI_COLLECTION_PREFIXES.join(' or ')}).`);
        }

        const vectorDb = this.getVectorStore();
        if (!await vectorDb.hasCollection(trimmedName)) {
            throw new Error(`Collection '${trimmedName}' does not exist in the connected Zilliz cluster.`);
        }

        const droppedCodebasePath = await this.resolveCollectionCodebasePath(vectorDb, trimmedName, new Map());
        await vectorDb.dropCollection(trimmedName);

        if (droppedCodebasePath) {
            this.snapshotManager.removeCodebaseCompletely(droppedCodebasePath);
            this.snapshotManager.saveCodebaseSnapshot();
            try {
                await this.syncManager.unregisterCodebaseWatcher(droppedCodebasePath);
            } catch {
                // Best-effort watcher cleanup; dropping cloud collection remains successful.
            }
        }

        return { droppedCodebasePath };
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * gets the first document from each collection to extract codebasePath from metadata,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorStore();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud`);
                // If no collections in cloud, remove all local codebases
                const localCodebases = this.snapshotManager.getIndexedCodebases();
                if (localCodebases.length > 0) {
                    console.log(`[SYNC-CLOUD] 🧹 Removing ${localCodebases.length} local codebases as cloud has no collections`);
                    for (const codebasePath of localCodebases) {
                        this.snapshotManager.removeIndexedCodebase(codebasePath);
                        console.log(`[SYNC-CLOUD] ➖ Removed local codebase: ${codebasePath}`);
                    }
                    this.snapshotManager.saveCodebaseSnapshot();
                    console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match empty cloud state`);
                }
                return;
            }

            const cloudCodebases = new Set<string>();

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Query the first document to get metadata
                    const results = await vectorDb.query(
                        collectionName,
                        '', // Empty filter to get all results
                        ['metadata'], // Only fetch metadata field
                        1 // Only need one result to extract codebasePath
                    );

                    if (results && results.length > 0) {
                        const firstResult = results[0];
                        const metadataStr = firstResult.metadata;

                        if (metadataStr) {
                            try {
                                const metadata = JSON.parse(metadataStr);
                                const codebasePath = metadata.codebasePath;

                                if (codebasePath && typeof codebasePath === 'string') {
                                    console.log(`[SYNC-CLOUD] 📍 Found codebase path: ${codebasePath} in collection: ${collectionName}`);
                                    cloudCodebases.add(codebasePath);
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                }
                            } catch (parseError) {
                                console.warn(`[SYNC-CLOUD] ⚠️  Failed to parse metadata JSON for collection ${collectionName}:`, parseError);
                            }
                        } else {
                            console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                        }
                    } else {
                        console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud`);

            // Get current local codebases
            const localIndexedCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localIndexedCodebases.size} locally indexed codebases in snapshot`);

            // Get codebases that are currently indexing (might have been interrupted)
            const indexingCodebases = this.snapshotManager.getIndexingCodebases();
            console.log(`[SYNC-CLOUD] 📊 Found ${indexingCodebases.length} codebases currently indexing`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localIndexedCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeIndexedCodebase(localCodebase);
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // FIX: Mark interrupted indexing codebases as indexed if they exist in cloud
            // This handles the case where indexing was interrupted but cloud index is complete
            for (const codebasePath of indexingCodebases) {
                if (cloudCodebases.has(codebasePath)) {
                    console.log(`[SYNC-CLOUD] 🔄 Marking interrupted indexing codebase as indexed: ${codebasePath}`);
                    // Get the last known stats from the snapshot info
                    const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                    const indexedFiles = (info as any)?.indexedFiles || 0;
                    const totalChunks = (info as any)?.totalChunks || 0;

                    // Mark as indexed with known stats
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles,
                        totalChunks,
                        status: 'completed'
                    }, this.runtimeFingerprint, 'verified');
                    hasChanges = true;
                } else if (await this.context.hasIndexedCollection(codebasePath)) {
                    // Double-check with hasIndexedCollection method
                    console.log(`[SYNC-CLOUD] 🔄 hasIndexedCollection confirms cloud index exists for: ${codebasePath}`);
                    const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                    const indexedFiles = (info as any)?.indexedFiles || 0;
                    const totalChunks = (info as any)?.totalChunks || 0;

                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles,
                        totalChunks,
                        status: 'completed'
                    }, this.runtimeFingerprint, 'verified');
                    hasChanges = true;
                }
            }

            // Note: We don't add cloud codebases that are missing locally (as per user requirement)
            console.log(`[SYNC-CLOUD] ℹ️  Skipping addition of cloud codebases not present locally (per sync policy)`);

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, formatUnknownError(error));
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns, zillizDropCollection } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];
        const requestedDropCollection = typeof zillizDropCollection === 'string' ? zillizDropCollection.trim() : undefined;
        let dropSummaryLine = '';

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (splitterType !== 'ast' && splitterType !== 'langchain') {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${splitterType}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                    }],
                    isError: true
                };
            }

            const existingInfo = this.snapshotManager.getCodebaseInfo(absolutePath);
            if (!forceReindex && existingInfo?.status === 'requires_reindex') {
                return {
                    content: [{
                        type: "text",
                        text: this.buildReindexInstruction(absolutePath, existingInfo.message)
                    }],
                    isError: true
                };
            }

            //Check if the snapshot and cloud index are in sync
            if (this.snapshotManager.getIndexedCodebases().includes(absolutePath) !== await this.context.hasIndexedCollection(absolutePath)) {
                console.warn(`[INDEX-VALIDATION] ❌ Snapshot and cloud index mismatch: ${absolutePath}`);
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed.

To update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.
To force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`
                    }],
                    isError: true
                };
            }

            // If force reindex, always clear every previous collection for this codebase hash.
            if (forceReindex) {
                console.log(`[FORCE-REINDEX] 🔄 Preparing force cleanup for '${absolutePath}'`);
                this.snapshotManager.removeCodebaseCompletely(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                try {
                    await this.syncManager.unregisterCodebaseWatcher(absolutePath);
                } catch {
                    // Best-effort watcher cleanup before force rebuild.
                }

                const droppedCollections = await this.clearAllCollectionsForForceReindex(absolutePath);
                if (droppedCollections.length > 0) {
                    const sortedDroppedCollections = [...droppedCollections].sort();
                    dropSummaryLine += `\nForce reindex cleanup dropped ${sortedDroppedCollections.length} prior collection(s) for this codebase hash: ${sortedDroppedCollections.join(', ')}.`;
                } else {
                    dropSummaryLine += `\nForce reindex cleanup found no prior collections for this codebase hash.`;
                }
            }

            if (requestedDropCollection) {
                if (!this.isZillizBackend()) {
                    return {
                        content: [{
                            type: "text",
                            text: "Error: zillizDropCollection is only supported when connected to a Zilliz Cloud backend."
                        }],
                        isError: true
                    };
                }

                const targetCollectionName = this.context.resolveCollectionName(absolutePath);
                if (requestedDropCollection === targetCollectionName) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: zillizDropCollection cannot target '${targetCollectionName}' for this same codebase create flow. Use {"action":"create","path":"${absolutePath}","force":true} for reindexing this codebase.`
                        }],
                        isError: true
                    };
                }

                const dropResult = await this.dropZillizCollectionForCreate(requestedDropCollection);
                dropSummaryLine += dropResult.droppedCodebasePath
                    ? `\nDropped Zilliz collection '${requestedDropCollection}' (mapped codebase: '${dropResult.droppedCodebasePath}').`
                    : `\nDropped Zilliz collection '${requestedDropCollection}'.`;
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorStore().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);
                    const guidanceMessage = await this.buildCollectionLimitMessage(absolutePath);
                    return {
                        content: [{
                            type: "text",
                            text: guidanceMessage
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                if (isCollectionLimitError(validationError)) {
                    const guidanceMessage = await this.buildCollectionLimitMessage(absolutePath);
                    return {
                        content: [{
                            type: "text",
                            text: guidanceMessage
                        }],
                        isError: true
                    };
                }

                const validationMessage = formatUnknownError(validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationMessage}`
                    }],
                    isError: true
                };
            }

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${dropSummaryLine}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);
            const errorMessage = formatUnknownError(error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, splitterType: string) {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            // Use the existing Context instance for indexing.
            let contextForThisTask = this.context;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            await this.context.loadResolvedIgnorePatterns(absolutePath);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            const { FileSynchronizer } = await import("@zokizuan/satori-core");
            const ignorePatterns = this.context.getActiveIgnorePatterns() || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.ensureCollectionPrepared(absolutePath);
            const collectionName = this.context.resolveCollectionName(absolutePath);
            this.context.registerSynchronizer(collectionName, synchronizer);
            if (contextForThisTask !== this.context) {
                contextForThisTask.registerSynchronizer(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const encoderEngine = this.context.getEmbeddingEngine();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${encoderEngine.getProvider()} with dimension: ${encoderEngine.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.runtimeFingerprint, 'verified');
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();
            await this.syncManager.registerCodebaseWatcher(absolutePath);

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.buildCollectionLimitMessage(absolutePath);
            }
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter, excludePatterns, useIgnoreFiles = true, returnRaw = false, showScores = false } = args;
        const resultLimit = limit || 10;
        const searchDiagnostics = {
            queryLength: typeof query === 'string' ? query.length : 0,
            limitRequested: resultLimit,
            resultsBeforeFilter: 0,
            resultsAfterFilter: 0,
            excludedByIgnore: 0,
            excludedBySubdirectory: 0,
            filterPass: 'initial' as 'initial' | 'expanded',
        };

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            const blockedRoot = this.getMatchingBlockedRoot(absolutePath);
            if (blockedRoot) {
                return {
                    content: [{
                        type: "text",
                        text: this.buildReindexInstruction(blockedRoot.path, blockedRoot.message)
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed or being indexed
            // Smart Path Resolution: Check if indexed, or if a parent is indexed
            let effectiveRoot = absolutePath;
            let subdirectoryFilter: string | null = null;

            let isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            let isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                // Try to find an indexed parent
                const indexedCodebases = this.snapshotManager.getIndexedCodebases();
                const parents = indexedCodebases.filter(root => absolutePath.startsWith(root) && absolutePath !== root);

                if (parents.length > 0) {
                    // Sort by length desc (longest match is closest parent)
                    parents.sort((a: string, b: string) => b.length - a.length);
                    effectiveRoot = parents[0];
                    subdirectoryFilter = absolutePath;
                    isIndexed = true;
                    isIndexing = this.snapshotManager.getIndexingCodebases().includes(effectiveRoot);
                    console.log(`[SEARCH] Auto-resolved subdirectory '${absolutePath}' to indexed root '${effectiveRoot}'`);
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Codebase '${absolutePath}' (or any parent) is not indexed. Call manage_index with {"action":"create","path":"${absolutePath}"} to index it first.`
                        }],
                        isError: true
                    };
                }
            }

            const gateResult = this.enforceFingerprintGate(effectiveRoot);
            if (gateResult.blockedResponse) {
                return gateResult.blockedResponse;
            }

            // Sync Optimization: Ensure freshness (Smart Sync-on-Read)
            // This handles the "call 5 tools, only 1 syncs" requirement via coalescing
            await this.syncManager.ensureFreshness(effectiveRoot, 3 * 60 * 1000); // 3 minute threshold matching auto-sync

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const encoderEngine = this.context.getEmbeddingEngine();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${encoderEngine.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${encoderEngine.getProvider()}...`);

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use proper extensions like '.ts', '.py'.` }],
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // Add query-time excludes (even if already indexed)
            const mergedExcludePatterns: string[] = [];
            if (Array.isArray(excludePatterns)) {
                for (const p of excludePatterns) {
                    if (typeof p === 'string') mergedExcludePatterns.push(p);
                }
            }

            // Also apply repo-root ignore files at search-time (opt-out)
            if (useIgnoreFiles !== false) {
                try {
                    const ignoreFiles = await fs.promises.readdir(effectiveRoot, { withFileTypes: true });
                    const ignoreFileNames = ignoreFiles
                        .filter((e: any) => e.isFile && e.isFile())
                        .map((e: any) => e.name)
                        .filter((name: string) => name.startsWith('.') && name.endsWith('ignore'));

                    for (const name of ignoreFileNames) {
                        if (mergedExcludePatterns.length > 200) break;
                        const filePath = path.join(effectiveRoot, name);
                        const patterns = await Context.getIgnorePatternsFromFile(filePath);
                        for (const pat of patterns) {
                            if (mergedExcludePatterns.length > 200) break;
                            mergedExcludePatterns.push(pat);
                        }
                    }
                } catch (e) {
                    // Ignore missing permissions / read errors for ignore files at search time.
                }
            }

            const excludeBuilt = this.buildSearchExcludeMatcher(mergedExcludePatterns, effectiveRoot, absolutePath);
            const relativeFilter = subdirectoryFilter
                ? path.relative(effectiveRoot, subdirectoryFilter).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
                : null;
            const MAX_SEARCH_CANDIDATES = 50;
            const initialCandidateLimit = Math.max(
                1,
                Math.min(MAX_SEARCH_CANDIDATES, Math.max(resultLimit * 4, resultLimit + 20))
            );

            const applyPostFilters = (results: any[], stageLabel: string, pass: 'initial' | 'expanded'): any[] => {
                let filteredResults = this.applySearchExcludeMatcher(results, excludeBuilt.matcher);
                const excludedByIgnore = results.length - filteredResults.length;
                if (excludeBuilt.matcher && filteredResults.length !== results.length) {
                    console.log(`[SEARCH] ${stageLabel}: excludePatterns filtered ${results.length} -> ${filteredResults.length}`);
                }

                let excludedBySubdirectory = 0;
                if (relativeFilter) {
                    const beforeSubdirectoryFilter = filteredResults.length;
                    filteredResults = filteredResults.filter((r: any) => {
                        if (!r || typeof r.relativePath !== 'string') return false;
                        const normalizedPath = r.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
                        return normalizedPath === relativeFilter || normalizedPath.startsWith(`${relativeFilter}/`);
                    });
                    excludedBySubdirectory = beforeSubdirectoryFilter - filteredResults.length;
                    if (beforeSubdirectoryFilter !== filteredResults.length) {
                        console.log(`[SEARCH] ${stageLabel}: subdirectory filter '${relativeFilter}' trimmed ${beforeSubdirectoryFilter} -> ${filteredResults.length}`);
                    }
                }

                searchDiagnostics.resultsBeforeFilter = results.length;
                searchDiagnostics.resultsAfterFilter = filteredResults.length;
                searchDiagnostics.excludedByIgnore = Math.max(0, excludedByIgnore);
                searchDiagnostics.excludedBySubdirectory = Math.max(0, excludedBySubdirectory);
                searchDiagnostics.filterPass = pass;

                return filteredResults;
            };

            // Search in the specified codebase (or resolved parent)
            let rawSearchResults = await this.context.semanticSearch(
                effectiveRoot,
                query,
                initialCandidateLimit,
                0.3,
                filterExpr
            );
            let searchResults = applyPostFilters(rawSearchResults, 'Initial pass', 'initial');

            // If post-filtering under-fills, expand candidate pool once to improve recall.
            if (
                searchResults.length < resultLimit &&
                initialCandidateLimit < MAX_SEARCH_CANDIDATES &&
                (excludeBuilt.matcher || relativeFilter)
            ) {
                rawSearchResults = await this.context.semanticSearch(
                    effectiveRoot,
                    query,
                    MAX_SEARCH_CANDIDATES,
                    0.3,
                    filterExpr
                );
                searchResults = applyPostFilters(rawSearchResults, 'Expanded pass', 'expanded');
            }

            if (searchResults.length > resultLimit) {
                searchResults = searchResults.slice(0, resultLimit);
            }

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${encoderEngine.getProvider()} embeddings`);

            if (excludeBuilt.warning) {
                console.log(`[SEARCH] ⚠️  ${excludeBuilt.warning}`);
            }

            if (searchResults.length === 0) {
                let noResultsMessage = `No results found for query: "${query}" in codebase '${absolutePath}'`;
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }],
                    meta: { searchDiagnostics }
                };
            }

            // If returnRaw is true, return JSON format for reranking
            if (returnRaw) {
                const rawResults = searchResults.map((result: any, index: number) => ({
                    index,
                    location: `${result.relativePath}:${result.startLine}-${result.endLine}`,
                    language: result.language,
                    score: result.score,
                    content: result.content,
                    breadcrumbs: Array.isArray(result.breadcrumbs) ? result.breadcrumbs : undefined,
                    metadata: {
                        breadcrumbs: Array.isArray(result.breadcrumbs) ? result.breadcrumbs : undefined
                    }
                }));

                const status = isIndexing ? 'indexing' : 'ready';

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            query,
                            codebasePath: absolutePath,
                            resultCount: searchResults.length,
                            resultsBeforeFilter: searchDiagnostics.resultsBeforeFilter,
                            resultsAfterFilter: searchDiagnostics.resultsAfterFilter,
                            excludedByIgnore: searchDiagnostics.excludedByIgnore,
                            excludedBySubdirectory: searchDiagnostics.excludedBySubdirectory,
                            filterPass: searchDiagnostics.filterPass,
                            isIndexing,
                            indexingStatus: status,
                            excludePatternsWarning: excludeBuilt.warning,
                            results: rawResults,
                            documentsForReranking: rawResults.map((r: any) => r.content)
                        }, null, 2)
                    }],
                    meta: { searchDiagnostics }
                };
            }

            // Optimize: Merge overlapping/adjacent chunks to provide better context
            // This solves the issue of fragmented snippets for large functions
            const mergedResults: any[] = [];
            const processedFiles = new Set<string>();

            // Sort by score to prioritize high relevance, but process by file group
            const sortedByScore = [...searchResults].sort((a: any, b: any) => b.score - a.score);

            for (const result of sortedByScore) {
                if (processedFiles.has(result.relativePath)) continue;

                // Find all relevant chunks for this file from the original search results
                // We want to merge all chunks that are close to each other
                const fileChunks = searchResults.filter((r: any) => r.relativePath === result.relativePath);

                if (fileChunks.length > 1) {
                    // Sort by line number
                    fileChunks.sort((a: any, b: any) => a.startLine - b.startLine);

                    const clusters: any[][] = [];
                    let currentCluster = [fileChunks[0]];

                    for (let i = 1; i < fileChunks.length; i++) {
                        const previous = currentCluster[currentCluster.length - 1];
                        const sameScope =
                            this.getBreadcrumbMergeKey(fileChunks[i]?.breadcrumbs) ===
                            this.getBreadcrumbMergeKey(previous?.breadcrumbs);

                        // Merge if within 20 lines (context window)
                        if (fileChunks[i].startLine <= previous.endLine + 20 && sameScope) {
                            currentCluster.push(fileChunks[i]);
                        } else {
                            clusters.push(currentCluster);
                            currentCluster = [fileChunks[i]];
                        }
                    }
                    clusters.push(currentCluster);

                    // Create merged result for each cluster
                    for (const cluster of clusters) {
                        const start = cluster[0].startLine;
                        const end = cluster[cluster.length - 1].endLine;
                        const maxScore = Math.max(...cluster.map((c: any) => c.score));
                        const representative = cluster.reduce((best: any, candidate: any) => (
                            candidate.score > best.score ? candidate : best
                        ), cluster[0]);

                        let mergedContent = "";
                        try {
                            const filePath = path.join(absolutePath, result.relativePath);
                            if (fs.existsSync(filePath)) {
                                const fileContent = fs.readFileSync(filePath, 'utf-8');
                                const lines = fileContent.split('\n');
                                // Ensure bounds
                                const startIdx = Math.max(0, start - 1);
                                const endIdx = Math.min(lines.length, end);
                                mergedContent = lines.slice(startIdx, endIdx).join('\n');
                            } else {
                                throw new Error("File not found");
                            }
                        } catch (e) {
                            // Fallback to joining snippets with divider
                            mergedContent = cluster.map((c: any) => c.content).join('\n\n... (gap) ...\n\n');
                        }

                        mergedResults.push({
                            ...representative, // Keep metadata from highest-scoring chunk in this cluster
                            startLine: start,
                            endLine: end,
                            content: mergedContent,
                            score: maxScore,
                            isMerged: cluster.length > 1
                        });
                    }
                } else {
                    mergedResults.push(result);
                }

                processedFiles.add(result.relativePath);
            }

            // Re-sort final merged results by score
            mergedResults.sort((a, b) => b.score - a.score);

            // Format results (Use mergedResults instead of searchResults)
            const formattedResults = mergedResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const PREVIEW_LIMIT = 4000;
                let context = truncateContent(result.content, PREVIEW_LIMIT);

                // Add explicit hint for agents if content is truncated
                if (context.endsWith('...')) {
                    const fullFilePath = path.join(absolutePath, result.relativePath);
                    // Use forward slashes for cross-platform consistency in agent thought process
                    const cleanPath = fullFilePath.replace(/\\/g, '/');
                    const missingChars = result.content.length - PREVIEW_LIMIT;
                    context += `\n\n(Preview truncated: ${missingChars} more chars. To read full file, call read_file(path='${cleanPath}'))`;
                }

                // Identify exact line matches for query terms
                let matchInfo = "";
                try {
                    const queryTerms = query.toLowerCase().split(/\s+/).filter((t: string) => t.length > 2);
                    if (queryTerms.length > 0) {
                        const matches: number[] = [];
                        const lines = result.content.split('\n');
                        lines.forEach((line: string, i: number) => {
                            const lowerLine = line.toLowerCase();
                            if (queryTerms.some((term: string) => lowerLine.includes(term))) {
                                matches.push(result.startLine + i);
                            }
                        });

                        if (matches.length > 0) {
                            // Deduplicate and limit
                            const unique = [...new Set(matches)].sort((a, b) => a - b);
                            const shown = unique.slice(0, 5).join(', ');
                            matchInfo = `\n   Matches at lines: ${shown}${unique.length > 5 ? '...' : ''}`;
                        }
                    }
                } catch (e) {
                    // Ignore matching errors
                }

                const codebaseInfo = path.basename(absolutePath);

                const scoreInfo = showScores ? ` [Score: ${result.score.toFixed(4)}]` : '';
                const scopeLine = this.formatScopeLine(result.breadcrumbs);

                return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]${scoreInfo}\n` +
                    `   Location: ${location}${matchInfo}\n` +
                    `   Rank: ${index + 1}\n` +
                    scopeLine +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${absolutePath}'${indexingStatusMessage}\n\n${formattedResults}`;

            if (excludeBuilt.warning) {
                resultMessage = `${excludeBuilt.warning}\n\n${resultMessage}`;
            }

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
                resultMessage += `\nStatus: 🔄 Indexing in progress`;
            } else {
                resultMessage += `\nStatus: ✅ Indexing complete`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }],
                meta: { searchDiagnostics }
            };
        } catch (error) {
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getAllCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently tracked."
                }]
            };
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const isRequiresReindex = status === 'requires_reindex';

            if (!isIndexed && !isIndexing && !isRequiresReindex) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();
            await this.syncManager.unregisterCodebaseWatcher(absolutePath);

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check indexing status using new status system
            const statusGate = this.enforceFingerprintGate(absolutePath);
            if (statusGate.blockedResponse) {
                return statusGate.blockedResponse;
            }

            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);

            let statusMessage = '';

            switch (status) {
                case 'indexed':
                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 Retry with manage_index action='create'.`;
                    } else {
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'sync_completed':
                    if (info && 'added' in info) {
                        const syncInfo = info as any;
                        statusMessage = `🔄 Codebase '${absolutePath}' sync completed.`;
                        statusMessage += `\n📊 Changes: +${syncInfo.added} added, -${syncInfo.removed} removed, ~${syncInfo.modified} modified`;
                        statusMessage += `\n🕐 Last synced: ${new Date(syncInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' sync completed.`;
                    }
                    break;

                case 'requires_reindex':
                    statusMessage = this.buildReindexInstruction(absolutePath, info && 'message' in info ? info.message : undefined);
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Call manage_index with {\"action\":\"create\",\"path\":\"${absolutePath}\"} to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * Handle sync request - manually trigger incremental sync for a codebase
     */
    public async handleSyncCodebase(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed
            const syncGate = this.enforceFingerprintGate(absolutePath);
            if (syncGate.blockedResponse) {
                return syncGate.blockedResponse;
            }

            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            if (!isIndexed) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Call manage_index with {\"action\":\"create\",\"path\":\"${absolutePath}\"} first.`
                    }],
                    isError: true
                };
            }

            console.log(`[SYNC] Manually triggering incremental sync for: ${absolutePath}`);

            // Perform incremental sync
            const syncStats = await this.context.reindexByChange(absolutePath);

            // Store sync result in snapshot
            this.snapshotManager.setCodebaseSyncCompleted(absolutePath, syncStats, this.runtimeFingerprint, 'verified');
            this.snapshotManager.saveCodebaseSnapshot();

            const totalChanges = syncStats.added + syncStats.removed + syncStats.modified;

            if (totalChanges === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `✅ No changes detected for codebase '${absolutePath}'. Index is up to date.`
                    }]
                };
            }

            const resultMessage = `🔄 Incremental sync completed for '${absolutePath}'.\n\n📊 Changes:\n+ ${syncStats.added} file(s) added\n- ${syncStats.removed} file(s) removed\n~ ${syncStats.modified} file(s) modified\n\nTotal changes: ${totalChanges}`;

            console.log(`[SYNC] ✅ Sync completed: +${syncStats.added}, -${syncStats.removed}, ~${syncStats.modified}`);

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };

        } catch (error: any) {
            console.error(`[SYNC] Error during sync:`, error);
            return {
                content: [{
                    type: "text",
                    text: `Error syncing codebase: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
    public async handleReadCode(args: any) {
        const { path: filePath } = args;

        try {
            const absolutePath = ensureAbsolutePath(filePath);

            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{ type: "text", text: `Error: File '${absolutePath}' not found.` }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isFile()) {
                return {
                    content: [{ type: "text", text: `Error: '${absolutePath}' is not a file.` }],
                    isError: true
                };
            }

            // Read file
            const content = fs.readFileSync(absolutePath, 'utf-8');

            return {
                content: [{
                    type: "text",
                    text: content
                }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error reading file: ${error.message}` }],
                isError: true
            };
        }
    }
}
