# CBM definition extractor sources

Pinned upstream commit: `11b662f9f7fba92012b872dd4fcaef7ee0c1300d` ([codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)).

These files are copied from that commit. Grammar sources are read from the pinned checkout during the build.

## Local patches

- `internal/cbm/cbm.h`: append `start_byte` and `end_byte` to `CBMDefinition`.
- `internal/cbm/extract_defs.c`: set both byte spans at all 22 definition line-span sites.
- `satori_extractor.c` and `satori_shim.c` are Satori-owned ABI and link shims.

## Vendored files

- `LICENSE`
- `internal/cbm/arena.h`
- `internal/cbm/cbm.h`
- `internal/cbm/extract_defs.c`
- `internal/cbm/extract_node_stack.h`
- `internal/cbm/helpers.c`
- `internal/cbm/helpers.h`
- `internal/cbm/lang_specs.c`
- `internal/cbm/lang_specs.h`
- `internal/cbm/ts_runtime.c`
- `internal/cbm/vendored/ts_runtime/LICENSE`
- `internal/cbm/vendored/ts_runtime/include/tree_sitter/api.h`
- `internal/cbm/vendored/ts_runtime/src/alloc.c`
- `internal/cbm/vendored/ts_runtime/src/alloc.h`
- `internal/cbm/vendored/ts_runtime/src/array.h`
- `internal/cbm/vendored/ts_runtime/src/atomic.h`
- `internal/cbm/vendored/ts_runtime/src/error_costs.h`
- `internal/cbm/vendored/ts_runtime/src/get_changed_ranges.c`
- `internal/cbm/vendored/ts_runtime/src/get_changed_ranges.h`
- `internal/cbm/vendored/ts_runtime/src/host.h`
- `internal/cbm/vendored/ts_runtime/src/language.c`
- `internal/cbm/vendored/ts_runtime/src/language.h`
- `internal/cbm/vendored/ts_runtime/src/length.h`
- `internal/cbm/vendored/ts_runtime/src/lexer.c`
- `internal/cbm/vendored/ts_runtime/src/lexer.h`
- `internal/cbm/vendored/ts_runtime/src/lib.c`
- `internal/cbm/vendored/ts_runtime/src/node.c`
- `internal/cbm/vendored/ts_runtime/src/parser.c`
- `internal/cbm/vendored/ts_runtime/src/parser.h`
- `internal/cbm/vendored/ts_runtime/src/point.c`
- `internal/cbm/vendored/ts_runtime/src/point.h`
- `internal/cbm/vendored/ts_runtime/src/portable/endian.h`
- `internal/cbm/vendored/ts_runtime/src/query.c`
- `internal/cbm/vendored/ts_runtime/src/reduce_action.h`
- `internal/cbm/vendored/ts_runtime/src/reusable_node.h`
- `internal/cbm/vendored/ts_runtime/src/stack.c`
- `internal/cbm/vendored/ts_runtime/src/stack.h`
- `internal/cbm/vendored/ts_runtime/src/subtree.c`
- `internal/cbm/vendored/ts_runtime/src/subtree.h`
- `internal/cbm/vendored/ts_runtime/src/tree.c`
- `internal/cbm/vendored/ts_runtime/src/tree.h`
- `internal/cbm/vendored/ts_runtime/src/tree_cursor.c`
- `internal/cbm/vendored/ts_runtime/src/tree_cursor.h`
- `internal/cbm/vendored/ts_runtime/src/ts_assert.h`
- `internal/cbm/vendored/ts_runtime/src/unicode.h`
- `internal/cbm/vendored/ts_runtime/src/unicode/ptypes.h`
- `internal/cbm/vendored/ts_runtime/src/unicode/umachine.h`
- `internal/cbm/vendored/ts_runtime/src/unicode/urename.h`
- `internal/cbm/vendored/ts_runtime/src/unicode/utf.h`
- `internal/cbm/vendored/ts_runtime/src/unicode/utf16.h`
- `internal/cbm/vendored/ts_runtime/src/unicode/utf8.h`
- `internal/cbm/vendored/ts_runtime/src/wasm_store.c`
- `internal/cbm/vendored/ts_runtime/src/wasm_store.h`
- `src/foundation/arena.c`
- `src/foundation/arena.h`
- `src/foundation/compat.h`
- `src/foundation/constants.h`
- `src/foundation/log.h`
- `src/foundation/mem_core.h`
- `src/foundation/mem_events.h`
- `src/foundation/platform.h`
- `src/semantic/ast_profile.c`
- `src/semantic/ast_profile.h`
- `src/simhash/minhash.c`
- `src/simhash/minhash.h`
- `vendored/xxhash/LICENSE`
- `vendored/xxhash/xxhash.h`
