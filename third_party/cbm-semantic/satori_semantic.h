#ifndef SATORI_SEMANTIC_H
#define SATORI_SEMANTIC_H

#include <stdint.h>
#include <stddef.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#define SATORI_SEMANTIC_ABI_VERSION 1
#define SATORI_SEMANTIC_OK 0
#define SATORI_SEMANTIC_ERR_INVALID_ARGUMENT -1
#define SATORI_SEMANTIC_ERR_OUT_OF_MEMORY -2
#define SATORI_SEMANTIC_ERR_PARSE_FAILED -3
#define SATORI_SEMANTIC_ERR_RESOLVE_FAILED -4
#define SATORI_SEMANTIC_ERR_HANDLE_NOT_FOUND -5
#define SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED -6

/* Deterministic resource limits */
#define SATORI_MAX_HANDLES 64
#define SATORI_MAX_SOURCES 20000
#define SATORI_MAX_AUXILIARIES 1000
#define SATORI_MAX_AGGREGATE_SOURCE_BYTES (100ULL * 1024ULL * 1024ULL) /* 100 MB */
#define SATORI_MAX_AGGREGATE_AUXILIARY_BYTES (10ULL * 1024ULL * 1024ULL) /* 10 MB */
#define SATORI_MAX_TOTAL_INPUT_BYTES (SATORI_MAX_AGGREGATE_SOURCE_BYTES + SATORI_MAX_AGGREGATE_AUXILIARY_BYTES)
#define SATORI_MAX_TOTAL_SOURCE_BYTES SATORI_MAX_AGGREGATE_SOURCE_BYTES
#define SATORI_MAX_DEFINITIONS 100000
#define SATORI_MAX_CALL_SITES 200000
#define SATORI_MAX_RESULTS 500000
#define SATORI_MAX_STR_TABLE_BYTES (64ULL * 1024ULL * 1024ULL)
#define SATORI_MAX_RECURSION_DEPTH 32

typedef uint32_t SatoriSemanticHandle;

/* Decision enum */
enum SatoriSemanticDecision {
    SATORI_DECISION_RESOLVED = 1,
    SATORI_DECISION_UNRESOLVED = 2,
    SATORI_DECISION_AMBIGUOUS = 3
};

/* Strategy enum */
enum SatoriSemanticStrategy {
    SATORI_STRATEGY_DIRECT_CALL = 1,
    SATORI_STRATEGY_TYPE_DISPATCH = 2,
    SATORI_STRATEGY_EMBED_DISPATCH = 3,
    SATORI_STRATEGY_INTERFACE_DISPATCH = 4,
    SATORI_STRATEGY_UNKNOWN = 99
};

/* Receiver / Proof binding kind */
enum SatoriReceiverBindingKind {
    SATORI_BINDING_NONE = 0,
    SATORI_BINDING_TYPED_PARAMETER = 1,
    SATORI_BINDING_CONSTRUCTOR_RETURN = 2,
    SATORI_BINDING_COMPOSITE_LITERAL = 3,
    SATORI_BINDING_FIELD_ACCESS = 4,
    SATORI_BINDING_MULTI_RETURN = 5,
    SATORI_BINDING_RANGE_VARIABLE = 6,
    SATORI_BINDING_EMBEDDED_PROMOTED = 7
};

/* Target kind */
enum SatoriTargetKind {
    SATORI_TARGET_NONE = 0,
    SATORI_TARGET_FUNCTION = 1,
    SATORI_TARGET_METHOD = 2
};

/* Fixed-width POD relationship result struct (exactly 64 bytes, little-endian) */
typedef struct {
    /* Source call occurrence (16 bytes) */
    uint32_t source_file_offset;
    uint32_t source_file_length;
    uint32_t call_start_byte;
    uint32_t call_end_byte;

    /* Target definition provenance (24 bytes) */
    uint32_t target_file_offset;
    uint32_t target_file_length;
    uint32_t target_name_offset;
    uint32_t target_name_length;
    uint32_t target_start_byte;
    uint32_t target_end_byte;

    /* Structured proof metadata (16 bytes) */
    uint32_t receiver_type_offset;  /* optional, length 0 if none */
    uint32_t receiver_type_length;
    uint32_t import_path_offset;    /* optional package import path, length 0 if none */
    uint32_t import_path_length;

    /* Decision, flags & scoring (8 bytes) */
    uint8_t receiver_binding_kind;  /* SatoriReceiverBindingKind (1 byte) */
    uint8_t target_kind;            /* SatoriTargetKind (1 byte) */
    uint8_t decision;               /* SatoriSemanticDecision (1 byte) */
    uint8_t strategy;               /* SatoriSemanticStrategy (1 byte) */
    float confidence;               /* (4 bytes) */
} SatoriSemanticResultV1;

typedef SatoriSemanticResultV1 SatoriSemanticRelationshipV1;

/* Fixed-width POD definition struct (exactly 64 bytes, little-endian) */
typedef struct {
    uint32_t name_offset;
    uint32_t name_length;
    uint32_t file_offset;
    uint32_t file_length;
    uint32_t span_start_byte;
    uint32_t span_end_byte;
    uint32_t receiver_type_offset;
    uint32_t receiver_type_length;
    uint32_t doc_comment_offset;
    uint32_t doc_comment_length;
    uint8_t kind;             /* SatoriTargetKind / SymbolKind (1 byte) */
    uint8_t is_exported;      /* (1 byte) */
    uint8_t is_test;          /* (1 byte) */
    uint8_t reserved_flags;   /* (1 byte) */
    uint32_t reserved[5];     /* 20 bytes padding to 64 bytes */
} SatoriSemanticDefinitionV1;

/* Fixed-width POD diagnostic struct (exactly 64 bytes, little-endian) */
typedef struct {
    uint32_t message_offset;
    uint32_t message_length;
    uint32_t file_offset;
    uint32_t file_length;
    uint32_t span_start_byte;
    uint32_t span_end_byte;
    uint8_t severity;         /* 1=error, 2=warning, 3=info, 4=hint (1 byte) */
    uint8_t code;             /* (1 byte) */
    uint16_t reserved_flags;  /* (2 bytes) */
    uint32_t reserved[9];     /* 36 bytes padding to 64 bytes */
} SatoriSemanticDiagnosticV1;

/* Static assertions for exact 64-byte struct sizes and key field offsets */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(SatoriSemanticResultV1) == 64, "SatoriSemanticResultV1 must be exactly 64 bytes");
_Static_assert(offsetof(SatoriSemanticResultV1, source_file_offset) == 0, "source_file_offset offset");
_Static_assert(offsetof(SatoriSemanticResultV1, target_file_offset) == 16, "target_file_offset offset");
_Static_assert(offsetof(SatoriSemanticResultV1, receiver_type_offset) == 40, "receiver_type_offset offset");
_Static_assert(offsetof(SatoriSemanticResultV1, receiver_binding_kind) == 56, "receiver_binding_kind offset");
_Static_assert(offsetof(SatoriSemanticResultV1, confidence) == 60, "confidence offset");

_Static_assert(sizeof(SatoriSemanticDefinitionV1) == 64, "SatoriSemanticDefinitionV1 must be exactly 64 bytes");
_Static_assert(offsetof(SatoriSemanticDefinitionV1, name_offset) == 0, "name_offset offset");
_Static_assert(offsetof(SatoriSemanticDefinitionV1, span_start_byte) == 16, "span_start_byte offset");
_Static_assert(offsetof(SatoriSemanticDefinitionV1, kind) == 40, "kind offset");

_Static_assert(sizeof(SatoriSemanticDiagnosticV1) == 64, "SatoriSemanticDiagnosticV1 must be exactly 64 bytes");
_Static_assert(offsetof(SatoriSemanticDiagnosticV1, message_offset) == 0, "message_offset offset");
_Static_assert(offsetof(SatoriSemanticDiagnosticV1, span_start_byte) == 16, "span_start_byte offset");
_Static_assert(offsetof(SatoriSemanticDiagnosticV1, severity) == 24, "severity offset");
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ABI lifecycle & metadata */
EMSCRIPTEN_KEEPALIVE uint32_t satori_semantic_abi_version(void);
EMSCRIPTEN_KEEPALIVE const char *satori_semantic_engine_version(void);
EMSCRIPTEN_KEEPALIVE const char *satori_semantic_global_last_error_message(void);
EMSCRIPTEN_KEEPALIVE const char *satori_semantic_last_error_message(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE const char *satori_semantic_last_error(SatoriSemanticHandle handle);

/* Session management */
EMSCRIPTEN_KEEPALIVE int satori_semantic_create(const char *language, uint32_t language_len, SatoriSemanticHandle *out_handle);
EMSCRIPTEN_KEEPALIVE int satori_semantic_add_auxiliary(SatoriSemanticHandle handle, const char *role, uint32_t role_len, const char *path, uint32_t path_len, const char *source, uint32_t source_len);
EMSCRIPTEN_KEEPALIVE int satori_semantic_add_source(SatoriSemanticHandle handle, const char *path, uint32_t path_len, const char *source, uint32_t source_len);
EMSCRIPTEN_KEEPALIVE int satori_semantic_resolve(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE void satori_semantic_destroy(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE void satori_semantic_free(SatoriSemanticHandle handle);

/* Multi-stream query exports */
/* 1. Relationships stream */
EMSCRIPTEN_KEEPALIVE uint32_t satori_semantic_result_count(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE const SatoriSemanticResultV1 *satori_semantic_results(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE uint32_t satori_semantic_relationship_count(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE const SatoriSemanticRelationshipV1 *satori_semantic_relationships(SatoriSemanticHandle handle);

/* 2. Definitions stream (ABI frozen; returns 0 for milestone 1) */
EMSCRIPTEN_KEEPALIVE uint32_t satori_semantic_definition_count(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE const SatoriSemanticDefinitionV1 *satori_semantic_definitions(SatoriSemanticHandle handle);

/* 3. Diagnostics stream (ABI frozen; returns 0 for milestone 1) */
EMSCRIPTEN_KEEPALIVE uint32_t satori_semantic_diagnostic_count(SatoriSemanticHandle handle);
EMSCRIPTEN_KEEPALIVE const SatoriSemanticDiagnosticV1 *satori_semantic_diagnostics(SatoriSemanticHandle handle);

/* String table for interning strings across streams */
EMSCRIPTEN_KEEPALIVE const char *satori_semantic_string_table(SatoriSemanticHandle handle, uint32_t *out_table_len);

/* Minimal smoke function for verification */
EMSCRIPTEN_KEEPALIVE int satori_semantic_go_smoke(void);

#ifdef __cplusplus
}
#endif

#endif /* SATORI_SEMANTIC_H */
