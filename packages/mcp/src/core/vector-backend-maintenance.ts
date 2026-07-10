import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    deleteCollectionWithVerification,
    type VectorDatabase,
} from "@zokizuan/satori-core";
import path from "node:path";
import type { SnapshotManager } from "./snapshot.js";
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from "./mutation-lease.js";

const SATORI_COLLECTION_PREFIXES = ["code_chunks_", "hybrid_code_chunks_"];
const MIN_RELIABLE_COLLECTION_CREATED_AT_MS = Date.UTC(2000, 0, 1);

type CandidateCollection = {
    name: string;
    createdAt?: string;
    codebasePath?: string;
    isTargetCollection: boolean;
    sortTimestampMs?: number;
};

type CollectionDetailsView = {
    name: string;
    createdAt?: string;
};

type VectorStoreBackendInfoView = {
    provider: "milvus" | "zilliz";
    transport: "grpc" | "rest";
    address?: string;
};

type VectorBackendMaintenanceHost = {
    context: Context;
    snapshotManager: SnapshotManager;
    getSnapshotAllCodebases(): Array<{ path: string; info: { lastUpdated?: string } }>;
    canonicalizeCodebasePath(codebasePath: string): string;
    resolveCollectionName(codebasePath: string): string;
    markCodebaseCleared(codebasePath: string, collectionName?: string): void;
    saveSnapshotIfSupported(): void;
    unwatchCodebase(codebasePath: string): Promise<void>;
    mutationLeaseCoordinator: MutationLeaseCoordinator | null;
};

export type ZillizCollectionDropResult =
    | { status: "dropped"; droppedCodebasePath?: string }
    | { status: "blocked"; activeLease: RootMutationLease }
    | { status: "unmapped" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export class VectorBackendMaintenance {
    constructor(private readonly host: VectorBackendMaintenanceHost) {}

    private getVectorStore(): VectorDatabase {
        return this.host.context.getVectorStore();
    }

    private isSatoriCodeCollection(collectionName: string): boolean {
        return SATORI_COLLECTION_PREFIXES.some((prefix) => collectionName.startsWith(prefix));
    }

    private getVectorBackendInfo(): VectorStoreBackendInfoView | null {
        const vectorDb = this.getVectorStore();
        if (typeof vectorDb.getBackendInfo !== "function") {
            return null;
        }

        try {
            const info = vectorDb.getBackendInfo();
            if (!info || typeof info !== "object") {
                return null;
            }

            if (info.provider !== "milvus" && info.provider !== "zilliz") {
                return null;
            }

            if (info.transport !== "grpc" && info.transport !== "rest") {
                return null;
            }

            return {
                provider: info.provider,
                transport: info.transport,
                address: typeof info.address === "string" ? info.address : undefined,
            };
        } catch {
            return null;
        }
    }

    private async listCollectionDetailsWithFallback(vectorDb: VectorDatabase): Promise<CollectionDetailsView[]> {
        if (typeof vectorDb.listCollectionDetails === "function") {
            const details = await vectorDb.listCollectionDetails();
            if (Array.isArray(details)) {
                return details
                    .filter((detail): detail is CollectionDetailsView => Boolean(detail && typeof detail.name === "string" && detail.name.length > 0))
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
            .filter((name): name is string => typeof name === "string" && name.length > 0)
            .map((name) => ({ name }));
    }

    private parseCodebaseFromMetadata(metadataValue: unknown): string | null | undefined {
        if (typeof metadataValue !== "string" || metadataValue.trim().length === 0) {
            return undefined;
        }

        try {
            const metadata: unknown = JSON.parse(metadataValue);
            const codebasePath = isRecord(metadata) ? metadata.codebasePath : undefined;
            if (typeof codebasePath !== "string" || codebasePath.trim().length === 0) {
                return undefined;
            }
            const trimmedPath = codebasePath.trim();
            return path.isAbsolute(trimmedPath)
                ? this.host.canonicalizeCodebasePath(trimmedPath)
                : null;
        } catch {
            return null;
        }
    }

    private buildSnapshotCollectionOwnership(): {
        byCollectionName: Map<string, string>;
        ambiguousCollections: Set<string>;
    } {
        const byCollectionName = new Map<string, string>();
        const ambiguousCollections = new Set<string>();
        for (const entry of this.host.getSnapshotAllCodebases()) {
            const canonicalRoot = this.host.canonicalizeCodebasePath(entry.path);
            const collectionName = this.host.resolveCollectionName(canonicalRoot);
            const existingRoot = byCollectionName.get(collectionName);
            if (existingRoot && existingRoot !== canonicalRoot) {
                byCollectionName.delete(collectionName);
                ambiguousCollections.add(collectionName);
                continue;
            }
            if (!ambiguousCollections.has(collectionName)) {
                byCollectionName.set(collectionName, canonicalRoot);
            }
        }
        return { byCollectionName, ambiguousCollections };
    }

    private async resolveCollectionCodebasePath(
        vectorDb: VectorDatabase,
        collectionName: string,
        byCollectionName: Map<string, string>,
        ambiguousCollections: Set<string>,
    ): Promise<string | undefined> {
        if (ambiguousCollections.has(collectionName)) {
            return undefined;
        }
        const knownPath = byCollectionName.get(collectionName);

        try {
            const results = await vectorDb.query(collectionName, "", ["metadata"], 1);
            if (!Array.isArray(results) || results.length === 0) {
                return knownPath;
            }

            const remotePath = this.parseCodebaseFromMetadata(results[0]?.metadata);
            if (remotePath === null) {
                return undefined;
            }
            if (!remotePath) {
                return knownPath;
            }
            if (knownPath && knownPath !== remotePath) {
                return undefined;
            }
            return remotePath;
        } catch {
            return undefined;
        }
    }

    private formatCollectionTimestamp(createdAt?: string): string {
        if (!createdAt) {
            return "[unknown]";
        }

        const timestamp = Date.parse(createdAt);
        if (!Number.isFinite(timestamp)) {
            return createdAt;
        }

        return new Date(timestamp).toISOString();
    }

    private parseTimestampMs(timestamp?: string): number | undefined {
        if (!timestamp) {
            return undefined;
        }

        const parsed = Date.parse(timestamp);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private resolveCollectionSortTimestampMs(
        createdAt: string | undefined,
        codebasePath: string | undefined,
        snapshotLastUpdatedByPath: Map<string, number>,
    ): number | undefined {
        const createdAtMs = this.parseTimestampMs(createdAt);
        const snapshotMs = codebasePath ? snapshotLastUpdatedByPath.get(codebasePath) : undefined;

        if (createdAtMs !== undefined && createdAtMs >= MIN_RELIABLE_COLLECTION_CREATED_AT_MS) {
            return createdAtMs;
        }

        if (snapshotMs !== undefined) {
            return snapshotMs;
        }

        return createdAtMs;
    }

    private async buildZillizCollectionLimitGuidance(targetCodebasePath: string): Promise<string> {
        const targetCollectionName = this.host.resolveCollectionName(targetCodebasePath);
        const vectorDb = this.getVectorStore();
        const collectionDetails = await this.listCollectionDetailsWithFallback(vectorDb);
        const codeCollections = collectionDetails.filter((detail) => this.isSatoriCodeCollection(detail.name));

        const { byCollectionName, ambiguousCollections } = this.buildSnapshotCollectionOwnership();

        const snapshotLastUpdatedByPath = new Map<string, number>();
        for (const entry of this.host.getSnapshotAllCodebases()) {
            const lastUpdatedMs = this.parseTimestampMs(entry.info.lastUpdated);
            if (lastUpdatedMs !== undefined) {
                snapshotLastUpdatedByPath.set(entry.path, lastUpdatedMs);
            }
        }

        const candidates: CandidateCollection[] = [];
        for (const detail of codeCollections) {
            const codebasePath = await this.resolveCollectionCodebasePath(
                vectorDb,
                detail.name,
                byCollectionName,
                ambiguousCollections,
            );
            candidates.push({
                name: detail.name,
                createdAt: detail.createdAt,
                codebasePath,
                isTargetCollection: detail.name === targetCollectionName,
                sortTimestampMs: this.resolveCollectionSortTimestampMs(
                    detail.createdAt,
                    codebasePath,
                    snapshotLastUpdatedByPath,
                ),
            });
        }

        candidates.sort((a, b) => {
            const aValid = Number.isFinite(a.sortTimestampMs);
            const bValid = Number.isFinite(b.sortTimestampMs);
            if (aValid && bValid) {
                return (a.sortTimestampMs as number) - (b.sortTimestampMs as number);
            }
            if (aValid) return -1;
            if (bValid) return 1;
            return a.name.localeCompare(b.name);
        });

        const oldestName = candidates.length > 0 ? candidates[0].name : undefined;
        const newestName = candidates.length > 1 ? candidates[candidates.length - 1].name : oldestName;
        const lines = candidates.map((candidate, index) => {
            const codebaseInfo = candidate.codebasePath ? candidate.codebasePath : "[unknown]";
            const labels: string[] = [];
            if (candidate.name === oldestName) labels.push("oldest");
            if (candidate.name === newestName) labels.push("newest");
            if (candidate.isTargetCollection) labels.push("target");
            const labelText = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
            return `${index + 1}. ${candidate.name}${labelText} | codebase: ${codebaseInfo} | created: ${this.formatCollectionTimestamp(candidate.createdAt)}`;
        });

        const suggestions = lines.length > 0
            ? lines.join("\n")
            : "No Satori-managed collections were discovered.";

        return `${COLLECTION_LIMIT_MESSAGE}

Reason: The connected Zilliz cluster has no remaining collection slots.
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

    public isZillizBackend(): boolean {
        const backendInfo = this.getVectorBackendInfo();
        return backendInfo?.provider === "zilliz";
    }

    public async buildCollectionLimitMessage(targetCodebasePath: string): Promise<string> {
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

    public async dropZillizCollectionForCreate(
        collectionName: string,
        createLease?: RootMutationLease,
    ): Promise<ZillizCollectionDropResult> {
        const trimmedName = collectionName.trim();
        if (trimmedName.length === 0) {
            throw new Error("zillizDropCollection must be a non-empty string.");
        }

        if (!this.isSatoriCodeCollection(trimmedName)) {
            throw new Error(`zillizDropCollection '${trimmedName}' is not a Satori-managed collection (expected prefix ${SATORI_COLLECTION_PREFIXES.join(" or ")}).`);
        }

        const vectorDb = this.getVectorStore();
        if (!await vectorDb.hasCollection(trimmedName)) {
            throw new Error(`Collection '${trimmedName}' does not exist in the connected Zilliz cluster.`);
        }

        const { byCollectionName, ambiguousCollections } = this.buildSnapshotCollectionOwnership();
        const droppedCodebasePath = await this.resolveCollectionCodebasePath(
            vectorDb,
            trimmedName,
            byCollectionName,
            ambiguousCollections,
        );
        if (!droppedCodebasePath) {
            return { status: "unmapped" };
        }
        const coordinator = this.host.mutationLeaseCoordinator;
        let droppedRootLease: RootMutationLease | undefined;
        let operationTerminal = false;
        const persistDroppedRootPhase = (phase: import("../config.js").IndexOperationPhase, mutateSnapshot?: () => void): void => {
            if (!droppedRootLease) {
                mutateSnapshot?.();
                if (mutateSnapshot) {
                    this.host.saveSnapshotIfSupported();
                }
                return;
            }
            coordinator?.assertCurrent(droppedRootLease);
            if (typeof this.host.snapshotManager.commitOperationPhase === "function") {
                this.host.snapshotManager.commitOperationPhase(
                    droppedRootLease,
                    phase,
                    mutateSnapshot,
                    () => coordinator?.assertCurrent(droppedRootLease!),
                );
            } else if (phase === "accepted" && typeof this.host.snapshotManager.startOperation === "function") {
                this.host.snapshotManager.startOperation(droppedRootLease);
                mutateSnapshot?.();
                if (this.host.snapshotManager.saveCodebaseSnapshot() === false) {
                    throw new Error(`Failed to persist clear phase '${phase}' for '${droppedCodebasePath}'.`);
                }
            } else if (typeof this.host.snapshotManager.transitionOperation === "function") {
                this.host.snapshotManager.transitionOperation(droppedRootLease, phase);
                mutateSnapshot?.();
                if (this.host.snapshotManager.saveCodebaseSnapshot() === false) {
                    throw new Error(`Failed to persist clear phase '${phase}' for '${droppedCodebasePath}'.`);
                }
            } else {
                mutateSnapshot?.();
                if (mutateSnapshot) {
                    this.host.saveSnapshotIfSupported();
                }
            }
            operationTerminal = phase === "completed" || phase === "failed" || phase === "blocked";
        };

        if (
            coordinator
            && (!createLease || !coordinator.isLeaseForRoot(createLease, droppedCodebasePath))
        ) {
            const leaseResult = coordinator.acquire(droppedCodebasePath, "clear");
            if (!leaseResult.acquired) {
                return { status: "blocked", activeLease: leaseResult.activeLease };
            }
            droppedRootLease = leaseResult.lease;
        }

        try {
            if (droppedRootLease && typeof this.host.snapshotManager.startOperation === "function") {
                persistDroppedRootPhase("accepted");
            }
            if (createLease) {
                coordinator?.assertCurrent(createLease);
            }
            if (droppedRootLease) {
                coordinator?.assertCurrent(droppedRootLease);
                persistDroppedRootPhase("writing");
            }
            await deleteCollectionWithVerification(vectorDb, trimmedName, {
                beforeDropAttempt: () => {
                    if (createLease) {
                        coordinator?.assertCurrent(createLease);
                    }
                    if (droppedRootLease) {
                        coordinator?.assertCurrent(droppedRootLease);
                    }
                },
            });

            if (createLease) {
                coordinator?.assertCurrent(createLease);
            }
            if (droppedRootLease) {
                coordinator?.assertCurrent(droppedRootLease);
                persistDroppedRootPhase("publishing");
            }
            if (droppedCodebasePath) {
                persistDroppedRootPhase("completed", () => {
                    this.host.markCodebaseCleared(droppedCodebasePath, trimmedName);
                });
                try {
                    await this.host.unwatchCodebase(droppedCodebasePath);
                } catch {
                    // Best-effort watcher cleanup; dropping cloud collection remains successful.
                }
            }
        } catch (error) {
            if (droppedRootLease && !operationTerminal && coordinator?.isCurrent(droppedRootLease)) {
                try {
                    persistDroppedRootPhase("failed");
                } catch {
                    // Lease fencing is authoritative; never overwrite a newer writer's receipt.
                }
            }
            throw error;
        } finally {
            if (droppedRootLease) {
                coordinator?.release(droppedRootLease);
            }
        }

        return { status: "dropped", droppedCodebasePath };
    }
}
