import type { SourceSpan } from '../language-analysis';
import type { SymbolRegistry } from '../symbols';
import type { SemanticProviderCoverage } from '../semantic';

/** Stable semantic configuration identity; publication generations are not part of it. */
export const PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID = 'python-native-resolution-v2';
export const NATIVE_PYTHON_PROVIDER_ID = 'satori-native-python';
export const NATIVE_PYTHON_PROVIDER_VERSION = 'bounded-origin-v2';
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
export const RESOLUTION_CALL_CONSTRUCTS = [
    'direct_call',
    'constructor_call',
    'member_call',
    'typed_member_call',
    'callback_flow',
    'dynamic_receiver',
    'unknown_call',
] as const;

export type ResolutionCallConstruct = typeof RESOLUTION_CALL_CONSTRUCTS[number];

export interface ResolutionObservedCandidate {
    readonly file: string;
    readonly span: SourceSpan;
    readonly name: string;
    readonly qualifiedName?: string;
    readonly symbolInstanceId?: string;
}

export interface ResolutionCallObservation {
    readonly kind: 'call';
    readonly calleeName: string;
    readonly calleeText: string;
    readonly receiverText?: string;
    readonly receiverType?: string;
    readonly construct: ResolutionCallConstruct;
    readonly candidates: readonly ResolutionObservedCandidate[];
}

export interface ResolutionClaim {
    readonly providerId: string;
    readonly providerVersion: string;
    readonly environmentConfigId: string;
    readonly sourceFile: string;
    readonly sourceInstanceId?: string;
    readonly targetInstanceId?: string;
    readonly targetSymbol?: string;
    readonly callSpan: SourceSpan;
    /** Structured source observation used by navigation; never decode dependency/proof prose for these facts. */
    readonly observation: ResolutionCallObservation;
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

export interface ResolutionProjectInput {
    readonly rootPath: string;
    readonly language: string;
    readonly registry: SymbolRegistry;
    readonly previousRegistry?: SymbolRegistry;
    readonly changedFiles?: ReadonlySet<string>;
}

export interface ResolutionProjectEvidence {
    readonly language: string;
    readonly providerId: string;
    readonly providerVersion: string;
    readonly environmentConfigId: string;
    readonly claimsByFile: ReadonlyMap<string, readonly ResolutionClaim[]>;
    /** Exact conservative relationship owners to rebuild. Omit for whole-language fallback. */
    readonly affectedSourceFiles?: ReadonlySet<string>;
    /** Non-indexed source inputs whose content can change semantic identity. */
    readonly sourceControlFiles?: readonly string[];
    /** Truthful provider coverage for capability/status projection. */
    readonly coverage?: SemanticProviderCoverage;
}

export interface ResolutionProjectAnalyzer {
    supportsLanguage(language: string): boolean;
    analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence>;
    getProviderMetadata?(language: string): Readonly<{
        providerId: string;
        providerVersion: string;
        environmentConfigId?: string;
    }> | undefined | Promise<Readonly<{
        providerId: string;
        providerVersion: string;
        environmentConfigId?: string;
    }> | undefined>;
    getSourceControlFiles?(input: {
        readonly rootPath: string;
        readonly language: string;
        readonly sourceFiles: readonly string[];
    }): Promise<readonly string[]>;
    dispose?(): Promise<void>;
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
