# Phase L1: Language Capability Matrix + Symbol Extractor Harness

**Status:** historical implementation plan; its matrix and first structural
symbol-extractor batches are implemented. Remaining definition-coverage work is
superseded by
`docs/plans/MULTI_LANGUAGE_SYMBOL_DEFINITION_PARITY_PLAN.md`.

The baseline and handoff descriptions below are retained to explain the
original implementation contract. They are not current repository status and
must not be used as an executable next-action plan.

## Capability

Satori should be able to add broader language support without turning every routed extension into a graph-navigation claim. Phase L1 creates an implementation-facing capability matrix and a symbol extractor harness so new languages can earn symbol-owned search, `file_outline`, and `read_file(open_symbol)` support independently from `IMPORTS`, `EXPORTS`, `CALLS`, and type-aware traversal.

This is a core-pipeline expansion plan, not a new MCP product surface.

## Current Baseline

- Public MCP surface is fixed at six tools: `list_codebases`, `manage_index`, `search_codebase`, `file_outline`, `call_graph`, and `read_file`.
- `packages/core/src/language/registry.ts` currently exposes boolean capabilities such as `search`, `astSplitter`, `symbols`, `owner`, `imports`, `callGraphBuild`, `callGraphQuery`, and `fileOutline`.
- TypeScript, JavaScript, and Python currently claim full navigation capabilities, including production-ready `call_graph`.
- Go and Rust currently claim `symbol_only`: extractor-backed symbol records, owner metadata, `file_outline`, and `read_file(open_symbol)` are fixture-proven, but `call_graph` remains unsupported.
- Java, C++, C#, and Scala currently have tree-sitter parser wiring for AST splitting, but they do not produce symbol labels and do not claim symbols or owners.
- PHP, Ruby, Kotlin, and Swift currently route as search-only.
- `processFileList` in production returns `status`, `symbolRecords`, and `symbolManifestFiles`, and it attaches `ownerSymbolKey` and `ownerSymbolInstanceId` to chunks through `resolveOwnerSymbolForChunk`.
- The relationship builder already stores conservative `CALLS`, `IMPORTS`, and `EXPORTS` records behind relationship sidecars. That behavior must not be widened by L1.
- MCP `call_graph` support is currently gated through language capability checks for `callGraphQuery` plus compatible relationship state. L1 must keep that gate closed for new symbol-only languages.

## Constraints

- Do not copy a "158 languages" claim as a single product promise.
- Language support must be claimed by capability tier, not by extension count.
- Files on disk and snapshot/fingerprint state remain the source of truth.
- Symbol records, relationship records, JSON sidecars, and SQLite cache remain derived navigation state.
- Search eligibility does not imply symbol extraction, ownership, outline, import/export, call graph, or type-aware traversal.
- `file_outline` and `read_file(open_symbol)` require deterministic symbol records and compatible registry state.
- `call_graph` support requires relationship fixtures, relationship manifests, compatible registry manifests, and MCP tests.
- L1 symbol-only languages must not claim `callGraphBuild` or `callGraphQuery`, must not emit `nextActions.callGraph`, and must keep `call_graph` unsupported or not-ready even when relationship sidecars exist globally.
- Low-confidence or name-only relationship extraction must not be presented as graph truth.
- Adding extensions to the capability matrix must not silently broaden the default indexing profile. Any profile expansion needs an explicit allowlist/profile test.
- JSON navigation sidecars remain canonical. SQLite is optional cache/validation/parity-gated explicit serving only; explicit SQLite reads require canonical JSON registry and relationship sidecar parity. Do not add SQLite-default work in this patch family.
- If any CMM code, tables, schemas, tests, fixtures, parser mappings, or generated artifacts are copied or substantially ported, the same patch must add `THIRD_PARTY.md` with MIT attribution.

## Non-Goals

- Do not add MCP tools.
- Do not expose raw SQL, Cypher, graph visualization, ADR workflows, dead-code claims, route/resource claims, or cross-service claims.
- Do not copy CMM's public MCP surface or query UX.
- Do not add `call_graph` claims for Go, Rust, Java, C#, PHP, Ruby, Kotlin, or Swift in L1.
- Do not broaden default indexing policy as a hidden side effect of language routing. Any index-profile expansion must be explicit and separately tested.
- Do not make import/export or call extraction part of the symbol-only acceptance gate.
- Do not remove remaining legacy v3 navigation identity/fallback paths in this L1 plan. That belongs to the separate Phase 2B cleanup patch.

## Capability Matrix Contract

Add a canonical capability declaration model with these columns:

```text
languageId
aliases
extensions
filenames
searchEligibility
parserCapability
symbolExtractionCapability
ownerExtractionCapability
importExportCapability
callsCapability
typeReceiverAwareCapability
fixtures
publicClaim
```

Recommended TypeScript shape:

```ts
export type CapabilityStatus =
    | "none"
    | "declared"
    | "fixture_covered"
    | "production_ready";

export interface LanguageCapabilityDeclaration {
    languageId: string;
    aliases: string[];
    extensions: string[];
    filenames?: string[];
    searchEligibility: CapabilityStatus;
    parserCapability: CapabilityStatus;
    symbolExtractionCapability: CapabilityStatus;
    ownerExtractionCapability: CapabilityStatus;
    importExportCapability: CapabilityStatus;
    callsCapability: CapabilityStatus;
    typeReceiverAwareCapability: CapabilityStatus;
    fixtures: {
        symbols?: string[];
        importsExports?: string[];
        calls?: string[];
        typeReceiverAware?: string[];
    };
    publicClaim: "search_only" | "symbol_only" | "imports_exports" | "calls_v0" | "type_receiver_aware";
}
```

Implementation files:

- `packages/core/src/languages/capabilities.ts` as the canonical matrix source.
- `packages/core/src/languages/types.ts` for matrix and extractor types.
- `packages/core/src/languages/extractors/registry.ts` for extractor lookup.
- `packages/core/src/languages/extractors/tree-sitter.ts` for generic tree-sitter symbol extraction helpers.
- `packages/core/src/language/registry.ts` remains a compatibility facade for current imports and maps the new matrix into the existing boolean `LanguageAdapterCapabilities`.

Compatibility mapping:

| Existing capability | Derived from new matrix |
| --- | --- |
| `search` | `searchEligibility != "none"` |
| `astSplitter` | `parserCapability != "none"` |
| `symbols` / `symbolMetadata` | `symbolExtractionCapability == "production_ready"` |
| `owner` | `ownerExtractionCapability == "production_ready"` |
| `imports` | `importExportCapability == "production_ready"` |
| `fileOutline` | `symbolExtractionCapability == "production_ready"` and registry fixtures pass |
| `callGraphBuild` / `callGraphQuery` | `callsCapability == "production_ready"` and relationship fixtures pass |
| `testLinks` | unchanged until relationship test-reference support is deliberately expanded |

The compatibility facade must be deterministic and tested. There must be one source of truth for capability declarations.

### Capability Status Semantics

`CapabilityStatus` values are internal implementation states, not marketing labels:

- `none`: no support is claimed and no runtime path may assume this capability exists.
- `declared`: routing or implementation scaffolding exists, but the capability is not publicly claimable.
- `fixture_covered`: focused extractor or relationship fixtures pass, but the full production proof path is incomplete.
- `production_ready`: all proof gates for that capability pass and docs may claim the capability at its tier.

For `symbolExtractionCapability`, `production_ready` requires all of the following:

- Extractor fixtures pass for the language.
- Parser/extractor failure fixtures prove malformed or unsupported source degrades to synthesized file-owner fallback.
- Indexing tests prove `ownerSymbolKey` and `ownerSymbolInstanceId` attach to chunks from extracted symbols.
- Indexing tests prove malformed or unsupported source does not crash and does not attach stale source-symbol owner metadata.
- `file_outline` tests pass for the language.
- `read_file(open_symbol)` tests pass with `symbolInstanceId`.
- Search tests prove no `nextActions.callGraph` is emitted for that language unless `callsCapability` is independently `production_ready`.

For `callsCapability`, `production_ready` additionally requires relationship fixture coverage and MCP `call_graph` traversal tests. Global relationship sidecar presence is not enough.

## Extractor Harness Contract

The splitter should not remain the only owner of symbol identity. L1 should introduce a symbol extractor seam while preserving the current TS/JS/Python behavior.

Core contracts:

- Splitters own chunking.
- Extractors own symbol candidates.
- `buildSymbolRecordsForFile` owns stable `symbolKey`, exact `symbolInstanceId`, synthesized file owners, deterministic sorting, and manifest-ready `SymbolRecord` output.
- Owner resolution owns mapping chunks to the tightest source symbol or synthesized file owner.

Recommended extractor interface:

```ts
export interface ExtractedSymbol {
    kind: "file" | "class" | "interface" | "type" | "function" | "method" | "constructor" | "struct" | "enum" | "trait" | "module" | "constant" | "variable";
    name: string;
    label: string;
    qualifiedName?: string;
    parentQualifiedNamePath?: string[];
    span: {
        startLine: number;
        endLine: number;
    };
}

export interface SymbolExtractor {
    languageId: string;
    extractorVersion: string;
    extract(input: {
        content: string;
        relativePath: string;
    }): ExtractedSymbol[];
}
```

L1 integration options:

- Preferred: `buildSymbolRecordsForFile` accepts explicit `extractedSymbols` and falls back to existing chunk `symbolLabel` extraction for TS/JS/Python during migration.
- Acceptable transitional path: tree-sitter extractors emit the same `symbolLabel` and breadcrumb metadata that `buildSymbolRecordsForFile` already consumes, but the capability matrix and extractor registry still own the new language support.

L1 must preserve these invariants:

- Every indexed file gets a synthesized file owner.
- A parser or extractor failure degrades to file-owner fallback, not partial or stale source-symbol claims.
- Malformed or unsupported source must not crash indexing and must not attach stale source-symbol owner metadata to chunks.
- A language cannot claim `symbol_only` unless top-level source symbols are fixture-covered and `file_outline` plus `read_file(open_symbol)` work.
- A language cannot claim `calls_v0` unless relationship fixtures prove traversal.

## Capability Tiers

### Tier 1: Symbol-Only Support

Add broad language routing and deterministic top-level symbol extraction first.

Acceptance per language:

- Extension routes to the intended `languageId`.
- Parser or basic extractor does not crash on fixture files.
- Synthesized file-owner fallback always exists.
- Top-level symbols are extracted when grammar support exists.
- `ownerSymbolKey` and `ownerSymbolInstanceId` attach to indexed chunks.
- `file_outline` works from the symbol registry.
- `read_file(open_symbol)` works with `symbolInstanceId`.
- Grouped search for the language does not emit `nextActions.callGraph`.
- `callGraphHint.supported=false` is returned with an unsupported graph reason until relationship tests exist.
- `call_graph` remains unsupported or not-ready for that language even if unrelated relationship sidecars exist for the codebase.
- Malformed or unsupported source indexes with synthesized file-owner fallback only.
- No stale extracted-symbol owner metadata is attached after parser or extractor failure.

### Tier 2: Import/Export Support

Add deterministic `IMPORTS` and `EXPORTS` only where syntax is simple and fixture-covered.

Acceptance per language:

- Relative or local imports resolve deterministically.
- Ambiguous imports and exports are skipped.
- Package, global, framework, or registry imports are skipped unless intentionally supported.
- Relationship manifests remain compatible and conservative.
- Unsupported import syntax does not poison symbol-only navigation.

### Tier 3: CALLS v0 Support

Add conservative direct-call extraction per language.

Acceptance per language:

- Same-file unique calls traverse.
- Ambiguous same-name targets are skipped.
- Cross-file calls stay low-confidence unless import/export evidence supports the target.
- `call_graph` is not claimed until MCP traversal fixtures pass.
- No receiver-aware, dynamic dispatch, overload, trait, interface, inheritance, macro, or reflection claim is made.

### Tier 4: Type/Receiver-Aware Support

Add language-specific type and receiver resolution later, one language at a time.

Priority order:

```text
Go
Rust
Java
C#
PHP
Ruby
Swift
Kotlin
```

Acceptance per language:

- Receiver/type evidence is explicitly represented in relationship records.
- False-positive-prone dynamic patterns are skipped or downgraded.
- Tests include overloads or equivalent ambiguity patterns for the language.
- Public docs distinguish type-aware traversal from conservative `CALLS v0`.

## First Batch

Target batch:

```text
Go
Rust
Java
C#
PHP
Ruby
Kotlin
Swift
```

Implement in three L1a patches, then defer L1b until the parser/basic-extractor decision is made:

| Patch | Scope | Reason |
| --- | --- | --- |
| L1a-1 | Matrix foundation, compatibility facade, extractor interface | Establish capability honesty while keeping TS/JS/Python behavior unchanged. |
| L1a-2 | Go and Rust symbol-only fixtures | Parser packages already exist in `packages/core`; top-level symbols are enough for the first useful symbol-only claim. |
| L1a-3 | Java and C# symbol-only fixtures | Parser packages already exist in `packages/core`; methods and constructors are required for a useful symbol-only claim. |
| L1b | PHP, Ruby, Kotlin, Swift | Currently search-only; requires either new parser dependencies, a deliberately scoped basic extractor, or attributed CMM-derived mappings. |

Do not include C/C++ in the first L1 implementation even though a parser exists. It has higher ambiguity and is not part of the requested first batch.

Initial symbol targets:

| Language | Initial symbol kinds |
| --- | --- |
| Go | top-level functions and top-level type declarations are sufficient for L1a-2; methods can be added when deterministic but are not required for the first symbol-only claim |
| Rust | top-level functions, structs, enums, traits, impl blocks, and modules are sufficient for L1a-2; nested/member extraction can come later |
| Java | classes, interfaces, enums, methods, constructors |
| C# | classes, interfaces, structs, enums, methods, constructors |
| PHP | classes, interfaces, traits, functions, methods |
| Ruby | classes, modules, methods |
| Kotlin | classes, interfaces, objects, functions, constructors |
| Swift | classes, structs, enums, protocols, functions, methods |

If a grammar cannot identify a symbol kind deterministically in L1, skip that symbol kind rather than emitting a weak label.

## Implementation Sequence

### L1a-1: Matrix Foundation and Extractor Interface

Files:

- `packages/core/src/languages/capabilities.ts`
- `packages/core/src/languages/types.ts`
- `packages/core/src/languages/extractors/registry.ts`
- `packages/core/src/language/registry.ts`
- `packages/core/src/language/registry.test.ts`

Tasks:

- Add the canonical capability declarations.
- Add `SymbolExtractor` and `ExtractedSymbol` interfaces.
- Keep the existing public capability helpers working through the compatibility facade.
- Add routing tests for all first-batch extensions.
- Add negative tests proving L1 candidate languages do not claim `callGraphBuild` or `callGraphQuery`.
- Add allowlist/profile tests proving extension routing does not broaden the default indexing profile unless explicitly changed.
- Keep TS/JS/Python behavior unchanged.

Exit criteria:

- Existing TS/JS/Python capability outputs remain unchanged.
- Search-only languages remain search-only until their extractor fixtures land.
- New matrix declarations do not alter MCP tool schemas or response shapes.
- No new language is marked `symbolExtractionCapability="production_ready"` in this patch unless the full production-ready proof path is also added.

### L1a-2: Go/Rust Symbol-Only Fixtures

Files:

- `packages/core/src/languages/extractors/registry.ts`
- `packages/core/src/languages/extractors/tree-sitter.ts`
- `packages/core/src/symbols/registry.ts`
- `packages/core/src/symbols/registry.test.ts`
- `packages/core/src/splitter/ast-splitter.ts`
- Go and Rust fixture tests under the existing core and MCP test structure

Tasks:

- Register the current TS/JS/Python extractor behavior as the baseline if not already done in L1a-1.
- Add generic helpers for named tree-sitter nodes.
- Add Go and Rust symbol extractors for the L1a-2 target symbols.
- Keep chunking behavior stable while extracting symbol candidates independently.
- Preserve synthesized file owner behavior.
- Add malformed/unsupported-source fallback tests.
- Verify grouped search omits `nextActions.callGraph` for Go and Rust.

Exit criteria:

- TS/JS/Python symbol registry tests remain green.
- Extractor failures return file-owner-only output instead of crashing indexing.
- Duplicate symbols and unstable labels are sorted and deduped deterministically.
- Go and Rust can be honestly documented as symbol-only.
- Go and Rust do not claim `callGraphBuild` or `callGraphQuery`.

### L1a-3: Java/C# Symbol-Only Fixtures

Files:

- New language fixture files under existing core test fixture structure.
- `packages/core/src/languages/extractors/*.test.ts`
- `packages/core/src/core/context.test.ts`
- `packages/mcp/src/core/handlers.file_outline.test.ts`
- `packages/mcp/src/core/handlers.scope.test.ts`

Tasks:

- Add fixture files for Java and C#.
- Extract classes/interfaces/enums plus methods and constructors. Java/C# should not claim symbol-only support without methods/constructors because class-only outline is not useful enough for L1.
- Verify indexing attaches `ownerSymbolKey` and `ownerSymbolInstanceId`.
- Verify `file_outline` returns deterministic symbols.
- Verify `read_file(open_symbol)` opens by `symbolInstanceId`.
- Verify grouped search omits `nextActions.callGraph` for these languages.
- Add malformed/unsupported-source fallback tests.

Exit criteria:

- Java and C# can be honestly documented as symbol-only.
- `callGraphHint.supported=false` is emitted for these languages until relationship tests are added.
- No relationship sidecar support is claimed.

### L1b: Parser Decision for PHP/Ruby/Kotlin/Swift

Files:

- `packages/core/package.json`
- `pnpm-lock.yaml`
- `packages/core/src/languages/capabilities.ts`
- Extractor files and tests for PHP, Ruby, Kotlin, and Swift
- `THIRD_PARTY.md` if copied or substantially ported material is used

Tasks:

- Choose parser dependencies or deliberately scoped basic extractors.
- Document any unsupported syntax in fixtures.
- Add attribution in the same patch if using CMM-derived tables, mappings, fixtures, or schemas.

Exit criteria:

- PHP, Ruby, Kotlin, and Swift either become fixture-covered symbol-only languages or remain search-only with explicit capability reasons.
- No unsupported parser dependency is introduced silently.

### Docs and Product Claims

Files:

- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
- `packages/core/README.md`
- `packages/mcp/README.md`
- `docs/plans/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md`
- `THIRD_PARTY.md` if required

Tasks:

- Update docs only after implementation behavior changes.
- Publish a tiered language support matrix.
- Distinguish search-only, symbol-only, imports/exports, calls v0, and type-aware support.
- State that `call_graph` remains relationship-backed and fixture-gated.

Exit criteria:

- No docs claim graph support for a language without relationship tests.
- No docs use a single broad language-count claim without tier qualification.

## CMM Porting Review Targets

The initial CMM review found these tested implementation areas worth using as references:

| Area | CMM files | L1 use |
| --- | --- | --- |
| Extension and filename routing | `/tmp/codebase-memory-mcp/src/discover/language.c` | Reference for candidate extension tables and special filename behavior only; do not import broad language-count claims. |
| Parser/node-kind mappings | `/tmp/codebase-memory-mcp/internal/cbm/lang_specs.c` | Reference for first-batch tree-sitter node kinds. Copying or substantially porting mappings requires `THIRD_PARTY.md`. |
| Definition walking strategy | `/tmp/codebase-memory-mcp/internal/cbm/extract_defs.c` | Reference for stack-based definition traversal and language-specific exceptions. L1 should port only symbol extraction behavior needed for the current tier. |
| Helper classification tables | `/tmp/codebase-memory-mcp/internal/cbm/helpers.c` | Reference for function-kind and module-parent grouping ideas. Copying tables requires attribution. |
| Symbol fixture patterns | `/tmp/codebase-memory-mcp/tests/test_node_creation_probe.c` and `/tmp/codebase-memory-mcp/tests/test_matrix_new_constructs.c` | Reference for fixture coverage, especially Go top-level functions, Java/C# class methods, Ruby functions, Kotlin/Swift constructs. Ported fixtures require attribution. |
| Import/call/type-aware extraction | `/tmp/codebase-memory-mcp/internal/cbm/extract_imports.c`, `/tmp/codebase-memory-mcp/internal/cbm/extract_calls.c`, and `/tmp/codebase-memory-mcp/internal/cbm/lsp/*` | Out of scope for L1. Review later for Tier 2, Tier 3, and Tier 4 only. |

Porting rules:

- Translate CMM ideas into Satori's capability matrix and symbol registry contracts; do not copy CMM's graph product model.
- Use CMM node-kind mappings only after adding attribution if copied or substantially ported.
- Keep CMM import, call, and LSP/type-aware behavior out of L1 even if the source fixtures show it working in CMM.
- Add Satori-native tests for the exact MCP behavior: registry-backed `file_outline`, `read_file(open_symbol)`, no `nextActions.callGraph`, and parser failure fallback.
- Treat CMM fixture success as prior art, not proof for Satori. Satori proof requires local Satori tests.

## Proof Plan

Minimum L1a gates:

```bash
pnpm --filter @zokizuan/satori-core test
pnpm --filter @zokizuan/satori-mcp test
pnpm run typecheck
pnpm run lint
git diff --check
```

Add `pnpm run test:integration` when MCP behavior or docs-visible behavior changes beyond unit coverage.

Required assertions:

- Matrix tests prove all first-batch extensions route to the intended `languageId`.
- Matrix tests prove L1 symbol-only languages do not claim `callGraphBuild` or `callGraphQuery`.
- Matrix/profile tests prove adding extensions does not broaden the default indexing profile without an explicit allowlist/profile change.
- Extractor tests prove parser/extractor no-crash behavior for each implemented language fixture.
- Extractor tests prove malformed or unsupported source degrades to synthesized file-owner fallback.
- Extractor tests prove deterministic symbol labels, spans, parents, and sort order.
- Indexing tests prove file-owner fallback exists when no source symbols are extracted.
- Indexing tests prove chunks get `ownerSymbolKey` and `ownerSymbolInstanceId`.
- Indexing tests prove parser/extractor failure does not attach stale source-symbol owner metadata.
- `file_outline` tests prove outline mode works for implemented L1 languages.
- `read_file(open_symbol)` tests prove exact `symbolInstanceId` open works for implemented L1 languages.
- Search tests prove `nextActions.callGraph` is absent for implemented L1 languages.
- Search tests prove unsupported graph state includes executable `navigationFallback`.
- `call_graph` tests prove L1 languages remain unsupported or not-ready even when relationship sidecars exist globally.

Future tier gates:

- Import/export support requires fixture-covered relationship manifest tests.
- `CALLS v0` support requires MCP `call_graph` traversal fixtures.
- Type/receiver-aware support requires ambiguity and false-positive fixtures for each language.

## Attribution Policy

Allowed to copy or adapt from CMM only with attribution:

- Extension/language mapping tables.
- Tree-sitter symbol node mappings.
- Symbol ontology ideas that become concrete tables or code.
- Parser fixtures.
- Relationship taxonomy ideas that become concrete schemas or tests.
- SQLite schema patterns.
- Graph traversal fixture patterns.

Do not copy from CMM:

- Public MCP tool surface.
- Cypher/query UX.
- Graph visualization product surface.
- Dead-code claims.
- Route/resource claims.
- ADR features.
- Cross-service claims.
- Marketing language or broad language-count claims.

If copied or substantially ported material is used, add this file in the same patch:

```text
THIRD_PARTY.md
```

Required entry shape:

```text
## codebase-memory-mcp

Source: https://github.com/DeusData/codebase-memory-mcp
License: MIT
Copyright: Copyright (c) 2025 DeusData

Satori includes copied or substantially adapted MIT-licensed implementation
details from codebase-memory-mcp for language coverage, parser mappings,
fixtures, relationship indexing, or graph traversal tests. The copied or
adapted material is used under the MIT License.
```

Architectural inspiration alone does not require `THIRD_PARTY.md`, but copied tables, mappings, schemas, fixtures, tests, or code do.

## Open Questions

1. Should L1 use the requested new `packages/core/src/languages/*` namespace, or should it stay under the current singular `packages/core/src/language/*` namespace? The plan recommends the new plural namespace with `language/registry.ts` as the compatibility facade.
2. Should PHP, Ruby, Kotlin, and Swift use tree-sitter parser dependencies immediately, or should L1b start with narrower text/basic extractors?
3. Should `symbolExtractionCapability` require member symbols for a language, or are top-level declarations sufficient for initial symbol-only support?
4. Should C/C++ and Scala get separate L1 plans after the requested first batch, given that parser packages already exist?
5. What is the exact docs wording for any future broad language-count claim? Recommendation: only count languages inside a named tier.

## Handoff

This plan is ready for implementation after the active Phase 2B cleanup priority is resolved or explicitly reprioritized. The first implementation patch should be L1a-1: matrix foundation, compatibility facade, and extractor interfaces only, with TS/JS/Python behavior unchanged and no call-graph claims, import/export support, type-aware behavior, SQLite-default work, or new MCP tools.
