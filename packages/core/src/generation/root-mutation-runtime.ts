import { AsyncLocalStorage } from 'node:async_hooks';
import {
    MutationLeaseCoordinator,
    isTerminalMutationOperationPhase,
    type MutationLeaseAction,
    type MutationOperationPhase,
    type RootMutationLease,
    type RootMutationOperation,
} from './root-mutation-coordinator';

export type RootMutationAction = MutationLeaseAction;

export type RootMutationActivity = Readonly<{
    id: string;
    action: RootMutationAction;
    canonicalRoot: string;
    generation: number;
    acceptedAt: string;
    pid: number;
    executorPid?: number;
    executorProcessGroupId?: number;
}>;

export type RootMutationRuntimeOptions = Readonly<{
    stateDir?: string;
    ownerId?: string;
    now?: () => number;
}>;

export type RootMutationContinuation<T> = Readonly<{
    response: T;
    completion: Promise<void>;
}>;

export type RootMutationExecutionOptions = Readonly<{
    signal?: AbortSignal;
}>;

export type RootMutationExecutor = Readonly<{
    pid: number;
    processGroupId?: number;
}>;

export type RootMutationExecution = Readonly<{
    id: string;
    signal: AbortSignal;
    assertCurrent(): void;
    heartbeat(): RootMutationOperation;
    update(
        phase: MutationOperationPhase,
        update?: { progress?: number; error?: string },
    ): RootMutationOperation;
    bindExecutor(executor: RootMutationExecutor): RootMutationActivity;
}>;

export type RootMutationStart<T> = Readonly<{
    operationId: string;
    started: Promise<T>;
    completion: Promise<void>;
}>;

export function formatRootMutationBlockedMessage(activeMutation: RootMutationActivity): string {
    return `Mutation '${activeMutation.action}' is already in progress for '${activeMutation.canonicalRoot}' `
        + `(operation=${activeMutation.id}, generation=${activeMutation.generation}, pid=${activeMutation.pid}).`;
}

export class RootMutationInProgressError extends Error {
    constructor(readonly activeMutation: RootMutationActivity) {
        super(formatRootMutationBlockedMessage(activeMutation));
        this.name = 'RootMutationInProgressError';
    }
}

export class RootMutationCancelledError extends Error {
    constructor(
        readonly operationId: string,
        readonly reason?: string,
    ) {
        super(reason ? `Mutation '${operationId}' was cancelled: ${reason}` : `Mutation '${operationId}' was cancelled.`);
        this.name = 'RootMutationCancelledError';
    }
}

type RootMutationControl = Readonly<{
    lease: RootMutationLease;
    controller: AbortController;
    execution: RootMutationExecution;
}>;

const coordinators = new WeakMap<RootMutationRuntime, MutationLeaseCoordinator>();
const operationScopes = new WeakMap<RootMutationRuntime, AsyncLocalStorage<RootMutationLease>>();
const operationControls = new WeakMap<RootMutationRuntime, Map<string, RootMutationControl>>();

function isRootMutationContinuation<T>(value: unknown): value is RootMutationContinuation<T> {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    const completion = record.completion as { then?: unknown } | undefined;
    return 'response' in record && typeof completion?.then === 'function';
}

function activityFromLease(lease: RootMutationLease): RootMutationActivity {
    return Object.freeze({
        id: lease.operationId,
        action: lease.action,
        canonicalRoot: lease.canonicalRoot,
        generation: lease.generation,
        acceptedAt: lease.acquiredAt,
        pid: lease.pid,
        ...(lease.executorPid !== undefined ? { executorPid: lease.executorPid } : {}),
        ...(lease.executorProcessGroupId !== undefined
            ? { executorProcessGroupId: lease.executorProcessGroupId }
            : {}),
    });
}

function cancellationReason(reason: unknown): string | undefined {
    if (reason instanceof Error) return reason.message;
    if (typeof reason === 'string' && reason.trim()) return reason;
    return undefined;
}

/**
 * Core-owned process runtime for the durable per-root writer fence and its
 * live operation projection and durable terminal receipt. First-party
 * integrations request a root mutation through this owner; raw leases never
 * cross the Core boundary.
 */
export class RootMutationRuntime {
    constructor(options: RootMutationRuntimeOptions = {}) {
        const coordinator = new MutationLeaseCoordinator({
            ...(options.stateDir ? { stateDir: options.stateDir } : {}),
            ...(options.ownerId ? { ownerId: options.ownerId } : {}),
            ...(options.now ? { now: options.now } : {}),
        });
        coordinators.set(this, coordinator);
        operationScopes.set(this, new AsyncLocalStorage<RootMutationLease>());
        operationControls.set(this, new Map());
    }

    async run<T>(
        root: string,
        action: RootMutationAction,
        work: (execution: RootMutationExecution) => Promise<T> | T,
        options: RootMutationExecutionOptions = {},
    ): Promise<T> {
        if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error('Mutation request was cancelled before acceptance.');
        }
        const coordinator = requireCoordinator(this);
        const scopes = requireOperationScopes(this);
        const current = scopes.getStore();
        if (current && coordinator.isLeaseForRoot(current, root)) {
            coordinator.assertCurrent(current);
            return await work(requireOperationControl(this, current.operationId).execution);
        }

        const acquired = coordinator.acquire(root, action);
        if (!acquired.acquired) {
            throw new RootMutationInProgressError(activityFromLease(acquired.activeLease));
        }

        const control = createOperationControl(this, acquired.lease);
        requireOperationControls(this).set(acquired.lease.operationId, control);
        return await scopes.run(acquired.lease, async () => {
            const unlinkSourceCancellation = linkSourceCancellation(
                options.signal,
                () => this.requestCancellation(
                    acquired.lease.operationId,
                    cancellationReason(options.signal?.reason),
                ),
            );
            try {
                return await work(control.execution);
            } finally {
                unlinkSourceCancellation();
                if (control.controller.signal.aborted && coordinator.isCurrent(acquired.lease)) {
                    const operation = coordinator.getOperationForLease(acquired.lease);
                    if (operation && !isTerminalMutationOperationPhase(operation.phase)) {
                        coordinator.updateOperation(acquired.lease, 'cancelled');
                    }
                }
                const released = coordinator.release(acquired.lease);
                if (released || !coordinator.isCurrent(acquired.lease)) {
                    requireOperationControls(this).delete(acquired.lease.operationId);
                }
            }
        });
    }

    /**
     * Enter the exact durable mutation lease already bound to this executor
     * process. This never acquires or releases the lease; the supervising
     * parent remains its lifetime owner and may release only after executor
     * quiescence is proven.
     */
    async runBoundExecutor<T>(
        root: string,
        action: RootMutationAction,
        operationId: string,
        work: (execution: RootMutationExecution) => Promise<T> | T,
        options: RootMutationExecutionOptions = {},
    ): Promise<T> {
        if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error('Mutation executor was cancelled before attachment.');
        }
        const coordinator = requireCoordinator(this);
        const scopes = requireOperationScopes(this);
        const current = scopes.getStore();
        if (current && coordinator.isLeaseForRoot(current, root)) {
            coordinator.assertCurrent(current);
            if (current.operationId !== operationId || current.action !== action) {
                throw new Error(`Mutation executor scope does not match operation '${operationId}'.`);
            }
            return await work(requireOperationControl(this, current.operationId).execution);
        }

        const lease = coordinator.attachBoundExecutor(root, operationId, action);
        const control = createOperationControl(this, lease);
        requireOperationControls(this).set(operationId, control);
        return await scopes.run(lease, async () => {
            const unlinkSourceCancellation = linkSourceCancellation(
                options.signal,
                () => {
                    if (!control.controller.signal.aborted) {
                        control.controller.abort(
                            options.signal?.reason ?? new RootMutationCancelledError(operationId),
                        );
                    }
                },
            );
            try {
                return await work(control.execution);
            } finally {
                unlinkSourceCancellation();
                requireOperationControls(this).delete(operationId);
            }
        });
    }

    start<T>(
        root: string,
        action: RootMutationAction,
        prepare: (
            execution: RootMutationExecution,
        ) => Promise<T | RootMutationContinuation<T>> | T | RootMutationContinuation<T>,
        options: RootMutationExecutionOptions = {},
    ): RootMutationStart<T> {
        let resolveStarted!: (value: T) => void;
        let rejectStarted!: (error: unknown) => void;
        let startedSettled = false;
        let operationId = '';
        const started = new Promise<T>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
        });
        const completion = this.run(root, action, async (execution) => {
            operationId = execution.id;
            const prepared = await prepare(execution);
            if (isRootMutationContinuation(prepared)) {
                startedSettled = true;
                resolveStarted(prepared.response);
                await prepared.completion;
                return;
            }
            startedSettled = true;
            resolveStarted(prepared);
        }, options).catch((error) => {
            if (!startedSettled) {
                startedSettled = true;
                rejectStarted(error);
            }
            throw error;
        });
        return Object.freeze({
            get operationId() { return operationId; },
            started,
            completion,
        });
    }

    getOperation(root: string): RootMutationOperation | undefined {
        return requireCoordinator(this).getOperation(root);
    }

    getCurrentOperation(root: string): RootMutationOperation | undefined {
        const lease = currentLeaseForRoot(this, root);
        return lease
            ? requireCoordinator(this).getOperationForLease(lease)
            : undefined;
    }

    getActiveMutation(root: string): RootMutationActivity | undefined {
        const lease = requireCoordinator(this).getActiveLease(root);
        return lease ? activityFromLease(lease) : undefined;
    }

    listActiveMutations(): RootMutationActivity[] {
        return requireCoordinator(this).listActiveLeases().map(activityFromLease);
    }

    assertCurrent(root: string): void {
        const lease = requireCurrentLeaseForRoot(this, root);
        requireCoordinator(this).assertCurrent(lease);
    }

    isCurrent(root: string): boolean {
        const lease = currentLeaseForRoot(this, root);
        return lease ? requireCoordinator(this).isCurrent(lease) : false;
    }

    requestCancellation(operationId: string, reason?: string): boolean {
        const control = requireOperationControls(this).get(operationId);
        if (!control) return false;
        const coordinator = requireCoordinator(this);
        const operation = coordinator.getOperationForLease(control.lease);
        if (!operation || isTerminalMutationOperationPhase(operation.phase)) return false;
        coordinator.requestOperationCancellation(control.lease, reason);
        if (!control.controller.signal.aborted) {
            control.controller.abort(new RootMutationCancelledError(operationId, reason));
        }
        return true;
    }

    heartbeatCurrentOperation(root: string): RootMutationOperation {
        const lease = requireCurrentLeaseForRoot(this, root);
        return requireCoordinator(this).heartbeatOperation(lease);
    }

    bindCurrentExecutor(root: string, executor: RootMutationExecutor): RootMutationActivity {
        const lease = requireCurrentLeaseForRoot(this, root);
        return activityFromLease(requireCoordinator(this).bindExecutor(lease, executor));
    }

    updateCurrentOperation(
        root: string,
        phase: MutationOperationPhase,
        update: { progress?: number; error?: string } = {},
    ): RootMutationOperation {
        const lease = requireCurrentLeaseForRoot(this, root);
        return requireCoordinator(this).updateOperation(lease, phase, update);
    }
}

function requireCoordinator(runtime: RootMutationRuntime): MutationLeaseCoordinator {
    const coordinator = coordinators.get(runtime);
    if (!coordinator) throw new Error('Root mutation runtime is not initialized.');
    return coordinator;
}

function requireOperationScopes(runtime: RootMutationRuntime): AsyncLocalStorage<RootMutationLease> {
    const scopes = operationScopes.get(runtime);
    if (!scopes) throw new Error('Root mutation runtime is not initialized.');
    return scopes;
}

function requireOperationControls(runtime: RootMutationRuntime): Map<string, RootMutationControl> {
    const controls = operationControls.get(runtime);
    if (!controls) throw new Error('Root mutation runtime is not initialized.');
    return controls;
}

function requireOperationControl(runtime: RootMutationRuntime, operationId: string): RootMutationControl {
    const control = requireOperationControls(runtime).get(operationId);
    if (!control) throw new Error(`Live mutation control is unavailable for operation '${operationId}'.`);
    return control;
}

function createOperationControl(runtime: RootMutationRuntime, lease: RootMutationLease): RootMutationControl {
    const controller = new AbortController();
    const execution: RootMutationExecution = Object.freeze({
        id: lease.operationId,
        signal: controller.signal,
        assertCurrent: () => requireCoordinator(runtime).assertCurrent(lease),
        heartbeat: () => requireCoordinator(runtime).heartbeatOperation(lease),
        update: (
            phase: MutationOperationPhase,
            update: { progress?: number; error?: string } = {},
        ) => requireCoordinator(runtime).updateOperation(lease, phase, update),
        bindExecutor: (executor: RootMutationExecutor) => (
            activityFromLease(requireCoordinator(runtime).bindExecutor(lease, executor))
        ),
    });
    return Object.freeze({ lease, controller, execution });
}

function linkSourceCancellation(signal: AbortSignal | undefined, cancel: () => void): () => void {
    if (!signal) return () => undefined;
    const listener = () => cancel();
    if (signal.aborted) {
        cancel();
        return () => undefined;
    }
    signal.addEventListener('abort', listener, { once: true });
    return () => signal.removeEventListener('abort', listener);
}

function currentLeaseForRoot(runtime: RootMutationRuntime, root: string): RootMutationLease | undefined {
    const coordinator = requireCoordinator(runtime);
    const lease = requireOperationScopes(runtime).getStore();
    return lease && coordinator.isLeaseForRoot(lease, root) ? lease : undefined;
}

function requireCurrentLeaseForRoot(runtime: RootMutationRuntime, root: string): RootMutationLease {
    const lease = currentLeaseForRoot(runtime, root);
    if (!lease) {
        throw new Error(`No Core root mutation scope is active for '${root}'.`);
    }
    return lease;
}

/** Internal Core-only accessors. Do not re-export from a package entrypoint. */
export function getRootMutationCoordinator(runtime: RootMutationRuntime): MutationLeaseCoordinator {
    return requireCoordinator(runtime);
}

export function getCurrentRootMutationLease(runtime: RootMutationRuntime, root: string): RootMutationLease {
    return requireCurrentLeaseForRoot(runtime, root);
}
