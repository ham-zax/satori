#include "foundation/arena.h"
#include "foundation/constants.h"
#include "foundation/log.h"
#include "foundation/mem_core.h"
#include "cbm.h"
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: GROW_ARRAY. */
#define GROW_ARRAY(arr, arena)                                                                   \
    do {                                                                                         \
        if ((arr)->count >= (arr)->cap) {                                                        \
            int new_cap = (arr)->cap == 0 ? CBM_SZ_32 : (arr)->cap * PAIR_LEN;                   \
            void *new_items = cbm_arena_alloc((arena), (size_t)new_cap * sizeof(*(arr)->items)); \
            if (!new_items)                                                                      \
                return;                                                                          \
            if ((arr)->items && (arr)->count > 0) {                                              \
                memcpy(new_items, (arr)->items, (size_t)(arr)->count * sizeof(*(arr)->items));   \
            }                                                                                    \
            (arr)->items = new_items;                                                            \
            (arr)->cap = new_cap;                                                                \
        }                                                                                        \
    } while (0)

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_first_line. */
static const char *cbm_first_line(CBMArena *a, const char *text) {
    if (!text) {
        return text;
    }
    const char *nl = strpbrk(text, "\r\n");
    if (!nl) {
        return text;
    }
    size_t n = (size_t)(nl - text);
    while (n > 0 && (text[n - 1] == ' ' || text[n - 1] == '\t')) {
        n--;
    }
    char *cut = (char *)cbm_arena_alloc(a, n + 1);
    if (!cut) {
        return text;
    }
    memcpy(cut, text, n);
    cut[n] = '\0';
    return cut;
}

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_js_family_path. */
static bool cbm_js_family_path(const char *path) {
    if (!path) {
        return false;
    }
    const char *dot = strrchr(path, '.');
    if (!dot) {
        return false;
    }
    static const char *const exts[] = {".js",  ".mjs", ".cjs", ".jsx", ".ts",
                                       ".mts", ".cts", ".tsx", ".ets", NULL};
    for (int i = 0; exts[i]; i++) {
        if (strcmp(dot, exts[i]) == 0) {
            return true;
        }
    }
    return false;
}

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_js_name_is_junk. */
static bool cbm_js_name_is_junk(const char *name) {
    if (!name || !name[0]) {
        return false; /* empty names are handled by the callers' own rules */
    }
    unsigned char c = (unsigned char)name[0];
    bool identifier_start = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' ||
                            c == '$' || c == '#' || c >= 0x80;
    /* Member names JS spells without an identifier start are still names:
     * computed keys (`[Symbol.iterator]`), string-literal keys (`"my-key"`,
     * `'x'`) and escaped identifiers (`А`). Measured on the TypeScript
     * corpus: 1,531 `[…]` members, 97 quoted members, 154 escaped
     * identifiers — all real definitions. What remains ({…} patterns, numeric
     * literals, parenthesised types, `...rest`) is a token, not a name. */
    bool member_key_start = c == '[' || c == '"' || c == '\'' || c == '\\';
    return !identifier_start && !member_key_start;
}

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_defs_push. */
void cbm_defs_push(CBMDefArray *arr, CBMArena *a, CBMDefinition def) {
    def.name = cbm_first_line(a, def.name);
    def.qualified_name = cbm_first_line(a, def.qualified_name);
    if (cbm_js_family_path(def.file_path) && cbm_js_name_is_junk(def.name)) {
        return;
    }
    GROW_ARRAY(arr, a);
    arr->items[arr->count++] = def;
}

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_usages_push. */
void cbm_usages_push(CBMUsageArray *arr, CBMArena *a, CBMUsage usage) {
    GROW_ARRAY(arr, a);
    arr->items[arr->count++] = usage;
}

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_impltrait_push. */
void cbm_impltrait_push(CBMImplTraitArray *arr, CBMArena *a, CBMImplTrait it) {
    GROW_ARRAY(arr, a);
    arr->items[arr->count++] = it;
}

/* Copied verbatim from internal/cbm/cbm.c at 11b662f9: cbm_result_alloc. */
CBMFileResult *cbm_result_alloc(void) {
    /* The one raw allocation of a result: cbm_free_result releases it with
     * the matching free. Extraction and the spill loader both come here. */
    enum { SINGLE = 1 };
    return (CBMFileResult *)calloc(SINGLE, sizeof(CBMFileResult));
}

/* Satori link shims for CBM's process-wide services. */
int cbm_macro_extraction_enabled(void) { return 1; }
TSNode cbm_ts_child_by_field_name(TSNode node, const char *name, uint32_t length) {
    return (ts_node_child_by_field_name)(node, name, length);
}
void *cbm_alloc(cbm_mem_class_t cls, size_t bytes) { (void)cls; return malloc(bytes); }
void *cbm_calloc(cbm_mem_class_t cls, size_t bytes) { (void)cls; return calloc(1, bytes); }
void *cbm_realloc(cbm_mem_class_t cls, void *block, size_t bytes) { (void)cls; return realloc(block, bytes); }
void cbm_free(cbm_mem_class_t cls, void *block) { (void)cls; free(block); }
void cbm_log(CBMLogLevel level, const char *msg, ...) { (void)level; (void)msg; }
