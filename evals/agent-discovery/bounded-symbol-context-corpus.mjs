import crypto from "node:crypto";
import fs from "node:fs";

const EXPECTED_SCHEMA_VERSION = 1;
const EXPECTED_FIXTURE_ID = "satori-bounded-symbol-context-phase-0-v1";
const VARIANT_EXACT = "exact_symbol_v2";
const VARIANT_SPAN = "direct_span";

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer.`);
    }
    return value;
}

function hasExactlyOne(record, keys) {
    return keys.filter((key) => Object.hasOwn(record, key)).length === 1;
}

function hasOnlyKeys(record, allowed) {
    return Object.keys(record).every((key) => allowed.includes(key));
}

export function classifyOpenSymbolVariant(openSymbol, wireContract) {
    if (!isRecord(openSymbol)) return null;
    const exact = wireContract.exactSymbol;
    const span = wireContract.directSpan;
    const isExact = openSymbol.contractVersion === wireContract.requestFormatVersion
        && hasExactlyOne(openSymbol, exact.exactlyOneIdentity)
        && hasExactlyOne(openSymbol, exact.exactlyOneOperation)
        && hasOnlyKeys(openSymbol, exact.allowed);
    if (isExact) return VARIANT_EXACT;
    const isSpan = span.required.every((key) => (
        Number.isSafeInteger(openSymbol[key]) && openSymbol[key] > 0
    )) && openSymbol.endLine >= openSymbol.startLine
        && hasOnlyKeys(openSymbol, span.allowed);
    return isSpan ? VARIANT_SPAN : null;
}

function typescriptLine(symbol, line, totalLines) {
    if (line === 1) return `export function ${symbol}(input: number) {`;
    if (line === totalLines) return "}";
    if (line === totalLines - 1) return "  return input;";
    return `  const step${String(line).padStart(4, "0")} = input + ${line};`;
}

function pythonLine(symbol, line, totalLines) {
    if (line === 1) return `def ${symbol}(input_value):`;
    if (line === totalLines) return "    return input_value";
    return `    step_${String(line).padStart(4, "0")} = input_value + ${line}`;
}

function materializeLineAnchoredSymbol(fixture) {
    const totalLines = requirePositiveInteger(fixture.totalLines, `${fixture.id}.totalLines`);
    const anchors = new Map((fixture.anchors ?? []).map((anchor) => [anchor.line, anchor.text]));
    const lineBuilder = fixture.language === "typescript"
        ? typescriptLine
        : fixture.language === "python"
            ? pythonLine
            : null;
    if (!lineBuilder) throw new Error(`${fixture.id}.language is unsupported.`);
    const lines = Array.from({ length: totalLines }, (_, index) => {
        const line = index + 1;
        return anchors.get(line) ?? lineBuilder(fixture.symbol, line, totalLines);
    });
    return `${lines.join("\n")}\n`;
}

function materializeSingleLine(fixture) {
    const totalBytes = requirePositiveInteger(fixture.totalBytes, `${fixture.id}.totalBytes`);
    const prefix = `export const ${fixture.symbol} = "`;
    const suffix = `";`;
    const fillBytes = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    if (fillBytes < 1) throw new Error(`${fixture.id}.totalBytes is too small.`);
    const source = `${prefix}${"x".repeat(fillBytes)}${suffix}`;
    if (Buffer.byteLength(source) !== totalBytes) {
        throw new Error(`${fixture.id} did not materialize to its declared byte count.`);
    }
    return source;
}

function materializeSingleLineSequence(fixture) {
    const minimumBytes = requirePositiveInteger(fixture.minimumBytes, `${fixture.id}.minimumBytes`);
    const lineBytes = requirePositiveInteger(fixture.lineBytes, `${fixture.id}.lineBytes`);
    const declaration = `export function ${fixture.symbol}(input: number) {`;
    const lines = [declaration];
    let materializedBytes = Buffer.byteLength(`${declaration}\n}\n`);
    let line = 2;
    while (materializedBytes < minimumBytes) {
        const prefix = `  const part${String(line).padStart(5, "0")} = input;`;
        const sourceLine = prefix.padEnd(lineBytes, " ");
        lines.push(sourceLine);
        materializedBytes += Buffer.byteLength(`${sourceLine}\n`);
        line += 1;
    }
    lines.push("}");
    return `${lines.join("\n")}\n`;
}

export function materializeFixture(fixture) {
    switch (fixture.kind) {
        case "line_anchored_symbol":
            return materializeLineAnchoredSymbol(fixture);
        case "single_line":
            return materializeSingleLine(fixture);
        case "single_line_sequence":
            return materializeSingleLineSequence(fixture);
        default:
            return null;
    }
}

export function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function validateLimits(limits) {
    for (const [key, value] of Object.entries(limits)) {
        requirePositiveInteger(value, `limits.${key}`);
    }
    if (limits.defaultSourceBytes > limits.maxSourceBytes) {
        throw new Error("Default source bytes exceed the public maximum.");
    }
    if (limits.defaultSourceLines > limits.maxSourceLines) {
        throw new Error("Default source lines exceed the public maximum.");
    }
    if (limits.defaultTotalResponseBytes > limits.hardResponseLimitBytes) {
        throw new Error("Default response bytes exceed the hard response limit.");
    }
    if (limits.emergencyErrorLimitBytes >= limits.hardResponseLimitBytes) {
        throw new Error("Emergency error limit must be below the normal response limit.");
    }
    if (
        limits.emergencyErrorLimitBytes > limits.v2ErrorLimitBytes
        || limits.v2ErrorLimitBytes >= limits.hardResponseLimitBytes
    ) {
        throw new Error("V2 error limits must fit between the emergency and normal response limits.");
    }
    if (limits.hardResponseLimitBytes > limits.modelVisibleToolResultBytes) {
        throw new Error("Hard response limit exceeds the model-visible tool-result limit.");
    }
    if (limits.maxInspectableSourceBytes <= limits.hardResponseLimitBytes) {
        throw new Error("Inspectable source limit must exceed the response limit.");
    }
}

export function validatePhase0Contract(contract) {
    if (!isRecord(contract) || contract.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
        throw new Error(`Phase 0 contract must use schema version ${EXPECTED_SCHEMA_VERSION}.`);
    }
    if (contract.fixtureId !== EXPECTED_FIXTURE_ID) {
        throw new Error(`Unexpected fixture id '${contract.fixtureId}'.`);
    }
    if (new Set(contract.publicToolNames).size !== 6 || contract.publicToolNames.length !== 6) {
        throw new Error("The frozen public tool surface must contain six unique names.");
    }
    validateLimits(contract.limits);
    if (
        contract.phase0.boundedContextProductChangesAllowed !== false
        || contract.phase0.measurementInstrumentationChangesAllowed !== true
        || contract.phase0.acceptanceSpecifications.runtimeAssertionsRequiredInPhase0 !== false
        || contract.phase0.acceptanceSpecifications.completeMatrixRequiredInPhase !== 6
    ) {
        throw new Error("Phase 0 must freeze baselines and specifications without requiring future runtime behavior.");
    }
    if (
        contract.baselineIdentityContract.historicalProductBaseline
            .eligibleForLatencyAndSourceCostComparison !== false
        || contract.baselineIdentityContract.instrumentedMeasurementBaseline
            .eligibleForLatencyAndSourceCostComparison !== true
        || contract.baselineIdentityContract.candidateMustUseSameInstrumentationImplementation !== true
    ) {
        throw new Error("Historical and instrumented baseline identities must remain distinct.");
    }
    for (const schemaCase of contract.wireContract.schemaCases) {
        const actual = classifyOpenSymbolVariant(schemaCase.openSymbol, contract.wireContract);
        if (actual !== schemaCase.acceptedVariant) {
            throw new Error(`${schemaCase.id} classified as ${actual}; expected ${schemaCase.acceptedVariant}.`);
        }
    }
    const sourceFailureReasons = new Set(contract.sourceFailureReasons);
    if (sourceFailureReasons.size !== contract.sourceFailureReasons.length) {
        throw new Error("Source failure reasons must be unique.");
    }
    if (sourceFailureReasons.has("language_selection_unsupported")) {
        throw new Error("Language selection support must not be a source failure reason.");
    }
    const allowedStatuses = new Set(contract.sourceStatuses);
    for (const mapping of contract.sourceStatusReasonMapping) {
        if (!allowedStatuses.has(mapping.status)) {
            throw new Error(`Unsupported source status '${mapping.status}'.`);
        }
        if (mapping.emptyReason !== null && !sourceFailureReasons.has(mapping.emptyReason)) {
            throw new Error(`Unsupported source empty reason '${mapping.emptyReason}'.`);
        }
        if (mapping.status === "partially_available" && mapping.emptyReason !== null) {
            throw new Error("Partially available source must use limitations, not emptyReason.");
        }
    }
    if (contract.streamingPolicy.asyncOperationsBetweenFinalObservationAndSnapshot !== 0) {
        throw new Error("The final source observation must be followed by synchronous snapshot construction.");
    }
    if (
        contract.streamingPolicy.sourceValidationLinearizationPoint
            !== "final_successful_root_bound_path_identity_observation"
        || contract.streamingPolicy.sourceAuthority !== "current_at_final_observation"
        || contract.streamingPolicy.responseAtomicityClaim !== "per_domain_authority_only"
    ) {
        throw new Error("Source linearization must not imply a globally atomic response.");
    }
    const sourceAuthority = contract.sourceAuthorityContract;
    const sourceContinuationDomains = contract.continuationDomains.sourceBySpanResolution;
    if (
        !sourceAuthority.excerptRequirements.allowedSpanResolution.includes("current_symbol_validated")
        || !sourceAuthority.excerptRequirements.allowedSpanResolution.includes("index_snapshot_matched")
        || sourceAuthority.changedSourceWithoutStructuralReresolution.sourceExcerpts !== 0
        || !sourceContinuationDomains.current_symbol_validated
            .includes("spanResolutionPolicyVersion")
        || !sourceContinuationDomains.current_symbol_validated
            .includes("extractorLanguageImplementationVersion")
        || !sourceContinuationDomains.current_symbol_validated
            .includes("currentSpanIdentity")
        || !sourceContinuationDomains.index_snapshot_matched.includes("indexedSourceIdentity")
        || contract.continuationDomains.allowedCurrentSpanResolutionDerivations
            .includes("not_applicable_identity_match")
        || contract.continuationDomains.currentSpanIdentityVariants.tagField !== "kind"
        || contract.continuationDomains.derivationIdentityVariant
            .exact_registry_rebuild_match !== "resolved_symbol_instance"
        || contract.continuationDomains.derivationIdentityVariant
            .language_structural_reresolution !== "canonical_structural_identity"
    ) {
        throw new Error("Current source excerpts must also have a currently valid symbol span.");
    }
    if (contract.fileIdentityContract.traversalContinuityClaimedWithoutTraversalIdentity !== false) {
        throw new Error("Final-target identity must not imply traversal continuity.");
    }
    const strengthPolicy = contract.fileIdentityContract.strengthPolicy;
    if (
        strengthPolicy?.strong?.publishInspectedSource !== true
        || strengthPolicy?.target_only?.publishInspectedSource !== true
        || strengthPolicy?.unsupported?.publishInspectedSource !== false
    ) {
        throw new Error("File-identity publication policy is not frozen for every strength.");
    }
    if (!contract.fileIdentityContract.internalSafetyFailures.includes("root_binding_invalid")) {
        throw new Error("Root-binding failures must retain a distinct internal classification.");
    }
    const sourceIoMetrics = new Set(contract.evaluation.sourceIoMetrics);
    const sourceProcessingMetrics = new Set(contract.evaluation.sourceProcessingMetrics);
    const sourceAccounting = contract.evaluation.symmetricSourceAccounting;
    if (
        !sourceIoMetrics.has("bytesObtained")
        || !sourceIoMetrics.has("readOperationCount")
        || !sourceProcessingMetrics.has("inputBytesProcessed")
        || sourceIoMetrics.has("inputBytesProcessed")
        || sourceProcessingMetrics.has("bytesObtained")
    ) {
        throw new Error("Source I/O and downstream processing metrics must remain separate.");
    }
    if (
        contract.evaluation.releaseGates.maximumPortableSourceBytesObtainedIncrease !== 0.2
        || sourceAccounting.alternateFileHelperBypassAllowed !== false
        || sourceAccounting.measurementBasisRequired !== true
        || sourceAccounting.observationIdRequired !== true
        || sourceAccounting.readIdRequired !== true
        || sourceAccounting.oneAcquisitionBasisPerObservation !== true
        || sourceAccounting.bytesObtainedEqualsRangeLength !== true
        || sourceAccounting.descriptorAndWrappingStreamDoubleRecordingAllowed !== false
        || sourceAccounting.portableIoAggregation
            !== "unique_non_overlapping_ranges_per_observationId"
        || sourceAccounting.overlappingRetriesInflatePortableIo !== false
        || sourceAccounting.processingBytesExcludedFromPortableIoGate !== true
        || sourceAccounting.mmapEstimateExcludedFromPortableIoGate !== true
        || sourceAccounting.portableIoGateMetric
            !== "total_SourceIoMetric.bytesObtained_per_completed_task"
        || sourceAccounting.ioMeasurementBases.includes("mmap_estimate")
        || sourceAccounting.processingOwnersMayOpenSourceDirectly !== false
        || sourceAccounting.processingOwnersRequireExistingObservationId !== true
    ) {
        throw new Error("Portable source-I/O accounting and its release gate are not frozen.");
    }
    const continuationHandles = contract.continuationHandles;
    if (
        continuationHandles.topLevelFingerprintAllowed !== false
        || continuationHandles.oneFingerprintPerHandle !== true
        || continuationHandles.kinds.caller_page.cursor !== "deterministic_last_edge_key"
        || continuationHandles.relationshipPaging.effectivePageSizeIncludedInFingerprint !== false
        || continuationHandles.relationshipPaging.resumePosition !== "strictly_after_cursor"
        || continuationHandles.relationshipPaging.invalidCursorCode
            !== "INVALID_RELATIONSHIP_CONTINUATION"
        || continuationHandles.relationshipPaging.consecutivePageInvariant
            !== "no_duplicate_or_missing_edges"
        || continuationHandles.relationshipPaging.nextCursorDerivation
            !== "final_returned_edge_under_frozen_ordering"
        || !continuationHandles.relationshipPaging.cursorScope.includes("relationshipManifest")
        || !continuationHandles.relationshipPaging.cursorScope.includes("projectionPolicyVersion")
        || continuationHandles.relationshipPaging.cursorFormatVersion !== 1
        || continuationHandles.relationshipPaging.maximumSerializedCursorBytes !== 1024
        || continuationHandles.relationshipPaging.opaqueCursorAuthentication !== "hmac_sha256"
        || continuationHandles.relationshipPaging.plainCursorCanonicalSerialization
            !== "canonical_json_v1"
        || continuationHandles.relationshipPaging.echoCursorInErrorsOrDiagnostics !== false
        || contract.continuationDomains.staticRelationships.includes("effectiveEdgeLimit")
    ) {
        throw new Error("Continuations must use independent handles and stable relationship traversal identity.");
    }
    const v2OutcomeContract = contract.v2OutcomeContract;
    if (
        v2OutcomeContract.commonErrorPrefix.formatVersion !== 2
        || v2OutcomeContract.commonErrorPrefix.kind !== "symbol_context"
        || v2OutcomeContract.commonErrorPrefix.status !== "error"
        || v2OutcomeContract.maximumSerializedErrorBytes !== contract.limits.v2ErrorLimitBytes
        || v2OutcomeContract.boundedCallerEchoBytes !== 0
    ) {
        throw new Error("Accepted V2 errors must share a bounded structured transport prefix.");
    }
    const fixtureIds = new Set();
    const fixtureDigests = {};
    for (const fixture of contract.fixtures) {
        if (fixtureIds.has(fixture.id)) throw new Error(`Duplicate fixture id '${fixture.id}'.`);
        fixtureIds.add(fixture.id);
        const source = materializeFixture(fixture);
        if (source === null) continue;
        fixtureDigests[fixture.id] = {
            sha256: sha256(source),
            bytes: Buffer.byteLength(source),
            lines: source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
        };
        for (const anchor of fixture.anchors ?? []) {
            const actualLine = source.split("\n")[anchor.line - 1];
            if (actualLine !== anchor.text) {
                throw new Error(`${fixture.id} anchor ${anchor.line} did not materialize exactly.`);
            }
        }
    }
    for (const requiredFixtureId of contract.requiredFixtureIds) {
        if (!fixtureIds.has(requiredFixtureId)) {
            throw new Error(`Missing required fixture '${requiredFixtureId}'.`);
        }
    }
    const failureFixture = contract.fixtures.find((fixture) => (
        fixture.id === "source-failure-reasons"
    ));
    if (JSON.stringify(failureFixture?.expectedReasons) !== JSON.stringify(contract.sourceFailureReasons)) {
        throw new Error("Source failure fixture does not match the frozen reason set.");
    }
    const unsupportedLanguage = contract.fixtures.find((fixture) => (
        fixture.id === "unsupported-language-capabilities"
    ));
    if (
        unsupportedLanguage?.expected?.sourceStatus !== "available"
        || unsupportedLanguage.expected.syntaxBoundaries !== "unsupported_language"
    ) {
        throw new Error("Unsupported language must preserve readable source and report capability loss.");
    }
    const atomicReplacement = contract.fixtures.find((fixture) => (
        fixture.id === "atomic-path-replacement-during-inspection"
    ));
    if (
        atomicReplacement?.expected?.emptyReason !== "path_identity_changed_during_inspection"
        || atomicReplacement.expected.sourcePublication !== "rejected"
    ) {
        throw new Error("Atomic path replacement must reject stale descriptor source.");
    }
    const postLinearizationMutation = contract.fixtures.find((fixture) => (
        fixture.id === "mutation-after-source-linearization"
    ));
    if (
        postLinearizationMutation?.expected?.sourceAuthority !== "current_at_final_observation"
        || postLinearizationMutation.expected.responseSnapshotValidity !== "preserved"
        || postLinearizationMutation.expected.globalAtomicityClaim !== false
    ) {
        throw new Error("Post-linearization mutation semantics are not frozen.");
    }
    const independentContinuations = contract.fixtures.find((fixture) => (
        fixture.id === "independent-continuation-handles"
    ));
    if (
        independentContinuations?.expected?.topLevelFingerprint !== false
        || independentContinuations.expected.pageSizeChangesTraversalIdentity !== false
    ) {
        throw new Error("Independent continuation-handle behavior is not frozen.");
    }
    const cursorValidation = contract.fixtures.find((fixture) => (
        fixture.id === "relationship-cursor-validation"
    ));
    const cursorCases = new Map(cursorValidation?.cases?.map((entry) => (
        [entry.case, entry.expected]
    )));
    if (
        cursorCases.get("malformed_cursor") !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("caller_cursor_used_for_callees")
            !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("cursor_from_another_relationship_kind")
            !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("non_member_cursor") !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("valid_page_size_change")
            !== "accepted_same_traversal_identity"
        || cursorCases.get("consecutive_pages") !== "no_duplicate_or_missing_edges"
        || cursorCases.get("next_cursor")
            !== "derived_from_final_returned_edge_under_frozen_ordering"
        || cursorCases.get("oversized_cursor") !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("unsupported_cursor_format_version")
            !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("non_canonical_plain_cursor")
            !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("opaque_cursor_authentication_failure")
            !== "INVALID_RELATIONSHIP_CONTINUATION"
        || cursorCases.get("end_of_traversal") !== "explicit_terminal_state"
    ) {
        throw new Error("Relationship cursor validation vectors are incomplete.");
    }
    const unresolvedCurrentSpan = contract.fixtures.find((fixture) => (
        fixture.id === "changed-source-unresolved-symbol-span"
    ));
    if (
        unresolvedCurrentSpan?.expected?.spanResolution !== "unavailable"
        || unresolvedCurrentSpan.expected.sourceExcerpts !== 0
    ) {
        throw new Error("Changed source without structural re-resolution must not use an index-time span.");
    }
    const resolutionPolicyMutation = contract.fixtures.find((fixture) => (
        fixture.id === "current-span-resolution-policy-mutation"
    ));
    const allowedDerivations = contract.continuationDomains.allowedCurrentSpanResolutionDerivations;
    if (
        resolutionPolicyMutation?.expected?.currentSymbolContinuation !== "stale"
        || !resolutionPolicyMutation.expected.requiredIdentityFields
            .includes("extractorLanguageImplementationVersion")
        || !resolutionPolicyMutation.expected.requiredIdentityFields
            .includes("resolutionDerivation")
        || JSON.stringify(resolutionPolicyMutation.expected.allowedDerivations)
            !== JSON.stringify(allowedDerivations)
    ) {
        throw new Error("Current-span derivation identity is not frozen.");
    }
    const rootBindingInvalid = contract.fixtures.find((fixture) => (
        fixture.id === "root-binding-invalid"
    ));
    if (
        rootBindingInvalid?.expected?.internalFailure !== "root_binding_invalid"
        || rootBindingInvalid.expected.isError !== true
        || rootBindingInvalid.expected.errorCode !== "ROOT_BINDING_INVALID"
        || rootBindingInvalid.expected.failClosed !== true
        || rootBindingInvalid.expected.unsafePathEchoed !== false
    ) {
        throw new Error("Root-binding failure behavior is not frozen.");
    }
    const resourceLimit = contract.fixtures.find((fixture) => (
        fixture.id === "minimum-envelope-resource-limit"
    ));
    if (
        resourceLimit?.expected?.status !== "error"
        || resourceLimit.expected.code !== "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT"
    ) {
        throw new Error("Resource-limit errors must use the common V2 error status.");
    }
    const exactlyOnceIo = contract.fixtures.find((fixture) => (
        fixture.id === "source-io-exactly-once"
    ));
    if (
        exactlyOnceIo?.expected?.acquisitionBasesPerObservation !== 1
        || exactlyOnceIo.expected.descriptorAndWrappingStreamBothCounted !== false
        || exactlyOnceIo.expected.processingContributesToPortableIo !== false
        || exactlyOnceIo.expected.processingOwnersOpenSourceDirectly !== false
    ) {
        throw new Error("Exactly-once portable source acquisition is not frozen.");
    }
    const staleSites = contract.fixtures.find((fixture) => fixture.id === "stale-relationship-sites");
    const failedDynamic = contract.fixtures.find((fixture) => fixture.id === "failed-dynamic-edge-source");
    if (
        staleSites?.expected?.siteCoordinatesCurrent !== false
        || failedDynamic?.expected?.dynamicEdge !== "suppressed"
    ) {
        throw new Error("Relationship site and dynamic-edge failure behavior is not frozen.");
    }
    if (JSON.stringify(fixtureDigests) !== JSON.stringify(contract.materializedFixtureDigests)) {
        throw new Error("Materialized fixture digests do not match the frozen manifest.");
    }
    return {
        fixtureId: contract.fixtureId,
        contractSha256: sha256(`${JSON.stringify(contract)}\n`),
        fixtureDigests,
    };
}

export function loadPhase0Contract(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}
