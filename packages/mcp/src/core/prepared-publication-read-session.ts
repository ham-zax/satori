import type { PublicationLease } from "@satori-code/core";

/**
 * One request, one immutable Publication lease.
 *
 * Readiness may inspect current state, but immutable serving identity comes only
 * from the atomic PublicationStore acquisition returned here.
 */
export interface PreparedPublicationReadSessionDependencies<TPrepared> {
    prepareReadiness(): Promise<TPrepared>;
    acquirePublicationLease(prepared: TPrepared): Promise<PublicationLease | undefined> | PublicationLease | undefined;
    isLeaseAdmitted(prepared: TPrepared, lease: PublicationLease): Promise<boolean> | boolean;
}

export type PreparedPublicationReadExecutor<TPrepared, TResult> = (
    prepared: TPrepared,
    lease: PublicationLease,
) => Promise<TResult>;

export type PreparedPublicationReadOutcome<TResult> =
    | { status: "completed"; result: TResult }
    | { status: "stale" };

export class PreparedPublicationReadSession<TPrepared> {
    public constructor(
        private readonly deps: PreparedPublicationReadSessionDependencies<TPrepared>,
    ) {}

    public async read<TResult>(
        execute: PreparedPublicationReadExecutor<TPrepared, TResult>,
    ): Promise<PreparedPublicationReadOutcome<TResult>> {
        const prepared = await this.deps.prepareReadiness();
        const lease = await this.deps.acquirePublicationLease(prepared);
        if (!lease) return { status: "stale" };
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
