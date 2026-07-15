import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    beginSourceMeasurementObservation,
    canPublishRootBoundFileIdentity,
    finishSourceMeasurementObservation,
    openRegularFileWithIdentityInsideRoot,
    readFileHandleExactly,
    recordSourceProcessing,
    RootBoundFileError,
    sameRootBoundFileIdentity,
    sourceIoOwnerForCurrentOperation,
    verifyStableFileDescriptorObservation,
    type RootBoundFileIdentity,
    type SourceMeasurementObservation,
    type SourceProcessingOutcome,
} from "@zokizuan/satori-core";

export type InspectableSourceFailureReason =
    | "source_exceeds_inspection_limit"
    | "source_descriptor_unavailable"
    | "source_changed_during_inspection"
    | "path_identity_changed_during_inspection"
    | "path_identity_unavailable";

export type InspectableSourceSelectionCapabilities = {
    localLexical: "available";
    lineWindows: "available";
    syntaxBoundaries: "unavailable_streaming_source";
    controlFlowAnchors: "unavailable_streaming_source";
};

export type InspectableSourceEvidence = {
    canonicalRoot: string;
    relativeFile: string;
    sourceBytes: Uint8Array;
    source: string;
    sourceByteLength: number;
    observedHash: string;
    identity: RootBoundFileIdentity;
    selectionCapabilities: InspectableSourceSelectionCapabilities;
    measurementObservation?: SourceMeasurementObservation;
};

type InspectableSourceFailureResult = {
    status: "unavailable" | "stale";
    reason: InspectableSourceFailureReason;
} | {
    status: "safety_error";
    reason: "root_binding_invalid";
    diagnosticCode: "ROOT_BINDING_INVALID";
};

export type InspectableSourceFinalizationResult = {
    status: "available";
    freshness: "current_at_final_observation";
} | InspectableSourceFailureResult;

export interface InspectableSourceFinalizer {
    finalize(input?: {
        validatePreparedAuthority?: () => Promise<void>;
    }): Promise<InspectableSourceFinalizationResult>;
    release(): Promise<void>;
}

export type PrepareInspectableSourceResult =
    | {
        status: "available";
        evidence: InspectableSourceEvidence;
        finalizer: InspectableSourceFinalizer;
    }
    | InspectableSourceFailureResult;

const STREAMING_SELECTION_CAPABILITIES: InspectableSourceSelectionCapabilities = {
    localLexical: "available",
    lineWindows: "available",
    syntaxBoundaries: "unavailable_streaming_source",
    controlFlowAnchors: "unavailable_streaming_source",
};

function isRelativeFileInsideRoot(relativeFile: string, logicalFile: string, canonicalRoot: string): boolean {
    if (path.isAbsolute(relativeFile)) {
        return false;
    }
    const relativePath = path.relative(canonicalRoot, logicalFile);
    return relativePath.length > 0
        && relativePath !== ".."
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);
}

function rootBindingFailure(): Extract<InspectableSourceFailureResult, { status: "safety_error" }> {
    return {
        status: "safety_error",
        reason: "root_binding_invalid",
        diagnosticCode: "ROOT_BINDING_INVALID",
    };
}

function mapRootBoundFailure(
    error: unknown,
): InspectableSourceFailureResult | undefined {
    if (!(error instanceof RootBoundFileError)) {
        return undefined;
    }
    switch (error.code) {
        case "root_binding_invalid":
            return rootBindingFailure();
        case "path_identity_unavailable":
            return { status: "unavailable", reason: "path_identity_unavailable" };
        case "source_changed_during_inspection":
            return { status: "stale", reason: "source_changed_during_inspection" };
        case "path_identity_changed_during_inspection":
            return { status: "stale", reason: "path_identity_changed_during_inspection" };
        default: {
            const exhaustive: never = error.code;
            throw new Error(`Unhandled root-bound source failure: ${exhaustive}`);
        }
    }
}

function finishIncompleteObservation(observation: SourceMeasurementObservation | undefined): void {
    finishSourceMeasurementObservation({
        observation,
        status: "partial",
    });
}

function sameSourceMetadata(
    left: { size: number; mtimeMs: number; ctimeMs: number },
    right: { size: number; mtimeMs: number; ctimeMs: number },
): boolean {
    return left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

/**
 * Prepare one bounded source observation while retaining its root-bound descriptor.
 * The caller must run the one-shot finalizer after composition. The finalizer
 * places prepared-authority validation between descriptor stability and the last
 * path rebinding, then the caller can synchronously freeze the response snapshot.
 */
export async function prepareInspectableSource(input: {
    codebaseRoot: string;
    relativeFile: string;
    maxInspectableBytes: number;
}): Promise<PrepareInspectableSourceResult> {
    if (!Number.isSafeInteger(input.maxInspectableBytes) || input.maxInspectableBytes < 0) {
        throw new Error("maxInspectableBytes must be a non-negative safe integer.");
    }

    let canonicalRoot: string;
    try {
        canonicalRoot = await fs.realpath(input.codebaseRoot);
    } catch {
        return { status: "unavailable", reason: "source_descriptor_unavailable" };
    }
    const logicalFile = path.resolve(canonicalRoot, input.relativeFile);
    if (!isRelativeFileInsideRoot(input.relativeFile, logicalFile, canonicalRoot)) {
        return rootBindingFailure();
    }

    let opened: Awaited<ReturnType<typeof openRegularFileWithIdentityInsideRoot>>;
    try {
        opened = await openRegularFileWithIdentityInsideRoot(logicalFile, canonicalRoot);
    } catch (error) {
        return mapRootBoundFailure(error)
            ?? { status: "unavailable", reason: "source_descriptor_unavailable" };
    }

    let measurementObservation: SourceMeasurementObservation | undefined;
    let observationNeedsOutcome = false;
    let descriptorTransferred = false;
    try {
        if (!canPublishRootBoundFileIdentity(opened.identity)) {
            return { status: "unavailable", reason: "path_identity_unavailable" };
        }
        if (opened.observedStat.size > input.maxInspectableBytes) {
            return { status: "unavailable", reason: "source_exceeds_inspection_limit" };
        }

        measurementObservation = beginSourceMeasurementObservation({
            owner: sourceIoOwnerForCurrentOperation("validation"),
            filePath: logicalFile,
            logicalBytesRequested: opened.observedStat.size,
            scanKind: "complete",
        });
        observationNeedsOutcome = measurementObservation !== undefined;

        let sourceBytes: Buffer;
        try {
            sourceBytes = await readFileHandleExactly(
                opened.handle,
                opened.observedStat.size,
                measurementObservation,
                { deferSuccessfulObservationOutcome: true },
            );
        } catch (error) {
            observationNeedsOutcome = false;
            return mapRootBoundFailure(error)
                ?? { status: "unavailable", reason: "source_descriptor_unavailable" };
        }

        const source = sourceBytes.toString("utf8");
        const hashingStartedAt = performance.now();
        let hashingOutcome: SourceProcessingOutcome = "failed";
        let observedHash: string;
        try {
            observedHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
            hashingOutcome = "success";
        } finally {
            recordSourceProcessing({
                observation: measurementObservation,
                owner: "hashing",
                inputBytesProcessed: sourceBytes.length,
                basis: "shared_buffer",
                outcome: hashingOutcome,
                durationMs: performance.now() - hashingStartedAt,
            });
        }

        const evidence: InspectableSourceEvidence = {
            canonicalRoot,
            relativeFile: input.relativeFile.replace(/\\/g, "/"),
            sourceBytes: new Uint8Array(sourceBytes),
            source,
            sourceByteLength: sourceBytes.length,
            observedHash,
            identity: opened.identity,
            selectionCapabilities: STREAMING_SELECTION_CAPABILITIES,
            ...(measurementObservation ? { measurementObservation } : {}),
        };
        let finalized = false;
        let released = false;
        let rebound: Awaited<ReturnType<typeof openRegularFileWithIdentityInsideRoot>> | undefined;
        const finishPartial = (): void => {
            if (!observationNeedsOutcome) return;
            finishIncompleteObservation(measurementObservation);
            observationNeedsOutcome = false;
        };
        const finalizer: InspectableSourceFinalizer = {
            finalize: async (finalizeInput = {}) => {
                if (finalized || released) {
                    throw new Error("Inspectable source finalization is one-shot.");
                }
                finalized = true;
                let finalDescriptorStat: Awaited<ReturnType<typeof verifyStableFileDescriptorObservation>>;
                try {
                    finalDescriptorStat = await verifyStableFileDescriptorObservation(
                        opened.handle,
                        logicalFile,
                        opened.observedStat,
                    );
                } catch (error) {
                    finishPartial();
                    return mapRootBoundFailure(error)
                        ?? { status: "stale", reason: "source_changed_during_inspection" };
                }

                await finalizeInput.validatePreparedAuthority?.();

                try {
                    rebound = await openRegularFileWithIdentityInsideRoot(logicalFile, canonicalRoot);
                } catch (error) {
                    finishPartial();
                    return mapRootBoundFailure(error)
                        ?? { status: "stale", reason: "path_identity_changed_during_inspection" };
                }
                if (!canPublishRootBoundFileIdentity(rebound.identity)) {
                    finishPartial();
                    return { status: "unavailable", reason: "path_identity_unavailable" };
                }
                if (!sameRootBoundFileIdentity(opened.identity, rebound.identity)) {
                    finishPartial();
                    return { status: "stale", reason: "path_identity_changed_during_inspection" };
                }
                if (!sameSourceMetadata(finalDescriptorStat, rebound.observedStat)) {
                    finishPartial();
                    return { status: "stale", reason: "source_changed_during_inspection" };
                }

                finishSourceMeasurementObservation({
                    observation: measurementObservation,
                    status: "completed",
                });
                observationNeedsOutcome = false;
                return { status: "available", freshness: "current_at_final_observation" };
            },
            release: async () => {
                if (released) return;
                released = true;
                finishPartial();
                await rebound?.handle.close().catch(() => undefined);
                await opened.handle.close().catch(() => undefined);
            },
        };
        descriptorTransferred = true;
        return { status: "available", evidence, finalizer };
    } finally {
        if (!descriptorTransferred && observationNeedsOutcome) {
            finishIncompleteObservation(measurementObservation);
        }
        if (!descriptorTransferred) {
            await opened.handle.close().catch(() => undefined);
        }
    }
}
