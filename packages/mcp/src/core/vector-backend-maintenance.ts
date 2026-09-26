import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    deleteCollectionWithVerification,
    type VectorDatabase,
    SATORI_COLLECTION_FAMILY_PREFIXES,
} from "@zokizuan/satori-core";
import path from "node:path";
import {
    RootMutationInProgressError,
    RootMutationRuntime,
    type MutationOperationPhase,
    type RootMutationActivity,
} from "@zokizuan/satori-core/integration";

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
    canonicalizeCodebasePath(codebasePath: string): string;
    resolveCollectionName(codebasePath: string): string;
    unwatchCodebase(codebasePath: string): Promise<void>;
    mutationRuntime: RootMutationRuntime;
};

export type ZillizCollectionDropResult =
    | { status: "dropped"; droppedCodebasePath?: string }
    | { status: "blocked"; activeMutation: RootMutationActivity }
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
        return SATORI_COLLECTION_FAMILY_PREFIXES.some((prefix) => collectionName.startsWith(prefix));
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
        let metadata: unknown = metadataValue;
        try {
            if (typeof metadataValue === "string") {
                if (metadataValue.trim().length === 0) return undefined;
                metadata = JSON.parse(metadataValue);
            }
        } catch {
            return null;
        }
        const codebasePath = isRecord(metadata) ? metadata.codebasePath : undefined;
        if (typeof codebasePath !== "string" || codebasePath.length === 0) {
            return undefined;
        }
        return path.isAbsolute(codebasePath)
            ? this.host.canonicalizeCodebasePath(codebasePath)
            : null;
    }

    private buildPublicationCollectionOwnership(): {
        byCollectionName: Map<string, string>;
        ambiguousCollections: Set<string>;
    } {
        const byCollectionName = new Map<string, string>();
        const ambiguousCollections = new Set<string>();
        const addOwnership = (collectionName: string, canonicalRoot: string): void => {
            const existingRoot = byCollectionName.get(collectionName);
            if (existingRoot && existingRoot !== canonicalRoot) {
                byCollectionName.delete(collectionName);
                ambiguousCollections.add(collectionName);
                return;
            }
            if (!ambiguousCollections.has(collectionName)) {
                byCollectionName.set(collectionName, canonicalRoot);
            }
        };

        for (const publication of this.host.context.listCurrentPublications()) {
            addOwnership(
                publication.publication.vector.collectionName,
                this.host.canonicalizeCodebasePath(publication.publication.canonicalRoot),
            );
        }
        for (const receipt of this.host.context.listIndexCandidateReceipts()) {
            addOwnership(
                receipt.collectionName,
                this.host.canonicalizeCodebasePath(receipt.canonicalRoot),
            );
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
            const results = await vectorDb.queryDocuments(collectionName, {
                fields: ["metadata"],
                limit: 1,
            });
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
        publicationCreatedAtByPath: Map<string, number>,
    ): number | undefined {
        const createdAtMs = this.parseTimestampMs(createdAt);
        const publicationMs = codebasePath ? publicationCreatedAtByPath.get(codebasePath) : undefined;

        if (createdAtMs !== undefined && createdAtMs >= MIN_RELIABLE_COLLECTION_CREATED_AT_MS) {
            return createdAtMs;
        }

        if (publicationMs !== undefined) {
            return publicationMs;
        }

        return createdAtMs;
    }

    private async buildZillizCollectionLimitGuidance(targetCodebasePath: string): Promise<string> {
        const targetCollectionName = this.host.resolveCollectionName(targetCodebasePath);
        const vectorDb = this.getVectorStore();
        const collectionDetails = await this.listCollectionDetailsWithFallback(vectorDb);
        const codeCollections = collectionDetails.filter((detail) => this.isSatoriCodeCollection(detail.name));

        const { byCollectionName, ambiguousCollections } = this.buildPublicationCollectionOwnership();

        const publicationCreatedAtByPath = new Map<string, number>();
        for (const publication of this.host.context.listCurrentPublications()) {
            const createdAtMs = this.parseTimestampMs(publication.publication.createdAt);
            if (createdAtMs !== undefined) {
                publicationCreatedAtByPath.set(publication.publication.canonicalRoot, createdAtMs);
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
                    publicationCreatedAtByPath,
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

    public async recoverStaleIndexCandidates(codebasePath: string): Promise<Readonly<{
        recoveredCollections: readonly string[];
        clearedReceipts: readonly string[];
    }>> {
        const canonicalRoot = this.host.canonicalizeCodebasePath(codebasePath);
        this.host.mutationRuntime.assertCurrent(canonicalRoot);
        const activeMutation = this.host.mutationRuntime.getActiveMutation(canonicalRoot);
        if (!activeMutation) {
            throw new Error(`No live mutation owns stale candidate recovery for '${canonicalRoot}'.`);
        }

        const receipts = this.host.context.listIndexCandidateReceipts()
            .filter((receipt) => this.host.canonicalizeCodebasePath(receipt.canonicalRoot) === canonicalRoot)
            .filter((receipt) => receipt.operationId !== activeMutation.id);
        const recoveredCollections: string[] = [];
        const clearedReceipts: string[] = [];
        const vectorDb = this.getVectorStore();

        for (const receipt of receipts) {
            this.host.mutationRuntime.assertCurrent(canonicalRoot);
            if (receipt.generation >= activeMutation.generation) {
                throw new Error(
                    `Index candidate '${receipt.operationId}' generation ${receipt.generation} is not older than active generation ${activeMutation.generation} for '${canonicalRoot}'.`,
                );
            }

            if (this.host.context.isPublicationCollectionReferenced(canonicalRoot, receipt.collectionName)) {
                this.host.context.clearIndexCandidateReceiptForCollection(
                    canonicalRoot,
                    receipt.collectionName,
                );
                clearedReceipts.push(receipt.collectionName);
                continue;
            }

            if (await vectorDb.hasCollection(receipt.collectionName)) {
                await deleteCollectionWithVerification(vectorDb, receipt.collectionName, {
                    beforeDropAttempt: () => this.host.mutationRuntime.assertCurrent(canonicalRoot),
                });
                recoveredCollections.push(receipt.collectionName);
            }
            this.host.mutationRuntime.assertCurrent(canonicalRoot);
            this.host.context.clearIndexCandidateReceiptForCollection(
                canonicalRoot,
                receipt.collectionName,
            );
            clearedReceipts.push(receipt.collectionName);
        }

        return { recoveredCollections, clearedReceipts };
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
    ): Promise<ZillizCollectionDropResult> {
        const trimmedName = collectionName.trim();
        if (trimmedName.length === 0) {
            throw new Error("zillizDropCollection must be a non-empty string.");
        }

        if (!this.isSatoriCodeCollection(trimmedName)) {
            throw new Error(`zillizDropCollection '${trimmedName}' is not a Satori-managed collection (expected prefix ${SATORI_COLLECTION_FAMILY_PREFIXES.join(" or ")}).`);
        }

        const vectorDb = this.getVectorStore();
        if (!await vectorDb.hasCollection(trimmedName)) {
            throw new Error(`Collection '${trimmedName}' does not exist in the connected Zilliz cluster.`);
        }

        const { byCollectionName, ambiguousCollections } = this.buildPublicationCollectionOwnership();
        const droppedCodebasePath = await this.resolveCollectionCodebasePath(
            vectorDb,
            trimmedName,
            byCollectionName,
            ambiguousCollections,
        );
        if (!droppedCodebasePath) {
            return { status: "unmapped" };
        }

        try {
            return await this.host.mutationRuntime.run(droppedCodebasePath, "clear", async () => {
                const operation = this.host.mutationRuntime.getCurrentOperation(droppedCodebasePath);
                const ownsClearOperation = operation?.action === "clear";
                const updateDroppedRootPhase = (
                    phase: MutationOperationPhase,
                    update: { error?: string } = {},
                ): void => {
                    if (!ownsClearOperation) return;
                    this.host.mutationRuntime.updateCurrentOperation(droppedCodebasePath, phase, update);
                };

                try {
                    this.host.mutationRuntime.assertCurrent(droppedCodebasePath);
                    updateDroppedRootPhase("writing");
                    const currentPublication = this.host.context.getCurrentPublication(droppedCodebasePath);
                    const dropsCurrentPublication = currentPublication?.publication.vector.collectionName === trimmedName;

                    if (dropsCurrentPublication) {
                        await this.host.context.clearIndex(droppedCodebasePath);
                        try {
                            await this.host.unwatchCodebase(droppedCodebasePath);
                        } catch {
                            // Best-effort watcher cleanup; Publication teardown remains authoritative.
                        }
                    } else {
                        await deleteCollectionWithVerification(vectorDb, trimmedName, {
                            beforeDropAttempt: () => this.host.mutationRuntime.assertCurrent(droppedCodebasePath),
                        });
                    }

                    this.host.mutationRuntime.assertCurrent(droppedCodebasePath);
                    updateDroppedRootPhase("completed");
                    return { status: "dropped" as const, droppedCodebasePath };
                } catch (error) {
                    if (ownsClearOperation && this.host.mutationRuntime.isCurrent(droppedCodebasePath)) {
                        try {
                            updateDroppedRootPhase("failed", { error: formatUnknownError(error) });
                        } catch {
                            // The Core mutation scope is authoritative; never overwrite a newer mutation.
                        }
                    }
                    throw error;
                }
            });
        } catch (error) {
            if (error instanceof RootMutationInProgressError) {
                return { status: "blocked", activeMutation: error.activeMutation };
            }
            throw error;
        }
    }
}
