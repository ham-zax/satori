import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIndexingResourceOverrides, type IndexingResourceOverrides } from '../config/indexing-resources';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CGROUP_ROOT = '/sys/fs/cgroup';
// October 2026 Satori profile, scratchpad/mem/report.md (Largest owners and
// lifetime) and a-report.md: compiler isolates reached 716 MiB heap plus V8
// capacity; parser isolates reached 0.4–0.5 GiB. Initial tree RSS was 743 MiB,
// including Potion helpers; reserve 1 GiB for shared/coordinator/native work.
const TYPESCRIPT_JOB_BYTES = GIB;
const ANALYSIS_JOB_BYTES = 512 * MIB;
const SHARED_WORKING_SET_BYTES = GIB;
const BURST_RESERVE_FRACTION = 0.20;
const FALLBACK_AVAILABLE_BYTES = 2 * GIB;

export interface IndexingMemoryStatus {
    readonly budgetMb: number;
    readonly hint: string;
}

export interface IndexingResourcePlan {
    readonly budgetBytes: number;
    readonly burstReserveBytes: number;
    readonly typescriptProjectConcurrency: number;
    readonly analysisWorkers: number;
    readonly analysisWindowFiles: number;
    readonly queuedEmbeddingTextBytes: number;
    readonly embeddingBatchMaxItems: number;
    readonly vectorWriteMaxRows: number;
    readonly memoryBudget: IndexingMemoryStatus;
}

export interface IndexingResourceObservationPort {
    platform(): string;
    readFile(file: string): string;
    totalMemory(): number;
    freeMemory(): number;
    cpuCount(): number;
}

const SYSTEM: IndexingResourceObservationPort = {
    platform: os.platform,
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    totalMemory: os.totalmem,
    freeMemory: os.freemem,
    cpuCount: os.availableParallelism,
};

function numericBytes(text: string | undefined): number | undefined {
    const value = text?.trim();
    if (!value || !/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}

export function isIndexingMemoryStatus(value: unknown): value is IndexingMemoryStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as IndexingMemoryStatus;
    return Number.isSafeInteger(status.budgetMb) && status.budgetMb >= 0 && typeof status.hint === 'string';
}

/** One observation/policy owner; stages consume its immutable per-operation plan. */
export class IndexingResourcePlanner {
    constructor(
        private readonly observation: IndexingResourceObservationPort = SYSTEM,
        private readonly overrides: () => IndexingResourceOverrides = readIndexingResourceOverrides,
        private readonly diagnostic: (message: string) => void = console.warn,
    ) {}

    createPlan(): IndexingResourcePlan {
        const absentFiles = new Set<string>();
        const read = (file: string): string | undefined => {
            try { return this.observation.readFile(file); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') absentFiles.add(file);
                return undefined;
            }
        };
        const sample = (reader: () => number, fallback: number): number => {
            try {
                const value = reader();
                return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
            } catch { return fallback; }
        };
        const overrides = this.overrides();
        for (const message of overrides.diagnostics) this.diagnostic(message);
        const totalMemory = sample(() => this.observation.totalMemory(), FALLBACK_AVAILABLE_BYTES);
        let available = sample(() => this.observation.freeMemory(), FALLBACK_AVAILABLE_BYTES);
        const limits: number[] = [];
        if (this.observation.platform() === 'linux') {
            const memAvailable = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(read('/proc/meminfo') ?? '');
            const kilobytes = numericBytes(memAvailable?.[1]);
            if (kilobytes !== undefined && Number.isSafeInteger(kilobytes * 1024)) available = kilobytes * 1024;
            const memberships = read('/proc/self/cgroup') ?? '';
            const membership = /^0::(\/[^\n]*)$/m.exec(memberships)?.[1];
            let unknownLimit = !membership;
            if (membership) {
                let cgroup = path.posix.resolve(CGROUP_ROOT, `.${path.posix.normalize(membership)}`);
                while (true) {
                    const rawMaximum = read(`${cgroup}/memory.max`);
                    const maximum = numericBytes(rawMaximum);
                    // Without controller files this level cannot impose a limit;
                    // continue to ancestors, which may enable the controller.
                    if (maximum === undefined && rawMaximum?.trim() !== 'max'
                        && !absentFiles.has(`${cgroup}/memory.max`)) unknownLimit = true;
                    if (maximum !== undefined) {
                        const current = numericBytes(read(`${cgroup}/memory.current`));
                        // A finite limit with unknown usage proves no headroom.
                        limits.push(Math.max(0, maximum - (current ?? maximum)));
                    }
                    if (cgroup === CGROUP_ROOT) break;
                    cgroup = path.posix.dirname(cgroup);
                }
            } else {
                const memoryMembership = memberships.split('\n')
                    .map(line => /^\d+:([^:]+):(\/.*)$/.exec(line))
                    .find(line => line?.[1].split(',').includes('memory'))?.[2];
                if (memoryMembership) {
                    const memoryRoot = `${CGROUP_ROOT}/memory`;
                    let cgroup = path.posix.resolve(memoryRoot, `.${path.posix.normalize(memoryMembership)}`);
                    let rawMaximum = read(`${cgroup}/memory.limit_in_bytes`);
                    // Containers may mount their own v1 cgroup at the mount root
                    // while /proc still reports its path in the host hierarchy.
                    if (absentFiles.has(`${cgroup}/memory.limit_in_bytes`)) {
                        cgroup = memoryRoot;
                        rawMaximum = read(`${cgroup}/memory.limit_in_bytes`);
                    }
                    if (/^\d+$/.test(rawMaximum?.trim() ?? '')) {
                        const maximum = BigInt(rawMaximum!.trim());
                        unknownLimit = false;
                        // v1 PAGE_COUNTER_MAX is rounded near 2^63; parse it as
                        // an integer before deciding it is unlimited (>= 2^60).
                        if (maximum < 1n << 60n) {
                            const rawCurrent = read(`${cgroup}/memory.usage_in_bytes`);
                            const current = /^\d+$/.test(rawCurrent?.trim() ?? '') ? BigInt(rawCurrent!.trim()) : maximum;
                            const headroom = maximum > current ? maximum - current : 0n;
                            limits.push(Number(headroom > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : headroom));
                        }
                    }
                }
            }
            if (unknownLimit) {
                limits.push(FALLBACK_AVAILABLE_BYTES);
                this.diagnostic('Cgroup memory limits are unreadable; using a conservative 2 GiB planning limit.');
            }
        }
        const hostReserve = Math.min(GIB, Math.max(256 * MIB, Math.ceil(totalMemory * 0.05)));
        limits.push(Math.max(0, available - hostReserve));
        if (overrides.budgetBytes !== undefined) limits.push(overrides.budgetBytes);
        const budgetBytes = Math.floor(Math.min(...limits));
        const burstReserveBytes = Math.ceil(budgetBytes * BURST_RESERVE_FRACTION);
        const workingBytes = Math.max(0, budgetBytes - burstReserveBytes - SHARED_WORKING_SET_BYTES);
        const queuedEmbeddingTextBytes = Math.max(MIB, Math.min(64 * MIB, Math.floor(workingBytes / 32)));
        // Queued entries also retain original/lexical text and projection metadata.
        const jobBytes = Math.max(0, workingBytes - 4 * queuedEmbeddingTextBytes);
        const cpus = Math.max(1, sample(() => this.observation.cpuCount(), 1));
        const cpuTypescript = Math.max(1, Math.min(3, cpus - 1));
        const cpuAnalysis = Math.max(0, Math.min(8, cpus - 1));
        const typescriptProjectConcurrency = Math.max(1, Math.min(cpuTypescript, Math.floor(jobBytes / TYPESCRIPT_JOB_BYTES)));
        const derivedAnalysis = Math.min(cpuAnalysis, Math.max(1, Math.floor(jobBytes / ANALYSIS_JOB_BYTES)));
        const analysisWorkers = overrides.analysisWorkers ?? derivedAnalysis;
        const analysisWindowFiles = Math.max(1, analysisWorkers) * (budgetBytes > 4 * GIB ? 2 : 1);
        const lowered = typescriptProjectConcurrency < cpuTypescript || (overrides.analysisWorkers === undefined && analysisWorkers < cpuAnalysis);
        const reason = typescriptProjectConcurrency < cpuTypescript
            ? typescriptProjectConcurrency === 1
                ? 'Full-index TypeScript projects run one at a time, so indexing may take longer.'
                : `Full-index TypeScript project concurrency is reduced to ${typescriptProjectConcurrency}, so indexing may take longer.`
            : 'Fewer analysis workers run in parallel, so indexing may take longer.';
        const memoryBudget = Object.freeze({
            budgetMb: Math.floor(budgetBytes / MIB),
            hint: `Memory budget ${(budgetBytes / GIB).toFixed(1)} GiB${lowered ? `: ${reason}` : '.'}`,
        });
        return Object.freeze({
            budgetBytes, burstReserveBytes, typescriptProjectConcurrency, analysisWorkers, analysisWindowFiles,
            queuedEmbeddingTextBytes,
            embeddingBatchMaxItems: Math.max(8, Math.min(1000, Math.floor(queuedEmbeddingTextBytes / (16 * 1024)))),
            vectorWriteMaxRows: Math.max(8, Math.min(256, Math.floor(queuedEmbeddingTextBytes / (32 * 1024)))),
            memoryBudget,
        });
    }
}

export interface IndexingProgress {
    phase: string;
    current: number;
    total: number;
    percentage: number;
    memoryBudget?: IndexingMemoryStatus;
}
