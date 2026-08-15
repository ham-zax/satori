import type { SourceSpan } from '../language-analysis';

export interface SemanticSourceFile {
    readonly path: string;
    readonly source: string;
    readonly sourceHash: string;
}

export interface SemanticAuxiliaryFile {
    readonly path: string;
    readonly role: string;
    readonly source: string;
    readonly sourceHash: string;
}

export interface SemanticProjectInput {
    readonly language: string;
    readonly sourceFiles: readonly SemanticSourceFile[];
    readonly auxiliaryFiles: readonly SemanticAuxiliaryFile[];
}

export type SemanticDecision = 'resolved' | 'unresolved' | 'ambiguous';
export type SemanticStrategy =
    | 'direct_call'
    | 'type_dispatch'
    | 'embed_dispatch'
    | 'interface_dispatch'
    | 'unknown';

export type SemanticReceiverBindingKind =
    | 'none'
    | 'typed_parameter'
    | 'constructor_return'
    | 'composite_literal'
    | 'field_access'
    | 'multi_return'
    | 'range_variable'
    | 'embedded_promoted';

export type SemanticTargetKind = 'none' | 'function' | 'method';

export interface SemanticTargetProvenance {
    readonly file: string;
    readonly span: SourceSpan;
    readonly name: string;
    readonly kind: SemanticTargetKind;
    readonly ownerName?: string;
}

export interface SemanticPackageBindingProof {
    readonly importPath: string;
    readonly localName?: string;
    readonly packageIdentity?: string;
    readonly span?: SourceSpan;
}

export interface SemanticReceiverBindingProof {
    readonly kind: SemanticReceiverBindingKind;
    readonly receiverType: string;
    readonly span?: SourceSpan;
}

export interface SemanticStructuredProof {
    readonly strategy: SemanticStrategy;
    readonly packageBinding?: SemanticPackageBindingProof;
    readonly receiverBinding?: SemanticReceiverBindingProof;
}

export interface SemanticResolvedOccurrence {
    readonly sourceFile: string;
    readonly callSpan: SourceSpan;
    readonly targetProvenance?: SemanticTargetProvenance;
    readonly proof: SemanticStructuredProof;
    readonly decision: SemanticDecision;
    readonly confidence: number;
}

export interface SemanticProjectEvidence {
    readonly language: string;
    readonly occurrencesByFile: ReadonlyMap<string, readonly SemanticResolvedOccurrence[]>;
}
