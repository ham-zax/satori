/*
 * Copyright (c) 2024 DeusData / Codebase Memory MCP contributors
 * Copyright (c) 2026 Satori Project contributors
 *
 * Licensed under the MIT License.
 * Ported and adapted from DeusData/codebase-memory-mcp (commit d150ebe4fc78a9a3f85013d2087a849e5d59eb0f).
 */

#ifndef CBM_COMPAT_H
#define CBM_COMPAT_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include "../common/arena.h"
#include "../tree_sitter/api.h"

typedef enum {
    CBM_LANG_GO = 0,
    CBM_LANG_PYTHON,
    CBM_LANG_JAVASCRIPT,
    CBM_LANG_TYPESCRIPT,
    CBM_LANG_TSX,
    CBM_LANG_RUST,
    CBM_LANG_JAVA,
    CBM_LANG_CPP,
    CBM_LANG_CSHARP,
    CBM_LANG_PHP,
    CBM_LANG_LUA,
    CBM_LANG_SCALA,
    CBM_LANG_KOTLIN,
    CBM_LANG_RUBY,
    CBM_LANG_C,
    CBM_LANG_UNKNOWN = 999
} CBMLanguage;

typedef enum {
    CBM_ORIGIN_RAW = 0,
    CBM_ORIGIN_PREPROCESSED
} CBMSourceOrigin;

typedef enum {
    CBM_RESOLVED_INVOCATION = 0,
    CBM_RESOLVED_CALL_REFERENCE,
} CBMResolvedKind;

/* LSP-resolved invocation / reference record */
typedef struct {
    const char *caller_qn;         /* enclosing function QN */
    const char *callee_qn;         /* resolved target QN */
    const char *strategy;          /* resolution strategy string */
    float confidence;              /* 0.0 - 1.0 */
    const char *reason;            /* diagnostic reason if unresolved */
    CBMResolvedKind kind;          /* invocation vs call reference */
    uint32_t site_start_byte;      /* start byte of call occurrence */
    uint32_t site_end_byte;        /* end byte of call occurrence */
    CBMSourceOrigin source_origin; /* raw or preprocessed */
} CBMResolvedCall;

typedef struct {
    CBMResolvedCall *items;
    int count;
    int cap;
} CBMResolvedCallArray;

static inline void cbm_resolvedcall_push(CBMResolvedCallArray *arr, CBMArena *a, CBMResolvedCall rc) {
    if (arr->count >= arr->cap) {
        int new_cap = arr->cap == 0 ? 16 : arr->cap * 2;
        CBMResolvedCall *new_items = (CBMResolvedCall*)cbm_arena_alloc(a, (size_t)new_cap * sizeof(CBMResolvedCall));
        if (arr->count > 0 && arr->items) {
            for (int i = 0; i < arr->count; ++i) {
                new_items[i] = arr->items[i];
            }
        }
        arr->items = new_items;
        arr->cap = new_cap;
    }
    arr->items[arr->count++] = rc;
}

typedef struct {
    const char *name;           /* short name */
    const char *qualified_name; /* project.path.name */
    const char *label;          /* "Function", "Method", "Class", "Variable", "Module" */
    const char *file_path;      /* relative path */
    uint32_t start_line;
    uint32_t end_line;
    const char *signature;              /* parameter text (NULL if none) */
    const char *return_type;            /* return type text (NULL if none) */
    const char *receiver;               /* Go method receiver (NULL if none) */
    const char *docstring;              /* leading doc comment (NULL if none) */
    const char *parent_class;           /* enclosing class QN for methods (NULL if none) */
    const char **decorators;            /* NULL-terminated array (NULL if none) */
    const char **base_classes;          /* NULL-terminated array (NULL if none) */
    const char **param_names;           /* NULL-terminated array (NULL if none) */
    const char **param_types;           /* NULL-terminated array (NULL if none) */
    const char **signature_param_types; /* ordered internal signature types; "?" means unknown */
    int signature_param_count;          /* number of entries in signature_param_types */
    const char **return_types;          /* NULL-terminated array (NULL if none) */
    const char *route_path;
    const char *route_method;
    int complexity;
    int cognitive;
    int loop_count;
    int loop_depth;
    bool is_recursive;
    int param_count;
    int max_access_depth;
    int linear_scan_in_loop;
    int alloc_in_loop;
    bool recursion_in_loop;
    bool unguarded_recursion;
    int lines;
    uint32_t *fingerprint;
    int fingerprint_k;
    bool is_exported;
    bool is_abstract;
    bool is_test;
    bool is_entry_point;
    const char *structural_profile;
    const char *body_tokens;
    const char *impl_trait;
} CBMDefinition;

typedef struct {
    CBMDefinition *items;
    int count;
    int cap;
} CBMDefArray;

typedef struct {
    const char *local_name;
    const char *module_path;
} CBMImport;

typedef struct {
    CBMImport *items;
    int count;
    int cap;
} CBMImportArray;

typedef struct CBMFileResult {
    CBMArena arena;
    CBMDefArray defs;
    CBMImportArray imports;
    CBMResolvedCallArray resolved_calls;
    const char *module_qn;
    const char *namespace_name;
    const char **exports;
    const char **constants;
    const char **global_vars;
    bool has_error;
    const char *error_msg;
} CBMFileResult;

static inline bool cbm_label_is_type_like(const char* label) {
    return label && (strcmp(label, "Type") == 0 || strcmp(label, "Interface") == 0 ||
                     strcmp(label, "Struct") == 0 || strcmp(label, "Enum") == 0 ||
                     strcmp(label, "Class") == 0);
}

#endif /* CBM_COMPAT_H */
