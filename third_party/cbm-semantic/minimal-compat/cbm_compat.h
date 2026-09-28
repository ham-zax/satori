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
    CBM_LANG_CUDA,
    CBM_LANG_UNKNOWN = 999
} CBMLanguage;

typedef enum {
    CBM_ORIGIN_RAW = 0,
    CBM_ORIGIN_PREPROCESSED
} CBMSourceOrigin;

#define CBM_SOURCE_ORIGIN_RAW CBM_ORIGIN_RAW
#define CBM_SOURCE_ORIGIN_PREPROCESSED CBM_ORIGIN_PREPROCESSED

typedef struct {
    const char *expr;
    const char *value;
    const char *keyword;
    int index;
} CBMCallArg;

#define CBM_MAX_CALL_ARGS 8

typedef struct {
    const char *callee_name;
    const char *enclosing_func_qn;
    const char *first_string_arg;
    const char *second_arg_name;
    CBMCallArg args[CBM_MAX_CALL_ARGS];
    int arg_count;
    int loop_depth;
    int branch_depth;
    int start_line;
    uint32_t site_start_byte;
    uint32_t site_end_byte;
    CBMSourceOrigin source_origin;
    bool is_method;
    bool requires_lsp_resolution;
} CBMCall;

typedef struct {
    CBMCall *items;
    int count;
    int cap;
} CBMCallArray;

static inline void cbm_calls_push(CBMCallArray *arr, CBMArena *a, CBMCall call) {
    if (!arr || !a) return;
    if (arr->count >= arr->cap) {
        int new_cap = arr->cap == 0 ? 16 : arr->cap * 2;
        CBMCall *items = (CBMCall *)cbm_arena_alloc(a, (size_t)new_cap * sizeof(CBMCall));
        if (!items) return;
        if (arr->items && arr->count > 0) {
            memcpy(items, arr->items, (size_t)arr->count * sizeof(CBMCall));
        }
        arr->items = items;
        arr->cap = new_cap;
    }
    arr->items[arr->count++] = call;
}

typedef struct {
    const char *trait_name;
    const char *struct_name;
    const char *struct_qn;
} CBMImplTrait;

typedef struct {
    CBMImplTrait *items;
    int count;
    int cap;
} CBMImplTraitArray;

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

/* Only the per-file Kotlin builtin-node injection uses this; Satori drives the
 * resolvers through their process_file entry points and never reads defs. */
static inline void cbm_defs_push(CBMDefArray *arr, CBMArena *a, CBMDefinition def) {
    if (!arr || !a) return;
    if (arr->count >= arr->cap) {
        int new_cap = arr->cap == 0 ? 16 : arr->cap * 2;
        CBMDefinition *items = (CBMDefinition *)cbm_arena_alloc(a, (size_t)new_cap * sizeof(CBMDefinition));
        if (!items) return;
        if (arr->items && arr->count > 0) {
            memcpy(items, arr->items, (size_t)arr->count * sizeof(CBMDefinition));
        }
        arr->items = items;
        arr->cap = new_cap;
    }
    arr->items[arr->count++] = def;
}

static inline void *cbm_memmem(const void *haystack, size_t haystack_len, const void *needle,
                               size_t needle_len) {
    if (needle_len == 0) return (void *)haystack;
    if (needle_len > haystack_len) return NULL;
    const char *h = (const char *)haystack;
    size_t last = haystack_len - needle_len;
    for (size_t i = 0; i <= last; i++) {
        if (memcmp(h + i, needle, needle_len) == 0) return (void *)(h + i);
    }
    return NULL;
}

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
    CBMCallArray calls;
    CBMImportArray imports;
    CBMImplTraitArray impl_traits;
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

/* Satori shims for CBM foundation APIs used by the vendored resolvers.
 * Memory classes only feed CBM's accounting, so they map to libc. The cursor
 * lease always hands out a private cursor, which CBM documents as always
 * correct (cbm.c: cbm_cursor_acquire); the pool is only an allocation
 * optimization for its multi-threaded native indexer. */
#include <stdlib.h>

typedef enum { CBM_MEM_CLASS_OTHER = 0 } cbm_mem_class_t;

static inline void *cbm_calloc(cbm_mem_class_t cls, size_t size) {
    (void)cls;
    return calloc(1, size);
}

static inline void cbm_free(cbm_mem_class_t cls, void *ptr) {
    (void)cls;
    free(ptr);
}

typedef struct {
    TSTreeCursor *cursor;
    TSTreeCursor private_cursor;
    int slot; /* always -1: private */
} cbm_cursor_lease_t;

static inline TSTreeCursor *cbm_cursor_acquire(cbm_cursor_lease_t *lease, int depth, TSNode node) {
    (void)depth;
    lease->private_cursor = ts_tree_cursor_new(node);
    lease->slot = -1;
    lease->cursor = &lease->private_cursor;
    return lease->cursor;
}

static inline void cbm_cursor_release(cbm_cursor_lease_t *lease) {
    ts_tree_cursor_delete(&lease->private_cursor);
    lease->cursor = NULL;
}

#endif /* CBM_COMPAT_H */
