/*
 * Copyright (c) 2026 Satori Project contributors
 *
 * Licensed under the MIT License.
 * Open-addressing string table implementing the minimal-compat
 * hash_table.h contract. Keys are borrowed; the table never copies or
 * frees keys or values. A failed allocation leaves the table unchanged and
 * cbm_ht_set returns NULL, matching "new key" from the caller's view.
 */
#include "hash_table.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *key;
    void *value;
} CBMHashEntry;

struct CBMHashTable {
    CBMHashEntry *entries;
    uint32_t capacity; /* power of two */
    uint32_t count;
};

static uint32_t hash_key(const char *key) {
    uint32_t h = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)key; *p; p++) {
        h ^= *p;
        h *= 16777619u;
    }
    return h;
}

static CBMHashEntry *find_slot(CBMHashEntry *entries, uint32_t capacity, const char *key) {
    uint32_t i = hash_key(key) & (capacity - 1);
    for (;;) {
        CBMHashEntry *e = &entries[i];
        if (!e->key || strcmp(e->key, key) == 0) return e;
        i = (i + 1) & (capacity - 1);
    }
}

static bool grow(CBMHashTable *ht) {
    uint32_t capacity = ht->capacity * 2;
    CBMHashEntry *entries = calloc(capacity, sizeof(CBMHashEntry));
    if (!entries) return false;
    for (uint32_t i = 0; i < ht->capacity; i++) {
        if (ht->entries[i].key) *find_slot(entries, capacity, ht->entries[i].key) = ht->entries[i];
    }
    free(ht->entries);
    ht->entries = entries;
    ht->capacity = capacity;
    return true;
}

CBMHashTable *cbm_ht_create(uint32_t initial_capacity) {
    uint32_t capacity = 16;
    while (capacity < initial_capacity * 2 && capacity < (1u << 30)) capacity *= 2;
    CBMHashTable *ht = calloc(1, sizeof(CBMHashTable));
    if (!ht) return NULL;
    ht->entries = calloc(capacity, sizeof(CBMHashEntry));
    if (!ht->entries) {
        free(ht);
        return NULL;
    }
    ht->capacity = capacity;
    return ht;
}

void cbm_ht_free(CBMHashTable *ht) {
    if (!ht) return;
    free(ht->entries);
    free(ht);
}

void *cbm_ht_set(CBMHashTable *ht, const char *key, void *value) {
    if (!ht || !key) return NULL;
    if ((ht->count + 1) * 4 > ht->capacity * 3 && !grow(ht)) return NULL;
    CBMHashEntry *e = find_slot(ht->entries, ht->capacity, key);
    if (e->key) {
        void *previous = e->value;
        e->value = value;
        return previous;
    }
    e->key = key;
    e->value = value;
    ht->count++;
    return NULL;
}

void *cbm_ht_get(const CBMHashTable *ht, const char *key) {
    if (!ht || !key) return NULL;
    CBMHashEntry *e = find_slot(ht->entries, ht->capacity, key);
    return e->key ? e->value : NULL;
}

bool cbm_ht_has(const CBMHashTable *ht, const char *key) {
    if (!ht || !key) return false;
    return find_slot(ht->entries, ht->capacity, key)->key != NULL;
}
