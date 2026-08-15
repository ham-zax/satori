#include "satori_semantic.h"
#include "common/arena.h"
#include "common/scope.h"
#include "common/type_rep.h"
#include "common/type_registry.h"
#include "common/lsp_node_iter.h"
#include "languages/go/go_lsp.h"
#include "minimal-compat/cbm_compat.h"
#include "tree_sitter/api.h"
#include "helpers.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

extern const TSLanguage *tree_sitter_go(void);

#define SATORI_ENGINE_VERSION_STR "cbm-d150ebe4+satori-go-semantic-v1"

typedef struct {
    char *path;
    uint32_t path_len;
    char *source;
    uint32_t source_len;
} SatoriSourceFile;

typedef struct {
    char *role;
    uint32_t role_len;
    char *path;
    uint32_t path_len;
    char *source;
    uint32_t source_len;
} SatoriAuxiliaryFile;

typedef struct {
    char *data;
    uint32_t len;
    uint32_t cap;
} SatoriStringTable;

typedef struct {
    bool active;
    uint32_t handle_id;
    char language[32];

    CBMArena arena;

    SatoriSourceFile *sources;
    uint32_t source_count;
    uint32_t source_cap;
    uint64_t total_source_bytes;

    SatoriAuxiliaryFile *auxiliaries;
    uint32_t aux_count;
    uint32_t aux_cap;
    uint64_t total_aux_bytes;

    SatoriSemanticResultV1 *results;
    uint32_t result_count;
    uint32_t result_cap;

    SatoriStringTable str_table;
    char last_error[512];
} SatoriSession;

static SatoriSession s_sessions[SATORI_MAX_HANDLES];
static uint32_t s_next_handle_id = 1;
static char s_global_last_error[512] = "";

static void set_global_error(const char *msg) {
    if (!msg) {
        s_global_last_error[0] = '\0';
        return;
    }
    strncpy(s_global_last_error, msg, sizeof(s_global_last_error) - 1);
    s_global_last_error[sizeof(s_global_last_error) - 1] = '\0';
}

static void set_session_error(SatoriSession *s, const char *msg) {
    if (!s) return;
    if (!msg) {
        s->last_error[0] = '\0';
        return;
    }
    strncpy(s->last_error, msg, sizeof(s->last_error) - 1);
    s->last_error[sizeof(s->last_error) - 1] = '\0';
}

static SatoriSession *find_session(SatoriSemanticHandle handle) {
    if (handle == 0) return NULL;
    for (int i = 0; i < SATORI_MAX_HANDLES; i++) {
        if (s_sessions[i].active && s_sessions[i].handle_id == handle) {
            return &s_sessions[i];
        }
    }
    return NULL;
}

static bool str_table_intern_checked(SatoriStringTable *st, const char *str, uint32_t len, uint32_t *out_offset, uint32_t *out_len) {
    if (!out_offset || !out_len) return false;
    if (!str || len == 0) {
        *out_offset = 0;
        *out_len = 0;
        return true;
    }

    /* Check if already present */
    if (st->data && st->len > 0) {
        for (uint32_t i = 0; i + len <= st->len; i++) {
            if (memcmp(st->data + i, str, len) == 0 && (i + len == st->len || st->data[i + len] == '\0')) {
                *out_offset = i;
                *out_len = len;
                return true;
            }
        }
    }

    /* Append to string table */
    uint32_t needed = st->len + len + 1;
    if (needed > SATORI_MAX_STR_TABLE_BYTES) {
        *out_offset = 0;
        *out_len = 0;
        return false;
    }
    if (needed > st->cap) {
        uint32_t new_cap = st->cap == 0 ? 1024 : st->cap * 2;
        while (new_cap < needed) new_cap *= 2;
        char *new_data = (char *)realloc(st->data, new_cap);
        if (!new_data) {
            *out_offset = 0;
            *out_len = 0;
            return false;
        }
        st->data = new_data;
        st->cap = new_cap;
    }

    uint32_t offset = st->len;
    memcpy(st->data + offset, str, len);
    st->data[offset + len] = '\0';
    st->len += len + 1;
    *out_offset = offset;
    *out_len = len;
    return true;
}

uint32_t satori_semantic_abi_version(void) {
    return SATORI_SEMANTIC_ABI_VERSION;
}

const char *satori_semantic_engine_version(void) {
    return SATORI_ENGINE_VERSION_STR;
}

const char *satori_semantic_global_last_error_message(void) {
    return s_global_last_error;
}

const char *satori_semantic_last_error_message(SatoriSemanticHandle handle) {
    SatoriSession *s = find_session(handle);
    if (!s) return s_global_last_error;
    return s->last_error;
}

const char *satori_semantic_last_error(SatoriSemanticHandle handle) {
    return satori_semantic_last_error_message(handle);
}

int satori_semantic_create(const char *language, uint32_t language_len, SatoriSemanticHandle *out_handle) {
    if (!out_handle) {
        set_global_error("Null out_handle pointer");
        return SATORI_SEMANTIC_ERR_INVALID_ARGUMENT;
    }
    *out_handle = 0;

    if (!language || language_len != 2 || memcmp(language, "go", 2) != 0) {
        set_global_error("Unsupported semantic language");
        return SATORI_SEMANTIC_ERR_INVALID_ARGUMENT;
    }

    /* Find empty session slot */
    SatoriSession *s = NULL;
    for (int i = 0; i < SATORI_MAX_HANDLES; i++) {
        if (!s_sessions[i].active) {
            s = &s_sessions[i];
            break;
        }
    }

    if (!s) {
        set_global_error("Max session handles exceeded (64)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    memset(s, 0, sizeof(SatoriSession));
    s->active = true;
    s->handle_id = s_next_handle_id++;
    memcpy(s->language, language, language_len);
    s->language[language_len] = '\0';

    cbm_arena_init(&s->arena);

    *out_handle = s->handle_id;
    return SATORI_SEMANTIC_OK;
}

int satori_semantic_add_source(SatoriSemanticHandle handle, const char *path, uint32_t path_len, const char *source, uint32_t source_len) {
    SatoriSession *s = find_session(handle);
    if (!s) {
        set_global_error("Handle not found in add_source");
        return SATORI_SEMANTIC_ERR_HANDLE_NOT_FOUND;
    }

    if (!path || path_len == 0 || !source) {
        set_session_error(s, "Invalid source arguments");
        return SATORI_SEMANTIC_ERR_INVALID_ARGUMENT;
    }

    if (s->source_count >= SATORI_MAX_SOURCES) {
        set_session_error(s, "Max source files exceeded (20000)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    if ((uint64_t)source_len > SATORI_MAX_TOTAL_SOURCE_BYTES ||
        s->total_source_bytes > SATORI_MAX_TOTAL_SOURCE_BYTES - (uint64_t)source_len) {
        set_session_error(s, "Total source bytes limit exceeded (100MB)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    uint64_t current_input_bytes = s->total_source_bytes + s->total_aux_bytes;
    if ((uint64_t)source_len > SATORI_MAX_TOTAL_INPUT_BYTES ||
        current_input_bytes > SATORI_MAX_TOTAL_INPUT_BYTES - (uint64_t)source_len) {
        set_session_error(s, "Total input bytes limit exceeded (110MB)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    if (s->source_count >= s->source_cap) {
        uint32_t new_cap = s->source_cap == 0 ? 16 : s->source_cap * 2;
        SatoriSourceFile *new_sources = (SatoriSourceFile *)realloc(s->sources, new_cap * sizeof(SatoriSourceFile));
        if (!new_sources) {
            set_session_error(s, "Out of memory allocating source files array");
            return SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
        }
        s->sources = new_sources;
        s->source_cap = new_cap;
    }

    char *path_copy = (char *)malloc(path_len + 1);
    char *src_copy = (char *)malloc(source_len + 1);
    if (!path_copy || !src_copy) {
        free(path_copy);
        free(src_copy);
        set_session_error(s, "Out of memory duplicating source file content");
        return SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
    }

    memcpy(path_copy, path, path_len);
    path_copy[path_len] = '\0';
    memcpy(src_copy, source, source_len);
    src_copy[source_len] = '\0';

    s->sources[s->source_count].path = path_copy;
    s->sources[s->source_count].path_len = path_len;
    s->sources[s->source_count].source = src_copy;
    s->sources[s->source_count].source_len = source_len;
    s->source_count++;
    s->total_source_bytes += source_len;

    return SATORI_SEMANTIC_OK;
}

int satori_semantic_add_auxiliary(SatoriSemanticHandle handle, const char *role, uint32_t role_len, const char *path, uint32_t path_len, const char *source, uint32_t source_len) {
    SatoriSession *s = find_session(handle);
    if (!s) {
        set_global_error("Handle not found in add_auxiliary");
        return SATORI_SEMANTIC_ERR_HANDLE_NOT_FOUND;
    }

    if (!role || role_len == 0 || !path || path_len == 0 || !source) {
        set_session_error(s, "Invalid auxiliary arguments");
        return SATORI_SEMANTIC_ERR_INVALID_ARGUMENT;
    }

    if (s->aux_count >= SATORI_MAX_AUXILIARIES) {
        set_session_error(s, "Max auxiliary files exceeded (1000)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    if ((uint64_t)source_len > SATORI_MAX_AGGREGATE_AUXILIARY_BYTES ||
        s->total_aux_bytes > SATORI_MAX_AGGREGATE_AUXILIARY_BYTES - (uint64_t)source_len) {
        set_session_error(s, "Total auxiliary bytes limit exceeded (10MB)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    uint64_t current_input_bytes = s->total_source_bytes + s->total_aux_bytes;
    if ((uint64_t)source_len > SATORI_MAX_TOTAL_INPUT_BYTES ||
        current_input_bytes > SATORI_MAX_TOTAL_INPUT_BYTES - (uint64_t)source_len) {
        set_session_error(s, "Total input bytes limit exceeded (110MB)");
        return SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
    }

    if (s->aux_count >= s->aux_cap) {
        uint32_t new_cap = s->aux_cap == 0 ? 8 : s->aux_cap * 2;
        SatoriAuxiliaryFile *new_aux = (SatoriAuxiliaryFile *)realloc(s->auxiliaries, new_cap * sizeof(SatoriAuxiliaryFile));
        if (!new_aux) {
            set_session_error(s, "Out of memory allocating auxiliary files array");
            return SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
        }
        s->auxiliaries = new_aux;
        s->aux_cap = new_cap;
    }

    char *role_copy = (char *)malloc(role_len + 1);
    char *path_copy = (char *)malloc(path_len + 1);
    char *src_copy = (char *)malloc(source_len + 1);
    if (!role_copy || !path_copy || !src_copy) {
        free(role_copy);
        free(path_copy);
        free(src_copy);
        set_session_error(s, "Out of memory duplicating auxiliary file content");
        return SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
    }

    memcpy(role_copy, role, role_len);
    role_copy[role_len] = '\0';
    memcpy(path_copy, path, path_len);
    path_copy[path_len] = '\0';
    memcpy(src_copy, source, source_len);
    src_copy[source_len] = '\0';

    s->auxiliaries[s->aux_count].role = role_copy;
    s->auxiliaries[s->aux_count].role_len = role_len;
    s->auxiliaries[s->aux_count].path = path_copy;
    s->auxiliaries[s->aux_count].path_len = path_len;
    s->auxiliaries[s->aux_count].source = src_copy;
    s->auxiliaries[s->aux_count].source_len = source_len;
    s->aux_count++;
    s->total_aux_bytes += source_len;

    return SATORI_SEMANTIC_OK;
}

static uint8_t map_strategy(const char *strat) {
    if (!strat) return SATORI_STRATEGY_UNKNOWN;
    if (strstr(strat, "direct")) return SATORI_STRATEGY_DIRECT_CALL;
    if (strstr(strat, "type_dispatch")) return SATORI_STRATEGY_TYPE_DISPATCH;
    if (strstr(strat, "embed")) return SATORI_STRATEGY_EMBED_DISPATCH;
    if (strstr(strat, "interface")) return SATORI_STRATEGY_INTERFACE_DISPATCH;
    return SATORI_STRATEGY_UNKNOWN;
}

typedef struct {
    const char *qualified_name;
    const char *file_path;
    uint32_t file_path_len;
    uint32_t start_byte;
    uint32_t end_byte;
} SatoriDefLoc;

typedef struct {
    SatoriDefLoc *items;
    uint32_t count;
    uint32_t cap;
} SatoriDefLocArray;

static bool def_locs_add(SatoriDefLocArray *arr, const char *qn, const char *path, uint32_t path_len, uint32_t start, uint32_t end) {
    if (!arr || !qn || !path) return false;
    if (arr->count >= arr->cap) {
        uint32_t new_cap = arr->cap == 0 ? 32 : arr->cap * 2;
        SatoriDefLoc *new_items = (SatoriDefLoc *)realloc(arr->items, new_cap * sizeof(SatoriDefLoc));
        if (!new_items) return false;
        arr->items = new_items;
        arr->cap = new_cap;
    }
    arr->items[arr->count].qualified_name = qn;
    arr->items[arr->count].file_path = path;
    arr->items[arr->count].file_path_len = path_len;
    arr->items[arr->count].start_byte = start;
    arr->items[arr->count].end_byte = end;
    arr->count++;
    return true;
}

static const SatoriDefLoc *def_locs_find(const SatoriDefLocArray *arr, const char *qn) {
    if (!arr || !qn) return NULL;
    for (uint32_t i = 0; i < arr->count; i++) {
        if (arr->items[i].qualified_name && strcmp(arr->items[i].qualified_name, qn) == 0) {
            return &arr->items[i];
        }
    }
    return NULL;
}

static const char *extract_module_name(CBMArena *arena, const SatoriAuxiliaryFile *auxiliaries, uint32_t aux_count) {
    if (!auxiliaries || aux_count == 0) return NULL;
    for (uint32_t i = 0; i < aux_count; i++) {
        const SatoriAuxiliaryFile *aux = &auxiliaries[i];
        if (!aux->path || !aux->source) continue;
        const char *base = strrchr(aux->path, '/');
        const char *fname = base ? base + 1 : aux->path;
        if (strcmp(fname, "go.mod") == 0 || (aux->role && strcmp(aux->role, "manifest") == 0)) {
            const char *src = aux->source;
            const char *p = src;
            while (*p) {
                while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
                if (strncmp(p, "module", 6) == 0 && (p[6] == ' ' || p[6] == '\t')) {
                    p += 6;
                    while (*p == ' ' || *p == '\t') p++;
                    const char *start = p;
                    while (*p && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
                    uint32_t len = (uint32_t)(p - start);
                    if (len > 0) {
                        char *mod = (char *)cbm_arena_alloc(arena, len + 1);
                        if (mod) {
                            memcpy(mod, start, len);
                            mod[len] = '\0';
                            return mod;
                        }
                    }
                }
                while (*p && *p != '\n') p++;
            }
        }
    }
    return NULL;
}

static const char *compute_go_package_qn(CBMArena *arena, const char *module_name, const char *pkg_clause_name, const char *file_path) {
    if (!file_path || !file_path[0]) return pkg_clause_name ? pkg_clause_name : "main";

    const char *last_slash = strrchr(file_path, '/');
    char dir[512] = "";
    if (last_slash) {
        size_t dlen = (size_t)(last_slash - file_path);
        if (dlen >= sizeof(dir)) dlen = sizeof(dir) - 1;
        memcpy(dir, file_path, dlen);
        dir[dlen] = '\0';
    }

    if (module_name && module_name[0]) {
        if (dir[0] && strcmp(dir, ".") != 0) {
            return cbm_arena_sprintf(arena, "%s/%s", module_name, dir);
        }
        if (pkg_clause_name && strcmp(pkg_clause_name, "main") == 0) {
            return "main";
        }
        return module_name;
    }

    if (dir[0] && strcmp(dir, ".") != 0) {
        return cbm_arena_sprintf(arena, "%s", dir);
    }
    return pkg_clause_name ? pkg_clause_name : "main";
}

static const char *extract_package_name(CBMArena *arena, TSNode root, const char *source) {
    if (ts_node_is_null(root) || !source) return "main";
    uint32_t count = ts_node_named_child_count(root);
    for (uint32_t i = 0; i < count; i++) {
        TSNode child = ts_node_named_child(root, i);
        if (ts_node_is_null(child)) continue;
        if (strcmp(ts_node_type(child), "package_clause") == 0) {
            uint32_t pc_count = ts_node_named_child_count(child);
            for (uint32_t j = 0; j < pc_count; j++) {
                TSNode id_node = ts_node_named_child(child, j);
                if (!ts_node_is_null(id_node)) {
                    char *name = cbm_node_text(arena, id_node, source);
                    if (name && name[0]) return name;
                }
            }
        }
    }
    return "main";
}

static void extract_ast_imports(GoLSPContext *ctx, TSNode root, const char *source) {
    if (ts_node_is_null(root) || !source) return;
    uint32_t count = ts_node_named_child_count(root);
    for (uint32_t i = 0; i < count; i++) {
        TSNode child = ts_node_named_child(root, i);
        if (ts_node_is_null(child)) continue;
        if (strcmp(ts_node_type(child), "import_declaration") == 0) {
            uint32_t ic = ts_node_named_child_count(child);
            for (uint32_t j = 0; j < ic; j++) {
                TSNode spec = ts_node_named_child(child, j);
                if (ts_node_is_null(spec)) continue;
                const char *stype = ts_node_type(spec);
                if (strcmp(stype, "import_spec_list") == 0) {
                    uint32_t sc = ts_node_named_child_count(spec);
                    for (uint32_t k = 0; k < sc; k++) {
                        TSNode ispec = ts_node_named_child(spec, k);
                        if (!ts_node_is_null(ispec) && strcmp(ts_node_type(ispec), "import_spec") == 0) {
                            TSNode path_node = ts_node_child_by_field_name(ispec, "path", 4);
                            TSNode name_node = ts_node_child_by_field_name(ispec, "name", 4);
                            if (!ts_node_is_null(path_node)) {
                                char *ptext = cbm_node_text(ctx->arena, path_node, source);
                                if (ptext) {
                                    if (ptext[0] == '"' || ptext[0] == '`') {
                                        ptext++;
                                        size_t plen = strlen(ptext);
                                        if (plen > 0 && (ptext[plen - 1] == '"' || ptext[plen - 1] == '`')) {
                                            ptext[plen - 1] = '\0';
                                        }
                                    }
                                    char *lname = NULL;
                                    if (!ts_node_is_null(name_node)) {
                                        lname = cbm_node_text(ctx->arena, name_node, source);
                                    }
                                    if (!lname || !lname[0]) {
                                        const char *last_slash = strrchr(ptext, '/');
                                        lname = (char *)(last_slash ? last_slash + 1 : ptext);
                                    }
                                    go_lsp_add_import(ctx, lname, ptext);
                                }
                            }
                        }
                    }
                } else if (strcmp(stype, "import_spec") == 0) {
                    TSNode path_node = ts_node_child_by_field_name(spec, "path", 4);
                    TSNode name_node = ts_node_child_by_field_name(spec, "name", 4);
                    if (!ts_node_is_null(path_node)) {
                        char *ptext = cbm_node_text(ctx->arena, path_node, source);
                        if (ptext) {
                            if (ptext[0] == '"' || ptext[0] == '`') {
                                ptext++;
                                size_t plen = strlen(ptext);
                                if (plen > 0 && (ptext[plen - 1] == '"' || ptext[plen - 1] == '`')) {
                                    ptext[plen - 1] = '\0';
                                }
                            }
                            char *lname = NULL;
                            if (!ts_node_is_null(name_node)) {
                                lname = cbm_node_text(ctx->arena, name_node, source);
                            }
                            if (!lname || !lname[0]) {
                                const char *last_slash = strrchr(ptext, '/');
                                lname = (char *)(last_slash ? last_slash + 1 : ptext);
                            }
                            go_lsp_add_import(ctx, lname, ptext);
                        }
                    }
                }
            }
        }
    }
}

static bool extract_ast_definitions(CBMArena *arena, CBMTypeRegistry *reg, SatoriDefLocArray *def_locs, TSNode root, const char *source, const char *pkg_name, const char *file_path, uint32_t file_path_len) {
    if (ts_node_is_null(root) || !source || !pkg_name) return true;
    uint32_t kn = 0;
    TSNode *kids = cbm_lsp_collect_children(arena, root, &kn);
    for (uint32_t i = 0; i < kn; i++) {
        TSNode child = kids[i];
        if (ts_node_is_null(child) || !ts_node_is_named(child)) continue;
        const char *kind = ts_node_type(child);

        if (strcmp(kind, "function_declaration") == 0) {
            TSNode name_node = ts_node_child_by_field_name(child, "name", 4);
            if (ts_node_is_null(name_node)) continue;
            char *fn_name = cbm_node_text(arena, name_node, source);
            if (!fn_name || !fn_name[0]) continue;

            CBMRegisteredFunc rf;
            memset(&rf, 0, sizeof(rf));
            rf.qualified_name = cbm_arena_sprintf(arena, "%s.%s", pkg_name, fn_name);
            rf.short_name = fn_name;
            cbm_registry_add_func(reg, rf);
            if (!def_locs_add(def_locs, rf.qualified_name, file_path, file_path_len, ts_node_start_byte(child), ts_node_end_byte(child))) {
                return false;
            }
        } else if (strcmp(kind, "method_declaration") == 0) {
            TSNode name_node = ts_node_child_by_field_name(child, "name", 4);
            TSNode recv_node = ts_node_child_by_field_name(child, "receiver", 8);
            if (ts_node_is_null(name_node) || ts_node_is_null(recv_node)) continue;

            char *method_name = cbm_node_text(arena, name_node, source);
            if (!method_name || !method_name[0]) continue;

            char *recv_name = NULL;
            uint32_t rnc = ts_node_child_count(recv_node);
            for (uint32_t r = 0; r < rnc && !recv_name; r++) {
                TSNode rp = ts_node_child(recv_node, r);
                if (ts_node_is_null(rp) || !ts_node_is_named(rp)) continue;
                if (strcmp(ts_node_type(rp), "parameter_declaration") != 0) continue;
                TSNode rtype = ts_node_child_by_field_name(rp, "type", 4);
                if (ts_node_is_null(rtype)) continue;
                const char *rtk = ts_node_type(rtype);
                if (strcmp(rtk, "pointer_type") == 0 && ts_node_named_child_count(rtype) > 0) {
                    rtype = ts_node_named_child(rtype, 0);
                }
                char *tn = cbm_node_text(arena, rtype, source);
                if (tn && tn[0]) recv_name = tn;
            }
            if (recv_name) {
                CBMRegisteredFunc rf;
                memset(&rf, 0, sizeof(rf));
                rf.receiver_type = cbm_arena_sprintf(arena, "%s.%s", pkg_name, recv_name);
                rf.qualified_name = cbm_arena_sprintf(arena, "%s.%s.%s", pkg_name, recv_name, method_name);
                rf.short_name = method_name;
                cbm_registry_add_func(reg, rf);
                if (!def_locs_add(def_locs, rf.qualified_name, file_path, file_path_len, ts_node_start_byte(child), ts_node_end_byte(child))) {
                    return false;
                }
            }
        } else if (strcmp(kind, "type_declaration") == 0) {
            uint32_t td_nc = ts_node_child_count(child);
            for (uint32_t t = 0; t < td_nc; t++) {
                TSNode spec = ts_node_child(child, t);
                if (ts_node_is_null(spec) || !ts_node_is_named(spec)) continue;
                if (strcmp(ts_node_type(spec), "type_spec") != 0) continue;
                TSNode tname = ts_node_child_by_field_name(spec, "name", 4);
                if (ts_node_is_null(tname)) continue;
                char *type_name = cbm_node_text(arena, tname, source);
                if (!type_name || !type_name[0]) continue;

                CBMRegisteredType rt;
                memset(&rt, 0, sizeof(rt));
                rt.qualified_name = cbm_arena_sprintf(arena, "%s.%s", pkg_name, type_name);
                rt.short_name = type_name;
                cbm_registry_add_type(reg, rt);
                if (!def_locs_add(def_locs, rt.qualified_name, file_path, file_path_len, ts_node_start_byte(child), ts_node_end_byte(child))) {
                    return false;
                }
            }
        }
    }
    return true;
}

int satori_semantic_resolve(SatoriSemanticHandle handle) {
    SatoriSession *s = find_session(handle);
    if (!s) {
        set_global_error("Handle not found in resolve");
        return SATORI_SEMANTIC_ERR_HANDLE_NOT_FOUND;
    }

    /* Reset previous results and string table */
    free(s->results);
    s->results = NULL;
    s->result_count = 0;
    s->result_cap = 0;

    free(s->str_table.data);
    s->str_table.data = NULL;
    s->str_table.len = 0;
    s->str_table.cap = 0;

    cbm_arena_destroy(&s->arena);
    cbm_arena_init(&s->arena);

    if (s->source_count == 0) {
        return SATORI_SEMANTIC_OK;
    }

    int status = SATORI_SEMANTIC_OK;
    TSTree **trees = NULL;
    TSParser *parser = NULL;
    SatoriDefLocArray def_locs;
    memset(&def_locs, 0, sizeof(def_locs));

    CBMTypeRegistry reg;
    cbm_registry_init(&reg, &s->arena);
    cbm_go_stdlib_register(&reg, &s->arena);

    parser = ts_parser_new();
    if (!parser) {
        set_session_error(s, "Failed to create Tree-sitter parser");
        status = SATORI_SEMANTIC_ERR_PARSE_FAILED;
        goto cleanup;
    }
    ts_parser_set_language(parser, tree_sitter_go());

    trees = (TSTree **)calloc(s->source_count, sizeof(TSTree *));
    if (!trees) {
        set_session_error(s, "Out of memory allocating tree array");
        status = SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
        goto cleanup;
    }

    const char *module_name = extract_module_name(&s->arena, s->auxiliaries, s->aux_count);

    // Phase 1: Parse AST and collect declarations into registry and definition map
    for (uint32_t i = 0; i < s->source_count; i++) {
        SatoriSourceFile *sf = &s->sources[i];
        trees[i] = ts_parser_parse_string(parser, NULL, sf->source, sf->source_len);
        if (!trees[i]) {
            set_session_error(s, "Tree-sitter parser failed to parse source file");
            status = SATORI_SEMANTIC_ERR_PARSE_FAILED;
            goto cleanup;
        }
        TSNode root = ts_tree_root_node(trees[i]);
        const char *pkg_clause = extract_package_name(&s->arena, root, sf->source);
        const char *pkg_qn = compute_go_package_qn(&s->arena, module_name, pkg_clause, sf->path);
        if (!extract_ast_definitions(&s->arena, &reg, &def_locs, root, sf->source, pkg_qn, sf->path, sf->path_len)) {
            set_session_error(s, "Out of memory recording AST definitions");
            status = SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
            goto cleanup;
        }
    }

    // Phase 2: Finalize registry lookup tables
    cbm_registry_finalize(&reg);

    // Phase 3: Resolve calls
    for (uint32_t i = 0; i < s->source_count; i++) {
        if (!trees[i]) continue;
        SatoriSourceFile *sf = &s->sources[i];
        TSNode root = ts_tree_root_node(trees[i]);
        const char *pkg_clause = extract_package_name(&s->arena, root, sf->source);
        const char *pkg_qn = compute_go_package_qn(&s->arena, module_name, pkg_clause, sf->path);
        CBMResolvedCallArray resolved_calls;
        memset(&resolved_calls, 0, sizeof(resolved_calls));

        GoLSPContext ctx;
        go_lsp_init(&ctx, &s->arena, sf->source, sf->source_len, &reg, pkg_qn, &resolved_calls);
        extract_ast_imports(&ctx, root, sf->source);
        go_lsp_process_file(&ctx, root);

        ts_tree_delete(trees[i]);
        trees[i] = NULL;

        if (resolved_calls.count > 0) {
            uint32_t needed = s->result_count + resolved_calls.count;
            if (needed > SATORI_MAX_RESULTS) {
                set_session_error(s, "Resource limit exceeded: max results exceeded");
                status = SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
                goto cleanup;
            }

            if (needed > s->result_cap) {
                uint32_t new_cap = s->result_cap == 0 ? 64 : s->result_cap * 2;
                while (new_cap < needed) new_cap *= 2;
                SatoriSemanticResultV1 *new_res = (SatoriSemanticResultV1 *)realloc(s->results, new_cap * sizeof(SatoriSemanticResultV1));
                if (!new_res) {
                    set_session_error(s, "Out of memory allocating results");
                    status = SATORI_SEMANTIC_ERR_OUT_OF_MEMORY;
                    goto cleanup;
                }
                s->results = new_res;
                s->result_cap = new_cap;
            }

            uint32_t src_path_len = 0;
            uint32_t src_path_off = 0;
            if (!str_table_intern_checked(&s->str_table, sf->path, sf->path_len, &src_path_off, &src_path_len)) {
                set_session_error(s, "String table resource limit exceeded");
                status = SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
                goto cleanup;
            }

            for (int r = 0; r < resolved_calls.count; r++) {
                CBMResolvedCall *rc = &resolved_calls.items[r];
                if (rc->confidence == 0.0f || (rc->strategy && strcmp(rc->strategy, "lsp_unresolved") == 0)) {
                    continue; // Skip unresolved diagnostic entries from relationship stream
                }

                SatoriSemanticResultV1 *dst = &s->results[s->result_count++];
                memset(dst, 0, sizeof(SatoriSemanticResultV1));

                dst->source_file_offset = src_path_off;
                dst->source_file_length = src_path_len;
                dst->call_start_byte = rc->site_start_byte;
                dst->call_end_byte = rc->site_end_byte;

                if (rc->callee_qn) {
                    const SatoriDefLoc *dl = def_locs_find(&def_locs, rc->callee_qn);
                    if (dl) {
                        const char *target_name = rc->callee_qn;
                        const char *last_dot = strrchr(rc->callee_qn, '.');
                        if (last_dot) {
                            target_name = last_dot + 1;
                        }
                        uint32_t target_len = (uint32_t)strlen(target_name);
                        if (!str_table_intern_checked(&s->str_table, target_name, target_len, &dst->target_name_offset, &dst->target_name_length)) {
                            set_session_error(s, "String table resource limit exceeded");
                            status = SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
                            goto cleanup;
                        }
                        if (!str_table_intern_checked(&s->str_table, dl->file_path, dl->file_path_len, &dst->target_file_offset, &dst->target_file_length)) {
                            set_session_error(s, "String table resource limit exceeded");
                            status = SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
                            goto cleanup;
                        }
                        dst->target_start_byte = dl->start_byte;
                        dst->target_end_byte = dl->end_byte;
                        dst->decision = (uint8_t)SATORI_DECISION_RESOLVED;
                    } else {
                        dst->decision = (uint8_t)SATORI_DECISION_UNRESOLVED;
                    }
                } else {
                    dst->decision = (uint8_t)SATORI_DECISION_UNRESOLVED;
                }

                dst->strategy = map_strategy(rc->strategy);
                dst->confidence = rc->confidence > 0.0f ? rc->confidence : 0.95f;
                if (dst->strategy == SATORI_STRATEGY_TYPE_DISPATCH || dst->strategy == SATORI_STRATEGY_EMBED_DISPATCH || dst->strategy == SATORI_STRATEGY_INTERFACE_DISPATCH) {
                    dst->target_kind = (uint8_t)SATORI_TARGET_METHOD;
                    if (rc->callee_qn) {
                        const char *first_dot = strchr(rc->callee_qn, '.');
                        const char *last_dot = strrchr(rc->callee_qn, '.');
                        if (first_dot && last_dot && last_dot > first_dot) {
                            uint32_t rlen = (uint32_t)(last_dot - first_dot - 1);
                            char recv_buf[128];
                            if (rlen < sizeof(recv_buf)) {
                                memcpy(recv_buf, first_dot + 1, rlen);
                                recv_buf[rlen] = '\0';
                                if (!str_table_intern_checked(&s->str_table, recv_buf, rlen, &dst->receiver_type_offset, &dst->receiver_type_length)) {
                                    set_session_error(s, "String table resource limit exceeded");
                                    status = SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED;
                                    goto cleanup;
                                }
                                dst->receiver_binding_kind = (uint8_t)SATORI_BINDING_NONE;
                            }
                        }
                    }
                } else {
                    dst->target_kind = (uint8_t)SATORI_TARGET_FUNCTION;
                }
            }
        }
    }

cleanup:
    if (trees) {
        for (uint32_t i = 0; i < s->source_count; i++) {
            if (trees[i]) {
                ts_tree_delete(trees[i]);
                trees[i] = NULL;
            }
        }
        free(trees);
    }
    free(def_locs.items);
    if (parser) {
        ts_parser_delete(parser);
    }
    return status;
}

uint32_t satori_semantic_result_count(SatoriSemanticHandle handle) {
    SatoriSession *s = find_session(handle);
    if (!s) return 0;
    return s->result_count;
}

const SatoriSemanticResultV1 *satori_semantic_results(SatoriSemanticHandle handle) {
    SatoriSession *s = find_session(handle);
    if (!s) return NULL;
    return s->results;
}

uint32_t satori_semantic_relationship_count(SatoriSemanticHandle handle) {
    return satori_semantic_result_count(handle);
}

const SatoriSemanticResultV1 *satori_semantic_relationships(SatoriSemanticHandle handle) {
    return satori_semantic_results(handle);
}

uint32_t satori_semantic_definition_count(SatoriSemanticHandle handle) {
    (void)handle;
    return 0; // Frozen multi-stream ABI contract (returns 0 in milestone 1)
}

const SatoriSemanticDefinitionV1 *satori_semantic_definitions(SatoriSemanticHandle handle) {
    (void)handle;
    return NULL;
}

uint32_t satori_semantic_diagnostic_count(SatoriSemanticHandle handle) {
    (void)handle;
    return 0; // Frozen multi-stream ABI contract (returns 0 in milestone 1)
}

const SatoriSemanticDiagnosticV1 *satori_semantic_diagnostics(SatoriSemanticHandle handle) {
    (void)handle;
    return NULL;
}

const char *satori_semantic_string_table(SatoriSemanticHandle handle, uint32_t *out_table_len) {
    SatoriSession *s = find_session(handle);
    if (!s) {
        if (out_table_len) *out_table_len = 0;
        return NULL;
    }
    if (out_table_len) *out_table_len = s->str_table.len;
    return s->str_table.data ? s->str_table.data : "";
}

void satori_semantic_destroy(SatoriSemanticHandle handle) {
    SatoriSession *s = find_session(handle);
    if (!s) return;

    for (uint32_t i = 0; i < s->source_count; i++) {
        free(s->sources[i].path);
        free(s->sources[i].source);
    }
    free(s->sources);

    for (uint32_t i = 0; i < s->aux_count; i++) {
        free(s->auxiliaries[i].role);
        free(s->auxiliaries[i].path);
        free(s->auxiliaries[i].source);
    }
    free(s->auxiliaries);

    free(s->results);
    free(s->str_table.data);
    cbm_arena_destroy(&s->arena);

    memset(s, 0, sizeof(SatoriSession));
    s->active = false;
}

void satori_semantic_free(SatoriSemanticHandle handle) {
    satori_semantic_destroy(handle);
}

int satori_semantic_go_smoke(void) {
    SatoriSemanticHandle h = 0;
    int rc = satori_semantic_create("go", 2, &h);
    if (rc != SATORI_SEMANTIC_OK) return rc;

    const char *go_src = "package main\n\nfunc hello() {}\nfunc main() {\n    hello()\n}\n";
    rc = satori_semantic_add_source(h, "main.go", 7, go_src, (uint32_t)strlen(go_src));
    if (rc != SATORI_SEMANTIC_OK) {
        satori_semantic_destroy(h);
        return rc;
    }

    rc = satori_semantic_resolve(h);
    if (rc != SATORI_SEMANTIC_OK) {
        satori_semantic_destroy(h);
        return rc;
    }

    uint32_t count = satori_semantic_relationship_count(h);
    (void)count;
    satori_semantic_destroy(h);
    return 0;
}
