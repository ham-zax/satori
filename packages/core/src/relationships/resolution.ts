import type { SourceSpan } from '../language-analysis';

/** Stable semantic configuration identity; publication generations are not part of it. */
export const PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID = 'python-native-resolution-v1';
export const NATIVE_PYTHON_PROVIDER_ID = 'satori-native-python';
export const NATIVE_PYTHON_PROVIDER_VERSION = 'bounded-origin-v1';
/**
 * A flow hop is one bounded value-origin transfer across an allocation,
 * field, or callback/parameter boundary. Constructor origins and direct
 * symbol/import evidence start at zero; syntactic member selection and class
 * inheritance do not increment the count. Every increment is represented by
 * one ordered `flow_hop` proof step, and claims above this bound abstain.
 */
export const MAX_PYTHON_FLOW_HOPS = 6;

export type ResolutionDecision = 'resolved' | 'unresolved' | 'ambiguous';

export const RESOLUTION_AUTHORITIES = [
    'direct_binding',
    'origin_flow',
    'heuristic_reference',
    'ambiguous',
    'unresolved',
    'unsupported',
] as const;

export type ResolutionAuthority = typeof RESOLUTION_AUTHORITIES[number];

const RESOLUTION_AUTHORITY_SET = new Set<string>(RESOLUTION_AUTHORITIES);

export function isResolutionAuthority(value: unknown): value is ResolutionAuthority {
    return typeof value === 'string' && RESOLUTION_AUTHORITY_SET.has(value);
}

/**
 * A CALLS edge independently proven by the resolver. These records may carry
 * low traversal confidence because confidence and proof authority encode
 * different facts; consumers that require exact binding can admit only this
 * narrow low-confidence subset.
 */
export function isProofBackedAuthoritativeCall(input: {
    type: string;
    resolutionAuthority?: ResolutionAuthority;
}): boolean {
    return input.type === 'CALLS'
        && (input.resolutionAuthority === 'direct_binding'
            || input.resolutionAuthority === 'origin_flow');
}

export function resolutionAuthorityForProof(input: {
    decision: ResolutionDecision;
    proofSteps: readonly ResolutionProofStep[];
    flowHops: number;
}): ResolutionAuthority {
    if (input.decision === 'ambiguous') return 'ambiguous';
    if (input.decision === 'unresolved') return 'unresolved';
    if (input.flowHops > 0 || input.proofSteps.some((step) => (
        step.kind === 'flow_hop'
        || step.kind === 'callback_origin'
        || step.kind === 'allocation_origin'
        || step.kind === 'field_origin'
    ))) {
        return 'origin_flow';
    }
    if (input.proofSteps.some((step) => (
        step.kind === 'absolute_import'
        || step.kind === 'relative_import'
        || step.kind === 'same_file_definition'
        || step.kind === 'constructor_origin'
        || step.kind === 'parameter_annotation'
        || step.kind === 'package_binding'
        || step.kind === 'receiver_type_binding'
        || step.kind === 'exact_target_definition'
    ))) {
        return 'direct_binding';
    }
    return 'heuristic_reference';
}

export type ResolutionProofStepKind =
    | 'call_site'
    | 'containing_caller'
    | 'absolute_import'
    | 'relative_import'
    | 'same_file_definition'
    | 'constructor_origin'
    | 'parameter_annotation'
    | 'package_binding'
    | 'receiver_type_binding'
    | 'exact_target_definition'
    | 'allocation_origin'
    | 'field_origin'
    | 'callback_origin'
    | 'class_inheritance'
    | 'flow_hop'
    | 'candidate_set'
    | 'ambiguity'
    | 'unresolved_dependency';


export interface ResolutionProofStep {
    readonly kind: ResolutionProofStepKind;
    readonly subject: string;
    readonly detail?: string;
    readonly span?: SourceSpan;
    /** One-based flow hop number for flow_hop steps. */
    readonly hop?: number;
}

/**
 * Provider-neutral evidence. A provider proposes identity; Satori validates
 * spans/snapshots and decides whether a relationship is publishable.
 */
export interface ResolutionClaim {
    readonly providerId: string;
    readonly providerVersion: string;
    readonly environmentConfigId: string;
    readonly sourceFile: string;
    readonly sourceInstanceId?: string;
    readonly targetInstanceId?: string;
    readonly targetSymbol?: string;
    readonly callSpan: SourceSpan;
    readonly decision: ResolutionDecision;
    readonly relationshipType: 'CALLS' | 'REFERENCES';
    /** Categorical proof authority; publication must not infer this from locality. */
    readonly resolutionAuthority: ResolutionAuthority;
    readonly proofSteps: readonly ResolutionProofStep[];
    /** Stable keys for unresolved/ambiguous and flow-origin dependencies. */
    readonly dependencyKeys: readonly string[];
    readonly flowHops: number;
}

export interface ResolutionProvider<TInput = unknown> {
    readonly providerId: string;
    readonly providerVersion: string;
    resolve(input: TInput): readonly ResolutionClaim[];
}

export function dependencyKeyForCall(input: {
    file: string;
    span: SourceSpan;
    receiverText?: string;
    calleeName: string;
}): string {
    return [
        input.file,
        input.span.startByte,
        input.span.endByte,
        input.receiverText ?? '',
        input.calleeName,
    ].join(':');
}
