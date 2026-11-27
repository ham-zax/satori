/** Single owner of the removed-runtime-env guard shared by config and the shared-runtime launcher client. */
export function assertRemovedRuntimeEnvUnset(read: (name: string) => string | undefined): void {
    if (read('SATORI_RERANK_APPLICATION_MODE') !== undefined) {
        throw new Error('SATORI_RERANK_APPLICATION_MODE has been removed; unset it.');
    }
}
