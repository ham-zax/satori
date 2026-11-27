import type { PublicationLease } from "@satori-code/core";

/**
 * One request, one immutable Publication lease.
 *
 * Readiness may inspect current state, but immutable serving identity comes only
 * from the atomic PublicationStore acquisition returned here.
 */
export interface PreparedPublicationReadSessionDependencies<
    TPrepared,
    TLease extends PublicationLease | null = PublicationLease,
> {
    prepareReadiness(): Promise<TPrepared>;
    /**
     * `null` means the prepared readiness names no Publication (for example the
     * root is still indexing): the executor answers from readiness alone.
     * `undefined` means the named Publication could no longer be leased: stale.
     */
    acquirePublicationLease(prepared: TPrepared): Promise<TLease | undefined> | TLease | undefined;
    isLeaseAdmitted(prepared: TPrepared, lease: PublicationLease): Promise<boolean> | boolean;
}

export type PreparedPublicationReadExecutor<TPrepared, TResult, TLease = PublicationLease> = (
    prepared: TPrepared,
    lease: TLease,
) => Promise<TResult>;

export type PreparedPublicationReadOutcome<TResult> =
    | { status: "completed"; result: TResult }
    | { status: "stale" };

export class PreparedPublicationReadSession<
    TPrepared,
    TLease extends PublicationLease | null = PublicationLease,
> {
    public constructor(
        private readonly deps: PreparedPublicationReadSessionDependencies<TPrepared, TLease>,
    ) {}

    public async read<TResult>(
        execute: PreparedPublicationReadExecutor<TPrepared, TResult, TLease>,
        options?: { signal?: AbortSignal },
    ): Promise<PreparedPublicationReadOutcome<TResult>> {
        const signal = options?.signal;
        signal?.throwIfAborted();
        const prepared = await this.deps.prepareReadiness();
        signal?.throwIfAborted();
        const lease = await this.deps.acquirePublicationLease(prepared);
        if (lease === undefined || lease === null) {
            signal?.throwIfAborted();
            if (lease === undefined) return { status: "stale" };
            const result = await execute(prepared, lease);
            signal?.throwIfAborted();
            return { status: "completed", result };
        }
        try {
            signal?.throwIfAborted();
            const admitted = await this.deps.isLeaseAdmitted(prepared, lease);
            signal?.throwIfAborted();
            if (!admitted) return { status: "stale" };
            const result = await execute(prepared, lease);
            signal?.throwIfAborted();
            const stillAdmitted = await this.deps.isLeaseAdmitted(prepared, lease);
            signal?.throwIfAborted();
            if (!stillAdmitted) return { status: "stale" };
            return { status: "completed", result };
        } finally {
            lease.release();
        }
    }
}
