import * as fs from "fs";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import ignore from "ignore";
import {
    AtomicIncrementalPublicationUnsupportedError,
    computeIndexPolicyControlSignature,
    Context,
    type SourceFreshnessPort,
    type ProvenGenerationReceipt,
    type ProvenVectorGenerationReceipt,
} from "@zokizuan/satori-core";
import { SnapshotManager } from "./snapshot.js";
import {
    BACKGROUND_FRESHNESS_THRESHOLD_MS,
    BACKGROUND_SYNC_INITIAL_DELAY_MS,
    BACKGROUND_SYNC_INTERVAL_MS,
    DEFAULT_WATCH_DEBOUNCE_MS,
    type IndexOperationPhase,
    type IndexOperationReceipt,
} from "../config.js";
import {
    formatMutationLeaseBlockedMessage,
    MutationLeaseCoordinator,
    type RootMutationLease,
} from "./mutation-lease.js";
import {
    SourceObservationState,
} from "./source-observation-state.js";

interface SyncManagerOptions {
    watchEnabled?: boolean;
    watchDebounceMs?: number;
    now?: () => number;
    onSyncCompleted?: (
        codebasePath: string,
        stats: SyncStats,
        assertMutationCurrent: () => void,
    ) => Promise<void> | void;
    mutationLeaseCoordinator?: MutationLeaseCoordinator;
    sourceFreshnessPort?: SourceFreshnessPort;
    crossProcessJoinTimeoutMs?: number;
    crossProcessJoinPollMs?: number;
    onLifecycleActivityChanged?: () => void;
}

export type FreshnessDecisionMode =
    | 'synced'
    | 'skipped_recent'
    | 'skipped_source_unchanged'
    | 'coalesced'
    | 'skipped_indexing'
    | 'skipped_requires_reindex'
    | 'skipped_source_checkpoint_unavailable'
    | 'skipped_mutation_in_progress'
    | 'skipped_missing_path'
    | 'reconciled_ignore_change'
    | 'ignore_reload_failed'
    | 'served_previous_generation';

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
    activeMutation?: RootMutationLease;
    operation?: IndexOperationReceipt;
    checkpointStatus?: 'missing' | 'corrupt';
    servedCollection?: string;
    servedRunId?: string;
    servedGenerationId?: string;
    servedGeneration?: number;
    pendingOperation?: {
        action: string;
        generation: number;
    };
}

export type FreshnessTriggerReason =
    | 'watcher_pending'
    | 'exact_compare_differs'
    | 'exact_compare_unavailable'
    | 'full_compare_differs'
    | 'full_compare_unavailable'
    | 'ignore_control_changed'
    | 'checkpoint_changed'
    | 'threshold_expired'
    | 'manual_zero_threshold';

export interface FreshnessTriggerInput {
    watcherPending?: boolean;
    exactComparison?: { status: string; changedPaths?: readonly string[] };
    fullComparison?: { status: string };
    ignoreControlChanged?: boolean;
    checkpointChanged?: boolean;
    thresholdMs?: number;
    timeSinceLastSyncMs?: number;
}

export function determineFreshnessTriggerReason(input: FreshnessTriggerInput): FreshnessTriggerReason {
    if (input.ignoreControlChanged) return 'ignore_control_changed';
    if (input.checkpointChanged) return 'checkpoint_changed';
    if (input.exactComparison?.status === 'differs') return 'exact_compare_differs';
    if (input.fullComparison?.status === 'differs') return 'full_compare_differs';
    if (input.watcherPending) return 'watcher_pending';
    if (input.exactComparison?.status === 'unavailable') return 'exact_compare_unavailable';
    if (input.fullComparison?.status === 'unavailable') return 'full_compare_unavailable';
    if (input.thresholdMs === 0) return 'manual_zero_threshold';
    return 'threshold_expired';
}

export type WatcherLifecycleState = 'starting' | 'ready' | 'failed' | 'stopped';
export type WatcherObservationCoverage = WatcherLifecycleState | 'disabled';
export type WatcherEventReason =
    | 'source_changed'
    | 'ignore_rules_changed'
    | 'directory_changed';

export type CandidateWatcherPolicy = Readonly<{
    policyHash: string;
    effectiveIgnorePatterns: readonly string[];
}>;

export type WatcherBootstrapCapture = Readonly<{
    canonicalRoot: string;
    watcherGeneration: number;
    observedEventEpoch: number;
    candidatePolicyHash: string;
}>;

export type FullIndexSourceHandoffInput = Readonly<{
    capture: WatcherBootstrapCapture;
    candidatePolicyHash: string;
    checkpointObservation: string;
    provenGeneration: ProvenVectorGenerationReceipt;
}>;

export type FullIndexSourceHandoffBarrierInput = Readonly<{
    candidatePolicyHash: string;
    markerRunId: string;
}>;

export interface WatcherObservationSnapshot {
    observedEventEpoch: number;
    comparedThroughEventEpoch: number;
    latestEpochByReason: Readonly<Record<WatcherEventReason, number>>;
    lastEventAt?: number;
    coverage: WatcherObservationCoverage;
    coverageGapSinceEpoch?: number;
    lastWatcherError?: string;
    pending: boolean;
}

export type PreparedReadObservationUnavailableReason =
    | 'watcher_disabled'
    | 'watcher_manager_not_started'
    | 'root_not_registered'
    | 'watcher_starting'
    | 'root_watcher_not_active'
    | 'watcher_failed'
    | 'watcher_event_pending'
    | 'watcher_observation_gap'
    | 'sync_active'
    | 'ignore_reconcile_active'
    | 'source_observation_failed'
    | 'checkpoint_unverified'
    | 'checkpoint_missing'
    | 'checkpoint_corrupt'
    | 'checkpoint_observation_mismatch';

export type PreparedReadObservation = {
    freshnessEpoch: number;
    watcherState: 'ready';
    checkpointObservation?: string;
};

export type PreparedReadObservationResult =
    | {
        available: true;
        observation: PreparedReadObservation;
    }
    | {
        available: false;
        reason: PreparedReadObservationUnavailableReason;
        freshnessEpoch: number;
        watcherState?: WatcherLifecycleState;
    };

export type PreparedReadWatcherDiagnostics = {
    configured: boolean;
    managerStarted: boolean;
    rootRegistered: boolean;
    watcherActive: boolean;
    lifecycleState?: WatcherLifecycleState;
    lastErrorCode?: string;
    checkpointStatus:
        | 'valid'
        | 'missing'
        | 'corrupt'
        | 'observation_mismatch'
        | 'unverified';
};

interface SyncExecutionOutcome {
    mode: Exclude<
        FreshnessDecisionMode,
        'skipped_recent' | 'skipped_source_unchanged' | 'skipped_source_checkpoint_unavailable'
    >;
    stats?: SyncStats;
    activeMutation?: RootMutationLease;
    operation?: IndexOperationReceipt;
    errorMessage?: string;
}

interface SyncStats {
    added: number;
    removed: number;
    modified: number;
    changedFiles: string[];
    navigationRecovery?: 'rebuilt' | 'failed';
    collectionName?: string;
    indexedFiles?: number;
    totalChunks?: number;
    indexStatus?: 'completed' | 'limit_reached';
    generationReceipt?: ProvenGenerationReceipt;
}

type SourceFreshnessCheckpointEvidence = Awaited<
    ReturnType<Context['inspectSourceFreshnessCheckpoint']>
>;
type ValidSourceFreshnessCheckpointEvidence = Extract<
    SourceFreshnessCheckpointEvidence,
    { status: 'valid' }
>;
type SourceFreshnessCheckpointValidation =
    | { checkpoint: ValidSourceFreshnessCheckpointEvidence | null }
    | { failure: FreshnessDecision };

interface RootWatcherObservation {
    observedEventEpoch: number;
    comparedThroughEventEpoch: number;
    latestEpochByReason: Map<WatcherEventReason, number>;
    lastEventAt?: number;
    coverage: WatcherObservationCoverage;
    coverageGapSinceEpoch?: number;
    lastWatcherError?: string;
}

interface EnsureFreshnessOptions {
    reason?: 'default' | 'ignore_change';
    coalescedEdits?: number;
    skipIgnoreControlCheck?: boolean;
    mutationLease?: RootMutationLease;
    preparedVectorReceipt?: ProvenVectorGenerationReceipt;
    exactSourceComparisonPaths?: readonly string[];
    fullSourceComparison?: boolean;
    onPhaseTiming?: (
        phase:
            | 'checkpoint_proof'
            | 'exact_path_comparison'
            | 'incremental_publication'
            | 'publication_source_navigation_load'
            | 'publication_fork'
            | 'publication_payload_delta'
            | 'publication_navigation_checkpoint'
            | 'publication_navigation_delta'
            | 'publication_relationship_load'
            | 'publication_relationship_delta'
            | 'publication_sidecar_stage'
            | 'publication_checkpoint_stage'
            | 'publication_payload_count'
            | 'publication_activation'
            | 'publication_retention_proof',
        durationMs: number,
    ) => void;
}

type CrossProcessSyncJoinRequest = Pick<
    EnsureFreshnessOptions,
    'exactSourceComparisonPaths' | 'onPhaseTiming'
>;

interface IgnoreReloadResult {
    previousMatcher?: ReturnType<typeof ignore>;
    matcher: ReturnType<typeof ignore>;
    version: number;
}

// v1 policy: only root-level control files trigger index-policy reconciliation.
const IGNORE_RULE_CONTROL_FILES = new Set(['.satoriignore', '.gitignore', 'satori.toml']);
const DEFAULT_CROSS_PROCESS_JOIN_TIMEOUT_MS = 15_000;
const DEFAULT_CROSS_PROCESS_JOIN_POLL_MS = 25;

function errorMessage(error: unknown, fallback = "unknown_error"): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === "string" && error.length > 0) {
        return error;
    }
    if (error === null || error === undefined) {
        return fallback;
    }
    return String(error);
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

export class SyncOperationError extends Error {
    public readonly cause: unknown;

    constructor(
        message: string,
        public readonly operation: IndexOperationReceipt | undefined,
        options?: { cause?: unknown },
    ) {
        super(message);
        this.name = "SyncOperationError";
        this.cause = options?.cause;
    }
}

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private sourceFreshnessPort: SourceFreshnessPort | null;
    private activeSyncs: Map<string, Promise<SyncExecutionOutcome>> = new Map();
    private lastSyncTimes: Map<string, number> = new Map();
    private backgroundSyncTimer: NodeJS.Timeout | null = null;
    private backgroundSyncEnabled = false;
    private backgroundSyncFlight: Promise<void> | null = null;
    private watcherModeStarted = false;
    private watchEnabled: boolean;
    private watchedCodebases: Set<string> = new Set();
    private watchers: Map<string, FSWatcher> = new Map();
    private watcherLifecycleStates: Map<string, WatcherLifecycleState> = new Map();
    private watcherErrorCodes: Map<string, string> = new Map();
    private watcherIgnoreMatchers: Map<string, ReturnType<typeof ignore>> = new Map();
    private watcherCandidatePolicies: Map<string, CandidateWatcherPolicy> = new Map();
    private watcherGenerations: Map<string, number> = new Map();
    private nextWatcherGeneration = 0;
    private ignoreRulesVersions: Map<string, number> = new Map();
    private activeIgnoreReconciles: Map<string, Promise<FreshnessDecision>> = new Map();
    private freshnessEpochs: Map<string, number> = new Map();
    private watcherObservations: Map<string, RootWatcherObservation> = new Map();
    private readonly sourceObservationState: SourceObservationState;
    private readonly now: () => number;
    private readonly onSyncCompleted?: SyncManagerOptions['onSyncCompleted'];
    private readonly mutationLeaseCoordinator?: MutationLeaseCoordinator;
    private readonly crossProcessJoinTimeoutMs: number;
    private readonly crossProcessJoinPollMs: number;
    private readonly onLifecycleActivityChanged?: () => void;

    constructor(context: Context, snapshotManager: SnapshotManager, options: SyncManagerOptions = {}) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.watchEnabled = options.watchEnabled === true;
        this.now = options.now || (() => Date.now());
        this.onSyncCompleted = options.onSyncCompleted;
        this.mutationLeaseCoordinator = options.mutationLeaseCoordinator;
        this.sourceFreshnessPort = options.sourceFreshnessPort ?? null;
        this.onLifecycleActivityChanged = options.onLifecycleActivityChanged;
        this.sourceObservationState = new SourceObservationState({
            assertMutationCurrent: (lease) => this.assertMutationCurrent(lease),
            hasCurrentWatcherCapture: (root, capture) => this.hasCurrentWatcherCapture(root, capture),
            coverWatcherObservation: (root, observedEventEpoch) => (
                this.coverWatcherObservation(root, observedEventEpoch)
            ),
            proveVectorGeneration: (root) => this.context.proveVectorGeneration(root),
            inspectSourceFreshnessCheckpoint: (root, checkpointIdentity, requestBoundReceipt) => (
                this.context.inspectSourceFreshnessCheckpoint(
                    root,
                    checkpointIdentity,
                    requestBoundReceipt,
                )
            ),
            getRegisteredSourceFreshnessCheckpointObservation: (root) => (
                this.context.getRegisteredSourceFreshnessCheckpointObservation(root)
            ),
            isPreparedReadAvailable: (root) => this.getPreparedReadObservation(root).available,
        });
        this.crossProcessJoinTimeoutMs = Math.max(
            1,
            options.crossProcessJoinTimeoutMs ?? DEFAULT_CROSS_PROCESS_JOIN_TIMEOUT_MS,
        );
        this.crossProcessJoinPollMs = Math.max(
            1,
            options.crossProcessJoinPollMs ?? DEFAULT_CROSS_PROCESS_JOIN_POLL_MS,
        );
    }

    private hasCurrentWatcherCapture(
        root: string,
        capture: WatcherBootstrapCapture,
    ): boolean {
        const observation = this.watcherObservations.get(root);
        return this.watchEnabled
            && this.watcherModeStarted
            && this.watchedCodebases.has(root)
            && this.watchers.has(root)
            && this.watcherLifecycleStates.get(root) === 'ready'
            && observation?.coverage === 'ready'
            && observation.observedEventEpoch >= capture.observedEventEpoch
            && this.watcherGenerations.get(root) === capture.watcherGeneration
            && this.watcherCandidatePolicies.get(root)?.policyHash === capture.candidatePolicyHash;
    }

    private bumpFreshnessEpoch(codebasePath: string): void {
        this.freshnessEpochs.set(codebasePath, (this.freshnessEpochs.get(codebasePath) ?? 0) + 1);
    }

    private canonicalWatcherRoot(codebasePath: string): string {
        return path.resolve(codebasePath);
    }

    private ensureWatcherObservation(
        codebasePath: string,
        coverage: WatcherObservationCoverage = this.watchEnabled ? 'starting' : 'disabled',
    ): RootWatcherObservation {
        const root = this.canonicalWatcherRoot(codebasePath);
        const existing = this.watcherObservations.get(root);
        if (existing) {
            return existing;
        }
        const observation: RootWatcherObservation = {
            observedEventEpoch: 0,
            comparedThroughEventEpoch: 0,
            latestEpochByReason: new Map(),
            coverage,
            ...(coverage === 'ready' ? {} : { coverageGapSinceEpoch: 0 }),
        };
        this.watcherObservations.set(root, observation);
        return observation;
    }

    private setWatcherCoverage(
        codebasePath: string,
        coverage: WatcherObservationCoverage,
        error?: string,
    ): void {
        const root = this.canonicalWatcherRoot(codebasePath);
        const observation = this.ensureWatcherObservation(root, coverage);
        observation.coverage = coverage;
        if (coverage === 'starting' || coverage === 'failed' || coverage === 'stopped' || coverage === 'disabled') {
            observation.coverageGapSinceEpoch ??= observation.observedEventEpoch;
        }
        if (error) {
            observation.lastWatcherError = error;
        } else if (coverage === 'starting' || coverage === 'ready') {
            delete observation.lastWatcherError;
        }
        if (coverage === 'disabled') {
            this.watcherLifecycleStates.delete(root);
        } else {
            this.watcherLifecycleStates.set(root, coverage);
        }
    }

    public recordWatcherEvent(
        codebasePath: string,
        reason: WatcherEventReason,
    ): number | null {
        const root = this.canonicalWatcherRoot(codebasePath);
        if (!this.watchEnabled || !this.watcherModeStarted || !this.canObserveRoot(root)) {
            return null;
        }
        const observation = this.ensureWatcherObservation(root);
        observation.observedEventEpoch += 1;
        observation.latestEpochByReason.set(reason, observation.observedEventEpoch);
        observation.lastEventAt = this.now();
        this.bumpFreshnessEpoch(root);
        return observation.observedEventEpoch;
    }

    public getWatcherObservation(codebasePath: string): WatcherObservationSnapshot {
        const root = this.canonicalWatcherRoot(codebasePath);
        const observation = this.watcherObservations.get(root) ?? {
            observedEventEpoch: 0,
            comparedThroughEventEpoch: 0,
            latestEpochByReason: new Map<WatcherEventReason, number>(),
            coverage: !this.watchEnabled
                ? 'disabled' as const
                : this.watcherErrorCodes.has(root)
                    ? 'failed' as const
                    : this.watcherModeStarted
                        ? 'starting' as const
                        : 'stopped' as const,
            coverageGapSinceEpoch: 0,
            ...(this.watcherErrorCodes.get(root)
                ? { lastWatcherError: this.watcherErrorCodes.get(root) }
                : {}),
        };
        const latestEpochByReason = {
            source_changed: observation.latestEpochByReason.get('source_changed') ?? 0,
            ignore_rules_changed: observation.latestEpochByReason.get('ignore_rules_changed') ?? 0,
            directory_changed: observation.latestEpochByReason.get('directory_changed') ?? 0,
        };
        return {
            observedEventEpoch: observation.observedEventEpoch,
            comparedThroughEventEpoch: observation.comparedThroughEventEpoch,
            latestEpochByReason,
            ...(observation.lastEventAt !== undefined ? { lastEventAt: observation.lastEventAt } : {}),
            coverage: observation.coverage,
            ...(observation.coverageGapSinceEpoch !== undefined
                ? { coverageGapSinceEpoch: observation.coverageGapSinceEpoch }
                : {}),
            ...(observation.lastWatcherError ? { lastWatcherError: observation.lastWatcherError } : {}),
            pending: observation.observedEventEpoch > observation.comparedThroughEventEpoch
                || observation.coverageGapSinceEpoch !== undefined,
        };
    }

    private captureWatcherFlightEpoch(codebasePath: string): number | undefined {
        const observation = this.watcherObservations.get(this.canonicalWatcherRoot(codebasePath));
        if (!observation) return undefined;
        return observation.observedEventEpoch;
    }

    /**
     * Captures the exact watcher observation that a completed full-index
     * candidate may later hand off to the prepared-source authority.
     */
    public captureWatcherBootstrap(
        codebasePath: string,
        candidatePolicyHash: string,
    ): WatcherBootstrapCapture | undefined {
        const root = this.canonicalWatcherRoot(codebasePath);
        const observation = this.watcherObservations.get(root);
        const watcherGeneration = this.watcherGenerations.get(root);
        const candidatePolicy = this.watcherCandidatePolicies.get(root);
        if (
            !this.watchEnabled
            || !this.watcherModeStarted
            || !this.watchedCodebases.has(root)
            || !this.canObserveRoot(root)
            || !this.watchers.has(root)
            || this.watcherLifecycleStates.get(root) !== 'ready'
            || observation?.coverage !== 'ready'
            || watcherGeneration === undefined
            || candidatePolicy?.policyHash !== candidatePolicyHash
        ) {
            return undefined;
        }
        return Object.freeze({
            canonicalRoot: root,
            watcherGeneration,
            observedEventEpoch: observation.observedEventEpoch,
            candidatePolicyHash,
        });
    }

    public beginFullIndexSourceHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffBarrierInput,
        mutationLease?: RootMutationLease,
    ): void {
        const root = this.canonicalWatcherRoot(codebasePath);
        this.sourceObservationState.beginHandoff(root, input, mutationLease);
    }

    public rejectFullIndexSourceHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffBarrierInput,
        mutationLease?: RootMutationLease,
    ): boolean {
        const root = this.canonicalWatcherRoot(codebasePath);
        return this.sourceObservationState.rejectHandoff(root, input, mutationLease);
    }

    private supersedeFullIndexSourceHandoffAfterSync(
        codebasePath: string,
        provenGeneration: ProvenVectorGenerationReceipt | undefined,
    ): boolean {
        const root = this.canonicalWatcherRoot(codebasePath);
        return this.sourceObservationState.supersedeHandoffAfterSync(root, provenGeneration);
    }

    /**
     * Binds an already-proven completed generation/checkpoint to the watcher
     * observation captured for the same candidate. This deliberately does not
     * use the ordinary snapshot-status-gated checkpoint validator: the full
     * index lifecycle is still marked indexing until this handoff succeeds or
     * fails closed.
     */
    public async completeFullIndexSourceHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffInput,
        mutationLease?: RootMutationLease,
    ): Promise<boolean> {
        const root = this.canonicalWatcherRoot(codebasePath);
        return this.sourceObservationState.completeHandoff(root, input, mutationLease);
    }

    private hasPendingWatcherObservation(codebasePath: string): boolean {
        const observation = this.watcherObservations.get(this.canonicalWatcherRoot(codebasePath));
        return observation !== undefined
            && (observation.observedEventEpoch > observation.comparedThroughEventEpoch
                || observation.coverageGapSinceEpoch !== undefined);
    }

    private coverWatcherObservation(codebasePath: string, flightEpoch: number | undefined): void {
        if (flightEpoch === undefined) return;
        const observation = this.watcherObservations.get(this.canonicalWatcherRoot(codebasePath));
        if (!observation) return;
        observation.comparedThroughEventEpoch = Math.max(
            observation.comparedThroughEventEpoch,
            flightEpoch,
        );
        for (const [reason, latestEpoch] of observation.latestEpochByReason.entries()) {
            if (latestEpoch <= observation.comparedThroughEventEpoch) {
                observation.latestEpochByReason.delete(reason);
            }
        }
        if (
            observation.coverage === 'ready'
            && observation.coverageGapSinceEpoch !== undefined
            && observation.coverageGapSinceEpoch <= observation.comparedThroughEventEpoch
        ) {
            delete observation.coverageGapSinceEpoch;
        }
    }

    public getPreparedReadObservation(codebasePath: string): PreparedReadObservationResult {
        const root = this.canonicalWatcherRoot(codebasePath);
        const freshnessEpoch = this.freshnessEpochs.get(root) ?? 0;
        const unavailable = (
            reason: PreparedReadObservationUnavailableReason,
        ): PreparedReadObservationResult => ({
            available: false,
            reason,
            freshnessEpoch,
            ...(this.watcherLifecycleStates.get(root)
                ? { watcherState: this.watcherLifecycleStates.get(root) }
                : {}),
        });
        if (!this.watchEnabled) return unavailable('watcher_disabled');
        if (!this.watcherModeStarted) return unavailable('watcher_manager_not_started');
        if (!this.watchedCodebases.has(root)) return unavailable('root_not_registered');
        if (this.watcherErrorCodes.has(root)) return unavailable('watcher_failed');
        const watcherState = this.watcherLifecycleStates.get(root);
        if (watcherState === 'starting') return unavailable('watcher_starting');
        if (watcherState !== 'ready' || !this.watchers.has(root)) {
            return unavailable('root_watcher_not_active');
        }
        const watcherObservation = this.watcherObservations.get(root);
        if (watcherObservation?.coverageGapSinceEpoch !== undefined) {
            return unavailable('watcher_observation_gap');
        }
        if (
            watcherObservation
            && watcherObservation.observedEventEpoch > watcherObservation.comparedThroughEventEpoch
        ) {
            return unavailable('watcher_event_pending');
        }
        if (this.activeSyncs.has(root)) return unavailable('sync_active');
        if (this.activeIgnoreReconciles.has(root)) return unavailable('ignore_reconcile_active');
        if (this.sourceObservationState.hasHandoffBarrier(root)) return unavailable('checkpoint_unverified');

        const checkpointInspectionSupported = typeof this.context.inspectSourceFreshnessCheckpoint === 'function';
        const checkpointObservation = this.sourceObservationState.getCheckpointObservation(root);
        const currentCheckpointObservation = this.sourceFreshnessPort
            ? this.sourceFreshnessPort.currentObservationToken(root)
            : this.context.getRegisteredSourceFreshnessCheckpointObservation?.(root);
        const checkpointStatus = this.sourceObservationState.getCheckpointStatus(root);
        if (checkpointInspectionSupported && checkpointStatus === 'missing') {
            return unavailable('checkpoint_missing');
        }
        if (checkpointInspectionSupported && checkpointStatus === 'corrupt') {
            return unavailable('checkpoint_corrupt');
        }
        if (checkpointInspectionSupported && checkpointStatus !== 'valid') {
            return unavailable('checkpoint_unverified');
        }
        if (checkpointInspectionSupported && (!checkpointObservation || !currentCheckpointObservation)) {
            return unavailable('checkpoint_observation_mismatch');
        }
        if (checkpointInspectionSupported && currentCheckpointObservation !== checkpointObservation) {
            return unavailable('checkpoint_observation_mismatch');
        }
        return {
            available: true,
            observation: {
                freshnessEpoch,
                watcherState: 'ready',
                ...(checkpointObservation ? { checkpointObservation } : {}),
            },
        };
    }

    public getPreparedReadDiagnostics(codebasePath: string): PreparedReadWatcherDiagnostics {
        const root = this.canonicalWatcherRoot(codebasePath);
        const checkpointState = this.sourceObservationState.hasHandoffBarrier(root)
            ? 'unverified' as const
            : this.sourceObservationState.getCheckpointStatus(root) ?? 'unverified';
        const checkpointObservation = this.sourceObservationState.getCheckpointObservation(root);
        const registeredCheckpointObservation = this.sourceFreshnessPort
            ? this.sourceFreshnessPort.currentObservationToken(root)
            : this.context.getRegisteredSourceFreshnessCheckpointObservation?.(root);
        const checkpointStatus = checkpointState === 'valid'
            && (!checkpointObservation || registeredCheckpointObservation !== checkpointObservation)
            ? 'observation_mismatch'
            : checkpointState;
        const lifecycleState = this.watcherLifecycleStates.get(root);
        const lastErrorCode = this.watcherErrorCodes.get(root);
        return {
            configured: this.watchEnabled,
            managerStarted: this.watcherModeStarted,
            rootRegistered: this.watchedCodebases.has(root),
            watcherActive: lifecycleState === 'ready' && this.watchers.has(root),
            ...(lifecycleState ? { lifecycleState } : {}),
            ...(lastErrorCode ? { lastErrorCode } : {}),
            checkpointStatus,
        };
    }

    private async inspectSourceFreshnessCheckpoint(
        codebasePath: string,
        preparedVectorReceipt?: ProvenVectorGenerationReceipt,
    ) {
        const status = this.snapshotManager.getCodebaseStatus(codebasePath);
        if (status !== 'indexed' && status !== 'sync_completed') return null;
        const info = this.snapshotManager.getCodebaseInfo?.(codebasePath) as { indexStatus?: unknown } | undefined;
        if (info?.indexStatus === 'limit_reached') return null;
        if (this.sourceFreshnessPort) {
            const prepared = await this.sourceFreshnessPort.prepareCurrentSourceObservation(
                codebasePath,
                { requestBoundReceipt: preparedVectorReceipt },
            );
            return prepared.available ? prepared.evidence : null;
        }
        const inspect = this.context.inspectSourceFreshnessCheckpoint as (
            this: Context,
            codebasePath: string,
            checkpointIdentity?: string,
            requestBoundReceipt?: ProvenVectorGenerationReceipt,
        ) => ReturnType<Context['inspectSourceFreshnessCheckpoint']>;
        if (typeof inspect !== 'function') return null;
        return inspect.call(
            this.context,
            codebasePath,
            undefined,
            preparedVectorReceipt,
        );
    }

    private async validateSourceFreshnessCheckpoint(
        codebasePath: string,
        checkedAt: string,
        thresholdMs: number,
        preparedVectorReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SourceFreshnessCheckpointValidation> {
        const checkpointEvidence = await this.inspectSourceFreshnessCheckpoint(
            codebasePath,
            preparedVectorReceipt,
        );
        if (checkpointEvidence?.status === 'valid') {
            const previousObservation = this.sourceObservationState.recordValidCheckpointObservation(
                codebasePath,
                checkpointEvidence.observationToken,
            );
            if (previousObservation && previousObservation !== checkpointEvidence.observationToken) {
                this.bumpFreshnessEpoch(codebasePath);
            }
            return { checkpoint: checkpointEvidence };
        }
        if (!checkpointEvidence) return { checkpoint: null };

        this.sourceObservationState.recordUnavailableCheckpoint(codebasePath, checkpointEvidence.status);
        this.lastSyncTimes.delete(codebasePath);
        this.bumpFreshnessEpoch(codebasePath);
        return {
            failure: {
                mode: 'skipped_source_checkpoint_unavailable',
                checkedAt,
                thresholdMs,
                checkpointStatus: checkpointEvidence.status,
                errorMessage: checkpointEvidence.message,
            },
        };
    }

    private persistOwnedOperationStart(lease: RootMutationLease | undefined, ownsLease: boolean): IndexOperationReceipt | undefined {
        if (!lease || !ownsLease || typeof this.snapshotManager.startOperation !== "function") {
            return undefined;
        }
        this.assertMutationCurrent(lease);
        const operation = typeof this.snapshotManager.commitOperationPhase === "function"
            ? this.snapshotManager.commitOperationPhase(
                lease,
                "accepted",
                undefined,
                () => this.assertMutationCurrent(lease),
            )
            : this.snapshotManager.startOperation(lease);
        if (
            typeof this.snapshotManager.commitOperationPhase !== "function"
            && this.snapshotManager.saveCodebaseSnapshot() === false
        ) {
            throw new Error(`Failed to persist accepted sync operation receipt for '${lease.canonicalRoot}'.`);
        }
        return operation;
    }

    private persistOwnedOperationPhase(
        lease: RootMutationLease | undefined,
        ownsLease: boolean,
        phase: IndexOperationPhase,
        mutateSnapshot?: () => void,
    ): IndexOperationReceipt | undefined {
        if (!lease || !ownsLease) {
            mutateSnapshot?.();
            return undefined;
        }
        if (typeof this.snapshotManager.transitionOperation !== "function") {
            mutateSnapshot?.();
            return undefined;
        }
        this.assertMutationCurrent(lease);
        const operation = typeof this.snapshotManager.commitOperationPhase === "function"
            ? this.snapshotManager.commitOperationPhase(
                lease,
                phase,
                mutateSnapshot,
                () => this.assertMutationCurrent(lease),
            )
            : (() => {
                const next = this.snapshotManager.transitionOperation(lease, phase);
                mutateSnapshot?.();
                if (this.snapshotManager.saveCodebaseSnapshot() === false) {
                    throw new Error(`Failed to persist sync operation phase '${phase}' for '${lease.canonicalRoot}'.`);
                }
                return next;
            })();
        return operation;
    }

    public async recordCurrentIgnoreControlSignature(
        codebasePath: string,
        existingLease?: RootMutationLease,
    ): Promise<void> {
        return this.recordIgnoreControlSignature(
            codebasePath,
            () => this.computeIgnoreControlSignature(codebasePath),
            existingLease,
        );
    }

    public async recordObservedIgnoreControlSignature(
        codebasePath: string,
        observedIgnoreControlSignature: string,
        existingLease?: RootMutationLease,
    ): Promise<void> {
        if (typeof this.snapshotManager.setCodebaseIgnoreControlSignature !== 'function') {
            return;
        }
        if (!observedIgnoreControlSignature.startsWith('v1:')) {
            throw new Error('Observed ignore-control signature is invalid.');
        }
        return this.recordIgnoreControlSignature(
            codebasePath,
            async () => observedIgnoreControlSignature,
            existingLease,
        );
    }

    private async recordIgnoreControlSignature(
        codebasePath: string,
        resolveIgnoreControlSignature: () => Promise<string>,
        existingLease?: RootMutationLease,
    ): Promise<void> {
        if (typeof this.snapshotManager.setCodebaseIgnoreControlSignature !== 'function') {
            return;
        }

        let lease = existingLease;
        let releaseLease = false;
        let lastDurableOperation: IndexOperationReceipt | undefined;
        if (this.mutationLeaseCoordinator) {
            if (lease) {
                this.mutationLeaseCoordinator.assertCurrent(lease);
            } else {
                const acquired = this.mutationLeaseCoordinator.acquire(codebasePath, 'sync');
                if (!acquired.acquired) {
                    throw new Error(formatMutationLeaseBlockedMessage(acquired.activeLease));
                }
                lease = acquired.lease;
                releaseLease = true;
            }
        }

        try {
            lastDurableOperation = this.persistOwnedOperationStart(lease, releaseLease);
            const ignoreControlSignature = await resolveIgnoreControlSignature();
            this.assertMutationCurrent(lease);
            const operation = this.persistOwnedOperationPhase(lease, releaseLease, "completed", () => {
                this.snapshotManager.setCodebaseIgnoreControlSignature(codebasePath, ignoreControlSignature);
            });
            if (operation) {
                lastDurableOperation = operation;
            } else {
                this.snapshotManager.saveCodebaseSnapshot();
            }
        } catch (error) {
            if (releaseLease && lease && this.mutationLeaseCoordinator?.isCurrent(lease)) {
                try {
                    lastDurableOperation = this.persistOwnedOperationPhase(lease, true, "failed") ?? lastDurableOperation;
                } catch {
                    // Preserve the last receipt this operation durably owned.
                }
            }
            throw new SyncOperationError(errorMessage(error), lastDurableOperation, { cause: error });
        } finally {
            if (releaseLease && lease) {
                this.mutationLeaseCoordinator?.release(lease);
            }
        }
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
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        const flightEpoch = this.captureWatcherFlightEpoch(codebasePath);
        const watcherObservationPending = this.hasPendingWatcherObservation(codebasePath);
        if (watcherObservationPending) {
            thresholdMs = 0;
        }
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();

        if (options.reason === 'ignore_change') {
            const checkpointValidation = await this.validateSourceFreshnessCheckpoint(
                codebasePath,
                checkedAt,
                thresholdMs,
                options.preparedVectorReceipt,
            );
            if ('failure' in checkpointValidation) return checkpointValidation.failure;
            const decision = await this.runIgnoreReconcile(
                codebasePath,
                options.coalescedEdits,
                undefined,
                options.mutationLease,
                checkpointValidation.checkpoint?.generationReceipt,
            );
            if (decision.mode === 'reconciled_ignore_change') {
                this.coverWatcherObservation(codebasePath, flightEpoch);
            }
            return decision;
        }

        // Join a live mutation before inspecting its checkpoint. The owner may be
        // between marker withdrawal and checkpoint publication.
        if (this.activeSyncs.has(codebasePath)) {
            console.log(`[SYNC] 🛡️ Request Coalesced: Attaching to active sync for '${codebasePath}'`);
            const outcome = await this.activeSyncs.get(codebasePath);
            const lastSync = this.lastSyncTimes.get(codebasePath);
            return {
                mode: 'coalesced',
                checkedAt,
                thresholdMs,
                lastSyncAt: lastSync ? new Date(lastSync).toISOString() : undefined,
                ageMs: lastSync ? Math.max(0, checkedAtMs - lastSync) : undefined,
                stats: outcome?.stats ? {
                    added: outcome.stats.added,
                    removed: outcome.stats.removed,
                    modified: outcome.stats.modified,
                } : undefined,
                activeMutation: outcome?.activeMutation,
                operation: outcome?.operation,
            };
        }

        // Source-freshness ownership is a precondition for every incremental path,
        // including ignore reconciliation. The identity comes from Core authority,
        // never from the lifecycle snapshot.
        const checkpointValidationStartedAt = Date.now();
        const checkpointValidation = await this.validateSourceFreshnessCheckpoint(
            codebasePath,
            checkedAt,
            thresholdMs,
            options.preparedVectorReceipt,
        );
        options.onPhaseTiming?.(
            'checkpoint_proof',
            Math.max(0, Date.now() - checkpointValidationStartedAt),
        );
        if ('failure' in checkpointValidation) return checkpointValidation.failure;

        let currentIgnoreControlSignature: string | undefined;
        if (options.skipIgnoreControlCheck !== true) {
            currentIgnoreControlSignature = await this.computeIgnoreControlSignature(codebasePath);
            const persistedIgnoreControlSignature = this.snapshotManager.getCodebaseIgnoreControlSignature?.(codebasePath);
            const publishedPolicy = checkpointValidation.checkpoint
                ?.generationReceipt
                ?.policy;
            const publishedIgnoreControlSignature = publishedPolicy?.controlSignature;
            const acceptedIgnoreControlSignature = publishedIgnoreControlSignature
                ?? persistedIgnoreControlSignature;
            const requiresDurableControlBinding = publishedPolicy !== undefined
                && publishedIgnoreControlSignature === undefined;

            if (typeof acceptedIgnoreControlSignature === 'string') {
                if (
                    requiresDurableControlBinding
                    || acceptedIgnoreControlSignature !== currentIgnoreControlSignature
                ) {
                    const decision = await this.runIgnoreReconcile(
                        codebasePath,
                        1,
                        currentIgnoreControlSignature,
                        options.mutationLease,
                        checkpointValidation.checkpoint?.generationReceipt,
                    );
                    if (decision.mode === 'reconciled_ignore_change') {
                        this.coverWatcherObservation(codebasePath, flightEpoch);
                    }
                    return decision;
                }
            } else if (
                (this.snapshotManager.getCodebaseStatus(codebasePath) === 'indexed'
                    || this.snapshotManager.getCodebaseStatus(codebasePath) === 'sync_completed')
                && typeof this.snapshotManager.setCodebaseIgnoreControlSignature === 'function'
            ) {
                const indexedPaths = typeof this.snapshotManager.getCodebaseIndexedPaths === 'function'
                    ? this.snapshotManager.getCodebaseIndexedPaths(codebasePath)
                    : [];
                const hasSynchronizer = typeof this.context.hasSynchronizerForCodebase === 'function'
                    ? this.context.hasSynchronizerForCodebase(codebasePath)
                    : false;

                if (indexedPaths.length > 0 || hasSynchronizer) {
                    const decision = await this.runIgnoreReconcile(
                        codebasePath,
                        1,
                        currentIgnoreControlSignature,
                        options.mutationLease,
                        checkpointValidation.checkpoint?.generationReceipt,
                    );
                    if (decision.mode === 'reconciled_ignore_change') {
                        this.coverWatcherObservation(codebasePath, flightEpoch);
                    }
                    return decision;
                }

            }
        }

        let exactComparisonResult: { status: string; changedPaths?: readonly string[] } | undefined;
        const exactSourceComparisonPaths = options.exactSourceComparisonPaths;
        if (!watcherObservationPending && exactSourceComparisonPaths && exactSourceComparisonPaths.length > 0) {
            const compareSourcePaths = this.context.compareSourcePathsToFreshnessCheckpoint;
            if (typeof compareSourcePaths === 'function') {
                const exactComparisonStartedAt = Date.now();
                const comparison = await compareSourcePaths.call(
                    this.context,
                    codebasePath,
                    exactSourceComparisonPaths,
                    options.preparedVectorReceipt,
                );
                exactComparisonResult = comparison;
                options.onPhaseTiming?.(
                    'exact_path_comparison',
                    Math.max(0, Date.now() - exactComparisonStartedAt),
                );
                if (comparison.status === 'matches') {
                    return {
                        mode: 'skipped_source_unchanged',
                        checkedAt,
                        thresholdMs,
                    };
                }
            }
        }

        let fullComparisonResult: { status: string } | undefined;
        if (options.fullSourceComparison === true) {
            const compareAllSource = this.context.compareAllSourceToFreshnessCheckpoint;
            if (typeof compareAllSource === 'function') {
                const fullComparisonStartedAt = Date.now();
                const comparison = await compareAllSource.call(
                    this.context,
                    codebasePath,
                    options.preparedVectorReceipt,
                );
                fullComparisonResult = comparison;
                options.onPhaseTiming?.(
                    'exact_path_comparison',
                    Math.max(0, Date.now() - fullComparisonStartedAt),
                );
                if (comparison.status === 'matches') {
                    return {
                        mode: 'skipped_source_unchanged',
                        checkedAt,
                        thresholdMs,
                    };
                }
            }
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
        const triggerReason = determineFreshnessTriggerReason({
            watcherPending: watcherObservationPending,
            exactComparison: exactComparisonResult,
            fullComparison: fullComparisonResult,
            ignoreControlChanged: false,
            thresholdMs,
            timeSinceLastSyncMs: timeSince,
        });
        console.log(`[SYNC] 🔄 Triggering Sync for '${codebasePath}'. Trigger: ${triggerReason} (Threshold: ${thresholdMs}ms)`);

        this.bumpFreshnessEpoch(codebasePath);
        const syncPromise = (async () => {
            try {
                return await this.syncCodebase(
                    codebasePath,
                    options.mutationLease,
                    currentIgnoreControlSignature,
                    {
                        exactSourceComparisonPaths: options.exactSourceComparisonPaths,
                        onPhaseTiming: options.onPhaseTiming,
                    },
                    checkpointValidation.checkpoint?.generationReceipt,
                );
            } catch (e) {
                // Log and rethrow to allow callers to handle/see failure
                console.error(`[SYNC] Error syncing '${codebasePath}':`, e);
                throw e;
            } finally {
                this.activeSyncs.delete(codebasePath);
                this.bumpFreshnessEpoch(codebasePath);
            }
        })();

        this.activeSyncs.set(codebasePath, syncPromise);
        const outcome = await syncPromise;
        const committedCheckpointStartedAt = Date.now();
        const committedCheckpoint = await this.inspectSourceFreshnessCheckpoint(
            codebasePath,
            outcome.stats?.generationReceipt,
        );
        options.onPhaseTiming?.(
            'checkpoint_proof',
            Math.max(0, Date.now() - committedCheckpointStartedAt),
        );
        if (committedCheckpoint?.status === 'valid') {
            this.sourceObservationState.recordValidCheckpointObservation(
                codebasePath,
                committedCheckpoint.observationToken,
            );
        } else {
            if (committedCheckpoint?.status === 'missing' || committedCheckpoint?.status === 'corrupt') {
                this.sourceObservationState.recordUnavailableCheckpoint(codebasePath, committedCheckpoint.status);
            } else {
                this.sourceObservationState.clearCheckpointObservation(codebasePath);
            }
        }
        const lastSyncedAt = this.lastSyncTimes.get(codebasePath);
        const decision: FreshnessDecision = {
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
            activeMutation: outcome.activeMutation,
            operation: outcome.operation,
            errorMessage: outcome.errorMessage,
        };
        if (outcome.mode === 'synced' && !outcome.errorMessage) {
            this.coverWatcherObservation(codebasePath, flightEpoch);
            if (committedCheckpoint?.status === 'valid') {
                this.supersedeFullIndexSourceHandoffAfterSync(
                    codebasePath,
                    committedCheckpoint.generationReceipt,
                );
            }
        }
        return decision;
    }

    private async runIgnoreReconcile(
        codebasePath: string,
        coalescedEdits: number = 1,
        nextIgnoreControlSignature?: string,
        existingLease?: RootMutationLease,
        preparedVectorReceipt?: ProvenVectorGenerationReceipt,
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

        let lease = existingLease;
        let releaseLease = false;
        let lastDurableOperation: IndexOperationReceipt | undefined;
        if (this.mutationLeaseCoordinator) {
            if (lease) {
                this.mutationLeaseCoordinator.assertCurrent(lease);
            } else {
                const acquired = this.mutationLeaseCoordinator.acquire(codebasePath, 'sync');
                if (!acquired.acquired) {
                    return {
                        mode: 'skipped_mutation_in_progress',
                        checkedAt,
                        thresholdMs: 0,
                        activeMutation: acquired.activeLease,
                    };
                }
                lease = acquired.lease;
                releaseLease = true;
            }
        }

        try {
            lastDurableOperation = this.persistOwnedOperationStart(lease, releaseLease);
            console.log(`[SYNC] 🔁 Ignore control files changed for '${codebasePath}', running reconciliation.`);
            const promise = this.reconcileIgnoreRulesChange(
                codebasePath,
                coalescedEdits,
                nextIgnoreControlSignature,
                lease,
                preparedVectorReceipt,
            );
            this.activeIgnoreReconciles.set(reconcileKey, promise);
            const decision = await promise;
            const phase = decision.mode === "ignore_reload_failed"
                ? "failed"
                : decision.mode === "skipped_requires_reindex"
                    ? "blocked"
                    : "completed";
            const operation = this.persistOwnedOperationPhase(lease, releaseLease, phase);
            if (operation) {
                lastDurableOperation = operation;
            }
            return {
                ...decision,
                ...(lastDurableOperation ? { operation: lastDurableOperation } : {}),
            };
        } catch (error) {
            if (releaseLease && lease && this.mutationLeaseCoordinator?.isCurrent(lease)) {
                try {
                    lastDurableOperation = this.persistOwnedOperationPhase(lease, true, "failed") ?? lastDurableOperation;
                } catch {
                    // Preserve the last receipt this operation durably owned.
                }
            }
            throw new SyncOperationError(errorMessage(error), lastDurableOperation, { cause: error });
        } finally {
            this.activeIgnoreReconciles.delete(reconcileKey);
            if (releaseLease && lease) {
                this.mutationLeaseCoordinator?.release(lease);
            }
        }
    }

    private async reconcileIgnoreRulesChange(
        codebasePath: string,
        coalescedEdits: number = 1,
        nextIgnoreControlSignature?: string,
        mutationLease?: RootMutationLease,
        preparedVectorReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<FreshnessDecision> {
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();
        const startedAt = checkedAtMs;
        let resolvedIgnoreControlSignature = nextIgnoreControlSignature ?? await this.computeIgnoreControlSignature(codebasePath);
        let indexedStateMutated = false;
        let policyObservationEstablished = false;

        try {
            if (this.activeSyncs.has(codebasePath)) {
                console.log(`[SYNC] ⏳ Ignore-rule reconcile waiting for in-flight sync '${codebasePath}'`);
                await this.activeSyncs.get(codebasePath);
            }

            const candidatePolicy = await this.context.observeIndexPolicyForIncrementalReconciliation(codebasePath);
            policyObservationEstablished = true;
            resolvedIgnoreControlSignature = candidatePolicy.controlSignature;
            this.assertMutationCurrent(mutationLease);
            if (!await this.context.activateObservedIndexPolicyForIncrementalReconciliation(candidatePolicy)) {
                this.snapshotManager.setCodebaseRequiresReindex(
                    codebasePath,
                    'index_policy_changed',
                    'Repository index-policy inputs changed. A full reindex is required before the new policy can become authoritative.',
                );
                this.snapshotManager.saveCodebaseSnapshot();
                return {
                    mode: 'skipped_requires_reindex',
                    checkedAt,
                    thresholdMs: 0,
                    coalescedEdits: Math.max(1, coalescedEdits),
                    durationMs: Math.max(0, this.now() - startedAt),
                    errorMessage: 'index_policy_changed',
                };
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

            const { previousMatcher, matcher, version } = await this.refreshIgnoreMatcherForCodebase(
                codebasePath,
                mutationLease,
            );

            if (typeof this.context.recreateSynchronizerForCodebase === 'function') {
                this.assertMutationCurrent(mutationLease);
                await this.context.recreateSynchronizerForCodebase(
                    codebasePath,
                    mutationLease ? () => this.assertMutationCurrent(mutationLease) : undefined,
                    mutationLease
                        ? (publish: () => void) => {
                            if (!this.mutationLeaseCoordinator) {
                                throw new Error(`Cannot publish synchronizer baseline for '${codebasePath}' without a mutation lease coordinator.`);
                            }
                            this.mutationLeaseCoordinator.publishWhileCurrent(mutationLease, publish);
                        }
                        : undefined,
                    { requireAuthorityCheckpoint: true },
                );
                this.assertMutationCurrent(mutationLease);
            }

            // Self-healing delete rule: remove anything currently indexed that new matcher ignores.
            const toDelete = indexedPathsBeforeReload.filter((relativePath) => this.matcherIgnoresRelativePath(matcher, relativePath));
            const retainedPaths = indexedPathsBeforeReload.filter((relativePath) => !this.matcherIgnoresRelativePath(matcher, relativePath));

            if (toDelete.length > 0 && typeof this.context.deleteIndexedPathsByRelativePaths === 'function') {
                if (mutationLease) {
                    this.mutationLeaseCoordinator?.assertCurrent(mutationLease);
                }
                await this.context.deleteIndexedPathsByRelativePaths(
                    codebasePath,
                    toDelete,
                    mutationLease ? () => this.assertMutationCurrent(mutationLease) : undefined,
                );
                indexedStateMutated = true;
            }

            if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                this.assertMutationCurrent(mutationLease);
                this.snapshotManager.setCodebaseIndexManifest(codebasePath, retainedPaths);
            }
            this.assertMutationCurrent(mutationLease);
            this.snapshotManager.saveCodebaseSnapshot();

            // Deleting newly ignored payload invalidates ordinary live proof.
            // Carry the pre-delete receipt so Core can revalidate that exact
            // source generation after the mutation lease is held.
            const syncDecision = await this.ensureFreshness(codebasePath, 0, {
                skipIgnoreControlCheck: true,
                mutationLease,
                preparedVectorReceipt,
            });
            const lastSyncAt = syncDecision.lastSyncAt;
            const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : undefined;
            const newlyIgnoredCount = previousMatcher
                ? indexedPathsBeforeReload.filter((relativePath) => !this.matcherIgnoresRelativePath(previousMatcher, relativePath) && this.matcherIgnoresRelativePath(matcher, relativePath)).length
                : toDelete.length;

            if (typeof this.snapshotManager.setCodebaseIgnoreControlSignature === 'function') {
                this.assertMutationCurrent(mutationLease);
                this.snapshotManager.setCodebaseIgnoreControlSignature(codebasePath, resolvedIgnoreControlSignature);
            }
            this.assertMutationCurrent(mutationLease);
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
        } catch (error) {
            let fallbackSyncExecuted = false;
            let fallbackStats: { added: number; removed: number; modified: number } | undefined;
            let fallbackRecovered = false;
            if (policyObservationEstablished) {
                try {
                    const fallbackDecision = await this.ensureFreshness(codebasePath, 0, {
                        skipIgnoreControlCheck: true,
                        mutationLease,
                    });
                    fallbackSyncExecuted = true;
                    fallbackStats = fallbackDecision.stats;
                    fallbackRecovered = fallbackDecision.mode === 'synced';
                } catch {
                    // Preserve primary failure metadata even if fallback sync fails.
                }
            }

            if (indexedStateMutated && !fallbackRecovered) {
                this.assertMutationCurrent(mutationLease);
                this.snapshotManager.setCodebaseRequiresReindex(
                    codebasePath,
                    'navigation_recovery_failed',
                    'Ignore-rule reconciliation deleted indexed paths, but sync recovery failed. Reindex is required before navigation tools are reliable.'
                );
                this.snapshotManager.saveCodebaseSnapshot();
            }

            return {
                mode: 'ignore_reload_failed',
                checkedAt,
                thresholdMs: 0,
                ignoreRulesVersion: this.ignoreRulesVersions.get(codebasePath),
                coalescedEdits: Math.max(1, coalescedEdits),
                durationMs: Math.max(0, this.now() - startedAt),
                errorMessage: errorMessage(error, "unknown_ignore_reload_error"),
                fallbackSyncExecuted,
                fallbackStats,
            };
        }
    }

    private async syncCodebase(
        codebasePath: string,
        existingLease?: RootMutationLease,
        currentIgnoreControlSignature?: string,
        joinRequest: CrossProcessSyncJoinRequest = {},
        preparedVectorReceipt?: ProvenVectorGenerationReceipt,
    ): Promise<SyncExecutionOutcome> {
        if (!this.canRunFreshnessMutation(codebasePath)
            && this.snapshotManager.getCodebaseStatus(codebasePath) === 'indexing') {
            console.log(`[SYNC] ⏭️  Skipping sync for '${codebasePath}' because indexing is active.`);
            return { mode: 'skipped_indexing' };
        }

        if (this.snapshotManager.getCodebaseStatus(codebasePath) === 'requires_reindex') {
            console.log(`[SYNC] ⏭️  Skipping sync for '${codebasePath}' because it requires reindex.`);
            return { mode: 'skipped_requires_reindex' };
        }

        let lease = existingLease;
        let releaseLease = false;
        let lastDurableOperation: IndexOperationReceipt | undefined;
        if (this.mutationLeaseCoordinator) {
            if (lease) {
                this.mutationLeaseCoordinator.assertCurrent(lease);
            } else {
                const acquired = this.mutationLeaseCoordinator.acquire(codebasePath, 'sync');
                if (!acquired.acquired) {
                    if (acquired.activeLease.action === 'sync') {
                        return this.joinCrossProcessSync(
                            codebasePath,
                            acquired.activeLease,
                            joinRequest,
                        );
                    }
                    return { mode: 'skipped_mutation_in_progress', activeMutation: acquired.activeLease };
                }
                lease = acquired.lease;
                releaseLease = true;
            }
        }

        try {
            lastDurableOperation = this.persistOwnedOperationStart(lease, releaseLease);
            // Async existence check to avoid blocking event loop.
            let pathMissing = false;
            try {
                this.assertMutationCurrent(lease);
                await fs.promises.access(codebasePath);
            } catch (error) {
                const code = errorCode(error);
                if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                    throw error;
                }
                pathMissing = true;
            }

            if (pathMissing) {
                // Clear vector/navigation state before dropping snapshot ownership
                // so a recreated path cannot inherit it.
                console.log(`[SYNC] 🗑️ Codebase '${codebasePath}' no longer exists. Clearing index state and removing from snapshot.`);
                this.assertMutationCurrent(lease);
                await this.context.clearIndex(codebasePath, undefined, {
                    ...(lease ? { assertMutationCurrent: () => this.assertMutationCurrent(lease) } : {}),
                });
                this.assertMutationCurrent(lease);
                const operation = this.persistOwnedOperationPhase(lease, releaseLease, "completed", () => {
                    this.snapshotManager.removeIndexedCodebase(codebasePath);
                });
                if (operation) {
                    lastDurableOperation = operation;
                } else {
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                await this.unwatchCodebase(codebasePath);
                return { mode: 'skipped_missing_path', operation: lastDurableOperation };
            }

            const assertCurrent = lease
                ? () => this.assertMutationCurrent(lease)
                : undefined;
            const publishCurrent = lease
                ? (publish: () => void) => {
                    if (!this.mutationLeaseCoordinator) {
                        throw new Error(`Cannot publish sync checkpoint for '${codebasePath}' without a mutation lease coordinator.`);
                    }
                    this.mutationLeaseCoordinator.publishWhileCurrent(lease, publish);
                }
                : undefined;
            const fencedCheckpointStartedAt = Date.now();
            const fencedCheckpoint = await this.inspectSourceFreshnessCheckpoint(
                codebasePath,
                preparedVectorReceipt,
            );
            joinRequest.onPhaseTiming?.(
                'checkpoint_proof',
                Math.max(0, Date.now() - fencedCheckpointStartedAt),
            );
            if (fencedCheckpoint && fencedCheckpoint.status !== 'valid') {
                throw new Error(
                    `Incremental sync cannot continue because its authoritative source checkpoint is ${fencedCheckpoint.status}: ${fencedCheckpoint.message}`,
                );
            }
            if (fencedCheckpoint?.status === 'valid') {
                this.sourceObservationState.recordCheckpointObservation(
                    codebasePath,
                    fencedCheckpoint.observationToken,
                );
                const registeredObservation = this.context.getRegisteredSourceFreshnessCheckpointObservation?.(codebasePath);
                if (
                    registeredObservation !== fencedCheckpoint.observationToken
                    && typeof this.context.recreateSynchronizerForCodebase === 'function'
                ) {
                    await this.context.recreateSynchronizerForCodebase(
                        codebasePath,
                        assertCurrent,
                        publishCurrent,
                        { requireAuthorityCheckpoint: true },
                    );
                    this.assertMutationCurrent(lease);
                }
            }

            // Incremental sync
            const syncOptions = {
                maintainCompletionMarker: true,
                ...(fencedCheckpoint?.status === 'valid' && fencedCheckpoint.generationReceipt ? {
                    sourceGenerationReceipt: fencedCheckpoint.generationReceipt,
                } : {}),
                ...(lease ? {
                    publicationAuthority: {
                        ownerId: lease.ownerId,
                        generation: lease.generation,
                        operationId: lease.operationId,
                    },
                } : {}),
                ...(assertCurrent && publishCurrent ? {
                    assertMutationCurrent: assertCurrent,
                    publishMutation: publishCurrent,
                } : {}),
                ...(joinRequest.onPhaseTiming
                    ? { onPhaseTiming: joinRequest.onPhaseTiming }
                    : {}),
            };
            if (lease) {
                this.mutationLeaseCoordinator?.assertCurrent(lease);
            }
            const writingOperation = this.persistOwnedOperationPhase(lease, releaseLease, "writing");
            if (writingOperation) {
                lastDurableOperation = writingOperation;
            }
            const publicationStartedAt = Date.now();
            const stats: SyncStats = await this.context.reindexByChange(codebasePath, undefined, syncOptions);
            joinRequest.onPhaseTiming?.(
                'incremental_publication',
                Math.max(0, Date.now() - publicationStartedAt),
            );
            if (lease) {
                this.mutationLeaseCoordinator?.assertCurrent(lease);
            }

            if (typeof this.context.getTrackedRelativePaths === 'function') {
                const trackedPaths = this.context.getTrackedRelativePaths(codebasePath);
                if (typeof this.snapshotManager.setCodebaseIndexManifest === 'function') {
                    this.assertMutationCurrent(lease);
                    this.snapshotManager.setCodebaseIndexManifest(codebasePath, trackedPaths);
                }
            }

            if (
                currentIgnoreControlSignature !== undefined
                && typeof this.snapshotManager.setCodebaseIgnoreControlSignature === 'function'
            ) {
                this.assertMutationCurrent(lease);
                this.snapshotManager.setCodebaseIgnoreControlSignature(codebasePath, currentIgnoreControlSignature);
            }

            // Centralized State Update
            this.lastSyncTimes.set(codebasePath, this.now());

            if (stats.navigationRecovery === 'failed') {
                this.assertMutationCurrent(lease);
                const operation = this.persistOwnedOperationPhase(lease, releaseLease, "failed", () => {
                    this.snapshotManager.setCodebaseRequiresReindex(
                        codebasePath,
                        'navigation_recovery_failed',
                        'Incremental sync completed, but navigation sidecar recovery failed. Reindex is required before navigation tools are reliable.'
                    );
                });
                if (operation) {
                    lastDurableOperation = operation;
                } else {
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                return { mode: 'skipped_requires_reindex', stats, operation: lastDurableOperation };
            }

            if (this.onSyncCompleted) {
                const assertMutationCurrent = () => this.assertMutationCurrent(lease);
                assertMutationCurrent();
                await this.onSyncCompleted(codebasePath, {
                    added: stats.added,
                    removed: stats.removed,
                    modified: stats.modified,
                    changedFiles: Array.isArray(stats.changedFiles) ? stats.changedFiles : []
                }, assertMutationCurrent);
                assertMutationCurrent();
            }

            if (lease) {
                this.mutationLeaseCoordinator?.assertCurrent(lease);
            }
            const operation = this.persistOwnedOperationPhase(lease, releaseLease, "completed", () => {
                this.snapshotManager.setCodebaseSyncCompleted(codebasePath, stats, undefined, 'verified', stats.collectionName);
            });
            if (operation) {
                lastDurableOperation = operation;
            } else {
                this.snapshotManager.saveCodebaseSnapshot();
            }

            if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                console.log(`[SYNC] ✅ Sync Result for '${codebasePath}': +${stats.added}, -${stats.removed}, ~${stats.modified}`);
            }
            return { mode: 'synced', stats, operation: lastDurableOperation };
        } catch (error) {
            console.error(`[SYNC] Failed to sync '${codebasePath}':`, error);
            if (error instanceof AtomicIncrementalPublicationUnsupportedError) {
                const operation = this.persistOwnedOperationPhase(lease, releaseLease, 'blocked', () => {
                    this.snapshotManager.setCodebaseRequiresReindex(
                        codebasePath,
                        'backend_requires_full_rebuild',
                        error.message,
                    );
                });
                if (operation) {
                    lastDurableOperation = operation;
                } else {
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                return {
                    mode: 'skipped_requires_reindex',
                    operation: lastDurableOperation,
                };
            }
            if (releaseLease && lease && this.mutationLeaseCoordinator?.isCurrent(lease)) {
                try {
                    lastDurableOperation = this.persistOwnedOperationPhase(lease, true, "failed") ?? lastDurableOperation;
                } catch {
                    // Preserve the last receipt this operation durably owned.
                }
            }
            throw new SyncOperationError(errorMessage(error), lastDurableOperation, { cause: error });
        } finally {
            if (releaseLease && lease) {
                this.mutationLeaseCoordinator?.release(lease);
            }
        }
    }

    private async joinCrossProcessSync(
        codebasePath: string,
        activeLease: RootMutationLease,
        request: CrossProcessSyncJoinRequest,
    ): Promise<SyncExecutionOutcome> {
        const observeOperation = this.snapshotManager.observeDurableLatestOperation;
        const matchesRuntime = this.snapshotManager.operationMatchesRuntimeFingerprint;
        if (
            !this.mutationLeaseCoordinator
            || typeof observeOperation !== 'function'
            || typeof matchesRuntime !== 'function'
        ) {
            return {
                mode: 'skipped_mutation_in_progress',
                activeMutation: activeLease,
            };
        }

        const deadline = Date.now() + this.crossProcessJoinTimeoutMs;
        let lastOperation: IndexOperationReceipt | undefined;
        while (Date.now() <= deadline) {
            const operation = observeOperation.call(this.snapshotManager, codebasePath);
            if (
                operation
                && operation.id === activeLease.operationId
                && operation.generation === activeLease.generation
                && operation.action === 'sync'
                && operation.canonicalRoot === activeLease.canonicalRoot
            ) {
                lastOperation = operation;
                if (!matchesRuntime.call(this.snapshotManager, operation)) {
                    return {
                        mode: 'coalesced',
                        activeMutation: activeLease,
                        operation,
                        errorMessage: 'The in-flight sync uses an incompatible runtime fingerprint.',
                    };
                }
                if (operation.phase === 'failed' || operation.phase === 'blocked') {
                    return {
                        mode: 'coalesced',
                        activeMutation: activeLease,
                        operation,
                        errorMessage: `The joined sync ended in terminal phase '${operation.phase}'.`,
                    };
                }
                if (operation.phase === 'completed') {
                    let checkpoint = await this.inspectSourceFreshnessCheckpoint(codebasePath);
                    if (!checkpoint || checkpoint.status !== 'valid') {
                        return {
                            mode: 'coalesced',
                            activeMutation: activeLease,
                            operation,
                            errorMessage: 'The joined sync completed without a proven active source checkpoint.',
                        };
                    }

                    const registeredObservation =
                        this.context.getRegisteredSourceFreshnessCheckpointObservation?.(codebasePath);
                    if (
                        registeredObservation !== checkpoint.observationToken
                        && typeof this.context.recreateSynchronizerForCodebase === 'function'
                    ) {
                        try {
                            await this.context.recreateSynchronizerForCodebase(
                                codebasePath,
                                undefined,
                                undefined,
                                { requireAuthorityCheckpoint: true },
                            );
                        } catch {
                            return {
                                mode: 'coalesced',
                                activeMutation: activeLease,
                                operation,
                                errorMessage: 'The joined sync completed, but this runtime could not bind its source checkpoint to the active publication.',
                            };
                        }
                        checkpoint = await this.inspectSourceFreshnessCheckpoint(codebasePath);
                        if (!checkpoint || checkpoint.status !== 'valid') {
                            return {
                                mode: 'coalesced',
                                activeMutation: activeLease,
                                operation,
                                errorMessage: 'The joined sync source checkpoint changed while this runtime was binding it.',
                            };
                        }
                        if (
                            this.context.getRegisteredSourceFreshnessCheckpointObservation?.(codebasePath)
                            !== checkpoint.observationToken
                        ) {
                            return {
                                mode: 'coalesced',
                                activeMutation: activeLease,
                                operation,
                                errorMessage: 'The joined sync source checkpoint did not bind to the active publication.',
                            };
                        }
                    }

                    const paths = request.exactSourceComparisonPaths;
                    if (paths && paths.length > 0) {
                        const compareSourcePaths = this.context.compareSourcePathsToFreshnessCheckpoint;
                        if (typeof compareSourcePaths !== 'function') {
                            return {
                                mode: 'coalesced',
                                activeMutation: activeLease,
                                operation,
                                errorMessage: 'The joined sync cannot prove the requested source observation.',
                            };
                        }
                        const comparison = await compareSourcePaths.call(
                            this.context,
                            codebasePath,
                            paths,
                        );
                        if (comparison.status !== 'matches') {
                            return {
                                mode: 'coalesced',
                                activeMutation: activeLease,
                                operation,
                                errorMessage: `The joined sync did not prove the requested source observation (${comparison.status}).`,
                            };
                        }
                    }

                    const finalOperation = observeOperation.call(this.snapshotManager, codebasePath);
                    if (
                        !finalOperation
                        || finalOperation.id !== operation.id
                        || finalOperation.generation !== operation.generation
                        || finalOperation.phase !== 'completed'
                    ) {
                        return {
                            mode: 'coalesced',
                            activeMutation: activeLease,
                            ...(finalOperation ? { operation: finalOperation } : { operation }),
                            errorMessage: 'The durable sync authority changed before the joined result could be accepted.',
                        };
                    }

                    this.sourceObservationState.recordValidCheckpointObservation(
                        codebasePath,
                        checkpoint.observationToken,
                    );
                    this.lastSyncTimes.set(codebasePath, this.now());
                    return {
                        mode: 'coalesced',
                        activeMutation: activeLease,
                        operation,
                    };
                }
            } else if (operation && operation.generation >= activeLease.generation) {
                return {
                    mode: 'coalesced',
                    activeMutation: activeLease,
                    operation,
                    errorMessage: 'The durable sync operation no longer matches the active mutation lease.',
                };
            }

            const currentLease = this.mutationLeaseCoordinator.getActiveLease(codebasePath);
            if (
                !currentLease
                || currentLease.operationId !== activeLease.operationId
                || currentLease.generation !== activeLease.generation
            ) {
                const terminal = observeOperation.call(this.snapshotManager, codebasePath);
                if (
                    terminal?.id === activeLease.operationId
                    && terminal.generation === activeLease.generation
                    && terminal.phase === 'completed'
                ) {
                    lastOperation = terminal;
                    continue;
                }
                return {
                    mode: 'coalesced',
                    activeMutation: activeLease,
                    ...(terminal ? { operation: terminal } : lastOperation ? { operation: lastOperation } : {}),
                    errorMessage: 'The in-flight sync lost its durable owner before proving completion.',
                };
            }
            await new Promise((resolve) => setTimeout(resolve, this.crossProcessJoinPollMs));
        }

        return {
            mode: 'coalesced',
            activeMutation: activeLease,
            ...(lastOperation ? { operation: lastOperation } : {}),
            errorMessage: 'Timed out waiting for the in-flight sync to prove completion.',
        };
    }

    public async handleSyncIndex(): Promise<void> {
        const indexedCodebases = this.snapshotManager.getIndexedCodebases();
        if (indexedCodebases.length === 0) return;

        // Execute sequentially to avoid resource spikes, but through the ensureFreshness gate.
        // Use BACKGROUND_FRESHNESS_THRESHOLD_MS (not 0). thresholdMs=0 always acquires a
        // mutation lease even for a no-op sync; that bumps mutationGeneration and invalidates
        // warm prepared-read observations mid multi-sample search sessions.
        // Recent search-driven syncs therefore skip; idle roots still recheck every interval.
        for (const codebasePath of indexedCodebases) {
            try {
                await this.ensureFreshness(codebasePath, BACKGROUND_FRESHNESS_THRESHOLD_MS);
            } catch (e) {
                // Individual codebase failure shouldn't stop the loop
                console.error(`[SYNC] Periodic sync failed for '${codebasePath}':`, e);
            }
        }
    }

    public startBackgroundSync(): void {
        if (this.backgroundSyncEnabled) {
            return;
        }

        this.backgroundSyncEnabled = true;
        this.scheduleBackgroundSync(BACKGROUND_SYNC_INITIAL_DELAY_MS);
    }

    private scheduleBackgroundSync(delayMs: number): void {
        if (!this.backgroundSyncEnabled) return;
        this.backgroundSyncTimer = setTimeout(() => {
            this.backgroundSyncTimer = null;
            void this.runBackgroundSync();
        }, delayMs);
    }

    private runBackgroundSync(): Promise<void> {
        const flight = (async () => {
            try {
                await this.handleSyncIndex();
            } catch (error) {
                console.error('[SYNC] Periodic synchronization pass failed:', error);
            }
        })();
        this.backgroundSyncFlight = flight;
        this.onLifecycleActivityChanged?.();
        void flight.finally(() => {
            if (this.backgroundSyncFlight === flight) {
                this.backgroundSyncFlight = null;
                this.onLifecycleActivityChanged?.();
            }
            this.scheduleBackgroundSync(BACKGROUND_SYNC_INTERVAL_MS);
        });
        return flight;
    }

    public stopBackgroundSync(): void {
        this.backgroundSyncEnabled = false;
        if (this.backgroundSyncTimer) {
            clearTimeout(this.backgroundSyncTimer);
            this.backgroundSyncTimer = null;
        }
    }

    /**
     * Stops new provider-owned synchronization work and joins every lifecycle
     * flight that may still hold mutation or backend authority.
     */
    public async stopAndDrainLifecycle(): Promise<void> {
        this.stopBackgroundSync();
        await this.stopWatcherMode();

        for (;;) {
            const pending = new Set<Promise<unknown>>();
            if (this.backgroundSyncFlight) {
                pending.add(this.backgroundSyncFlight);
            }
            for (const flight of this.activeSyncs.values()) {
                pending.add(flight);
            }
            for (const flight of this.activeIgnoreReconciles.values()) {
                pending.add(flight);
            }
            if (pending.size === 0) return;
            await Promise.allSettled(pending);
        }
    }

    public getActiveLifecycleOperationCount(): number {
        return this.backgroundSyncFlight ? 1 : 0;
    }

    public getWatchDebounceMs(): number {
        return DEFAULT_WATCH_DEBOUNCE_MS;
    }

    private canObserveRoot(codebasePath: string): boolean {
        const status = this.snapshotManager.getCodebaseStatus(codebasePath);
        return status === 'indexing' || status === 'indexed' || status === 'sync_completed';
    }

    private canRunFreshnessMutation(codebasePath: string): boolean {
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

    private async refreshIgnoreMatcherForCodebase(
        codebasePath: string,
        mutationLease?: RootMutationLease,
    ): Promise<IgnoreReloadResult> {
        const previousMatcher = this.watcherIgnoreMatchers.get(codebasePath);

        const matcher = await this.buildIgnoreMatcherForCodebase(codebasePath);
        this.assertMutationCurrent(mutationLease);
        this.watcherIgnoreMatchers.set(codebasePath, matcher);

        const version = this.getIgnoreRuleVersion(codebasePath) + 1;
        this.ignoreRulesVersions.set(codebasePath, version);
        if (typeof this.snapshotManager.setCodebaseIgnoreRulesVersion === 'function') {
            this.assertMutationCurrent(mutationLease);
            this.snapshotManager.setCodebaseIgnoreRulesVersion(codebasePath, version);
        }

        return { previousMatcher, matcher, version };
    }

    private assertMutationCurrent(lease?: RootMutationLease): void {
        if (lease) {
            this.mutationLeaseCoordinator?.assertCurrent(lease);
        }
    }

    private async buildIgnoreMatcherForCodebase(
        codebasePath: string,
        effectiveIgnorePatterns?: readonly string[],
    ): Promise<ReturnType<typeof ignore>> {
        const matcher = ignore();
        // Context is the single source of truth for effective ignore rules.
        const basePatterns = effectiveIgnorePatterns
            ?? this.context.getActiveIgnorePatterns?.(codebasePath)
            ?? [];
        matcher.add([...new Set(basePatterns)]);
        return matcher;
    }

    private async computeIgnoreControlSignature(codebasePath: string): Promise<string> {
        return computeIndexPolicyControlSignature(path.resolve(codebasePath));
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

        const matcher = this.getIgnoreMatcherForCodebase(codebasePath);
        if (matcher.ignores(relativePath)) {
            return true;
        }

        const withSlash = relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
        return matcher.ignores(withSlash);
    }

    private async handleWatcherError(codebasePath: string, error: unknown): Promise<void> {
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        const message = errorMessage(error, "");
        const code = errorCode(error);
        const watcherError = code || 'WATCHER_ERROR';
        this.setWatcherCoverage(codebasePath, 'failed', watcherError);
        this.watcherErrorCodes.set(codebasePath, watcherError);
        if (code === 'ENOSPC' || message.includes('ENOSPC')) {
            console.error(`[SYNC-WATCH] ENOSPC detected while watching '${codebasePath}'. Disabling watcher mode and relying on periodic/manual sync.`);
            await this.stopWatcherMode();
            return;
        }

        console.error(`[SYNC-WATCH] Watcher error for '${codebasePath}':`, error);
        this.bumpFreshnessEpoch(codebasePath);
        await this.unregisterCodebaseWatcher(codebasePath);
    }

    public async touchWatchedCodebase(
        codebasePath: string,
        candidatePolicy?: CandidateWatcherPolicy,
    ): Promise<void> {
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        this.watchedCodebases.add(codebasePath);
        this.ensureWatcherObservation(codebasePath, this.watchEnabled ? 'starting' : 'disabled');
        if (candidatePolicy) {
            const previousCandidatePolicy = this.watcherCandidatePolicies.get(codebasePath);
            this.watcherCandidatePolicies.set(codebasePath, {
                policyHash: candidatePolicy.policyHash,
                effectiveIgnorePatterns: Object.freeze([...candidatePolicy.effectiveIgnorePatterns]),
            });
            if (
                this.watchers.has(codebasePath)
                && previousCandidatePolicy?.policyHash !== candidatePolicy.policyHash
            ) {
                await this.unregisterCodebaseWatcher(codebasePath);
            }
        }
        if (!this.watchEnabled || !this.watcherModeStarted) {
            return;
        }
        await this.refreshWatchersFromWatchList();
    }

    /**
     * Rebinds observation to the active published policy after a candidate is
     * rejected. The replacement gets a new watcher generation and retains the
     * existing observation gap until an ordinary freshness proof covers it.
     */
    public async restoreActiveWatcherPolicy(
        codebasePath: string,
        candidatePolicyHash: string,
    ): Promise<boolean> {
        const root = this.canonicalWatcherRoot(codebasePath);
        if (this.watcherCandidatePolicies.get(root)?.policyHash !== candidatePolicyHash) {
            return false;
        }

        this.watcherCandidatePolicies.delete(root);
        await this.unregisterCodebaseWatcher(root);
        if (this.watchEnabled && this.watcherModeStarted && this.canObserveRoot(root)) {
            await this.refreshWatchersFromWatchList();
        }
        return true;
    }

    public async unwatchCodebase(codebasePath: string): Promise<void> {
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        this.watchedCodebases.delete(codebasePath);
        await this.unregisterCodebaseWatcher(codebasePath);
        this.lastSyncTimes.delete(codebasePath);
        this.ignoreRulesVersions.delete(codebasePath);
        this.freshnessEpochs.delete(codebasePath);
        this.watcherObservations.delete(codebasePath);
        this.sourceObservationState.clearCodebase(codebasePath);
        this.watcherCandidatePolicies.delete(codebasePath);
        this.watcherGenerations.delete(codebasePath);
        this.activeIgnoreReconciles.delete(codebasePath);
        this.watcherLifecycleStates.delete(codebasePath);
        this.watcherErrorCodes.delete(codebasePath);
    }

    public async registerCodebaseWatcher(codebasePath: string): Promise<void> {
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        if (!this.watchEnabled || !this.watcherModeStarted) {
            return;
        }

        if (!this.canObserveRoot(codebasePath)) {
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

        let watcher: FSWatcher;
        try {
            const candidatePolicy = this.watcherCandidatePolicies.get(codebasePath);
            this.watcherIgnoreMatchers.set(
                codebasePath,
                await this.buildIgnoreMatcherForCodebase(
                    codebasePath,
                    candidatePolicy?.effectiveIgnorePatterns,
                )
            );
            watcher = chokidar.watch(codebasePath, {
                persistent: true,
                ignoreInitial: true,
                ignored: (watchPath) => this.shouldIgnoreWatchPath(codebasePath, watchPath),
            });
        } catch (error) {
            this.watcherIgnoreMatchers.delete(codebasePath);
            await this.handleWatcherError(codebasePath, error);
            return;
        }

        const onPathChange = (
            watchPath: string,
            eventReason: Exclude<WatcherEventReason, 'ignore_rules_changed'>,
        ) => {
            if (this.watchers.get(codebasePath) !== watcher) {
                return;
            }
            const relativePath = this.normalizeRelativePath(codebasePath, watchPath);
            const observationReason: WatcherEventReason = this.isIgnoreRuleControlFile(relativePath)
                ? 'ignore_rules_changed'
                : eventReason;
            if (this.recordWatcherEvent(codebasePath, observationReason) === null) {
                return;
            }
        };

        this.watcherErrorCodes.delete(codebasePath);
        this.setWatcherCoverage(codebasePath, 'starting');
        this.watcherGenerations.set(codebasePath, ++this.nextWatcherGeneration);
        this.watchers.set(codebasePath, watcher);
        watcher
            .on('ready', () => {
                if (this.watchers.get(codebasePath) === watcher) {
                    this.setWatcherCoverage(codebasePath, 'ready');
                }
            })
            .on('add', (watchPath) => onPathChange(watchPath, 'source_changed'))
            .on('change', (watchPath) => onPathChange(watchPath, 'source_changed'))
            .on('unlink', (watchPath) => onPathChange(watchPath, 'source_changed'))
            .on('addDir', (watchPath) => onPathChange(watchPath, 'directory_changed'))
            .on('unlinkDir', (watchPath) => onPathChange(watchPath, 'directory_changed'))
            .on('error', (error) => {
                void this.handleWatcherError(codebasePath, error);
            });

        console.log(`[SYNC-WATCH] Observing '${codebasePath}' for source events.`);
    }

    public async unregisterCodebaseWatcher(codebasePath: string): Promise<void> {
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        this.watcherIgnoreMatchers.delete(codebasePath);

        const watcher = this.watchers.get(codebasePath);
        if (!watcher) {
            return;
        }

        if (this.watcherLifecycleStates.get(codebasePath) !== 'failed') {
            this.setWatcherCoverage(codebasePath, 'stopped');
        }
        this.watchers.delete(codebasePath);
        try {
            await watcher.close();
        } catch (error) {
            console.error(`[SYNC-WATCH] Failed to close watcher for '${codebasePath}':`, error);
        }
    }

    public async refreshWatchersFromWatchList(): Promise<void> {
        if (!this.watchEnabled || !this.watcherModeStarted) {
            return;
        }

        const watchableCodebases = new Set(
            Array.from(this.watchedCodebases).filter((codebasePath) => this.canObserveRoot(codebasePath))
        );

        for (const watchedPath of Array.from(this.watchers.keys())) {
            if (!watchableCodebases.has(watchedPath)) {
                await this.unregisterCodebaseWatcher(watchedPath);
            }
        }

        for (const codebasePath of watchableCodebases) {
            await this.registerCodebaseWatcher(codebasePath);
        }
    }

    public async refreshWatchersFromSnapshot(): Promise<void> {
        await this.refreshWatchersFromWatchList();
    }

    public async startWatcherMode(): Promise<void> {
        if (!this.watchEnabled || this.watcherModeStarted) {
            return;
        }

        this.watcherModeStarted = true;
        await this.refreshWatchersFromWatchList();
        console.log(`[SYNC-WATCH] Watcher mode enabled.`);
    }

    public async stopWatcherMode(): Promise<void> {
        this.watcherModeStarted = false;

        for (const codebasePath of this.watchers.keys()) {
            this.setWatcherCoverage(codebasePath, 'stopped');
            this.bumpFreshnessEpoch(codebasePath);
        }

        this.watcherIgnoreMatchers.clear();
        this.watcherCandidatePolicies.clear();
        this.watcherGenerations.clear();
        this.lastSyncTimes.clear();
        this.ignoreRulesVersions.clear();
        this.freshnessEpochs.clear();
        this.watcherObservations.clear();
        this.sourceObservationState.clearAll();
        this.watchedCodebases.clear();

        const watchers = Array.from(this.watchers.values());
        this.watchers.clear();

        await Promise.all(watchers.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[SYNC-WATCH] Failed to close watcher:', error);
            }
        }));
        this.watcherLifecycleStates.clear();
    }
}
