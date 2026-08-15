/**
 * Fixed-width 64-byte POD layout offsets and types for SatoriSemanticResultV1.
 */
export const SATORI_SEMANTIC_ABI_VERSION = 1;
export const RESULT_STRUCT_SIZE = 64;
export const DEFINITION_STRUCT_SIZE = 64;
export const DIAGNOSTIC_STRUCT_SIZE = 64;

export const STRUCT_OFFSETS = {
    SOURCE_FILE_OFFSET: 0,
    SOURCE_FILE_LENGTH: 4,
    CALL_START_BYTE: 8,
    CALL_END_BYTE: 12,
    TARGET_FILE_OFFSET: 16,
    TARGET_FILE_LENGTH: 20,
    TARGET_NAME_OFFSET: 24,
    TARGET_NAME_LENGTH: 28,
    TARGET_START_BYTE: 32,
    TARGET_END_BYTE: 36,
    RECEIVER_TYPE_OFFSET: 40,
    RECEIVER_TYPE_LENGTH: 44,
    IMPORT_PATH_OFFSET: 48,
    IMPORT_PATH_LENGTH: 52,
    RECEIVER_BINDING_KIND: 56,
    TARGET_KIND: 57,
    DECISION: 58,
    STRATEGY: 59,
    CONFIDENCE: 60,
} as const;

export const DEFINITION_OFFSETS = {
    NAME_OFFSET: 0,
    NAME_LENGTH: 4,
    FILE_OFFSET: 8,
    FILE_LENGTH: 12,
    SPAN_START_BYTE: 16,
    SPAN_END_BYTE: 20,
    RECEIVER_TYPE_OFFSET: 24,
    RECEIVER_TYPE_LENGTH: 28,
    DOC_COMMENT_OFFSET: 32,
    DOC_COMMENT_LENGTH: 36,
    KIND: 40,
    IS_EXPORTED: 41,
    IS_TEST: 42,
    RESERVED_FLAGS: 43,
} as const;

export const DIAGNOSTIC_OFFSETS = {
    MESSAGE_OFFSET: 0,
    MESSAGE_LENGTH: 4,
    FILE_OFFSET: 8,
    FILE_LENGTH: 12,
    SPAN_START_BYTE: 16,
    SPAN_END_BYTE: 20,
    SEVERITY: 24,
    CODE: 25,
    RESERVED_FLAGS: 26,
} as const;

export enum SemanticDecision {
    RESOLVED = 1,
    UNRESOLVED = 2,
    AMBIGUOUS = 3,
}

export enum SemanticStrategy {
    DIRECT_CALL = 1,
    TYPE_DISPATCH = 2,
    EMBED_DISPATCH = 3,
    INTERFACE_DISPATCH = 4,
    UNKNOWN = 99,
}

export enum ReceiverBindingKind {
    NONE = 0,
    TYPED_PARAMETER = 1,
    CONSTRUCTOR_RETURN = 2,
    COMPOSITE_LITERAL = 3,
    FIELD_ACCESS = 4,
    MULTI_RETURN = 5,
    RANGE_VARIABLE = 6,
    EMBEDDED_PROMOTED = 7,
}

export enum TargetKind {
    NONE = 0,
    FUNCTION = 1,
    METHOD = 2,
}

export interface RawSemanticResult {
    readonly sourceFile: string;
    readonly callStartByte: number;
    readonly callEndByte: number;
    readonly targetFile?: string;
    readonly targetName?: string;
    readonly targetStartByte?: number;
    readonly targetEndByte?: number;
    readonly receiverType?: string;
    readonly importPath?: string;
    readonly receiverBindingKind: ReceiverBindingKind;
    readonly targetKind: TargetKind;
    readonly decision: SemanticDecision;
    readonly strategy: SemanticStrategy;
    readonly confidence: number;
}

export interface RawSemanticDefinition {
    readonly name: string;
    readonly file: string;
    readonly spanStartByte: number;
    readonly spanEndByte: number;
    readonly receiverType?: string;
    readonly docComment?: string;
    readonly kind: TargetKind;
    readonly isExported: boolean;
    readonly isTest: boolean;
}

export interface RawSemanticDiagnostic {
    readonly message: string;
    readonly file: string;
    readonly spanStartByte: number;
    readonly spanEndByte: number;
    readonly severity: number;
    readonly code: number;
}
