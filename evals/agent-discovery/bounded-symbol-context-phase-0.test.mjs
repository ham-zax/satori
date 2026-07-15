import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    loadPhase0Contract,
    materializeFixture,
    validatePhase0Contract,
} from "./bounded-symbol-context-corpus.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_FILE = path.join(TEST_DIR, "bounded-symbol-context-phase-0.json");

test("bounded symbol-context Phase 0 contract is deterministic and internally consistent", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const first = validatePhase0Contract(contract);
    const second = validatePhase0Contract(loadPhase0Contract(CONTRACT_FILE));

    assert.deepEqual(first, second);
    assert.match(first.contractSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.keys(first.fixtureDigests).length, 8);
    assert.equal(first.fixtureDigests["huge-single-line-typescript"].bytes, 840000);
    assert.equal(first.fixtureDigests["huge-single-line-typescript"].lines, 1);
    assert.ok(
        first.fixtureDigests["large-below-inspection-limit-typescript"].bytes >= 131072,
    );
});

test("Phase 0 freezes future acceptance without requiring production behavior", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);

    assert.equal(contract.phase0.boundedContextProductChangesAllowed, false);
    assert.equal(contract.phase0.measurementInstrumentationChangesAllowed, true);
    assert.equal(
        contract.phase0.acceptanceSpecifications.runtimeAssertionsRequiredInPhase0,
        false,
    );
    assert.equal(contract.phase0.acceptanceSpecifications.completeMatrixRequiredInPhase, 6);
    assert.equal(
        contract.baselineIdentityContract.historicalProductBaseline
            .eligibleForLatencyAndSourceCostComparison,
        false,
    );
    assert.equal(
        contract.baselineIdentityContract.instrumentedMeasurementBaseline
            .eligibleForLatencyAndSourceCostComparison,
        true,
    );
    assert.equal(
        contract.baselineIdentityContract.candidateMustUseSameInstrumentationImplementation,
        true,
    );
});

test("large fixtures preserve beginning, middle, end, repeated-branch, and Python evidence", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const byId = new Map(contract.fixtures.map((fixture) => [fixture.id, fixture]));
    const cases = [
        ["large-relevant-beginning-typescript", 41],
        ["large-relevant-middle-typescript", 612],
        ["large-relevant-end-typescript", 1162],
        ["repeated-branches-remote-call-typescript", 840],
        ["multi-exit-exception-python", 861],
    ];

    for (const [fixtureId, expectedLine] of cases) {
        const fixture = byId.get(fixtureId);
        assert.ok(fixture, fixtureId);
        const source = materializeFixture(fixture);
        assert.equal(source.split("\n")[expectedLine - 1], (
            fixture.anchors.find((anchor) => anchor.line === expectedLine).text
        ));
        assert.equal(fixture.expected.queryAnchorLine, expectedLine);
    }
});

test("historical exact-open capture is full-span plain source, not a v2 package", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const historical = contract.historicalExactOpen;
    const text = historical.normalizedResponse.content[0].text;

    assert.equal(historical.request.open_symbol.contractVersion, undefined);
    assert.equal(text, historical.source.trimEnd());
    assert.equal(historical.normalizedResponse.formatVersion, undefined);
    assert.equal(historical.normalizedResponse.kind, undefined);
});

test("emergency error projection is fixed and bounded", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const projection = {
        formatVersion: 2,
        kind: "symbol_context",
        status: "error",
        code: "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT",
        reason: "minimum_safe_package_exceeds_limit",
        symbolId: "s".repeat(160),
        minimumRequiredResponseBytes: 40000,
        hardResponseLimitBytes: contract.limits.hardResponseLimitBytes,
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(projection));

    assert.deepEqual(
        Object.keys(projection),
        contract.emergencyError.mandatoryFields,
    );
    assert.ok(serializedBytes <= contract.limits.emergencyErrorLimitBytes);
    for (const forbidden of contract.emergencyError.forbiddenFields) {
        assert.equal(Object.hasOwn(projection, forbidden), false);
    }
});

test("source failure, language capability loss, and mutation continuations stay distinct", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const byId = new Map(contract.fixtures.map((fixture) => [fixture.id, fixture]));
    const unsupported = byId.get("unsupported-language-capabilities").expected;
    const descriptorMutation = byId.get("descriptor-mutation-during-inspection").expected;
    const pathReplacement = byId.get("atomic-path-replacement-during-inspection").expected;

    assert.equal(contract.sourceFailureReasons.includes("language_selection_unsupported"), false);
    assert.equal(unsupported.sourceStatus, "available");
    assert.equal(unsupported.localLexical, "available");
    assert.equal(unsupported.syntaxBoundaries, "unsupported_language");
    for (const staleSource of [descriptorMutation, pathReplacement]) {
        assert.equal(staleSource.sourceStatus, "stale");
        assert.equal(staleSource.sourceExcerpts, 0);
        assert.equal(staleSource.sourceContinuation, "unavailable");
        assert.equal(staleSource.continuationReason, "fresh_resolution_required");
    }
});

test("file identity, source linearization, source mappings, and site authority are frozen", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const byId = new Map(contract.fixtures.map((fixture) => [fixture.id, fixture]));
    const sourceValidationOrder = contract.streamingPolicy.sourceValidationOrder;

    assert.deepEqual(contract.fileIdentityContract.strengths, [
        "strong",
        "target_only",
        "unsupported",
    ]);
    assert.equal(
        contract.fileIdentityContract.traversalContinuityClaimedWithoutTraversalIdentity,
        false,
    );
    assert.equal(
        contract.fileIdentityContract.strengthPolicy.strong.publishInspectedSource,
        true,
    );
    assert.equal(
        contract.fileIdentityContract.strengthPolicy.target_only.publishInspectedSource,
        true,
    );
    assert.equal(
        contract.fileIdentityContract.strengthPolicy.unsupported.publishInspectedSource,
        false,
    );
    assert.equal(
        sourceValidationOrder.at(-2),
        "observe_final_root_confined_path_to_descriptor_identity",
    );
    assert.equal(sourceValidationOrder.at(-1), "construct_immutable_response_snapshot");
    assert.equal(
        contract.streamingPolicy.sourceValidationLinearizationPoint,
        "final_successful_root_bound_path_identity_observation",
    );
    assert.equal(contract.streamingPolicy.sourceAuthority, "current_at_final_observation");
    assert.equal(contract.streamingPolicy.responseAtomicityClaim, "per_domain_authority_only");
    assert.equal(contract.streamingPolicy.asyncOperationsBetweenFinalObservationAndSnapshot, 0);

    const partiallyAvailable = contract.sourceStatusReasonMapping.find((entry) => (
        entry.status === "partially_available"
    ));
    assert.equal(partiallyAvailable.emptyReason, null);
    assert.equal(partiallyAvailable.limitation, "line_exceeds_excerpt_limit");

    assert.equal(
        byId.get("stale-relationship-sites").expected.siteCoordinatesCurrent,
        false,
    );
    assert.equal(byId.get("failed-dynamic-edge-source").expected.dynamicEdge, "suppressed");
    assert.equal(byId.get("unsupported-path-identity").expected.sourcePublication, "rejected");
    assert.equal(
        byId.get("mutation-after-source-linearization").expected.globalAtomicityClaim,
        false,
    );
    assert.equal(byId.get("root-binding-invalid").expected.failClosed, true);
    assert.equal(byId.get("root-binding-invalid").expected.errorCode, "ROOT_BINDING_INVALID");
    assert.equal(byId.get("root-binding-invalid").expected.unsafePathEchoed, false);
});

test("continuation handles, source authority, and accepted V2 outcomes are independent", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const byId = new Map(contract.fixtures.map((fixture) => [fixture.id, fixture]));
    const handles = contract.continuationHandles;
    const authority = contract.sourceAuthorityContract;
    const outcomes = new Map(contract.v2OutcomeContract.outcomes.map((entry) => (
        [entry.outcome, entry]
    )));

    assert.equal(handles.topLevelFingerprintAllowed, false);
    assert.deepEqual(handles.kinds.source_range.domains, ["symbol", "source"]);
    assert.deepEqual(handles.kinds.caller_page.domains, ["symbol", "relationships"]);
    assert.equal(handles.kinds.caller_page.cursor, "deterministic_last_edge_key");
    assert.equal(handles.relationshipPaging.effectivePageSizeIncludedInFingerprint, false);
    assert.equal(handles.relationshipPaging.resumePosition, "strictly_after_cursor");
    assert.equal(
        handles.relationshipPaging.invalidCursorCode,
        "INVALID_RELATIONSHIP_CONTINUATION",
    );
    assert.equal(handles.relationshipPaging.cursorScope.includes("relationshipManifest"), true);
    assert.equal(handles.relationshipPaging.cursorScope.includes("projectionPolicyVersion"), true);
    assert.equal(
        handles.relationshipPaging.nextCursorDerivation,
        "final_returned_edge_under_frozen_ordering",
    );
    assert.equal(handles.relationshipPaging.cursorFormatVersion, 1);
    assert.equal(handles.relationshipPaging.maximumSerializedCursorBytes, 1024);
    assert.equal(handles.relationshipPaging.opaqueCursorAuthentication, "hmac_sha256");
    assert.equal(handles.relationshipPaging.echoCursorInErrorsOrDiagnostics, false);
    assert.equal(contract.continuationDomains.staticRelationships.includes("effectiveEdgeLimit"), false);

    assert.deepEqual(authority.excerptRequirements.allowedSpanResolution, [
        "current_symbol_validated",
        "index_snapshot_matched",
    ]);
    assert.equal(
        byId.get("changed-source-unresolved-symbol-span").expected.sourceExcerpts,
        0,
    );
    assert.equal(
        contract.continuationDomains.sourceBySpanResolution.current_symbol_validated.includes(
            "extractorLanguageImplementationVersion",
        ),
        true,
    );
    assert.equal(
        contract.continuationDomains.sourceBySpanResolution.current_symbol_validated.includes(
            "currentSpanIdentity",
        ),
        true,
    );
    assert.equal(
        contract.continuationDomains.allowedCurrentSpanResolutionDerivations.includes(
            "not_applicable_identity_match",
        ),
        false,
    );
    assert.equal(contract.continuationDomains.currentSpanIdentityVariants.tagField, "kind");
    assert.equal(
        contract.continuationDomains.derivationIdentityVariant.exact_registry_rebuild_match,
        "resolved_symbol_instance",
    );
    const cursorCases = new Map(byId.get("relationship-cursor-validation").cases.map((entry) => (
        [entry.case, entry.expected]
    )));
    assert.equal(
        cursorCases.get("caller_cursor_used_for_callees"),
        "INVALID_RELATIONSHIP_CONTINUATION",
    );
    assert.equal(
        cursorCases.get("cursor_from_another_relationship_kind"),
        "INVALID_RELATIONSHIP_CONTINUATION",
    );
    assert.equal(cursorCases.get("non_member_cursor"), "INVALID_RELATIONSHIP_CONTINUATION");
    assert.equal(cursorCases.get("valid_page_size_change"), "accepted_same_traversal_identity");
    assert.equal(cursorCases.get("consecutive_pages"), "no_duplicate_or_missing_edges");
    assert.equal(
        cursorCases.get("next_cursor"),
        "derived_from_final_returned_edge_under_frozen_ordering",
    );
    assert.equal(cursorCases.get("oversized_cursor"), "INVALID_RELATIONSHIP_CONTINUATION");
    assert.equal(
        cursorCases.get("non_canonical_plain_cursor"),
        "INVALID_RELATIONSHIP_CONTINUATION",
    );
    assert.equal(
        byId.get("current-span-resolution-policy-mutation").expected.currentSymbolContinuation,
        "stale",
    );

    assert.equal(outcomes.get("source_unavailable_identity_valid").isError, false);
    assert.equal(outcomes.get("stale_continuation").code, "STALE_CONTINUATION");
    assert.equal(outcomes.get("root_binding_invalid").code, "ROOT_BINDING_INVALID");
    assert.deepEqual(contract.v2OutcomeContract.commonErrorPrefix, {
        formatVersion: 2,
        kind: "symbol_context",
        status: "error",
    });
});

test("source I/O and downstream processing accounting cannot double-count bytes", () => {
    const contract = loadPhase0Contract(CONTRACT_FILE);
    const accounting = contract.evaluation.symmetricSourceAccounting;
    const byId = new Map(contract.fixtures.map((fixture) => [fixture.id, fixture]));

    assert.equal(
        contract.evaluation.releaseGates.maximumPortableSourceBytesObtainedIncrease,
        0.2,
    );
    assert.equal(contract.evaluation.sourceIoMetrics.includes("bytesObtained"), true);
    assert.equal(contract.evaluation.sourceIoMetrics.includes("readOperationCount"), true);
    assert.equal(contract.evaluation.sourceIoMetrics.includes("inputBytesProcessed"), false);
    assert.equal(contract.evaluation.sourceProcessingMetrics.includes("inputBytesProcessed"), true);
    assert.equal(contract.evaluation.sourceProcessingMetrics.includes("bytesObtained"), false);
    assert.deepEqual(accounting.ioOwners, [
        "validation",
        "outline",
        "graph_site",
        "search_evidence",
        "continuation",
    ]);
    assert.deepEqual(accounting.processingOwners, [
        "hashing",
        "selector",
        "parser",
        "extractor",
        "graph_site",
        "search_evidence",
    ]);
    assert.equal(accounting.observationIdRequired, true);
    assert.equal(accounting.readIdRequired, true);
    assert.equal(accounting.oneAcquisitionBasisPerObservation, true);
    assert.equal(accounting.bytesObtainedEqualsRangeLength, true);
    assert.equal(accounting.descriptorAndWrappingStreamDoubleRecordingAllowed, false);
    assert.equal(
        accounting.portableIoAggregation,
        "unique_non_overlapping_ranges_per_observationId",
    );
    assert.equal(accounting.overlappingRetriesInflatePortableIo, false);
    assert.equal(accounting.measurementBasisRequired, true);
    assert.equal(accounting.alternateFileHelperBypassAllowed, false);
    assert.equal(accounting.processingBytesExcludedFromPortableIoGate, true);
    assert.equal(accounting.mmapEstimateExcludedFromPortableIoGate, true);
    assert.equal(
        accounting.portableIoGateMetric,
        "total_SourceIoMetric.bytesObtained_per_completed_task",
    );
    assert.equal(accounting.ioMeasurementBases.includes("mmap_estimate"), false);
    assert.equal(accounting.processingOwnersMayOpenSourceDirectly, false);
    assert.equal(accounting.processingOwnersRequireExistingObservationId, true);
    assert.equal(accounting.osPhysicalIoUsedAsPortableGate, false);
    assert.equal(
        byId.get("source-io-exactly-once").expected.descriptorAndWrappingStreamBothCounted,
        false,
    );
});
