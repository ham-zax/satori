/**
 * Runtime cache for source synchronizers.
 *
 * Durable source state is owned by PublicationStore/source.json. This registry
 * binds each reusable FileSynchronizer to its current Publication ID and keeps
 * mutation targets; it never persists source authority.
 */
import { FileSynchronizer } from './synchronizer';
import type { PublicationRef } from '../generation/contracts';
import type { PublicationSourceCheckpoint } from './snapshot-codec';

export type PublicationSourceComparison = Pick<FileSynchronizer,
    'comparePathsToOwnedCheckpoint'
    | 'compareAllSourceToOwnedCheckpoint'
    | 'compareSourceObservationToOwnedCheckpoint'>;

// A frozen outer object alone does not witness immutable checkpoint contents.
// Accessors and non-JSON objects cannot provide that witness either.
function isFrozenCheckpointData(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return true;
    const prototype = Object.getPrototypeOf(value);
    return Object.isFrozen(value)
        && (prototype === Object.prototype || prototype === Array.prototype)
        && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
            'value' in descriptor && isFrozenCheckpointData(descriptor.value));
}

export interface SynchronizerRegistryPorts {
    canonicalizeCodebasePath(codebasePath: string): string;
    getCurrentPublicationSourceCheckpoint(codebasePath: string): {
        ref: PublicationRef;
        checkpoint: PublicationSourceCheckpoint;
        observationToken: string;
    } | null;
    getActiveIgnorePatterns(codebasePath?: string): string[];
    getIndexedExtensionsForCodebase(codebasePath: string): string[];
    loadIndexProfileForCodebase(codebasePath: string): unknown;
    resolveCollectionName(codebasePath: string): string;
}

export class SynchronizerRegistry {
    private readonly synchronizers = new Map<string, {
        synchronizer: FileSynchronizer;
        publicationId?: string;
    }>();
    private readonly synchronizerMutationTargets = new Map<string, string>();
    private readonly sourceComparisons = new WeakMap<PublicationSourceCheckpoint, {
        canonicalRoot: string;
        policySignature: string;
        comparison: PublicationSourceComparison;
    }>();

    constructor(private readonly ports: SynchronizerRegistryPorts) {}

    getPublicationSourceComparison(
        canonicalRoot: string,
        checkpoint: PublicationSourceCheckpoint,
        ignorePatterns: readonly string[],
        supportedExtensions: readonly string[],
        additionalObservablePaths: readonly string[] = [],
    ): PublicationSourceComparison {
        const policySignature = JSON.stringify([ignorePatterns, supportedExtensions, additionalObservablePaths]);
        const cached = this.sourceComparisons.get(checkpoint);
        if (cached?.canonicalRoot === canonicalRoot && cached.policySignature === policySignature) {
            return cached.comparison;
        }
        // Construction still validates every miss. These instances never enter
        // the mutation registry, so commits cannot advance read-admission state.
        const comparison = new FileSynchronizer(canonicalRoot, [...ignorePatterns], [...supportedExtensions], {
            sourceCheckpoint: checkpoint,
            additionalObservablePaths,
        });
        if (isFrozenCheckpointData(checkpoint)) {
            this.sourceComparisons.set(checkpoint, { canonicalRoot, policySignature, comparison });
        }
        return comparison;
    }

    getSynchronizer(collectionName: string): FileSynchronizer | undefined {
        return this.synchronizers.get(collectionName)?.synchronizer;
    }

    getSynchronizerForPublication(
        collectionName: string,
        publicationId: string,
    ): FileSynchronizer | undefined {
        const registered = this.synchronizers.get(collectionName);
        return registered?.publicationId === publicationId
            ? registered.synchronizer
            : undefined;
    }

    getActiveSynchronizers(): Map<string, FileSynchronizer> {
        const active = new Map<string, FileSynchronizer>();
        for (const [collectionName, registered] of this.synchronizers.entries()) {
            active.set(collectionName, registered.synchronizer);
        }
        return active;
    }

    registerSynchronizerForPublication(
        collectionName: string,
        publicationId: string,
        synchronizer: FileSynchronizer,
    ): void {
        const replaced = this.synchronizers.get(collectionName)?.synchronizer;
        if (replaced && replaced !== synchronizer) {
            this.retireSynchronizer(replaced);
        }
        for (const [registeredKey, registered] of this.synchronizers.entries()) {
            if (
                registered.synchronizer === synchronizer
                && registered.publicationId !== undefined
                && registered.publicationId !== publicationId
            ) {
                this.synchronizers.delete(registeredKey);
                this.synchronizerMutationTargets.delete(registeredKey);
            }
        }
        this.synchronizers.set(collectionName, { synchronizer, publicationId });
        this.synchronizerMutationTargets.delete(collectionName);
    }

    async recreateSynchronizerForCodebase(
        codebasePath: string,
        assertMutationCurrent: () => void,
        options: { requireAuthorityCheckpoint?: boolean } = {},
    ): Promise<void> {
        this.ports.loadIndexProfileForCodebase(codebasePath);
        const canonicalRoot = this.ports.canonicalizeCodebasePath(codebasePath);
        const currentSource = this.ports.getCurrentPublicationSourceCheckpoint(canonicalRoot);
        if (options.requireAuthorityCheckpoint && !currentSource) {
            throw new Error(`Cannot recreate source freshness state for '${canonicalRoot}': no current Publication source checkpoint exists.`);
        }
        if (!currentSource) {
            this.clearSynchronizerForCollection(this.ports.resolveCollectionName(canonicalRoot));
            return;
        }
        assertMutationCurrent();
        const synchronizer = new FileSynchronizer(
            canonicalRoot,
            this.ports.getActiveIgnorePatterns(canonicalRoot),
            this.ports.getIndexedExtensionsForCodebase(canonicalRoot),
            { sourceCheckpoint: currentSource.checkpoint },
        );
        const collectionName = this.ports.resolveCollectionName(canonicalRoot);
        this.registerSynchronizerForPublication(
            collectionName,
            currentSource.ref.id,
            synchronizer,
        );
    }

    hasSynchronizerForCodebase(codebasePath: string): boolean {
        return this.synchronizers.has(this.ports.resolveCollectionName(codebasePath));
    }

    clearSynchronizerForCollection(collectionName: string): void {
        const synchronizer = this.synchronizers.get(collectionName)?.synchronizer;
        if (synchronizer) this.retireSynchronizer(synchronizer);
        this.synchronizerMutationTargets.delete(collectionName);
    }

    private retireSynchronizer(synchronizer: FileSynchronizer): void {
        // Physical and family names alias one runtime object and retire together.
        for (const [key, registered] of this.synchronizers) {
            if (registered.synchronizer === synchronizer) {
                this.synchronizers.delete(key);
                this.synchronizerMutationTargets.delete(key);
            }
        }
    }

    getMutationTarget(synchronizerKey: string): string | undefined {
        return this.synchronizerMutationTargets.get(synchronizerKey);
    }

    clearMutationTarget(synchronizerKey: string): void {
        this.synchronizerMutationTargets.delete(synchronizerKey);
    }

    setMutationTarget(synchronizerKey: string, collectionName: string): void {
        this.synchronizerMutationTargets.set(synchronizerKey, collectionName);
    }
}
