/**
 * MCP-owned watcher observation cache for Publication source freshness.
 *
 * Durable source authority is PublicationStore/source.json. This owner keeps
 * only compact watcher/checkpoint observations and the temporary full-index
 * handoff barrier used while MCP lifecycle state is still "indexing".
 */
import type { ProvenSourceFreshnessCheckpointEvidence } from "@satori-code/core/integration";
import type {
    FullIndexSourceHandoffBarrierInput,
    FullIndexSourceHandoffInput,
    WatcherBootstrapCapture,
} from "./sync.js";

export type SourceCheckpointObservationStatus = 'valid' | 'missing' | 'corrupt';

export interface SourceObservationStateDependencies {
    assertMutationCurrent(root: string): void;
    hasCurrentWatcherCapture(root: string, capture: WatcherBootstrapCapture): boolean;
    coverWatcherObservation(root: string, observedEventEpoch: number | undefined): void;
    inspectSourceFreshnessCheckpoint(root: string): Promise<ProvenSourceFreshnessCheckpointEvidence>;
    getCurrentPublicationSourceObservation(root: string): string | null;
    isPreparedReadAvailable(root: string): boolean;
}

export class SourceObservationState {
    private readonly sourceCheckpointObservations = new Map<string, string>();
    private readonly sourceCheckpointStatuses = new Map<string, SourceCheckpointObservationStatus>();
    private readonly fullIndexSourceHandoffBarriers = new Map<string, FullIndexSourceHandoffBarrierInput>();

    constructor(private readonly deps: SourceObservationStateDependencies) {}

    recordValidCheckpointObservation(codebasePath: string, observationToken: string): string | undefined {
        const previous = this.sourceCheckpointObservations.get(codebasePath);
        this.sourceCheckpointStatuses.set(codebasePath, 'valid');
        this.sourceCheckpointObservations.set(codebasePath, observationToken);
        return previous;
    }

    recordUnavailableCheckpoint(codebasePath: string, status: 'missing' | 'corrupt'): void {
        this.sourceCheckpointStatuses.set(codebasePath, status);
        this.sourceCheckpointObservations.delete(codebasePath);
    }

    recordCheckpointObservation(codebasePath: string, observationToken: string): void {
        this.sourceCheckpointObservations.set(codebasePath, observationToken);
    }

    clearCheckpointObservation(codebasePath: string): void {
        this.sourceCheckpointObservations.delete(codebasePath);
    }

    getCheckpointObservation(codebasePath: string): string | undefined {
        return this.sourceCheckpointObservations.get(codebasePath);
    }

    getCheckpointStatus(codebasePath: string): SourceCheckpointObservationStatus | undefined {
        return this.sourceCheckpointStatuses.get(codebasePath);
    }

    hasHandoffBarrier(codebasePath: string): boolean {
        return this.fullIndexSourceHandoffBarriers.has(codebasePath);
    }

    clearCodebase(codebasePath: string): void {
        this.sourceCheckpointObservations.delete(codebasePath);
        this.sourceCheckpointStatuses.delete(codebasePath);
        this.fullIndexSourceHandoffBarriers.delete(codebasePath);
    }

    clearAll(): void {
        this.sourceCheckpointObservations.clear();
        this.sourceCheckpointStatuses.clear();
        this.fullIndexSourceHandoffBarriers.clear();
    }

    beginHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffBarrierInput,
    ): void {
        this.deps.assertMutationCurrent(codebasePath);
        if (input.publicationId.length === 0) {
            throw new TypeError('Full-index source handoff requires a Publication ID.');
        }
        this.fullIndexSourceHandoffBarriers.set(codebasePath, Object.freeze({ ...input }));
    }

    rejectHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffBarrierInput,
    ): boolean {
        this.deps.assertMutationCurrent(codebasePath);
        const barrier = this.fullIndexSourceHandoffBarriers.get(codebasePath);
        if (barrier?.publicationId !== input.publicationId) return false;
        this.fullIndexSourceHandoffBarriers.delete(codebasePath);
        return true;
    }

    supersedeHandoffAfterSync(codebasePath: string, publicationId: string | undefined): boolean {
        const barrier = this.fullIndexSourceHandoffBarriers.get(codebasePath);
        if (
            !barrier
            || !publicationId
            || this.deps.getCurrentPublicationSourceObservation(codebasePath) !== publicationId
        ) return false;
        this.fullIndexSourceHandoffBarriers.delete(codebasePath);
        return true;
    }

    async completeHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffInput,
    ): Promise<boolean> {
        this.deps.assertMutationCurrent(codebasePath);
        const barrier = this.fullIndexSourceHandoffBarriers.get(codebasePath);
        if (
            barrier?.publicationId !== input.publicationId
            || input.capture.canonicalRoot !== codebasePath
            || input.checkpointObservation.length === 0
        ) {
            return false;
        }
        if (!this.deps.hasCurrentWatcherCapture(codebasePath, input.capture)) return false;

        let currentCheckpoint: ProvenSourceFreshnessCheckpointEvidence;
        try {
            currentCheckpoint = await this.deps.inspectSourceFreshnessCheckpoint(codebasePath);
        } catch {
            return false;
        }
        if (
            currentCheckpoint.status !== 'valid'
            || currentCheckpoint.publicationId !== input.publicationId
            || currentCheckpoint.observationToken !== input.checkpointObservation
            || this.deps.getCurrentPublicationSourceObservation(codebasePath) !== input.checkpointObservation
        ) {
            return false;
        }

        this.deps.assertMutationCurrent(codebasePath);
        if (!this.deps.hasCurrentWatcherCapture(codebasePath, input.capture)) return false;
        this.sourceCheckpointStatuses.set(codebasePath, 'valid');
        this.sourceCheckpointObservations.set(codebasePath, input.checkpointObservation);
        this.deps.coverWatcherObservation(codebasePath, input.capture.observedEventEpoch);
        this.fullIndexSourceHandoffBarriers.delete(codebasePath);
        return this.deps.isPreparedReadAvailable(codebasePath);
    }
}
