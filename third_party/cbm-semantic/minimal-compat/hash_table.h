/*
 * Copyright (c) 2024 DeusData / Codebase Memory MCP contributors
 * Copyright (c) 2026 Satori Project contributors
 *
 * Licensed under the MIT License.
 * Satori shim for codebase-memory-mcp src/foundation/hash_table.h: the same
 * contract (string -> void*, borrowed keys) for the subset the vendored
 * resolvers use, without CBM's memory-accounting allocator stack.
 */
#ifndef CBM_HASH_TABLE_H
#define CBM_HASH_TABLE_H

#include <stdbool.h>
#include <stdint.h>

typedef struct CBMHashTable CBMHashTable;

CBMHashTable *cbm_ht_create(uint32_t initial_capacity);
void cbm_ht_free(CBMHashTable *ht);
void *cbm_ht_set(CBMHashTable *ht, const char *key, void *value);
void *cbm_ht_get(const CBMHashTable *ht, const char *key);
bool cbm_ht_has(const CBMHashTable *ht, const char *key);

#endif /* CBM_HASH_TABLE_H */
