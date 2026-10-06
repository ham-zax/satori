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
    ): Promise<PreparedPublicationReadOutcome<TResult>> {
        const prepared = await this.deps.prepareReadiness();
        const lease = await this.deps.acquirePublicationLease(prepared);
        if (lease === undefined) return { status: "stale" };
        if (lease === null) return { status: "completed", result: await execute(prepared, lease) };
        try {
            if (!(await this.deps.isLeaseAdmitted(prepared, lease))) {
                return { status: "stale" };
            }
            const result = await execute(prepared, lease);
            if (!(await this.deps.isLeaseAdmitted(prepared, lease))) {
                return { status: "stale" };
            }
            return { status: "completed", result };
        } finally {
            lease.release();
        }
    }
}
