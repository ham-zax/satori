import { isRepositoryRelativePath } from '../paths/repository-path';
import {
    RESOLUTION_CALL_CONSTRUCTS,
    isResolutionAuthority,
    resolutionAuthorityForProof,
    type ResolutionCallObservation,
    type ResolutionClaim,
    type ResolutionProofStep,
} from './resolution';

const RESOLUTION_DECISIONS = new Set(['resolved', 'unresolved', 'ambiguous']);
const RESOLUTION_PROOF_STEP_KINDS = new Set([
    'call_site',
    'containing_caller',
    'absolute_import',
    'relative_import',
    'same_file_definition',
    'constructor_origin',
    'parameter_annotation',
    'package_binding',
    'receiver_type_binding',
    'exact_target_definition',
    'allocation_origin',
    'field_origin',
    'callback_origin',
    'class_inheritance',
    'flow_hop',
    'candidate_set',
    'ambiguity',
    'unresolved_dependency',
]);
const RESOLUTION_CALL_CONSTRUCT_SET = new Set<string>(RESOLUTION_CALL_CONSTRUCTS);
const ORIGIN_FLOW_PROOF_KINDS = new Set([
    'flow_hop',
    'callback_origin',
    'allocation_origin',
    'field_origin',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
    return value === undefined || isNonEmptyString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 1;
}

function isSourceSpan(value: unknown): boolean {
    if (!isRecord(value)
        || !isPositiveInteger(value.startLine)
        || !isPositiveInteger(value.endLine)
        || value.endLine < value.startLine) {
        return false;
    }
    for (const field of ['startByte', 'endByte', 'startColumn', 'endColumn']) {
        if (!isNonNegativeInteger(value[field])) return false;
    }
    return Number(value.endByte) >= Number(value.startByte)
        && (value.startLine !== value.endLine || Number(value.endColumn) >= Number(value.startColumn));
}

export function isResolutionCallObservation(value: unknown): value is ResolutionCallObservation {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'kind',
            'calleeName',
            'calleeText',
            'receiverText',
            'receiverType',
            'construct',
            'candidates',
        ])
        || value.kind !== 'call'
        || !isNonEmptyString(value.calleeName)
        || !isNonEmptyString(value.calleeText)
        || !isOptionalNonEmptyString(value.receiverText)
        || !isOptionalNonEmptyString(value.receiverType)
        || typeof value.construct !== 'string'
        || !RESOLUTION_CALL_CONSTRUCT_SET.has(value.construct)
        || !Array.isArray(value.candidates)) {
        return false;
    }
    return value.candidates.every((candidate) => (
        isRecord(candidate)
        && hasOnlyKeys(candidate, ['file', 'span', 'name', 'qualifiedName', 'symbolInstanceId'])
        && isRepositoryRelativePath(candidate.file)
        && isSourceSpan(candidate.span)
        && isNonEmptyString(candidate.name)
        && isOptionalNonEmptyString(candidate.qualifiedName)
        && isOptionalNonEmptyString(candidate.symbolInstanceId)
    ));
}

export function isResolutionProofStep(value: unknown): value is ResolutionProofStep {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['kind', 'subject', 'detail', 'span', 'hop'])
        || typeof value.kind !== 'string'
        || !RESOLUTION_PROOF_STEP_KINDS.has(value.kind)
        || !isNonEmptyString(value.subject)
        || !isOptionalNonEmptyString(value.detail)
        || (value.span !== undefined && !isSourceSpan(value.span))
        || (value.hop !== undefined && !isNonNegativeInteger(value.hop))) {
        return false;
    }
    return true;
}

export function isCanonicalResolutionClaim(value: unknown): value is ResolutionClaim {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'providerId',
            'providerVersion',
            'environmentConfigId',
            'sourceFile',
            'sourceInstanceId',
            'targetInstanceId',
            'targetSymbol',
            'callSpan',
            'observation',
            'decision',
            'relationshipType',
            'resolutionAuthority',
            'proofSteps',
            'dependencyKeys',
            'flowHops',
        ])
        || !isNonEmptyString(value.providerId)
        || !isNonEmptyString(value.providerVersion)
        || !isNonEmptyString(value.environmentConfigId)
        || !isRepositoryRelativePath(value.sourceFile)
        || !isOptionalNonEmptyString(value.sourceInstanceId)
        || !isOptionalNonEmptyString(value.targetInstanceId)
        || !isOptionalNonEmptyString(value.targetSymbol)
        || !isSourceSpan(value.callSpan)
        || !isResolutionCallObservation(value.observation)
        || typeof value.decision !== 'string'
        || !RESOLUTION_DECISIONS.has(value.decision)
        || (value.relationshipType !== 'CALLS' && value.relationshipType !== 'REFERENCES')
        || !isResolutionAuthority(value.resolutionAuthority)
        || !Array.isArray(value.proofSteps)
        || value.proofSteps.length === 0
        || !value.proofSteps.every(isResolutionProofStep)
        || !Array.isArray(value.dependencyKeys)
        || !value.dependencyKeys.every(isNonEmptyString)
        || !isNonNegativeInteger(value.flowHops)) {
        return false;
    }

    if (value.decision === 'resolved') {
        if (
            value.relationshipType !== 'CALLS'
            || !isNonEmptyString(value.sourceInstanceId)
            || !isNonEmptyString(value.targetInstanceId)
            || !isNonEmptyString(value.targetSymbol)
            || (value.resolutionAuthority !== 'direct_binding' && value.resolutionAuthority !== 'origin_flow')
        ) {
            return false;
        }

        const derivedAuthority = resolutionAuthorityForProof({
            decision: value.decision,
            proofSteps: value.proofSteps,
            flowHops: value.flowHops,
        });
        if (derivedAuthority !== value.resolutionAuthority) return false;

        if (
            value.resolutionAuthority === 'origin_flow'
            && !value.proofSteps.some((step) => ORIGIN_FLOW_PROOF_KINDS.has(step.kind))
        ) {
            return false;
        }
        return true;
    }

    return value.relationshipType === 'REFERENCES'
        && value.dependencyKeys.length > 0
        && value.targetInstanceId === undefined
        && value.targetSymbol === undefined
        && (value.resolutionAuthority === 'ambiguous'
            || value.resolutionAuthority === 'unresolved'
            || value.resolutionAuthority === 'unsupported'
            || value.resolutionAuthority === 'heuristic_reference');
}
