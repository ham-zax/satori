import os from "node:os";

export type LateOnExecutionPlan = Readonly<{
    /** Model sessions, each on its own worker thread, encoding documents in parallel. */
    encoderSessions: number;
    /** ONNX Runtime intra-op threads per session. */
    intraOpThreads: number;
}>;

export type LateOnHostResources = Readonly<{
    logicalCpus: number;
    availableMemoryBytes: number;
    /** Active index/sync mutations; when > 0, LateOn caps to 1 session (~0.53 GiB) to avoid swap spikes. */
    activeMutations?: number;
    /** Host memory headroom kept free before scaling beyond 1 session. */
    reserveMemoryBytes?: number;
}>;

// Sizing comes from 64-candidate reranks on a Ryzen 7 3800X (WSL2), with CPU
// affinity emulating 2-16 CPU hosts. Scores are bit-identical for every layout.
// - Up to four CPUs, single-threaded sessions scale best (4 CPUs: 4x1 1.52 s,
//   1x4 1.97 s).
// - From 8 CPUs, 4 sessions x 2 threads (1.23-1.26 s) is within 5% of the best
//   layout (8x1, 1.17-1.22 s) at roughly half its memory.
// - One session saturates near 4 threads (1x4 1.74 s, 1x8 1.86 s). Hosts beyond
//   16 CPUs add a session per 4 CPUs, up to 8; that range is extrapolated, not
//   measured.
const LATEON_BASE_ENCODER_SESSIONS = 4;
const LATEON_MAXIMUM_ENCODER_SESSIONS = 8;
const LATEON_CPUS_PER_EXTRA_SESSION = 4;
const LATEON_MAXIMUM_THREADS_PER_SESSION = 4;
const LATEON_MAXIMUM_THREADS_PER_POOLED_SESSION = 2;
// Each session adds ~370 MB of peak worker RSS (1x8 0.53 GB, 4x2 1.64 GB);
// require 1 GiB of free memory per session when the worker starts.
const LATEON_AVAILABLE_MEMORY_PER_SESSION_BYTES = 1024 * 1024 * 1024;
const LATEON_HOST_RESERVE_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

function wholeAtLeastOne(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export function planLateOnExecution(host: LateOnHostResources): LateOnExecutionPlan {
    const logicalCpus = wholeAtLeastOne(host.logicalCpus);
    if ((host.activeMutations ?? 0) > 0) {
        return Object.freeze({
            encoderSessions: 1,
            intraOpThreads: Math.min(LATEON_MAXIMUM_THREADS_PER_SESSION, logicalCpus),
        });
    }
    const reserve = host.reserveMemoryBytes && Number.isFinite(host.reserveMemoryBytes) && host.reserveMemoryBytes > 0
        ? host.reserveMemoryBytes
        : 0;
    const plannableMemory = Math.max(0, host.availableMemoryBytes - reserve);
    const encoderSessions = Math.min(
        logicalCpus,
        Math.max(
            LATEON_BASE_ENCODER_SESSIONS,
            Math.floor(logicalCpus / LATEON_CPUS_PER_EXTRA_SESSION),
        ),
        LATEON_MAXIMUM_ENCODER_SESSIONS,
        wholeAtLeastOne(plannableMemory / LATEON_AVAILABLE_MEMORY_PER_SESSION_BYTES),
    );
    const threadCeiling = encoderSessions >= LATEON_BASE_ENCODER_SESSIONS
        ? LATEON_MAXIMUM_THREADS_PER_POOLED_SESSION
        : LATEON_MAXIMUM_THREADS_PER_SESSION;
    return Object.freeze({
        encoderSessions,
        intraOpThreads: Math.min(threadCeiling, wholeAtLeastOne(logicalCpus / encoderSessions)),
    });
}

/** Sizes the pool from this host's CPUs (affinity-aware), cgroup-aware free memory, and active mutations. */
export function resolveHostLateOnExecutionPlan(
    options: Readonly<{ activeMutations?: number }> = {},
): LateOnExecutionPlan {
    return planLateOnExecution({
        logicalCpus: os.availableParallelism(),
        availableMemoryBytes: process.availableMemory(),
        activeMutations: options.activeMutations,
        reserveMemoryBytes: LATEON_HOST_RESERVE_BYTES,
    });
}
