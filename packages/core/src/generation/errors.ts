/** Generation-domain errors shared by Core mutation owners. */
export class AtomicIncrementalPublicationUnsupportedError extends Error {
    constructor() {
        super('The active vector backend cannot stage an atomic incremental publication; a full rebuild is required.');
        this.name = 'AtomicIncrementalPublicationUnsupportedError';
    }
}

/** On-disk index data was written by another format version; the only fix is a fresh index. */
export class IndexFormatIncompatibleError extends Error {
    readonly remediation = 'reindex' as const;

    constructor(detail: string) {
        super(`${detail}; reindex is required.`);
        this.name = 'IndexFormatIncompatibleError';
    }
}
