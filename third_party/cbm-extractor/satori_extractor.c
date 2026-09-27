#include "foundation/arena.h"
#include "cbm.h"
#include "helpers.h"
#include "lang_specs.h"
#include "tree_sitter/api.h"
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef SATORI_CBM_LANG
#error SATORI_CBM_LANG must select a CBM language
#endif

static char *result_buffer;
static size_t result_length;
static size_t result_capacity;
/* CBM qualified names are "<project>.<module path>.<name>"; with the empty
 * project the module prefix is what cbm_fqn_module_source_lang returns for
 * rel_path, exactly as CBM's own pipeline computes it (cbm.c). */
static const char *module_prefix;

static void clear_result(void) {
    free(result_buffer);
    result_buffer = NULL;
    result_length = 0;
    result_capacity = 0;
}

static int append_bytes(const char *text, size_t length) {
    if (length > INT_MAX || result_length > INT_MAX - length) return 0;
    size_t needed = result_length + length + 1;
    if (needed > result_capacity) {
        size_t capacity = result_capacity ? result_capacity : 256;
        while (capacity < needed) capacity *= 2;
        char *grown = realloc(result_buffer, capacity);
        if (!grown) return 0;
        result_buffer = grown;
        result_capacity = capacity;
    }
    memcpy(result_buffer + result_length, text, length);
    result_length += length;
    result_buffer[result_length] = '\0';
    return 1;
}

static int append_field(const char *value, int strip_module_prefix) {
    if (!value) return 1;
    if (strip_module_prefix && module_prefix) {
        size_t prefix_length = strlen(module_prefix);
        if (strcmp(value, module_prefix) == 0) value += prefix_length;
        else if (strncmp(value, module_prefix, prefix_length) == 0 && value[prefix_length] == '.') value += prefix_length + 1;
        else if (value[0] == '.') value += 1; /* project-rooted QN outside this module */
    }
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
        const char output = (*cursor == '\t' || *cursor == '\r' || *cursor == '\n') ? ' ' : (char)*cursor;
        if (!append_bytes(&output, 1)) return 0;
    }
    return 1;
}

static int append_number(uint32_t value) {
    char digits[16];
    int length = snprintf(digits, sizeof(digits), "%u", value);
    return length > 0 && append_bytes(digits, (size_t)length);
}

static int append_definition(const CBMDefinition *definition) {
    const char tab = '\t';
    const char newline = '\n';
    return append_field(definition->label, 0) && append_bytes(&tab, 1) &&
           append_field(definition->name, 0) && append_bytes(&tab, 1) &&
           append_field(definition->qualified_name, 1) && append_bytes(&tab, 1) &&
           append_field(definition->parent_class, 1) && append_bytes(&tab, 1) &&
           append_number(definition->start_line) && append_bytes(&tab, 1) &&
           append_number(definition->end_line) && append_bytes(&tab, 1) &&
           append_number(definition->start_byte) && append_bytes(&tab, 1) &&
           append_number(definition->end_byte) && append_bytes(&newline, 1);
}

int satori_extract(const char *src, int len, const char *rel_path) {
    clear_result();
    if (!src || len < 0 || !rel_path) return -1;
    const TSLanguage *language = cbm_ts_language(SATORI_CBM_LANG);
    if (!language) return -1;
    TSParser *parser = ts_parser_new();
    if (!parser) return -1;
    if (!ts_parser_set_language(parser, language)) {
        ts_parser_delete(parser);
        return -1;
    }
    TSTree *tree = ts_parser_parse_string(parser, NULL, src, (uint32_t)len);
    if (!tree) {
        ts_parser_delete(parser);
        return -1;
    }
    CBMFileResult *result = cbm_result_alloc();
    if (!result) {
        ts_tree_delete(tree);
        ts_parser_delete(parser);
        return -1;
    }
    cbm_arena_init(&result->arena);
    CBMArena scratch;
    cbm_arena_init_lazy(&scratch, 512 * 1024);
    module_prefix = cbm_fqn_module_source_lang(&result->arena, "", rel_path, SATORI_CBM_LANG);
    CBMExtractCtx context = {
        .arena = &result->arena,
        .scratch = &scratch,
        .result = result,
        .source = src,
        .source_len = len,
        .language = SATORI_CBM_LANG,
        .project = "",
        .rel_path = rel_path,
        .module_qn = module_prefix,
        .root = ts_tree_root_node(tree),
        .walk_budget_nodes = 0, /* CBM_WALK_MAX_NODES_DEFAULT at the pinned commit. */
    };
    cbm_extract_definitions(&context);
    int count = result->defs.count;
    int valid = 1;
    for (int index = 0; index < count; index++) {
        if (!append_definition(&result->defs.items[index])) {
            valid = 0;
            break;
        }
    }
    module_prefix = NULL;
    cbm_arena_destroy(&scratch);
    cbm_arena_destroy(&result->arena);
    free(result);
    ts_tree_delete(tree);
    ts_parser_delete(parser);
    if (!valid) {
        clear_result();
        return -1;
    }
    return count;
}

const char *satori_result_ptr(void) { return result_buffer; }
int satori_result_len(void) { return (int)result_length; }
