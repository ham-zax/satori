import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSatoriStateRoot } from '../config/runtime-state-root';
import type {
    Publication,
    PublicationId,
    PublicationLease,
    PublicationRef,
} from './contracts';
import type {
    MutationLeaseCoordinator,
    RootMutationLease,
} from './root-mutation-coordinator';
import {
    RootMutationRuntime,
    getRootMutationCoordinator,
} from './root-mutation-runtime';
import {
    parsePublicationSourceCheckpoint,
    type PublicationSourceCheckpoint,
} from '../sync/snapshot-codec';
import {
    parsePublicationPackageOwnership,
    type PublicationPackageOwnership,
} from '../packages/ownership';

interface CurrentPublicationPointer {
    version: 1;
    publicationId: PublicationId;
}

const startupCleanupStateRoots = new Set<string>();

export interface PublicationStoreOptions {
    stateRoot?: string;
    mutationCoordinator: MutationLeaseCoordinator;
    /** Enable only when one runtime owns all publication read leases for this state root. */
    singleRuntimeReaderCoordination?: boolean;
}

declare const sharedPublicationRuntimeBrand: unique symbol;

export type SharedPublicationRuntime = Readonly<{
    [sharedPublicationRuntimeBrand]: true;
}>;

const sharedPublicationStores = new WeakMap<object, PublicationStore>();

/**
 * Explicit supported-owner boundary for destructive Publication GC.
 * Every supported Context reading one state root must share this handle.
 * Direct Context construction remains conservative and never infers safety
 * from its own zero lease count.
 */
export function createSharedPublicationRuntime(
    rootMutationRuntime: RootMutationRuntime,
    options: { stateRoot?: string } = {},
): SharedPublicationRuntime {
    const runtime = Object.freeze({}) as SharedPublicationRuntime;
    sharedPublicationStores.set(runtime, new PublicationStore({
        ...options,
        mutationCoordinator: getRootMutationCoordinator(rootMutationRuntime),
        singleRuntimeReaderCoordination: true,
    }));
    return runtime;
}

export function getSharedPublicationStore(
    runtime: SharedPublicationRuntime,
    rootMutationRuntime: RootMutationRuntime,
): PublicationStore {
    const store = sharedPublicationStores.get(runtime);
    if (!store) {
        throw new Error('Shared Publication runtime was not created by Core.');
    }
    if (!store.usesRootMutationRuntime(rootMutationRuntime)) {
        throw new Error('Shared Publication runtime must share the Context RootMutationRuntime.');
    }
    return store;
}

function resolveStateRoot(stateRoot?: string): string {
    return resolveSatoriStateRoot({
        configured: stateRoot ?? process.env.SATORI_STATE_ROOT,
        homeDir: os.homedir(),
    });
}

function publicationRootKey(canonicalRoot: string): string {
    return crypto.createHash('sha256').update(canonicalRoot).digest('hex');
}

export function resolvePublicationGenerationRoot(
    canonicalRoot: string,
    id: PublicationId,
    stateRoot?: string,
): string {
    assertPublicationId(id);
    return path.join(
        resolveStateRoot(stateRoot),
        'publications',
        publicationRootKey(canonicalRoot),
        'generations',
        id,
    );
}

export function resolvePublicationNavigationRoot(
    canonicalRoot: string,
    id: PublicationId,
    stateRoot?: string,
): string {
    return path.join(resolvePublicationGenerationRoot(canonicalRoot, id, stateRoot), 'navigation');
}

type PublicationActivationDurability = 'visible_unconfirmed' | 'durable';

export class PublicationActivationError extends Error {
    constructor(
        readonly ref: PublicationRef,
        readonly activationCause: unknown,
        readonly durability: PublicationActivationDurability,
    ) {
        const causeMessage = activationCause instanceof Error
            ? activationCause.message
            : String(activationCause);
        super(
            durability === 'durable'
                ? `Publication '${ref.id}' became crash-durable before activation acknowledgement failed: ${causeMessage}`
                : `Publication '${ref.id}' current pointer was renamed but parent-directory fsync did not complete; activation durability is unconfirmed: ${causeMessage}`,
        );
        this.name = 'PublicationActivationError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeRoot(root: string): string {
    const absolute = path.resolve(root);
    try {
        return fs.realpathSync.native(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
        throw error;
    }
}

function assertPublicationId(id: string): asserts id is PublicationId {
    if (
        id.length === 0
        || id === '.'
        || id === '..'
        || id.includes('/')
        || id.includes('\\')
        || id.includes('\0')
    ) {
        throw new Error(`Invalid publication id '${id}'.`);
    }
}

function parseStringArray(value: unknown, field: string): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`Invalid Publication ${field}.`);
    }
    return Object.freeze([...value]);
}

function parsePublication(value: unknown, sourcePath: string): Publication {
    if (!isRecord(value) || value.version !== 1) {
        throw new Error(`Unsupported Publication format at '${sourcePath}'.`);
    }
    if (
        typeof value.id !== 'string'
        || typeof value.canonicalRoot !== 'string'
        || typeof value.createdAt !== 'string'
        || (value.status !== 'complete' && value.status !== 'partial')
        || !isRecord(value.policy)
        || !['default', 'minimal', 'all-text'].includes(String(value.policy.profile))
        || typeof value.policy.controlSignature !== 'string'
        || !isRecord(value.format)
        || typeof value.format.indexFormatVersion !== 'string'
        || typeof value.format.embeddingIdentity !== 'string'
        || typeof value.format.relationshipVersion !== 'string'
        || !isRecord(value.vector)
        || typeof value.vector.collectionName !== 'string'
        || typeof value.vector.indexedFiles !== 'number'
        || !Number.isSafeInteger(value.vector.indexedFiles)
        || value.vector.indexedFiles < 0
        || typeof value.vector.totalChunks !== 'number'
        || !Number.isSafeInteger(value.vector.totalChunks)
        || value.vector.totalChunks < 0
        || (value.status === 'complete' && (
            !isRecord(value.navigation)
            || value.navigation.relativeRoot !== 'navigation'
        ))
        || (value.status === 'partial' && value.navigation !== null)
    ) {
        throw new Error(`Invalid Publication descriptor at '${sourcePath}'.`);
    }
    assertPublicationId(value.id);
    const publication: Publication = {
        version: 1,
        id: value.id,
        canonicalRoot: value.canonicalRoot,
        createdAt: value.createdAt,
        status: value.status,
        policy: Object.freeze({
            profile: value.policy.profile as Publication['policy']['profile'],
            customExtensions: parseStringArray(value.policy.customExtensions, 'policy.customExtensions'),
            customIgnorePatterns: parseStringArray(value.policy.customIgnorePatterns, 'policy.customIgnorePatterns'),
            fileBasedIgnorePatterns: parseStringArray(value.policy.fileBasedIgnorePatterns, 'policy.fileBasedIgnorePatterns'),
            supportedExtensions: parseStringArray(value.policy.supportedExtensions, 'policy.supportedExtensions'),
            effectiveIgnorePatterns: parseStringArray(value.policy.effectiveIgnorePatterns, 'policy.effectiveIgnorePatterns'),
            policyHash: typeof value.policy.policyHash === 'string'
                ? value.policy.policyHash
                : (() => { throw new Error(`Invalid Publication policy.policyHash at '${sourcePath}'.`); })(),
            controlSignature: value.policy.controlSignature,
        }),
        format: Object.freeze({
            indexFormatVersion: value.format.indexFormatVersion,
            embeddingIdentity: value.format.embeddingIdentity,
            relationshipVersion: value.format.relationshipVersion,
        }),
        vector: Object.freeze({
            collectionName: value.vector.collectionName,
            indexedFiles: Number(value.vector.indexedFiles),
            totalChunks: Number(value.vector.totalChunks),
        }),
        navigation: value.navigation === null
            ? null
            : Object.freeze({ relativeRoot: 'navigation' as const }),
    };
    return Object.freeze(publication);
}

function parseCurrentPointer(value: unknown, sourcePath: string): CurrentPublicationPointer {
    if (
        !isRecord(value)
        || value.version !== 1
        || typeof value.publicationId !== 'string'
    ) {
        throw new Error(`Invalid current Publication pointer at '${sourcePath}'.`);
    }
    assertPublicationId(value.publicationId);
    return { version: 1, publicationId: value.publicationId };
}

export class PublicationStore {
    private readonly stateRoot: string;
    private readonly publicationsRoot: string;
    private readonly mutationCoordinator: MutationLeaseCoordinator;
    private readonly singleRuntimeReaderCoordination: boolean;
    private readonly readLeasesByRoot = new Map<string, Map<PublicationId, number>>();
    private readonly retiringPublicationIdsByRoot = new Map<string, Set<PublicationId>>();

    constructor(options: PublicationStoreOptions) {
        this.stateRoot = resolveStateRoot(options.stateRoot);
        this.publicationsRoot = path.join(this.stateRoot, 'publications');
        this.mutationCoordinator = options.mutationCoordinator;
        this.singleRuntimeReaderCoordination = options.singleRuntimeReaderCoordination === true;
        // Cold-start cleanup runs once per state root before this process can issue Publication leases.
        // Runtime GC remains separately gated by singleRuntimeReaderCoordination in isGcEligible().
        if (!startupCleanupStateRoots.has(this.stateRoot)) {
            this.pruneStartupOrphans();
            startupCleanupStateRoots.add(this.stateRoot);
        }
    }

    usesRootMutationRuntime(runtime: RootMutationRuntime): boolean {
        return this.mutationCoordinator === getRootMutationCoordinator(runtime);
    }

    getCurrent(root: string): PublicationRef | null {
        const canonicalRoot = canonicalizeRoot(root);
        const pointer = this.readCurrentPointer(canonicalRoot);
        if (!pointer) return null;
        const current = this.getByIdCanonical(canonicalRoot, pointer.publicationId);
        if (!current) {
            throw new Error(
                `Current Publication '${pointer.publicationId}' for '${canonicalRoot}' is missing its descriptor.`,
            );
        }
        return current;
    }

    listCurrent(): PublicationRef[] {
        let rootEntries: fs.Dirent[];
        try {
            rootEntries = fs.readdirSync(this.publicationsRoot, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }

        const current: PublicationRef[] = [];
        for (const rootEntry of rootEntries) {
            const publicationRoot = path.join(this.publicationsRoot, rootEntry.name);
            if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
                throw new Error(`Publication state contains unsupported root entry '${publicationRoot}'.`);
            }
            const pointerPath = path.join(publicationRoot, 'current.json');
            let pointer: CurrentPublicationPointer;
            try {
                pointer = parseCurrentPointer(JSON.parse(fs.readFileSync(pointerPath, 'utf8')), pointerPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
            const descriptorPath = path.join(
                publicationRoot,
                'generations',
                pointer.publicationId,
                'publication.json',
            );
            const publication = this.readPublication(descriptorPath);
            const canonicalRoot = canonicalizeRoot(publication.canonicalRoot);
            if (
                canonicalRoot !== publication.canonicalRoot
                || publicationRootKey(canonicalRoot) !== rootEntry.name
                || publication.id !== pointer.publicationId
            ) {
                throw new Error(`Current Publication state at '${publicationRoot}' has inconsistent root/id ownership.`);
            }
            current.push({ id: publication.id, publication });
        }
        return current.sort((left, right) => (
            left.publication.canonicalRoot.localeCompare(right.publication.canonicalRoot)
        ));
    }

    getById(root: string, id: PublicationId): PublicationRef | null {
        return this.getByIdCanonical(canonicalizeRoot(root), id);
    }

    acquireCurrentRead(root: string): PublicationLease | null {
        const canonicalRoot = canonicalizeRoot(root);
        // Pointer resolution and the ID-keyed pin are deliberately one synchronous
        // operation. Retirement reservation is synchronous in this owner too, so a
        // candidate cannot become reclaimable between selection and pinning.
        const pointer = this.readCurrentPointer(canonicalRoot);
        if (!pointer) return null;
        const current = this.getByIdCanonical(canonicalRoot, pointer.publicationId);
        if (!current) {
            throw new Error(
                `Current Publication '${pointer.publicationId}' for '${canonicalRoot}' is missing its descriptor.`,
            );
        }
        return this.acquireRef(canonicalRoot, current);
    }

    acquireRead(root: string, id: PublicationId): PublicationLease | null {
        const canonicalRoot = canonicalizeRoot(root);
        const publication = this.getByIdCanonical(canonicalRoot, id);
        return publication ? this.acquireRef(canonicalRoot, publication) : null;
    }

    getSourceCheckpoint(root: string, id: PublicationId): PublicationSourceCheckpoint | null {
        const canonicalRoot = canonicalizeRoot(root);
        assertPublicationId(id);
        const sourcePath = this.sourceCheckpointPath(canonicalRoot, id);
        try {
            return parsePublicationSourceCheckpoint(fs.readFileSync(sourcePath, 'utf8'), canonicalRoot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    getPackageOwnership(root: string, id: PublicationId): PublicationPackageOwnership | null {
        const canonicalRoot = canonicalizeRoot(root);
        assertPublicationId(id);
        const ownershipPath = this.packageOwnershipPath(canonicalRoot, id);
        try {
            return parsePublicationPackageOwnership(
                fs.readFileSync(ownershipPath, 'utf8'),
                canonicalRoot,
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    getCurrentSourceCheckpoint(root: string): {
        ref: PublicationRef;
        checkpoint: PublicationSourceCheckpoint;
        observationToken: PublicationId;
    } | null {
        const ref = this.getCurrent(root);
        if (!ref) return null;
        const checkpoint = this.getSourceCheckpoint(ref.publication.canonicalRoot, ref.id);
        if (!checkpoint) {
            throw new Error(`Current Publication '${ref.id}' is missing source.json.`);
        }
        return { ref, checkpoint, observationToken: ref.id };
    }

    getNavigation(root: string, id: PublicationId): {
        ref: PublicationRef;
        rootPath: string;
    } | null {
        const canonicalRoot = canonicalizeRoot(root);
        const ref = this.getByIdCanonical(canonicalRoot, id);
        if (!ref || ref.publication.navigation === null) return null;
        return {
            ref,
            rootPath: resolvePublicationNavigationRoot(canonicalRoot, id, this.stateRoot),
        };
    }

    getCurrentNavigation(root: string): {
        ref: PublicationRef;
        rootPath: string;
    } | null {
        const ref = this.getCurrent(root);
        return ref ? this.getNavigation(ref.publication.canonicalRoot, ref.id) : null;
    }

    prepareNavigationRoot(
        root: string,
        id: PublicationId,
        lease: RootMutationLease,
    ): string {
        const canonicalRoot = canonicalizeRoot(root);
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication navigation root '${canonicalRoot}'.`);
        }
        this.mutationCoordinator.assertCurrent(lease);
        assertPublicationId(id);
        const generationRoot = this.generationRoot(canonicalRoot, id);
        fs.mkdirSync(generationRoot, { recursive: true });
        const navigationRoot = resolvePublicationNavigationRoot(canonicalRoot, id, this.stateRoot);
        if (fs.existsSync(navigationRoot)) {
            throw new Error(`Publication '${id}' navigation is immutable and already exists.`);
        }
        return navigationRoot;
    }

    stageSourceCheckpoint(
        root: string,
        id: PublicationId,
        checkpoint: PublicationSourceCheckpoint,
        lease: RootMutationLease,
    ): void {
        const canonicalRoot = canonicalizeRoot(root);
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication source root '${canonicalRoot}'.`);
        }
        this.mutationCoordinator.assertCurrent(lease);
        assertPublicationId(id);
        const validated = parsePublicationSourceCheckpoint(JSON.stringify(checkpoint), canonicalRoot);
        const sourcePath = this.sourceCheckpointPath(canonicalRoot, id);
        if (fs.existsSync(sourcePath)) {
            const existing = parsePublicationSourceCheckpoint(fs.readFileSync(sourcePath, 'utf8'), canonicalRoot);
            if (JSON.stringify(existing) !== JSON.stringify(validated)) {
                throw new Error(`Publication '${id}' source checkpoint is immutable and already has different content.`);
            }
            return;
        }
        this.writeDurableFile(sourcePath, `${JSON.stringify(validated, null, 2)}\n`);
    }

    stagePackageOwnership(
        root: string,
        id: PublicationId,
        ownership: PublicationPackageOwnership,
        lease: RootMutationLease,
    ): void {
        const canonicalRoot = canonicalizeRoot(root);
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication package root '${canonicalRoot}'.`);
        }
        this.mutationCoordinator.assertCurrent(lease);
        assertPublicationId(id);
        const validated = parsePublicationPackageOwnership(JSON.stringify(ownership), canonicalRoot);
        const ownershipPath = this.packageOwnershipPath(canonicalRoot, id);
        if (fs.existsSync(ownershipPath)) {
            const existing = parsePublicationPackageOwnership(
                fs.readFileSync(ownershipPath, 'utf8'),
                canonicalRoot,
            );
            if (JSON.stringify(existing) !== JSON.stringify(validated)) {
                throw new Error(`Publication '${id}' package ownership is immutable and already has different content.`);
            }
            return;
        }
        this.writeDurableFile(ownershipPath, `${JSON.stringify(validated, null, 2)}\n`);
    }

    activate(publication: Publication, lease: RootMutationLease): PublicationRef {
        const canonicalRoot = canonicalizeRoot(publication.canonicalRoot);
        if (canonicalRoot !== publication.canonicalRoot) {
            throw new Error(`Publication root '${publication.canonicalRoot}' is not canonical.`);
        }
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication root '${canonicalRoot}'.`);
        }
        assertPublicationId(publication.id);
        const validated = parsePublication(publication, '<activation>');
        if (validated.canonicalRoot !== canonicalRoot) {
            throw new Error('Publication descriptor root changed during validation.');
        }

        const ref: PublicationRef = { id: validated.id, publication: validated };
        let pointerReplaced = false;
        let pointerDurabilityConfirmed = false;
        try {
            this.mutationCoordinator.publishWhileCurrent(lease, () => {
                const publicationRoot = this.publicationRoot(canonicalRoot);
                const generationsRoot = path.join(publicationRoot, 'generations');
                const generationRoot = this.generationRoot(canonicalRoot, validated.id);
                fs.mkdirSync(generationRoot, { recursive: true });

                const descriptorPath = path.join(generationRoot, 'publication.json');
                if (fs.existsSync(descriptorPath)) {
                    const existing = this.readPublication(descriptorPath);
                    if (JSON.stringify(existing) !== JSON.stringify(validated)) {
                        throw new Error(`Publication '${validated.id}' is immutable and already has different metadata.`);
                    }
                } else {
                    this.writeDurableFile(descriptorPath, `${JSON.stringify(validated, null, 2)}\n`);
                }

                if (validated.navigation !== null) {
                    const navigationRoot = path.join(generationRoot, validated.navigation.relativeRoot);
                    if (!fs.statSync(navigationRoot).isDirectory()) {
                        throw new Error(`Publication '${validated.id}' navigation resource is not a directory.`);
                    }
                }

                const sourceCheckpoint = this.getSourceCheckpoint(canonicalRoot, validated.id);
                if (!sourceCheckpoint) {
                    throw new Error(`Publication '${validated.id}' is missing source.json.`);
                }
                const packageOwnership = this.getPackageOwnership(canonicalRoot, validated.id);
                if (!packageOwnership) {
                    throw new Error(`Publication '${validated.id}' is missing ownership.json.`);
                }

                // Make every staged local candidate resource durable before its ID can
                // become reachable from current.json.
                this.fsyncTree(generationRoot);
                this.fsyncDirectory(generationsRoot);
                this.fsyncDirectory(publicationRoot);
                this.fsyncDirectory(this.publicationsRoot);
                this.fsyncDirectory(this.stateRoot);

                const pointerPath = this.currentPointerPath(canonicalRoot);
                const temporaryPointer = `${pointerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
                try {
                    this.writeDurableFile(
                        temporaryPointer,
                        `${JSON.stringify({ version: 1, publicationId: validated.id } satisfies CurrentPublicationPointer, null, 2)}\n`,
                    );
                    fs.renameSync(temporaryPointer, pointerPath);
                    pointerReplaced = true;
                    this.fsyncDirectory(publicationRoot);
                    pointerDurabilityConfirmed = true;
                } finally {
                    fs.rmSync(temporaryPointer, { force: true });
                }
            });
        } catch (error) {
            if (pointerReplaced) {
                throw new PublicationActivationError(
                    ref,
                    error,
                    pointerDurabilityConfirmed ? 'durable' : 'visible_unconfirmed',
                );
            }
            throw error;
        }

        return ref;
    }

    clearCurrent(root: string, lease: RootMutationLease): void {
        const canonicalRoot = canonicalizeRoot(root);
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication root '${canonicalRoot}'.`);
        }
        this.mutationCoordinator.publishWhileCurrent(lease, () => {
            const pointerPath = this.currentPointerPath(canonicalRoot);
            try {
                fs.unlinkSync(pointerPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
            }
            this.fsyncDirectory(path.dirname(pointerPath));
        });
    }

    discardUnpublished(root: string, id: PublicationId, lease: RootMutationLease): void {
        const canonicalRoot = canonicalizeRoot(root);
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication root '${canonicalRoot}'.`);
        }
        assertPublicationId(id);
        this.mutationCoordinator.publishWhileCurrent(lease, () => {
            if (this.readCurrentPointer(canonicalRoot)?.publicationId === id) {
                throw new Error(`Cannot discard current Publication '${id}'.`);
            }
            const generationRoot = this.generationRoot(canonicalRoot, id);
            let generationStat: fs.Stats;
            try {
                generationStat = fs.lstatSync(generationRoot);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
            }
            if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
                throw new Error(`Publication generation '${generationRoot}' is not a removable directory.`);
            }
            fs.rmSync(generationRoot, { recursive: true, force: false });
            this.fsyncDirectory(path.dirname(generationRoot));
        });
    }

    isGcEligible(root: string, id: PublicationId): boolean {
        const canonicalRoot = canonicalizeRoot(root);
        assertPublicationId(id);
        if (!this.singleRuntimeReaderCoordination) return false;
        if (this.isRetiring(canonicalRoot, id)) return false;
        const current = this.readCurrentPointer(canonicalRoot);
        if (current?.publicationId === id) return false;
        return (this.readLeasesByRoot.get(canonicalRoot)?.get(id) ?? 0) === 0;
    }

    async collectGarbage(
        root: string,
        lease: RootMutationLease,
        deleteVectorCollection: (
            collectionName: string,
            assertMutationCurrent: () => void,
        ) => Promise<void>,
    ): Promise<string[]> {
        const canonicalRoot = canonicalizeRoot(root);
        if (!this.mutationCoordinator.isLeaseForRoot(lease, canonicalRoot)) {
            throw new Error(`Mutation lease does not own Publication GC root '${canonicalRoot}'.`);
        }
        this.mutationCoordinator.assertCurrent(lease);
        if (!this.singleRuntimeReaderCoordination) return [];

        const publications = this.listGenerationPublications(canonicalRoot);
        const currentId = this.readCurrentPointer(canonicalRoot)?.publicationId;
        const protectedCollections = new Set(
            publications
                .filter((ref) => (
                    ref.id === currentId
                    || (this.readLeasesByRoot.get(canonicalRoot)?.get(ref.id) ?? 0) > 0
                ))
                .map((ref) => ref.publication.vector.collectionName),
        );
        const removedCollections: string[] = [];
        const assertMutationCurrent = (): void => this.mutationCoordinator.assertCurrent(lease);

        for (const ref of publications) {
            const collectionName = ref.publication.vector.collectionName;
            if (protectedCollections.has(collectionName)) continue;
            if (publications.some((other) => (
                other.id !== ref.id
                && other.publication.vector.collectionName === collectionName
            ))) continue;
            if (!this.reserveForGc(canonicalRoot, ref.id)) continue;
            try {
                assertMutationCurrent();
                await deleteVectorCollection(collectionName, assertMutationCurrent);
                assertMutationCurrent();
                this.mutationCoordinator.publishWhileCurrent(lease, () => {
                    if (this.readCurrentPointer(canonicalRoot)?.publicationId === ref.id) {
                        throw new Error(`Publication '${ref.id}' became current during GC.`);
                    }
                    if ((this.readLeasesByRoot.get(canonicalRoot)?.get(ref.id) ?? 0) !== 0) {
                        throw new Error(`Publication '${ref.id}' acquired a read lease during GC.`);
                    }
                    this.removeGeneration(canonicalRoot, ref.id);
                });
                removedCollections.push(collectionName);
            } finally {
                this.releaseGcReservation(canonicalRoot, ref.id);
            }
        }
        return removedCollections;
    }

    private pruneStartupOrphans(): void {
        let publicationRoots: fs.Dirent[];
        try {
            publicationRoots = fs.readdirSync(this.publicationsRoot, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }

        for (const rootEntry of publicationRoots) {
            const publicationRoot = path.join(this.publicationsRoot, rootEntry.name);
            if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
                throw new Error(`Publication state contains unsupported root entry '${publicationRoot}'.`);
            }
            const generationsRoot = path.join(publicationRoot, 'generations');
            let generationEntries: fs.Dirent[];
            try {
                generationEntries = fs.readdirSync(generationsRoot, { withFileTypes: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }

            const pointerPath = path.join(publicationRoot, 'current.json');
            let current: CurrentPublicationPointer | null = null;
            try {
                current = parseCurrentPointer(JSON.parse(fs.readFileSync(pointerPath, 'utf8')), pointerPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }

            const canonicalRoot = this.resolveStartupCanonicalRoot(
                publicationRoot,
                generationEntries,
                current,
            );
            if (!canonicalRoot || this.mutationCoordinator.getActiveLease(canonicalRoot)) continue;

            for (const entry of generationEntries) {
                const generationRoot = path.join(generationsRoot, entry.name);
                if (!entry.isDirectory() || entry.isSymbolicLink()) {
                    throw new Error(`Publication state contains unsupported generation entry '${generationRoot}'.`);
                }
                assertPublicationId(entry.name);
            }

            let removed = false;
            for (const entry of generationEntries) {
                if (current?.publicationId === entry.name) continue;
                const generationRoot = path.join(generationsRoot, entry.name);
                if (fs.existsSync(path.join(generationRoot, 'publication.json'))) {
                    // A descriptor-bearing generation may have been selected previously and
                    // can still be protected by reader/retention semantics outside this
                    // process. Without a durable read-lease migration, it is not provably
                    // private, so cold-start cleanup must preserve it.
                    continue;
                }
                fs.rmSync(generationRoot, { recursive: true, force: false });
                removed = true;
            }
            if (removed) this.fsyncDirectory(generationsRoot);
        }
    }

    private resolveStartupCanonicalRoot(
        publicationRoot: string,
        generationEntries: readonly fs.Dirent[],
        current: CurrentPublicationPointer | null,
    ): string | null {
        const acceptRoot = (candidate: string, expected?: string): string => {
            const canonicalRoot = canonicalizeRoot(candidate);
            if (
                canonicalRoot !== candidate
                || publicationRootKey(canonicalRoot) !== path.basename(publicationRoot)
                || (expected !== undefined && expected !== canonicalRoot)
            ) {
                throw new Error(`Publication startup state at '${publicationRoot}' has inconsistent root ownership.`);
            }
            return canonicalRoot;
        };

        if (current) {
            const descriptorPath = path.join(
                publicationRoot,
                'generations',
                current.publicationId,
                'publication.json',
            );
            const publication = this.readPublication(descriptorPath);
            if (publication.id !== current.publicationId) {
                throw new Error(`Current Publication '${current.publicationId}' does not match its descriptor.`);
            }
            return acceptRoot(publication.canonicalRoot);
        }

        let canonicalRoot: string | undefined;
        for (const entry of generationEntries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const generationRoot = path.join(publicationRoot, 'generations', entry.name);
            for (const [evidencePath, rootField] of [
                [path.join(generationRoot, 'publication.json'), 'canonicalRoot'],
                [path.join(generationRoot, 'source.json'), 'canonicalRoot'],
                [path.join(generationRoot, 'navigation', 'manifest.json'), 'normalizedRootPath'],
            ] as const) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                    throw error;
                }
                if (!isRecord(parsed) || typeof parsed[rootField] !== 'string') {
                    throw new Error(`Publication startup evidence at '${evidencePath}' has no root identity.`);
                }
                canonicalRoot = acceptRoot(parsed[rootField] as string, canonicalRoot);
                break;
            }
        }
        return canonicalRoot ?? null;
    }

    private acquireRef(canonicalRoot: string, ref: PublicationRef): PublicationLease | null {
        if (this.isRetiring(canonicalRoot, ref.id)) return null;
        let leasesById = this.readLeasesByRoot.get(canonicalRoot);
        if (!leasesById) {
            leasesById = new Map();
            this.readLeasesByRoot.set(canonicalRoot, leasesById);
        }
        leasesById.set(ref.id, (leasesById.get(ref.id) ?? 0) + 1);
        let released = false;
        return {
            ...ref,
            release: () => {
                if (released) return;
                released = true;
                const current = leasesById!.get(ref.id) ?? 0;
                if (current <= 1) leasesById!.delete(ref.id);
                else leasesById!.set(ref.id, current - 1);
                if (leasesById!.size === 0) this.readLeasesByRoot.delete(canonicalRoot);
            },
        };
    }

    private listGenerationPublications(canonicalRoot: string): PublicationRef[] {
        const generationsRoot = path.join(this.publicationRoot(canonicalRoot), 'generations');
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(generationsRoot, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }

        const publications: PublicationRef[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                throw new Error(`Publication state contains unsupported generation entry '${path.join(generationsRoot, entry.name)}'.`);
            }
            assertPublicationId(entry.name);
            const ref = this.getByIdCanonical(canonicalRoot, entry.name);
            if (ref) publications.push(ref);
        }
        return publications.sort((left, right) => left.id.localeCompare(right.id));
    }

    private reserveForGc(canonicalRoot: string, id: PublicationId): boolean {
        if (!this.isGcEligible(canonicalRoot, id)) return false;
        let retiring = this.retiringPublicationIdsByRoot.get(canonicalRoot);
        if (!retiring) {
            retiring = new Set();
            this.retiringPublicationIdsByRoot.set(canonicalRoot, retiring);
        }
        retiring.add(id);
        return true;
    }

    private releaseGcReservation(canonicalRoot: string, id: PublicationId): void {
        const retiring = this.retiringPublicationIdsByRoot.get(canonicalRoot);
        if (!retiring) return;
        retiring.delete(id);
        if (retiring.size === 0) this.retiringPublicationIdsByRoot.delete(canonicalRoot);
    }

    private isRetiring(canonicalRoot: string, id: PublicationId): boolean {
        return this.retiringPublicationIdsByRoot.get(canonicalRoot)?.has(id) === true;
    }

    private removeGeneration(canonicalRoot: string, id: PublicationId): void {
        const generationRoot = this.generationRoot(canonicalRoot, id);
        let generationStat: fs.Stats;
        try {
            generationStat = fs.lstatSync(generationRoot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
            throw new Error(`Publication generation '${generationRoot}' is not a removable directory.`);
        }
        fs.rmSync(generationRoot, { recursive: true, force: false });
        this.fsyncDirectory(path.dirname(generationRoot));
    }

    private getByIdCanonical(canonicalRoot: string, id: PublicationId): PublicationRef | null {
        assertPublicationId(id);
        const descriptorPath = path.join(this.generationRoot(canonicalRoot, id), 'publication.json');
        let publication: Publication;
        try {
            publication = this.readPublication(descriptorPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        if (publication.id !== id || publication.canonicalRoot !== canonicalRoot) {
            throw new Error(`Publication descriptor at '${descriptorPath}' does not match its addressed root/id.`);
        }
        return { id, publication };
    }

    private readPublication(descriptorPath: string): Publication {
        return parsePublication(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), descriptorPath);
    }

    private readCurrentPointer(canonicalRoot: string): CurrentPublicationPointer | null {
        const pointerPath = this.currentPointerPath(canonicalRoot);
        try {
            return parseCurrentPointer(JSON.parse(fs.readFileSync(pointerPath, 'utf8')), pointerPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    private publicationRoot(canonicalRoot: string): string {
        return path.join(this.publicationsRoot, publicationRootKey(canonicalRoot));
    }

    private generationRoot(canonicalRoot: string, id: PublicationId): string {
        return resolvePublicationGenerationRoot(canonicalRoot, id, this.stateRoot);
    }

    private currentPointerPath(canonicalRoot: string): string {
        return path.join(this.publicationRoot(canonicalRoot), 'current.json');
    }

    private sourceCheckpointPath(canonicalRoot: string, id: PublicationId): string {
        return path.join(this.generationRoot(canonicalRoot, id), 'source.json');
    }

    private packageOwnershipPath(canonicalRoot: string, id: PublicationId): string {
        return path.join(this.generationRoot(canonicalRoot, id), 'ownership.json');
    }

    private writeDurableFile(targetPath: string, contents: string): void {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const descriptor = fs.openSync(targetPath, 'wx');
        try {
            fs.writeFileSync(descriptor, contents, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }

    private fsyncTree(rootPath: string): void {
        for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
            const childPath = path.join(rootPath, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Publication candidate contains unsupported symbolic link '${childPath}'.`);
            }
            if (entry.isDirectory()) {
                this.fsyncTree(childPath);
                continue;
            }
            if (entry.isFile()) {
                const descriptor = fs.openSync(childPath, 'r');
                try {
                    fs.fsyncSync(descriptor);
                } finally {
                    fs.closeSync(descriptor);
                }
                continue;
            }
            throw new Error(`Publication candidate contains unsupported filesystem entry '${childPath}'.`);
        }
        this.fsyncDirectory(rootPath);
    }

    private fsyncDirectory(directoryPath: string): void {
        const descriptor = fs.openSync(directoryPath, 'r');
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }
}
