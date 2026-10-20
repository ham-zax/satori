import {
    Embedding,
    type EmbeddingBatchPolicy,
    type EmbeddingIdentity,
    type EmbeddingVector,
} from './base-embedding';
import {
    POTION_DIMENSION,
    POTION_RETAINED_TOKEN_LIMIT,
    PotionEmbedding,
    type PotionEmbeddingConfig,
} from './potion-embedding';

// October 2026 LibreOffice micro-benchmark: one helper uses about 4.3 cores
// and encodes about 4,300 chunks/s; 2 helpers 7,200/s, 3 helpers 9,200/s.
const CORES_PER_HELPER = 5;
const MAX_HELPERS = 3;

/** Helper processes worth running on a machine with this many CPUs. */
export function defaultPotionHelperCount(cpuCount: number): number {
    return Math.max(1, Math.min(MAX_HELPERS, Math.floor(cpuCount / CORES_PER_HELPER)));
}

/**
 * Spreads document batches over up to `helperCount` identical Potion helpers.
 * Every helper loads the same pinned model, so a batch gets the same vectors
 * on any helper. Helpers after the first start only when every running one is
 * busy; each keeps its own idle shutdown.
 */
export class PotionEmbeddingPool extends Embedding {
    protected maxTokens = POTION_RETAINED_TOKEN_LIMIT;
    private readonly members: PotionEmbedding[];
    private readonly inFlight: number[];
    private readonly perMemberRequests: number;
    private readonly slotWaiters: Array<() => void> = [];
    private growing: Promise<void> | null = null;
    private growthStopped = false;
    private closed = false;

    constructor(
        first: PotionEmbedding,
        private readonly helperCount: number,
        private readonly createMember: () => Promise<PotionEmbedding>,
    ) {
        super();
        if (!Number.isSafeInteger(helperCount) || helperCount <= 0) {
            throw new Error('Potion helper count must be a positive safe integer.');
        }
        this.members = [first];
        this.inFlight = [0];
        this.perMemberRequests = first.getBatchPolicy().maxConcurrentRequests ?? 1;
    }

    static async create(config: Readonly<PotionEmbeddingConfig>, helperCount: number): Promise<PotionEmbeddingPool> {
        const first = await PotionEmbedding.create(config);
        return new PotionEmbeddingPool(first, helperCount, () => PotionEmbedding.create(config));
    }

    private leastBusy(): number {
        let best = 0;
        for (let index = 1; index < this.members.length; index++) {
            if (this.inFlight[index] < this.inFlight[best]) best = index;
        }
        return best;
    }

    private grow(): void {
        if (this.growing || this.growthStopped || this.closed || this.members.length >= this.helperCount) return;
        // `growing` is cleared before waiters wake, so a waiter that still finds
        // every helper busy can start the next helper at once.
        this.growing = this.createMember().then(async (member) => {
            if (this.closed) {
                this.growing = null;
                await member.close();
                return;
            }
            this.members.push(member);
            this.inFlight.push(0);
            this.growing = null;
            for (const wake of this.slotWaiters.splice(0)) wake();
        }, (error: unknown) => {
            // The running helpers still serve every request with the same
            // vectors; only throughput is lost.
            this.growthStopped = true;
            this.growing = null;
            console.warn(`[Potion] Additional helper could not start; continuing with ${this.members.length}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    /** Waits until some helper has room for one more batch request; never over-fills a helper. */
    private async acquire(): Promise<number> {
        while (true) {
            const index = this.leastBusy();
            if (this.inFlight[index] > 0) this.grow();
            if (this.inFlight[index] < this.perMemberRequests) {
                this.inFlight[index]++;
                return index;
            }
            await new Promise<void>(resolve => this.slotWaiters.push(resolve));
        }
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        const index = await this.acquire();
        try {
            return await this.members[index].embedDocuments(texts);
        } finally {
            this.inFlight[index]--;
            this.slotWaiters.shift()?.();
        }
    }

    async embedQuery(text: string): Promise<EmbeddingVector> {
        // Queries use each helper's reserved foreground slot, not a batch slot.
        return this.members[this.leastBusy()].embedQuery(text);
    }

    async detectDimension(): Promise<number> {
        return POTION_DIMENSION;
    }

    getDimension(): number {
        return POTION_DIMENSION;
    }

    getProvider(): string {
        return this.members[0].getProvider();
    }

    override getIdentity(): Readonly<EmbeddingIdentity> {
        return this.members[0].getIdentity();
    }

    override getBatchPolicy(): EmbeddingBatchPolicy {
        return {
            ...this.members[0].getBatchPolicy(),
            maxConcurrentRequests: this.perMemberRequests * this.helperCount,
        };
    }

    override async close(): Promise<void> {
        this.closed = true;
        await this.growing;
        await Promise.all(this.members.map(member => member.close()));
    }
}
