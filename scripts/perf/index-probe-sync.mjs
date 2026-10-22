// Cleanup must sync the restored bytes even when watcher catch-up wins the lease.
// Only a blocked 'sync' is retried; every other refusal is returned unchanged.
// Measured sync requests do not use this retry path.
const TERMINAL_PHASES = ['completed', 'failed', 'cancelled', 'blocked']; // Mirrors isTerminalMutationOperationPhase in packages/core/src/generation/root-mutation-coordinator.ts
export async function requestCleanupSync({
    requestSync,
    currentOperation,
    waitTimeoutMs,
    now = () => performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
    // A non-finite budget makes the deadline NaN, so no wait would ever expire.
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
        throw new Error('requestCleanupSync requires a positive waitTimeoutMs');
    }
    const deadline = now() + waitTimeoutMs;
    const requireTime = () => {
        if (now() >= deadline) throw new Error(`cleanup sync remained blocked for ${waitTimeoutMs} ms`);
    };
    while (true) {
        requireTime();
        const response = await requestSync();
        const active = response?.hints?.activeMutation;
        if (response?.status !== 'blocked' || response.reason !== 'mutation_in_progress'
            || active?.action !== 'sync' || !active.id) return response;

        while (true) {
            requireTime();
            await sleep(Math.min(100, deadline - now()));
            requireTime();
            const operation = await currentOperation();
            if (!operation || operation.id !== active.id
                || TERMINAL_PHASES.includes(operation.phase)) break;
        }
        // A terminal status can precede lease release. Retry within the same deadline.
    }
}
