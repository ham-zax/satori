export {
    resolveRuntimeOwnerStateDir,
    resolveSatoriStateRoot,
} from './config/runtime-state-root';
export {
    createSharedPublicationRuntime,
    createStorageMaintenanceReaderGuard,
    probeCurrentPublicationForPath,
} from './generation/publication-store';
export type {
    PublicationPathProbe,
    SharedPublicationRuntime,
    StorageMaintenanceReaderGuard,
} from './generation/publication-store';
export {
    RootMutationCancelledError,
    RootMutationInProgressError,
    RootMutationRuntime,
    createRootMutationLeasePort,
    formatRootMutationBlockedMessage,
    type RootMutationActivity,
    type RootMutationExecution,
    type RootMutationExecutionOptions,
    type RootMutationExecutor,
    type RootMutationLeasePort,
    type RootMutationStart,
} from './generation/root-mutation-runtime';
export {
    MutationExecutorStillActiveError,
} from './generation/root-mutation-coordinator';
export type {
    MutationOperationPhase,
    MutationTrigger,
    RootMutationOperation,
} from './generation/root-mutation-coordinator';
export type {
    ProvenSourceFreshnessCheckpointEvidence,
    SourceFreshnessPathComparison,
} from './sync/synchronizer';

export type { IndexingMemoryStatus } from './indexing/resources';
export { isIndexingMemoryStatus } from './indexing/resources';
export {
    claimAndUnlinkStaleFileLock,
    isLinuxProcessIdentityLive,
    publishAtomicFileLock,
    readLinuxBootId,
    readLinuxProcessIdentity,
    readLinuxProcessStartTime,
    removeOwnedFileLockIfUnchanged,
    sameFileLockIdentity,
    type FileLockIdentity,
    type LinuxProcessIdentity,
} from './utils/file-lock';
