import * as fs from "fs";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import ignore from "ignore";
import {
    AtomicIncrementalPublicationUnsupportedError,
    computeIndexPolicyControlSignature,
    Context,
    type PublicationRef,
} from "@zokizuan/satori-core";
import {
    RootMutationInProgressError,
    RootMutationRuntime,
    type MutationOperationPhase,
    type RootMutationActivity,
    type RootMutationOperation,
} from "@zokizuan/satori-core/integration";
import {
    BACKGROUND_FRESHNESS_THRESHOLD_MS,
    BACKGROUND_SYNC_INITIAL_DELAY_MS,
    BACKGROUND_SYNC_INTERVAL_MS,
} from "../config.js";
import {
    SourceObservationState,
} from "./source-observation-state.js";

interface SyncManagerOptions {
    watchEnabled?: boolean;
    now?: () => number;
    onSyncCompleted?: (
        codebasePath: string,
        stats: SyncStats,
        assertMutationCurrent: () => void,
    ) => Promise<void> | void;
    mutationRuntime: RootMutationRuntime;
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
    | 'served_previous_generation'
    | 'read_only';

export type SourceFreshnessAssessment =
    | {
        state: 'verified';
        reason: 'watcher_continuity' | 'exact_source_comparison' | 'full_source_comparison';
    }
    | {
        state: 'changed';
        reason: 'ignore_control_changed' | 'exact_source_comparison' | 'full_source_comparison';
    }
    | {
        state: 'unverified';
        reason:
            | PreparedReadObservationUnavailableReason
            | 'source_checkpoint_probe_failed'
            | 'ignore_control_probe_failed'
            | 'exact_source_comparison_unavailable'
            | 'exact_source_comparison_failed'
            | 'full_source_comparison_unavailable'
            | 'full_source_comparison_failed';
    };

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
    activeMutation?: RootMutationActivity;
    operation?: RootMutationOperation;
    checkpointStatus?: 'missing' | 'corrupt';
    servedCollection?: string;
    servedPublicationId?: string;
    servedGeneration?: number;
    pendingOperation?: {
        action: string;
        generation: number;
    };
    sourceFreshness?: SourceFreshnessAssessment;
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
    publicationId: string;
    checkpointObservation: string;
}>;

export type FullIndexSourceHandoffBarrierInput = Readonly<{
    publicationId: string;
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
        'skipped_recent' | 'skipped_source_unchanged' | 'skipped_source_checkpoint_unavailable' | 'read_only'
    >;
    stats?: SyncStats;
    activeMutation?: RootMutationActivity;
    operation?: RootMutationOperation;
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
    preparedPublication?: PublicationRef;
    exactSourceComparisonPaths?: readonly string[];
    fullSourceComparison?: boolean;
    onSyncProgress?: (progress: {
        phase: string;
        current: number;
        total: number;
        percentage: number;
    }) => void;
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
            | 'publication_activation',
        durationMs: number,
    ) => void;
}

export type ReadFreshnessOptions = Pick<
    EnsureFreshnessOptions,
    'preparedPublication' | 'exactSourceComparisonPaths' | 'fullSourceComparison' | 'onPhaseTiming'
>;

type SyncExecutionRequest = Pick<
    EnsureFreshnessOptions,
    'exactSourceComparisonPaths' | 'onSyncProgress' | 'onPhaseTiming'
>;

interface IgnoreReloadResult {
    previousMatcher?: ReturnType<typeof ignore>;
    matcher: ReturnType<typeof ignore>;
    version: number;
}

// v1 policy: only root-level control files trigger index-policy reconciliation.
const IGNORE_RULE_CONTROL_FILES = new Set(['.satoriignore', '.gitignore', 'satori.toml']);

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
        public readonly operation: RootMutationOperation | undefined,
        options?: { cause?: unknown },
    ) {
        super(message);
        this.name = "SyncOperationError";
        this.cause = options?.cause;
    }
}

export class SyncManager {
    private context: Context;
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
    private readonly mutationRuntime: RootMutationRuntime;
    private readonly onLifecycleActivityChanged?: () => void;

    constructor(context: Context, options: SyncManagerOptions) {
        this.context = context;
        this.watchEnabled = options.watchEnabled === true;
        this.now = options.now || (() => Date.now());
        this.onSyncCompleted = options.onSyncCompleted;
        this.mutationRuntime = options.mutationRuntime;
        this.onLifecycleActivityChanged = options.onLifecycleActivityChanged;
        this.sourceObservationState = new SourceObservationState({
            assertMutationCurrent: (root) => this.mutationRuntime.assertCurrent(root),
            hasCurrentWatcherCapture: (root, capture) => this.hasCurrentWatcherCapture(root, capture),
            coverWatcherObservation: (root, observedEventEpoch) => (
                this.coverWatcherObservation(root, observedEventEpoch)
            ),
            inspectSourceFreshnessCheckpoint: (root) => (
                this.context.inspectSourceFreshnessCheckpoint(root)
            ),
            getCurrentPublicationSourceObservation: (root) => (
                this.context.getCurrentPublicationSourceObservation(root)
            ),
            isPreparedReadAvailable: (root) => this.getPreparedReadObservation(root).available,
        });
        for (const publication of this.context.listCurrentPublications()) {
            this.watchedCodebases.add(this.canonicalWatcherRoot(publication.publication.canonicalRoot));
        }
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
    ): void {
        const root = this.canonicalWatcherRoot(codebasePath);
        this.sourceObservationState.beginHandoff(root, input);
    }

    public rejectFullIndexSourceHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffBarrierInput,
    ): boolean {
        const root = this.canonicalWatcherRoot(codebasePath);
        return this.sourceObservationState.rejectHandoff(root, input);
    }

    private supersedeFullIndexSourceHandoffAfterSync(
        codebasePath: string,
        publicationId: string | undefined,
    ): boolean {
        const root = this.canonicalWatcherRoot(codebasePath);
        return this.sourceObservationState.supersedeHandoffAfterSync(root, publicationId);
    }

    /**
     * Binds an already-proven completed generation/checkpoint to the watcher
     * observation captured for the same candidate. This deliberately bypasses
     * ordinary current-Publication checkpoint lookup because the candidate is
     * not current until this handoff succeeds or fails closed.
     */
    public async completeFullIndexSourceHandoff(
        codebasePath: string,
        input: FullIndexSourceHandoffInput,
    ): Promise<boolean> {
        const root = this.canonicalWatcherRoot(codebasePath);
        return this.sourceObservationState.completeHandoff(root, input);
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
        const currentCheckpointObservation = this.context.getCurrentPublicationSourceObservation(root);
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
        const registeredCheckpointObservation = this.context.getCurrentPublicationSourceObservation(root);
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
        preparedPublication?: PublicationRef,
    ) {
        const publication = preparedPublication ?? this.context.getCurrentPublication(codebasePath) ?? undefined;
        if (!publication || publication.publication.status !== 'complete') return null;
        return this.context.inspectSourceFreshnessCheckpoint(
            codebasePath,
            preparedPublication,
        );
    }

    private async validateSourceFreshnessCheckpoint(
        codebasePath: string,
        checkedAt: string,
        thresholdMs: number,
        preparedPublication?: PublicationRef,
    ): Promise<SourceFreshnessCheckpointValidation> {
        const checkpointEvidence = await this.inspectSourceFreshnessCheckpoint(
            codebasePath,
            preparedPublication,
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

    private getLiveOperation(codebasePath: string): RootMutationOperation | undefined {
        return this.mutationRuntime.getCurrentOperation(codebasePath);
    }

    private publishOperationPhase(
        codebasePath: string,
        phase: MutationOperationPhase,
        update: { progress?: number; error?: string } = {},
    ): RootMutationOperation {
        return this.mutationRuntime.updateCurrentOperation(codebasePath, phase, update);
    }

    /**
     * Read-only freshness assessment for ordinary search/navigation requests.
     *
     * This may inspect source/checkpoint state and advance watcher proof only
     * when a source comparison proves equality. It never starts, joins, or
     * awaits Publication mutation.
     */
    public async assessReadFreshness(
        codebasePath: string,
        thresholdMs: number = 60000,
        options: ReadFreshnessOptions = {},
    ): Promise<FreshnessDecision> {
        codebasePath = this.canonicalWatcherRoot(codebasePath);
        const flightEpoch = this.captureWatcherFlightEpoch(codebasePath);
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();
        const sourcePublication = options.preparedPublication
            ?? this.context.getCurrentPublication(codebasePath)
            ?? undefined;
        const lastSync = this.lastSyncTimes.get(codebasePath);
        const withReadMetadata = (
            decision: Omit<FreshnessDecision, 'checkedAt' | 'thresholdMs'>,
        ): FreshnessDecision => ({
            ...decision,
            checkedAt,
            thresholdMs,
            ...(lastSync !== undefined
                ? {
                    lastSyncAt: new Date(lastSync).toISOString(),
                    ageMs: Math.max(0, checkedAtMs - lastSync),
                }
                : {}),
        });

        let checkpointValidation: SourceFreshnessCheckpointValidation;
        try {
            const checkpointValidationStartedAt = Date.now();
            checkpointValidation = await this.validateSourceFreshnessCheckpoint(
                codebasePath,
                checkedAt,
                thresholdMs,
                sourcePublication,
            );
            options.onPhaseTiming?.(
                'checkpoint_proof',
                Math.max(0, Date.now() - checkpointValidationStartedAt),
            );
        } catch (error) {
            return withReadMetadata({
                mode: 'read_only',
                errorMessage: errorMessage(error),
                sourceFreshness: {
                    state: 'unverified',
                    reason: 'source_checkpoint_probe_failed',
                },
            });
        }
        if ('failure' in checkpointValidation) {
            return {
                ...checkpointValidation.failure,
                ...(lastSync !== undefined
                    ? {
                        lastSyncAt: new Date(lastSync).toISOString(),
                        ageMs: Math.max(0, checkedAtMs - lastSync),
                    }
                    : {}),
                sourceFreshness: {
                    state: 'unverified',
                    reason: checkpointValidation.failure.checkpointStatus === 'corrupt'
                        ? 'checkpoint_corrupt'
                        : 'checkpoint_missing',
                },
            };
        }

        try {
            const acceptedIgnoreControlSignature = sourcePublication?.publication.policy.controlSignature;
            if (
                typeof acceptedIgnoreControlSignature === 'string'
                && acceptedIgnoreControlSignature !== await this.computeIgnoreControlSignature(codebasePath)
            ) {
                return withReadMetadata({
                    mode: 'read_only',
                    sourceFreshness: {
                        state: 'changed',
                        reason: 'ignore_control_changed',
                    },
                });
            }
        } catch (error) {
            return withReadMetadata({
                mode: 'read_only',
                errorMessage: errorMessage(error),
                sourceFreshness: {
                    state: 'unverified',
                    reason: 'ignore_control_probe_failed',
                },
            });
        }

        if (flightEpoch !== undefined && this.hasPendingWatcherObservation(codebasePath)) {
            const compareSourceObservation = this.context.compareSourceObservationToFreshnessCheckpoint;
            if (typeof compareSourceObservation === 'function') {
                try {
                    const observationComparisonStartedAt = Date.now();
                    const comparison = await compareSourceObservation.call(
                        this.context,
                        codebasePath,
                        sourcePublication,
                    );
                    options.onPhaseTiming?.(
                        'exact_path_comparison',
                        Math.max(0, Date.now() - observationComparisonStartedAt),
                    );
                    if (comparison.status === 'matches') {
                        // Cover only watcher events captured before this complete source
                        // observation. Later events remain pending and still invalidate reads.
                        this.coverWatcherObservation(codebasePath, flightEpoch);
                    }
                } catch {
                    // Preserve the existing fail-closed watcher_event_pending result.
                }
            }
        }

        let exactMatched = false;
        let exactComparisonUnverifiedReason:
            | 'exact_source_comparison_unavailable'
            | 'exact_source_comparison_failed'
            | undefined;
        const exactSourceComparisonPaths = options.exactSourceComparisonPaths;
        if (exactSourceComparisonPaths && exactSourceComparisonPaths.length > 0) {
            const compareSourcePaths = this.context.compareSourcePathsToFreshnessCheckpoint;
            if (typeof compareSourcePaths !== 'function') {
                exactComparisonUnverifiedReason = 'exact_source_comparison_unavailable';
            } else {
                try {
                    const exactComparisonStartedAt = Date.now();
                    const comparison = await compareSourcePaths.call(
                        this.context,
                        codebasePath,
                        exactSourceComparisonPaths,
                        sourcePublication,
                    );
                    options.onPhaseTiming?.(
                        'exact_path_comparison',
                        Math.max(0, Date.now() - exactComparisonStartedAt),
                    );
                    if (comparison.status === 'differs') {
                        return withReadMetadata({
                            mode: 'read_only',
                            sourceFreshness: {
                                state: 'changed',
                                reason: 'exact_source_comparison',
                            },
                        });
                    }
                    if (comparison.status === 'matches') {
                        exactMatched = true;
                    } else {
                        exactComparisonUnverifiedReason = 'exact_source_comparison_unavailable';
                    }
                } catch {
                    exactComparisonUnverifiedReason = 'exact_source_comparison_failed';
                }
            }
        }

        let fullMatched = false;
        if (options.fullSourceComparison === true) {
            const compareAllSource = this.context.compareAllSourceToFreshnessCheckpoint;
            if (typeof compareAllSource !== 'function') {
                return withReadMetadata({
                    mode: 'read_only',
                    sourceFreshness: {
                        state: 'unverified',
                        reason: 'full_source_comparison_unavailable',
                    },
                });
            }
            try {
                const fullComparisonStartedAt = Date.now();
                const comparison = await compareAllSource.call(
                    this.context,
                    codebasePath,
                    sourcePublication,
                );
                options.onPhaseTiming?.(
                    'exact_path_comparison',
                    Math.max(0, Date.now() - fullComparisonStartedAt),
                );
                if (comparison.status === 'differs') {
                    return withReadMetadata({
                        mode: 'read_only',
                        sourceFreshness: {
                            state: 'changed',
                            reason: 'full_source_comparison',
                        },
                    });
                }
                if (comparison.status === 'unavailable') {
                    return withReadMetadata({
                        mode: 'read_only',
                        sourceFreshness: {
                            state: 'unverified',
                            reason: 'full_source_comparison_unavailable',
                        },
                    });
                }
                fullMatched = true;
                this.coverWatcherObservation(codebasePath, flightEpoch);
            } catch (error) {
                return withReadMetadata({
                    mode: 'read_only',
                    errorMessage: errorMessage(error),
                    sourceFreshness: {
                        state: 'unverified',
                        reason: 'full_source_comparison_failed',
                    },
                });
            }
        } else if (exactMatched && !this.hasPendingWatcherObservation(codebasePath)) {
            this.coverWatcherObservation(codebasePath, flightEpoch);
        }

        if (exactComparisonUnverifiedReason && !fullMatched) {
            return withReadMetadata({
                mode: 'read_only',
                sourceFreshness: {
                    state: 'unverified',
                    reason: exactComparisonUnverifiedReason,
                },
            });
        }

        const preparedObservation = this.getPreparedReadObservation(codebasePath);
        if (!preparedObservation.available) {
            return withReadMetadata({
                mode: exactMatched || fullMatched ? 'skipped_source_unchanged' : 'read_only',
                sourceFreshness: {
                    state: 'unverified',
                    reason: preparedObservation.reason,
                },
            });
        }

        return withReadMetadata({
            mode: exactMatched || fullMatched ? 'skipped_source_unchanged' : 'read_only',
            sourceFreshness: {
                state: 'verified',
                reason: fullMatched
                    ? 'full_source_comparison'
                    : exactMatched
                        ? 'exact_source_comparison'
                        : 'watcher_continuity',
            },
        });
    }

    /**
     * Ensures the codebase is fresh before use.
     * Unified entry point for explicit/background sync operations.
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
        const sourcePublication = options.preparedPublication
            ?? this.context.getCurrentPublication(codebasePath)
            ?? undefined;

        if (options.reason === 'ignore_change') {
            const checkpointValidation = await this.validateSourceFreshnessCheckpoint(
                codebasePath,
                checkedAt,
                thresholdMs,
                sourcePublication,
            );
            if ('failure' in checkpointValidation) return checkpointValidation.failure;
            const decision = await this.runIgnoreReconcile(
                codebasePath,
                options.coalescedEdits,
                undefined,
                sourcePublication,
                options,
            );
            if (decision.mode === 'reconciled_ignore_change') {
                this.coverWatcherObservation(codebasePath, flightEpoch);
            }
            return decision;
        }

        // Join a live mutation before inspecting its checkpoint. The owner may be
        // between Publication activation and checkpoint publication.
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
        // including ignore reconciliation. The identity comes from the current
        // Publication and its source checkpoint.
        const checkpointValidationStartedAt = Date.now();
        const checkpointValidation = await this.validateSourceFreshnessCheckpoint(
            codebasePath,
            checkedAt,
            thresholdMs,
            sourcePublication,
        );
        options.onPhaseTiming?.(
            'checkpoint_proof',
            Math.max(0, Date.now() - checkpointValidationStartedAt),
        );
        if ('failure' in checkpointValidation) return checkpointValidation.failure;

        let currentIgnoreControlSignature: string | undefined;
        if (options.skipIgnoreControlCheck !== true) {
            currentIgnoreControlSignature = await this.computeIgnoreControlSignature(codebasePath);
            const acceptedIgnoreControlSignature = sourcePublication?.publication.policy.controlSignature;

            if (
                typeof acceptedIgnoreControlSignature === 'string'
                && acceptedIgnoreControlSignature !== currentIgnoreControlSignature
            ) {
                const decision = await this.runIgnoreReconcile(
                    codebasePath,
                    1,
                    currentIgnoreControlSignature,
                    sourcePublication,
                    options,
                );
                if (decision.mode === 'reconciled_ignore_change') {
                    this.coverWatcherObservation(codebasePath, flightEpoch);
                }
                return decision;
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
                    sourcePublication,
                );
                exactComparisonResult = comparison;
                options.onPhaseTiming?.(
                    'exact_path_comparison',
                    Math.max(0, Date.now() - exactComparisonStartedAt),
                );
                if (comparison.status === 'matches') {
                    this.coverWatcherObservation(codebasePath, flightEpoch);
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
                    sourcePublication,
                );
                fullComparisonResult = comparison;
                options.onPhaseTiming?.(
                    'exact_path_comparison',
                    Math.max(0, Date.now() - fullComparisonStartedAt),
                );
                if (comparison.status === 'matches') {
                    this.coverWatcherObservation(codebasePath, flightEpoch);
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
                    currentIgnoreControlSignature,
                    {
                        exactSourceComparisonPaths: options.exactSourceComparisonPaths,
                        onSyncProgress: options.onSyncProgress,
                        onPhaseTiming: options.onPhaseTiming,
                    },
                    sourcePublication,
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
        const committedCheckpoint = await this.inspectSourceFreshnessCheckpoint(codebasePath);
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
                    committedCheckpoint.publicationId,
                );
            }
        }
        return decision;
    }

    private async runIgnoreReconcile(
        codebasePath: string,
        coalescedEdits: number = 1,
        nextIgnoreControlSignature?: string,
        preparedPublication?: PublicationRef,
        executionRequest: SyncExecutionRequest = {},
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

        try {
            return await this.mutationRuntime.run(codebasePath, 'sync', async () => {
                let lastOperation = this.getLiveOperation(codebasePath);
                try {
                    console.log(`[SYNC] 🔁 Ignore control files changed for '${codebasePath}', running reconciliation.`);
                    const promise = this.reconcileIgnoreRulesChange(
                        codebasePath,
                        coalescedEdits,
                        nextIgnoreControlSignature,
                        preparedPublication,
                        executionRequest,
                    );
                    this.activeIgnoreReconciles.set(reconcileKey, promise);
                    const decision = await promise;
                    const phase = decision.mode === "ignore_reload_failed"
                        ? "failed"
                        : decision.mode === "skipped_requires_reindex"
                            ? "blocked"
                            : "completed";
                    lastOperation = this.publishOperationPhase(codebasePath, phase);
                    return {
                        ...decision,
                        operation: lastOperation,
                    };
                } catch (error) {
                    if (this.mutationRuntime.isCurrent(codebasePath)) {
                        try {
                            lastOperation = this.publishOperationPhase(
                                codebasePath,
                                "failed",
                                { error: errorMessage(error) },
                            );
                        } catch {
                            // Keep the last live state this operation owned.
                        }
                    }
                    throw new SyncOperationError(errorMessage(error), lastOperation, { cause: error });
                } finally {
                    this.activeIgnoreReconciles.delete(reconcileKey);
                }
            });
        } catch (error) {
            if (error instanceof RootMutationInProgressError) {
                return {
                    mode: 'skipped_mutation_in_progress',
                    checkedAt,
                    thresholdMs: 0,
                    activeMutation: error.activeMutation,
                };
            }
            throw error;
        }
    }

    private async reconcileIgnoreRulesChange(
        codebasePath: string,
        coalescedEdits: number = 1,
        nextIgnoreControlSignature?: string,
        preparedPublication?: PublicationRef,
        executionRequest: SyncExecutionRequest = {},
    ): Promise<FreshnessDecision> {
        const checkedAtMs = this.now();
        const checkedAt = new Date(checkedAtMs).toISOString();
        const startedAt = checkedAtMs;
        if (nextIgnoreControlSignature !== undefined && !nextIgnoreControlSignature.startsWith('v1:')) {
            throw new Error('Observed ignore-control signature is invalid.');
        }
        let policyObservationEstablished = false;

        try {
            if (this.activeSyncs.has(codebasePath)) {
                console.log(`[SYNC] ⏳ Ignore-rule reconcile waiting for in-flight sync '${codebasePath}'`);
                await this.activeSyncs.get(codebasePath);
            }

            const candidatePolicy = await this.context.observeIndexPolicyForIncrementalReconciliation(codebasePath);
            policyObservationEstablished = true;
            this.mutationRuntime.assertCurrent(codebasePath);
            if (!await this.context.activateObservedIndexPolicyForIncrementalReconciliation(candidatePolicy)) {
                return {
                    mode: 'skipped_requires_reindex',
                    checkedAt,
                    thresholdMs: 0,
                    coalescedEdits: Math.max(1, coalescedEdits),
                    durationMs: Math.max(0, this.now() - startedAt),
                    errorMessage: 'index_policy_changed',
                };
            }

            const sourcePublication = preparedPublication ?? this.context.getCurrentPublication(codebasePath) ?? undefined;
            const sourceCheckpoint = sourcePublication
                ? this.context.getPublicationSourceCheckpoint(sourcePublication)
                : null;
            if (!sourceCheckpoint) {
                throw new Error('missing_publication_source_checkpoint');
            }
            const indexedPathsBeforeReload = sourceCheckpoint.fileHashes.map(([relativePath]) => relativePath);

            const { previousMatcher, matcher, version } = await this.refreshIgnoreMatcherForCodebase(codebasePath);

            this.mutationRuntime.assertCurrent(codebasePath);
            await this.context.recreateSynchronizerForCodebase(
                codebasePath,
                { requireAuthorityCheckpoint: true },
            );
            this.mutationRuntime.assertCurrent(codebasePath);

            // Self-healing delete rule: remove anything currently indexed that new matcher ignores.
            const toDelete = indexedPathsBeforeReload.filter((relativePath) => this.matcherIgnoresRelativePath(matcher, relativePath));

            if (toDelete.length > 0) {
                this.mutationRuntime.assertCurrent(codebasePath);
                await this.context.deleteIndexedPathsByRelativePaths(codebasePath, toDelete);
            }

            // Deleting newly ignored payload invalidates ordinary live proof.
            // Carry the pre-delete receipt so Core can revalidate that exact
            // source generation after the mutation lease is held.
            const syncDecision = await this.ensureFreshness(codebasePath, 0, {
                skipIgnoreControlCheck: true,
                preparedPublication,
                onSyncProgress: executionRequest.onSyncProgress,
                onPhaseTiming: executionRequest.onPhaseTiming,
            });
            const lastSyncAt = syncDecision.lastSyncAt;
            const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : undefined;
            const newlyIgnoredCount = previousMatcher
                ? indexedPathsBeforeReload.filter((relativePath) => !this.matcherIgnoresRelativePath(previousMatcher, relativePath) && this.matcherIgnoresRelativePath(matcher, relativePath)).length
                : toDelete.length;

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
            if (policyObservationEstablished) {
                try {
                    const fallbackDecision = await this.ensureFreshness(codebasePath, 0, {
                        skipIgnoreControlCheck: true,
                        onSyncProgress: executionRequest.onSyncProgress,
                        onPhaseTiming: executionRequest.onPhaseTiming,
                    });
                    fallbackSyncExecuted = true;
                    fallbackStats = fallbackDecision.stats;
                } catch {
                    // Preserve primary failure metadata even if fallback sync fails.
                }
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
        _currentIgnoreControlSignature?: string,
        joinRequest: SyncExecutionRequest = {},
        preparedPublication?: PublicationRef,
    ): Promise<SyncExecutionOutcome> {
        const currentPublication = preparedPublication ?? this.context.getCurrentPublication(codebasePath) ?? undefined;
        if (!currentPublication) {
            const activeMutation = this.mutationRuntime.getActiveMutation(codebasePath);
            if (activeMutation?.action === 'create' || activeMutation?.action === 'reindex') {
                console.log(`[SYNC] ⏭️  Skipping sync for '${codebasePath}' because indexing is active.`);
                return { mode: 'skipped_indexing', activeMutation };
            }
            return { mode: 'skipped_requires_reindex' };
        }
        if (currentPublication.publication.status !== 'complete') {
            console.log(`[SYNC] ⏭️  Skipping sync for '${codebasePath}' because the current Publication is partial.`);
            return { mode: 'skipped_requires_reindex' };
        }

        try {
            return await this.mutationRuntime.run(codebasePath, 'sync', async () => {
                let lastOperation = this.getLiveOperation(codebasePath);
                try {
                    let pathMissing = false;
                    try {
                        this.mutationRuntime.assertCurrent(codebasePath);
                        await fs.promises.access(codebasePath);
                    } catch (error) {
                        const code = errorCode(error);
                        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
                        pathMissing = true;
                    }

                    if (pathMissing) {
                        console.log(`[SYNC] 🗑️ Codebase '${codebasePath}' no longer exists. Clearing Publication-owned index state.`);
                        this.mutationRuntime.assertCurrent(codebasePath);
                        await this.context.clearIndex(codebasePath);
                        this.mutationRuntime.assertCurrent(codebasePath);
                        lastOperation = this.publishOperationPhase(codebasePath, "completed", { progress: 100 });
                        await this.unwatchCodebase(codebasePath);
                        return { mode: 'skipped_missing_path', operation: lastOperation };
                    }

                    const fencedCheckpointStartedAt = Date.now();
                    const fencedCheckpoint = await this.inspectSourceFreshnessCheckpoint(
                        codebasePath,
                        currentPublication,
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
                        const registeredObservation = this.context.getCurrentPublicationSourceObservation(codebasePath);
                        if (registeredObservation !== fencedCheckpoint.observationToken) {
                            await this.context.recreateSynchronizerForCodebase(
                                codebasePath,
                                { requireAuthorityCheckpoint: true },
                            );
                            this.mutationRuntime.assertCurrent(codebasePath);
                        }
                    }

                    const syncOptions = {
                        sourcePublication: currentPublication,
                        ...(joinRequest.onPhaseTiming
                            ? { onPhaseTiming: joinRequest.onPhaseTiming }
                            : {}),
                    };
                    this.mutationRuntime.assertCurrent(codebasePath);
                    lastOperation = this.publishOperationPhase(codebasePath, "writing");
                    const publicationStartedAt = Date.now();
                    const stats: SyncStats = await this.context.reindexByChange(
                        codebasePath,
                        joinRequest.onSyncProgress,
                        syncOptions,
                    );
                    joinRequest.onPhaseTiming?.(
                        'incremental_publication',
                        Math.max(0, Date.now() - publicationStartedAt),
                    );
                    this.mutationRuntime.assertCurrent(codebasePath);

                    this.lastSyncTimes.set(codebasePath, this.now());

                    if (stats.navigationRecovery === 'failed') {
                        lastOperation = this.publishOperationPhase(
                            codebasePath,
                            "failed",
                            { error: 'Incremental sync completed, but Publication navigation recovery failed.' },
                        );
                        return { mode: 'skipped_requires_reindex', stats, operation: lastOperation };
                    }

                    if (this.onSyncCompleted) {
                        const assertMutationCurrent = () => this.mutationRuntime.assertCurrent(codebasePath);
                        assertMutationCurrent();
                        await this.onSyncCompleted(codebasePath, {
                            added: stats.added,
                            removed: stats.removed,
                            modified: stats.modified,
                            changedFiles: Array.isArray(stats.changedFiles) ? stats.changedFiles : []
                        }, assertMutationCurrent);
                        assertMutationCurrent();
                    }

                    lastOperation = this.publishOperationPhase(codebasePath, "completed", { progress: 100 });

                    if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                        console.log(`[SYNC] ✅ Sync Result for '${codebasePath}': +${stats.added}, -${stats.removed}, ~${stats.modified}`);
                    }
                    return { mode: 'synced', stats, operation: lastOperation };
                } catch (error) {
                    console.error(`[SYNC] Failed to sync '${codebasePath}':`, error);
                    if (error instanceof AtomicIncrementalPublicationUnsupportedError) {
                        lastOperation = this.publishOperationPhase(
                            codebasePath,
                            'blocked',
                            { error: error.message },
                        );
                        return {
                            mode: 'skipped_requires_reindex',
                            operation: lastOperation,
                        };
                    }
                    if (this.mutationRuntime.isCurrent(codebasePath)) {
                        try {
                            lastOperation = this.publishOperationPhase(
                                codebasePath,
                                "failed",
                                { error: errorMessage(error) },
                            );
                        } catch {
                            // Keep the last live state this operation owned.
                        }
                    }
                    throw new SyncOperationError(errorMessage(error), lastOperation, { cause: error });
                }
            });
        } catch (error) {
            if (error instanceof RootMutationInProgressError) {
                return { mode: 'skipped_mutation_in_progress', activeMutation: error.activeMutation };
            }
            throw error;
        }
    }

    public async handleSyncIndex(): Promise<void> {
        const indexedCodebases = this.context.listCurrentPublications()
            .filter((publication) => publication.publication.status === 'complete')
            .map((publication) => publication.publication.canonicalRoot);
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

    private canObserveRoot(codebasePath: string): boolean {
        if (this.context.getCurrentPublication(codebasePath)) return true;
        const activeMutation = this.mutationRuntime.getActiveMutation(codebasePath);
        return activeMutation?.action === 'create'
            || activeMutation?.action === 'reindex'
            || activeMutation?.action === 'sync';
    }

    private getIgnoreRuleVersion(codebasePath: string): number {
        const current = this.ignoreRulesVersions.get(codebasePath);
        return Number.isFinite(current) ? Number(current) : 0;
    }

    private async refreshIgnoreMatcherForCodebase(codebasePath: string): Promise<IgnoreReloadResult> {
        const previousMatcher = this.watcherIgnoreMatchers.get(codebasePath);

        const matcher = await this.buildIgnoreMatcherForCodebase(codebasePath);
        this.mutationRuntime.assertCurrent(codebasePath);
        this.watcherIgnoreMatchers.set(codebasePath, matcher);

        const version = this.getIgnoreRuleVersion(codebasePath) + 1;
        this.ignoreRulesVersions.set(codebasePath, version);

        return { previousMatcher, matcher, version };
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

    public async startWatcherMode(): Promise<void> {
        if (!this.watchEnabled || this.watcherModeStarted) {
            return;
        }

        this.watcherModeStarted = true;
        for (const publication of this.context.listCurrentPublications()) {
            this.watchedCodebases.add(this.canonicalWatcherRoot(publication.publication.canonicalRoot));
        }
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
