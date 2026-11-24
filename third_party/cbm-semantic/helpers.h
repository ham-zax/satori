#ifndef SATORI_HELPERS_MINIMAL_H
#define SATORI_HELPERS_MINIMAL_H

#include "cbm.h"

static inline char *cbm_node_text(CBMArena *a, TSNode node, const char *source) {
    uint32_t start = ts_node_start_byte(node);
    uint32_t end = ts_node_end_byte(node);
    if (end <= start) {
        return cbm_arena_strdup(a, "");
    }
    return cbm_arena_strndup(a, source + start, end - start);
}

static inline bool cbm_is_keyword(const char *name, CBMLanguage lang) {
    if (!name || !name[0]) return true;
    if (lang != CBM_LANG_RUST) return false;
    static const char *const rust_keywords[] = {
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
        "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
        "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
        "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
        "abstract", "become", "box", "do", "final", "macro", "override", "priv", "try",
        "typeof", "unsized", "virtual", "yield", "Some", "None", "Ok", "Err", "Vec",
        "String", "Box", "Rc", "Arc", "Option", "Result", "println", "eprintln", "format",
        "write", "writeln", "print", "eprint", "panic", "assert", "assert_eq", "assert_ne",
        "debug_assert", "todo", "unimplemented", "cfg", "derive", "test", "allow", "deny",
        "warn", "forbid", "deprecated", NULL
    };
    for (const char *const *keyword = rust_keywords; *keyword; keyword++) {
        if (strcmp(name, *keyword) == 0) return true;
    }
    return false;
}

/* 1-based ordinal of a Go `init` function_declaration among its file's top-level
 * `init` functions (QN disambiguation, #1910 / 6e784c38). */
static inline int satori_go_init_ordinal(TSNode fn_node, const char *source) {
    TSNode root = fn_node;
    for (TSNode p = ts_node_parent(root); !ts_node_is_null(p); p = ts_node_parent(p)) {
        root = p;
    }
    int ordinal = 0;
    TSTreeCursor cur = ts_tree_cursor_new(root);
    if (ts_tree_cursor_goto_first_child(&cur)) {
        do {
            TSNode child = ts_tree_cursor_current_node(&cur);
            if (strcmp(ts_node_type(child), "function_declaration") != 0) {
                continue;
            }
            TSNode name = ts_node_child_by_field_name(child, "name", 4);
            if (ts_node_is_null(name)) {
                continue;
            }
            uint32_t start = ts_node_start_byte(name);
            if (ts_node_end_byte(name) - start != 4 || memcmp(source + start, "init", 4) != 0) {
                continue;
            }
            ordinal++;
            if (ts_node_eq(child, fn_node)) {
                break;
            }
        } while (ts_tree_cursor_goto_next_sibling(&cur));
    }
    ts_tree_cursor_delete(&cur);
    return ordinal;
}

static inline const char *cbm_go_init_qn(CBMArena *a, const char *base_qn, const char *rel_path,
                                         TSNode fn_node, const char *source) {
    if (!base_qn || !rel_path) {
        return base_qn;
    }
    const char *base = strrchr(rel_path, '/');
    base = base ? base + 1 : rel_path;
    const char *qn =
        cbm_arena_sprintf(a, "%s#%s:%d", base_qn, base, satori_go_init_ordinal(fn_node, source));
    return qn ? qn : base_qn;
}

static inline char *cbm_go_receiver_type_name(CBMArena *a, TSNode recv, const char *source) {
    uint32_t nc = ts_node_child_count(recv);
    for (uint32_t i = 0; i < nc; i++) {
        TSNode child = ts_node_child(recv, i);
        if (strcmp(ts_node_type(child), "parameter_declaration") != 0) {
            continue;
        }
        TSNode tn = ts_node_child_by_field_name(child, "type", 4);
        if (ts_node_is_null(tn)) {
            continue;
        }
        for (int guard = 0; guard < 4 && !ts_node_is_null(tn); guard++) {
            const char *tk = ts_node_type(tn);
            if (strcmp(tk, "type_identifier") == 0) {
                return cbm_node_text(a, tn, source);
            }
            if (strcmp(tk, "pointer_type") == 0 || strcmp(tk, "generic_type") == 0) {
                TSNode inner = ts_node_child_by_field_name(tn, "type", 4);
                if (ts_node_is_null(inner)) {
                    inner = ts_node_named_child(tn, 0);
                }
                tn = inner;
                continue;
            }
            break;
        }
    }
    return NULL;
}

/* GoogleTest TEST(Suite, Case) macro head naming (#3048 / fb690ae9). */
static inline bool satori_is_cpp_test_macro(const char *name) {
    return strcmp(name, "TEST") == 0 || strcmp(name, "TEST_F") == 0 ||
           strcmp(name, "TEST_P") == 0 || strcmp(name, "TYPED_TEST") == 0 ||
           strcmp(name, "TYPED_TEST_P") == 0;
}

static inline char *satori_cpp_test_arg_text(char *text) {
    if (!text) return NULL;
    char *w = text;
    for (const char *r = text; *r;) {
        if (r[0] == '/' && r[1] == '*') {
            const char *close = strstr(r + 2, "*/");
            r = close ? close + 2 : r + strlen(r);
            *w++ = ' ';
        } else if (r[0] == '/' && r[1] == '/') {
            while (*r && *r != '\n') r++;
        } else {
            *w++ = *r++;
        }
    }
    *w = '\0';
    while (w > text && (w[-1] == ' ' || w[-1] == '\t' || w[-1] == '\n' || w[-1] == '\r')) *--w = '\0';
    char *start = text;
    while (*start == ' ' || *start == '\t' || *start == '\n' || *start == '\r') start++;
    return start;
}

static inline TSNode satori_find_c_params(TSNode node) {
    TSNode decl = ts_node_child_by_field_name(node, "declarator", 10);
    while (!ts_node_is_null(decl)) {
        TSNode params = ts_node_child_by_field_name(decl, "parameters", 10);
        if (!ts_node_is_null(params)) return params;
        decl = ts_node_child_by_field_name(decl, "declarator", 10);
    }
    TSNode empty;
    memset(&empty, 0, sizeof(empty));
    return empty;
}

static inline char *cbm_cpp_test_macro_name(CBMArena *a, bool enabled, const char *name,
                                            TSNode func_node, const char *source) {
    if (!enabled || !name || !source || ts_node_is_null(func_node) ||
        !satori_is_cpp_test_macro(name)) {
        return NULL;
    }
    TSNode params = ts_node_child_by_field_name(func_node, "parameters", 10);
    if (ts_node_is_null(params)) params = satori_find_c_params(func_node);
    if (ts_node_is_null(params)) return NULL;
    const char *args[2] = {NULL, NULL};
    int count = 0;
    uint32_t nc = ts_node_named_child_count(params);
    for (uint32_t i = 0; i < nc && count < 2; i++) {
        TSNode child = ts_node_named_child(params, i);
        if (ts_node_is_null(child) || strcmp(ts_node_type(child), "comment") == 0) continue;
        TSNode type_node = ts_node_child_by_field_name(child, "type", 4);
        char *text = satori_cpp_test_arg_text(
            cbm_node_text(a, ts_node_is_null(type_node) ? child : type_node, source));
        if (text && text[0]) args[count++] = text;
    }
    if (count == 2) return cbm_arena_sprintf(a, "%s_%s_%s", name, args[0], args[1]);
    if (count == 1) return cbm_arena_sprintf(a, "%s_%s", name, args[0]);
    return NULL;
}

#endif /* SATORI_HELPERS_MINIMAL_H */
