# Upstream Provenance: CBM Semantic Engine for Satori

This directory vendors a minimal, self-contained semantic analysis closure extracted from [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp) and Tree-sitter, compiled to WebAssembly for language intelligence in Satori.

## Pinned Upstream References

| Component | Upstream Repository | Pinned Commit / Version | License |
|---|---|---|---|
| CBM Core & Go Resolver | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | `d150ebe4fc78a9a3f85013d2087a849e5d59eb0f` | MIT |
| Tree-sitter C Runtime | [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | `v0.24.4` (`64f26b5272a2e8c2534cece6e3f4d6d67ddf70dc`) | MIT |
| Tree-sitter Go Grammar | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | `v0.23.4` (`a28f4c274719be1e2aa652eb6bd391c5dd97a3cf`) | MIT |

## Vendored Components

1. **Common Core (`common/`)**:
   - `arena.c`, `arena.h`: Bump-pointer memory allocator for AST traversal and type structures.
   - `scope.c`, `scope.h`: Hierarchical lexical scoping table for variable and type bindings.
   - `type_rep.c`, `type_rep.h`: Structural representation of primitives, pointers, structs, interfaces, and function signatures.
   - `type_registry.c`, `type_registry.h`: Project-wide type and function definition registry with field and method resolution.

2. **Go Resolver (`languages/go/`)**:
   - `go_lsp.c`, `go_lsp.h`: AST type-evaluator and call-resolver for Go, implementing package qualification, method receiver resolution, struct embedding promotion, and composite literal type inference.
   - `go_stdlib_data.c`: Pre-compiled type and function signatures for the standard Go library.

3. **Tree-sitter Runtime (`tree_sitter/`)**:
   - `api.h` and C parser runtime implementation (`lib.c`, `alloc.c`, `parser.c`, `node.c`, `tree.c`, etc.).

4. **Tree-sitter Go Grammar (`grammars/tree-sitter-go/`)**:
   - `parser.c`: Generated Tree-sitter parse tables and lexer for Go source files.

5. **Satori Bridge & ABI (`satori_semantic.h`, `satori_semantic.c`)**:
   - Fixed-width 64-byte POD result structures (`SatoriSemanticResultV1`), UTF-8 string table, and memory-safe isolated handle lifecycle.

## License Notices

All vendored components are licensed under the MIT License. See `packages/core/assets/semantic-engine/THIRD_PARTY_LICENSES.md` for full license texts.
