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

#endif /* SATORI_HELPERS_MINIMAL_H */
