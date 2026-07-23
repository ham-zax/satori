# Symbol-Owned Retrieval Implementation Plan

**Status:** complete. The symbol-owned retrieval architecture and all R0-R4
execution batches are implemented or evidence-closed. This plan
was reconciled against clean revision
`f8d799b0704d8c26bfedf2b42f90ebfc3f7cbb70` on 2026-07-23. R0
relationship-only publication repair is implemented with terminal decision
`relationship_only_upgrade_pass`. R1 relationship-backed test references are
implemented with terminal decision `test_reference_relationship_pass`. R2
exact Python import-alias/parameter receiver evidence is implemented with
terminal decision `typed_receiver_parameter_pass`. R3 closed with
`ambiguity_contract_pass`, and the direct R4 consolidation closed with
`symbol_owned_program_complete`. No executable work remains in this plan.

## Archival Authority Boundary

This document is a completed implementation and evidence record.

Sections that retain terms such as “target,” “tasks,” “acceptance,” “initial
scope,” or imperative verbs describe the contract under which completed work
was implemented. They do not authorize new execution.

Only an explicit newly authorized plan may reopen or extend this architecture.
Where historical targets conflict with a completed execution record, current
repository truth and the terminal execution record control.

## Capability

Satori has shifted from chunk-first semantic retrieval to symbol-owned
repository intelligence. Agents discover implementation concepts as stable
symbols first, then navigate to supporting chunks, callers, tests, and file
spans through the existing MCP tools.

The public MCP tool surface stays fixed:

- `list_codebases`
- `manage_index`
- `search_codebase`
- `continue_search`
- `file_outline`
- `call_graph`
- `read_file`

## Chosen Direction

Adopt a Satori-native version of the codebase-memory insight:

```text
Files
  -> language routing
  -> symbol extraction
  -> symbol registry
  -> relationship engine
  -> navigation index

Chunks
  -> retrieval index
  -> ownerSymbolKey + ownerSymbolInstanceId

search_codebase
  -> retrieve chunks
  -> aggregate by owner symbol
  -> rank symbols
  -> compose deterministic evidence
  -> existing MCP response
```

Satori should not become codebase-memory. Satori keeps semantic retrieval, freshness gates, installer-first setup, MCP contracts, and deterministic sidecars. The borrowed pattern is symbol ownership and relationship-aware evidence.

The separate operational remediation in
`docs/remediation/2026-07-23-operational-search-and-navigation-findings.md`
completed R1-R6. In particular, exact `symbolId` now owns call-graph identity,
Python decorator spans are canonicalized consistently, and freshness
coordination no longer needs to be solved inside a relationship-expansion
phase. A later, separately authorized Phase 5B0/5B1 follow-up added only the
bounded receiver-aware Python `CALLS` behavior recorded below.

## 2026-07-23 Targeted Relationship Follow-up Decision

The symbol registry, relationship sidecars, generation binding, and
relationship-backed `call_graph` described below are implemented. The bounded
follow-up did not replace them with codebase-memory or copy its runtime. It
closed this demonstrated Python coverage gap:

```text
tree-sitter records member call
  -> CallSite(kind="member", receiverText, qualifiedCallee)
  -> buildCallRelationshipsForRegistry drops it
  -> graph-ready symbol can expose zero outgoing edges
```

The current Satori graph is not empty. On the post-reindex
`tradingview_ratio` publication, `run_validation` returned six outgoing edges.
The zero-edge witnesses (`CircuitBreaker.check_drawdown`,
`calculate_spread_from_frames`, and `test_combination_generation`) primarily
contain member calls such as `self.method(...)`, `model.method(...)`, or
`dashboard.method(...)`, which the current relationship builder intentionally
skips.

Use codebase-memory as a pinned behavioral reference for Python receiver/type
resolution, not as Satori's storage or runtime dependency:

- upstream: https://github.com/DeusData/codebase-memory-mcp
- reviewed revision: `dc7178c8dc91bd14098add339c5d37087d88c9bf`
- license: MIT, `LICENSE` SHA-256
  `1f58f9911dc5e3bcb96de28bb28e7b6bb7eb323952d29569c5d7214a152146bb`
- relevant upstream owners: `internal/cbm/extract_calls.c`,
  `internal/cbm/lsp/py_lsp.c`, `src/pipeline/pass_lsp_cross.c`,
  `src/pipeline/pass_calls.c`, and `src/pipeline/lsp_resolve.h`

Do not port codebase-memory's SQLite graph, graph-buffer pipeline, built-in or
stdlib node injection, 15-tool MCP surface, daemon, installer, Cypher layer,
semantic index, UI, or other language resolvers as part of this task. Those
would duplicate Satori authorities and change the product rather than repair
the demonstrated gap.

## 2026-07-23 Repository Reconciliation

The original phase descriptions mixed completed architecture, stale test
TODOs, and still-real relationship gaps. Current repository evidence gives the
following execution truth:

| Area | Current repository truth | Decision |
| --- | --- | --- |
| Language routing, symbols, owners, grouped search, outline, exact open, relationship sidecars, and relationship-backed graph traversal | Implemented in Core/MCP with focused fixtures | Complete; do not reopen |
| Same-line and Python decorator byte ownership | Covered by language-analysis, owner-resolution, relationship, and MCP graph tests | Phase 3 complete |
| Overloads and test-helper collisions | Distinct-instance and ranking fixtures exist | Reuse evidence |
| Generated/source duplicate ownership | R3 provides a focused source/generated identity and grouping fixture; distinct instances and groups are proven | Complete: `ambiguity_contract_pass` |
| Relationship-backed test references | R1 derives additive `TESTS` records only from resolved test-to-production calls and projects them separately from traversal | Complete; legacy v3 graph state remains unused |
| Python import aliases | R2 resolves a written local alias through the existing relative `ModuleBinding` to one exact repository class | Complete for the frozen alias witness |
| Python typed parameters | R2 persists simple identifier annotations as callable-scoped receiver facts and resolves one exact repository class/method | Complete for the frozen parameter witness; broader inference remains deferred |
| Constructor assignments, annotated assignments, repository-local return types, and optional/union normalization | No important repository witness is frozen in this plan | Deferred; not executable work |
| Phase 7 comparison against codebase-memory | The external runtime is not needed to decide Satori's contract, and the repository already has direct search and compact-contract fixtures plus the frozen 30-task owner-retrieval evidence | Replace with a bounded evidence consolidation, not a new benchmark framework |

### Publication compatibility result

`RELATIONSHIP_BUILDER_VERSION` currently participates in
`CanonicalCompletionFingerprint`. R0 now keeps ordinary admission exact while
classifying the sole `relationshipVersion` delta only inside repair. The repair
requires the marker-owned v4 publication, complete forced-hash zero-change
source proof, exact payload membership, and mutation-lease publication
authority before it stages navigation.

The implemented narrow path is:

```text
trusted old completion marker
  + exact match for every vector/lexical/source-projection field
  + relationshipVersion as the only differing fingerprint field
  + sealed v4 policy and exact current source/checkpoint/chunk/payload proof
    -> stage fresh symbol/relationship navigation
    -> atomically activate a new v4 policy/navigation/graph receipt over the
       unchanged completion marker, source checkpoint, and collection
```

The canonical v4 policy rename is the activation decision. The completion
marker, source checkpoint, vector/lexical collection, root navigation pointer,
and SQLite cache remain unchanged. Normal search admission remains fail-closed
until that new policy binds and proves the current relationship generation.
Every other mismatch retains the established `requires_reindex` result, and
legacy v3 publications remain ineligible.

### Completed execution record

| Batch | Kind | Outcome |
| --- | --- | --- |
| R0 | Complete: `relationship_only_upgrade_pass` | Proven relationship-only navigation repair with zero vector-payload writes or embedding calls |
| R1 | Complete: `test_reference_relationship_pass` | Deterministic `TESTS` records restore relationship-backed `call_graph.testReferences` without entering graph traversal |
| R2 | Complete: `typed_receiver_parameter_pass` | Resolve exact Python import aliases and simple parameter-annotation receiver types |
| R3 | Complete: `ambiguity_contract_pass` | Generated/source duplicates retain exact identities and separate groups; existing path policy is the sole ordering distinction |
| R4 | Complete: `symbol_owned_program_complete` | Direct symbol-owned workflow evidence and descriptive response sizes are consolidated without a new benchmark layer |

R0 was required before R1 or R2 changed persisted relationship meaning. R1
and R2 were independent semantic batches after R0. R3 and R4 remained
evidence-only because their frozen witnesses did not disprove an existing
acceptance rule.

### Reusable reconciliation evidence

The following focused baseline is green at the reconciled revision and remains
reusable until its named code, fixtures, parser assets, schemas, or
configuration change:

- Core persisted-authority, relationship-builder, symbol-sidecar, and
  language-analysis tests: 125 passed, 0 failed.
- MCP relationship-backed graph, public graph handler, compact-contract, and
  deterministic search-evaluation tests: 38 passed, 0 failed.

The exact commands are:

```bash
pnpm --filter @zokizuan/satori-core exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/persisted-index-authority.test.ts \
  src/relationships/builder.test.ts \
  src/symbols/sidecar.test.ts \
  src/language-analysis/service.test.ts

pnpm --filter @zokizuan/satori-mcp exec node --import tsx \
  --import ./src/test-state-root.ts --test --test-concurrency=1 \
  src/core/relationship-backed-call-graph.test.ts \
  src/core/handlers.call_graph.test.ts \
  src/core/search-compact-contract.test.ts \
  src/core/search.eval.test.ts
```

## Core Constraints

1. No public MCP tool expansion.
2. Symbol data is a derived index, not a second source of truth.
3. Source of truth remains files on disk plus snapshot/fingerprint state.
4. Every derived symbol record must be rebuildable deterministically from file content, extractor version, language router version, and repository root.
5. Search output schemas may be enriched only within existing response contracts.
6. Existing `requires_reindex` and `hints.reindex` behavior remains authoritative.
7. `search_codebase` remains the sync-on-read freshness entrypoint.
8. `file_outline`, `call_graph`, and `read_file(open_symbol)` must not guess on ambiguous symbol identity.
9. No LLM-based evidence composition; all response shaping must be deterministic.
10. Any copied code or tables from MIT sources must preserve attribution in repo license/docs.
11. `search_codebase` returns symbols; chunks are supporting evidence only.
12. Every indexed chunk must have an owner, falling back to a synthesized file symbol when no tighter owner exists.

## Non-Goals

- Do not paste codebase-memory's C runtime into Satori.
- Do not expose `search_symbols`, `resolve_owner`, `graph_query`, or similar new MCP tools.
- Do not make all languages claim full call-graph support when only search or outline is implemented.
- Do not silently include docs in runtime search; scope semantics remain unchanged.
- Do not make vectors the source of symbol truth.
- Do not store secrets, env payloads, or generated artifacts in new sidecars.

## Architecture Contract

### 1. Index Policy

Owner: `packages/core`.

Responsibilities:

- Decide which files are eligible for indexing.
- Enforce safe-broad defaults and hard denylist.
- Support `default`, `minimal`, and `all-text` profiles.
- Preserve `.satoriignore`, `.gitignore`, and repo `satori.toml` behavior.

Implementation impact:

- Keep `packages/core/src/config/defaults.ts` as the profile source.
- Expand supported extensions only through deterministic defaults or explicit config.
- Keep all-text guarded by UTF-8 probe and size cap.

### 2. Language Router

Owner: `packages/core/src/language`.

Responsibilities:

- Map filename or extension to a canonical language id.
- Support compound extensions and special filenames.
- Expose capability flags per language.

Target capabilities:

```text
SEARCH
AST_SPLIT
SYMBOLS
OWNER
IMPORTS
CALL_GRAPH
TEST_LINKS
```

Initial required router additions:

- TypeScript modules: `.mts`, `.cts`
- C/C++ variants: `.cc`, `.cxx`, `.hh`, `.hxx`, `.ixx`
- Kotlin script: `.kts`
- Frontend containers: `.vue`, `.svelte`, `.astro`
- Styles/templates where safe: `.css`, `.scss`
- Build files: `Dockerfile`, `Makefile`, `CMakeLists.txt`, `justfile`, `Justfile`

Capability honesty requirement:

- If a language is searchable but lacks symbols, expose `SEARCH` only.
- `OWNER` means the language can resolve chunks to extracted source symbols beyond the synthesized file owner.
- All indexed chunks still receive a synthesized file owner when no extracted owner exists.
- If a language has outline but no call graph, `call_graph` must return structured unsupported state with executable `navigationFallback`.

### 3. Symbol Extractors

Owner: `packages/core/src/splitter` initially; may split into `packages/core/src/symbols`.

Responsibilities:

- Extract stable symbols with spans and display labels.
- Produce deterministic stable and exact symbol identities.
- Preserve breadcrumbs and parent-child symbol relationships.
- Fail closed to chunk-only indexing when extraction fails.

Minimum symbol shape:

```ts
interface SymbolRecord {
  symbolKey: string;
  symbolInstanceId: string;
  language: string;
  kind:
    | 'file'
    | 'module'
    | 'namespace'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'trait'
    | 'macro'
    | 'function'
    | 'method'
    | 'property'
    | 'component'
    | 'hook'
    | 'config'
    | 'test';
  name: string;
  qualifiedName: string;
  label: string;
  file: string;
  span: {
    startLine: number;
    endLine: number;
    startByte?: number;
    endByte?: number;
    startColumn?: number;
    endColumn?: number;
  };
  parentKey?: string;
  parentQualifiedNamePath: string[];
  exported?: boolean;
  fileHash: string;
  extractorVersion: string;
  ontologyTags?: RepositoryOntologyTag[];
}
```

Deterministic identity rules:

```text
symbolKey = stableHash(relativePath + language + kind + qualifiedName + parentQualifiedNamePath)
symbolInstanceId = stableHash(symbolKey + fileHash + span + extractorVersion)
```

Use `symbolKey` for stable-ish identity across small edits. Use `symbolInstanceId` for exact snapshot identity and stale-open rejection. Do not use vector ids or chunk ids as symbol ids.

`span` must be serialized canonically before hashing, with explicit field ordering and absent optional fields omitted.

`parentQualifiedNamePath` is the ordered parent kind/name chain, excluding spans and extractor version. Do not derive it from `parentKey`; parent-key churn must not cascade into child keys.

Rename continuity rule:

- `symbolKey` is a deterministic continuity key, not proof that two edited symbols are identical.
- `symbolKey` is not expected to survive file moves or file renames in v1.
- Rename detection may later use parent chain, declaration ordinal, and local structure fingerprints, but must remain a probable-continuity hint.
- Exact navigation must validate `symbolInstanceId`, `fileHash`, and manifest compatibility; it must never rely on probable continuity.

Repository ontology tags:

```text
API
CONTROLLER
SERVICE
MODEL
SCHEMA
CONFIG
MIGRATION
TEST
GENERATED
HOOK
COMPONENT
UTILITY
```

Ontology tags must be deterministic and rule-based, derived from path, filename, decorators/annotations, exported names, or framework-specific syntax. No LLM classification is allowed in the indexer.

Ontology tags are optional in early phases and must not affect ranking until deterministic fixtures prove useful precision.

### 4. Symbol Registry

Owner: `packages/core/src/symbols` builds and writes the registry. `packages/mcp` loads compatible registries and shapes tool responses.

Semantics:

- Files are the source of truth.
- The Symbol Registry is the canonical derived navigation view for a specific compatible indexed snapshot.
- Symbol records are authoritative only within their manifest compatibility boundary.

Responsibilities:

- Store latest symbol records per indexed root.
- Support exact lookup by `symbolInstanceId`.
- Support candidate lookup by `symbolKey`.
- Support reverse lookup by file, label, qualified name, and logical path.
- Support file-scoped outline queries.
- Support span containment lookup for owner resolution.
- Expose deterministic stale/incompatible states to MCP handlers.

Runtime indexes built during load:

```ts
symbolsByInstanceId: Map<string, SymbolRecord>;
symbolsByKey: Map<string, SymbolRecord[]>;
symbolsByFile: Map<string, SymbolRecord[]>;
symbolsByLabel: Map<string, SymbolRecord[]>;
symbolsByQualifiedName: Map<string, SymbolRecord[]>;
```

`symbolKey` lookup may return multiple records for overloads, repeated lexical bindings, or other logical-name ambiguity. Multiplicity is candidate state, not registry corruption. Callers must disambiguate with `symbolInstanceId`, file hash, manifest compatibility, exact file constraints, or exact label constraints; unresolved logical lookups return an explicit ambiguous outcome. Duplicate `symbolInstanceId` remains invalid registry state.

Persistence model:

```text
~/.satori/navigation/<root-hash>/manifest.json
~/.satori/navigation/<root-hash>/symbols/index.json
~/.satori/navigation/<root-hash>/symbols/by-file/<file-hash>.json
~/.satori/navigation/<root-hash>/relationships/by-file/<file-hash>.json
```

MVP may write one shard, but all read/write APIs must assume the sharded layout above.

Generated artifact rule:

```text
Generated artifacts may be represented as path-level or symbol-level references.
Satori must not embed generated artifact contents in navigation sidecars unless
the file is already eligible under the active index policy.
```

This same rule applies to secrets and env-like files: references may exist only when safe, contents must not be embedded unless the active index policy admits the file.

Manifest fields:

```ts
interface SymbolRegistryManifest {
  schemaVersion: 'symbol_registry_v1';
  normalizedRootPath: string;
  rootFingerprint: string;
  repoIdentity?: string;
  indexPolicyHash: string;
  languageRouterVersion: string;
  extractorVersion: string;
  relationshipVersion: string;
  builtAt: string;
  files: Array<{
    path: string;
    hash: string;
    language: string;
    symbolCount: number;
  }>;
}
```

Invariants:

- Registry membership must match the active index policy.
- Registry rebuild must be deterministic for stable inputs.
- Partial registry failure must degrade per file, not poison the whole codebase unless manifest integrity fails.
- A missing or incompatible registry maps to `requires_reindex` or structured unsupported state according to existing tool rules.
- Absolute path is display/debug metadata, not the sole compatibility anchor. Compatibility must include root fingerprint and index policy hash.

### 5. Owner Resolver

Owner: `packages/core` for index-time ownership. `packages/mcp` may perform legacy query-time repair only from a compatible registry.

Responsibilities:

- Assign `ownerSymbolKey` and `ownerSymbolInstanceId` to every indexed chunk.
- Use the tightest containing symbol by source span.
- Prefer method/function over class/module when spans nest.
- Fall back to synthesized file owner when no tighter symbol exists.

Synthesized owner rule:

- Every indexed file gets a synthesized `file` symbol.
- Every indexed chunk must have an owner.
- If extraction fails, chunks are owned by the synthesized file symbol and confidence is capped at low/medium depending on retrieval evidence.

Synthesized file symbol shape:

```ts
{
  kind: 'file';
  name: basename(relativePath);
  qualifiedName: relativePath;
  parentQualifiedNamePath: [];
  span: fullFileSpan;
}
```

Synthesized file symbols are internal owners. `file_outline` may omit them when extracted child symbols exist, but may return them as the only outline item for `SEARCH`-only or extractor-failed files with a warning.

Resolution algorithm:

```text
input: chunk file, chunk start/end byte when available, chunk start/end line, symbol records for file
filter:
  prefer byte containment when both chunk and symbol byte ranges exist
  else line containment where symbol.startLine <= chunk.startLine and chunk.endLine <= symbol.endLine
sort:
  1. smallest byte span first when available, else smallest line span
  2. deepest parent chain first
  3. kind priority method/function/hook/component/property/type/enum/trait/class/namespace/module/file
  4. stable symbolKey
output:
  ownerSymbolKey and ownerSymbolInstanceId
  synthesized file owner only when no tighter candidate exists
```

Index-time contract:

- New chunks written to retrieval index must carry `metadata.ownerSymbolKey` and `metadata.ownerSymbolInstanceId`.
- Existing `symbolId` remains supported for backward compatibility until migration.

### 6. Retrieval Index

Owner: existing vector/hybrid storage.

Responsibilities:

- Store chunks, embeddings, BM25/sparse data, and metadata.
- Retrieve candidates by semantic and lexical query signals.
- Never decide final symbol identity alone.

Required metadata additions:

```ts
metadata.ownerSymbolKey?: string;
metadata.ownerSymbolInstanceId?: string;
metadata.symbolId?: string;        // legacy/compat alias during transition
metadata.symbolLabel?: string;
metadata.symbolKind?: string;
metadata.languageCapability?: string[];
```

Migration rule:

- Old indexes without `ownerSymbolKey` continue to work through query-time repair if a compatible symbol registry exists.
- When a chunk's `ownerSymbolInstanceId` is absent from a compatible registry, MCP may repair ownership by `ownerSymbolKey` plus file/span containment.
- If repair is ambiguous or no tighter extracted owner exists, downgrade to the synthesized file owner with low confidence and `debug.symbolAggregation.ownerSource="registry_repair"`.
- If index and registry manifests are incompatible, return `requires_reindex` instead of repairing.
- If no compatible registry exists, search degrades to current chunk/file grouping behavior.

### 7. Relationship Engine

Owner: `packages/core` builds relationship sidecars at index time. `packages/mcp` reads relationship sidecars and exposes filtered views through existing tools.

Responsibilities:

- Store relationships between symbols and files.
- Feed `call_graph`, `file_outline`, `read_file(open_symbol)`, and search evidence.

Relationship types:

```text
CALLS
IMPORTS
EXPORTS
EXTENDS
IMPLEMENTS
REFERENCES
TESTS
GENERATES
CONFIGURES
```

Minimum relationship shape:

```ts
interface RelationshipRecord {
  sourceKey: string;
  sourceInstanceId?: string;
  targetKey?: string;
  targetInstanceId?: string;
  targetPath?: string;
  type:
    | 'CALLS'
    | 'IMPORTS'
    | 'EXPORTS'
    | 'EXTENDS'
    | 'IMPLEMENTS'
    | 'REFERENCES'
    | 'TESTS'
    | 'GENERATES'
    | 'CONFIGURES';
  file: string;
  span?: SymbolRecord['span'];
  confidence: 'high' | 'medium' | 'low';
}
```

Relationship manifest:

```ts
interface RelationshipManifest {
  schemaVersion: 'relationship_v2';
  symbolRegistryManifestHash: string;
  relationshipVersion: string;
  builtAt: string;
}
```

`symbolRegistryManifestHash` must cover schema version, root fingerprint, index policy hash, language router version, extractor version, and file hashes. MCP must load relationship sidecars only when this hash matches the loaded compatible symbol registry manifest.

Initial scope:

- Preserve current TS/JS/Python call graph behavior.
- Add import/export edges where extractors already provide enough data.
- Add test references only from resolved call evidence plus a deterministic
  test/fixture path classification; do not link by filename/name similarity.
- Make `call_graph` a filtered relationship view, not a separate graph product.

Relationship trust boundary:

- `CALLS v0` records are heuristic relationship evidence, not graph-grade import/receiver-resolved facts.
- v0 extraction may emit only function/method-owned records.
- Unique same-file name targets may be `high` confidence.
- Unique cross-file name targets must be `low` confidence unless import/export evidence exists.
- Ambiguous same-name targets must be skipped rather than guessed.
- Class/container-owned duplicate call edges must not be emitted when method/function owners exist.

Non-initial scope:

- Full type-aware cross-language call graph for all languages.
- Runtime trace ingestion.
- Whole-program alias analysis.

### 8. Symbol-Centric Ranking

Owner: `packages/mcp/src/core/handlers.ts` initially; should move to a search-ranking module when stable.

Current model:

```text
chunk score -> rerank -> group chunk/file/symbol
```

Target model:

```text
chunk score
  -> ownerSymbolKey
  -> aggregate evidence by symbol
  -> symbol score
  -> deterministic evidence composer
```

Symbol score inputs:

- Best chunk score for the symbol.
- Saturated support from evidence chunks, for example `log(1 + chunkCount)` or `min(chunkCount, 3)`.
- Query-term match in symbol name/label.
- Repository ontology tag match, only after deterministic fixtures prove useful precision.
- Exact path/operator constraints.
- Runtime/docs/mixed scope.
- Test demotion unless query asks for tests.
- Changed-file boost from existing `auto_changed_first`.
- Optional reranker boost applied only to evidence chunks, not as sole identity source.

Tie-break order:

1. Higher normalized symbol score.
2. Runtime source before tests/docs/generated.
3. Non-generated before generated.
4. Shorter file path depth for equal confidence.
5. Lexicographic `file`.
6. Stable `symbolKey`.

Ambiguity rule:

- Do not collapse distinct symbols just because labels match.
- Return multiple candidate symbols when ownership is distinct or overloaded.
- Use the existing exact-lookup `ambiguous` status when one exact target cannot
  be selected. Grouped output exposes distinct concrete targets; no additional
  public ambiguity field is required.

Deterministic confidence bands:

```text
high: exact symbol/name/path match plus strong owned evidence
medium: semantic evidence plus resolved non-file owner
low: chunk evidence only, synthesized file owner, or partial extractor fallback
```

### 9. Evidence Composer

Owner: new internal helper in `packages/mcp/src/core`.

Responsibilities:

- Convert ranked symbols into current `SearchGroupResult` shape.
- Attach compact supporting evidence.
- Build `callGraphHint` when relationship support exists.
- Build `navigationFallback` when graph support is missing.
- Emit deterministic `nextActions`.

No LLM calls.

Evidence fields should remain compatible with existing response contracts:

- `symbolId`
- `symbolKey`
- `symbolInstanceId`
- `symbolLabel`
- `file`
- `startLine`
- `endLine`
- `preview`
- `collapsedChunkCount`
- `callGraphHint`
- `navigationFallback`
- `nextActions`
- `warnings`
- `hints`

Evidence rule:

- `search_codebase` returns symbol groups.
- Chunks are evidence attached to those groups.
- Raw mode may still expose chunks for debugging/compatibility, but grouped mode must be symbol-first when a compatible navigation index exists.

## Navigation Compatibility Matrix

| Navigation state | `search_codebase` | `file_outline` | `read_file(open_symbol)` | `call_graph` |
| --- | --- | --- | --- | --- |
| Registry missing but retrieval index ready | chunk/file fallback with navigation warning, or `requires_reindex` when request options require symbol-owned grouped results, exact symbol reads, call graph hints, or `open_symbol`-style next actions | `requires_reindex` | cannot open symbol; return exact-open unsupported/reindex guidance | unsupported with fallback |
| Registry version incompatible | `requires_reindex` | `requires_reindex` | `requires_reindex` | `requires_reindex` |
| Language has `SEARCH` only | normal retrieval with synthesized file owner and low/medium confidence | synthesized file-symbol outline when a compatible registry entry exists, otherwise unsupported | file/range only | unsupported with fallback |
| File extractor failed | chunk/file fallback with partial warning and synthesized file owner | partial outline warning or unsupported for that file | file/range only unless exact symbol exists | unsupported with fallback for affected file |
| Relationship sidecar missing | search works with no supported graph hint | outline works | symbol open works | unsupported with fallback |
| Relationship sidecar incompatible | search works but graph hint downgraded unless relationship incompatibility implies full navigation mismatch | outline works if registry compatible | symbol open works if registry compatible | `requires_reindex` |

## Historical Language Capability Roadmap

This section records the original target state. It is not a statement of
current public capabilities or executable work.

Current language capability truth is owned by
`packages/core/src/languages/capabilities.ts` and the completed
`MULTI_LANGUAGE_SYMBOL_DEFINITION_PARITY_PLAN.md`. Kotlin and Swift were not
promoted. `IMPORTS` and `CALL_GRAPH` must not be inferred from the historical
target table below.

### Baseline: current full support

```text
TypeScript: SEARCH, AST_SPLIT, SYMBOLS, OWNER, CALL_GRAPH, TEST_LINKS
JavaScript: SEARCH, AST_SPLIT, SYMBOLS, OWNER, CALL_GRAPH, TEST_LINKS
Python:     SEARCH, AST_SPLIT, SYMBOLS, OWNER, CALL_GRAPH, TEST_LINKS
```

`TEST_LINKS` is implemented through additive relationship-backed `TESTS`
records derived only from resolved calls in admitted test/fixture paths. Those
records populate the existing root-target `call_graph.testReferences` field
without entering graph traversal.

`IMPORTS` remained unclaimed at the public capability layer even though the
relationship sidecar now stores bounded relative `IMPORTS`/`EXPORTS` evidence.
The completed R0-R4 program did not promote that capability.

### Phase language targets

```text
Go:        SEARCH, AST_SPLIT, SYMBOLS, OWNER, IMPORTS
Java:      SEARCH, AST_SPLIT, SYMBOLS, OWNER, IMPORTS
Rust:      SEARCH, AST_SPLIT, SYMBOLS, OWNER
C#:        SEARCH, AST_SPLIT, SYMBOLS, OWNER, IMPORTS
C/C++:     SEARCH, AST_SPLIT, SYMBOLS, OWNER, IMPORTS
Kotlin:    SEARCH, SYMBOLS, OWNER
Swift:     SEARCH, SYMBOLS, OWNER
```

Call graph for these languages should be added only after outline and owner resolution are stable.

## Implementation Phases

### Phase 0: Attribution and Architecture Guardrails

Status: complete.

Files:

- `LICENSE` or `THIRD_PARTY.md` if added
- `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`
- this plan

Tasks:

- Add MIT attribution for any copied tables or codebase-memory-derived code.
- Document that copied extension tables are reference data, not runtime dependency.
- Add architecture note: symbols are derived state, files remain source of truth.

Acceptance:

- License attribution exists before copied implementation lands.
- Public MCP tool list unchanged.

### Phase 1: Capability-Driven Language Router

Status: complete. Current routing and filename authorities live under
`packages/core/src/language/*`, `packages/core/src/languages/*`, and
`packages/core/src/config/defaults.ts`; the older singular file names below are
historical.

Files:

- `packages/core/src/language/registry.ts`
- `packages/core/src/config/defaults.ts`
- related tests

Tasks:

- Expand extension and filename routing.
- Add capability enum fields for `SEARCH`, `OWNER`, `IMPORTS`, `TEST_LINKS`.
- Add tests for key extensions and filenames.
- Keep default profile safe-broad and denylist-protected.

Acceptance:

- All listed user target extensions are routed or explicitly unsupported with capability reason.
- Index-profile default extension sets remain unchanged in this phase unless a separate behavior-change patch updates search/indexing tests.
- `.mts`, `.cts`, `.cc`, `.cxx`, `.hh`, `.hxx`, `.ixx`, `.kts` routing is tested.
- Special filenames `Dockerfile`, `Makefile`, `CMakeLists.txt`, `justfile`, `Justfile` are tested.

### Phase 2: Symbol Registry Contracts and Sidecar Writer

Status: complete.

Files:

- new `packages/core/src/symbols/*`
- `packages/core/src/splitter/ast-splitter.ts`
- index/reindex write path

Tasks:

- Define `SymbolRecord` and manifest schema.
- Build TS/JS/Python symbol records from existing extraction paths.
- Write symbol registry during index/reindex using the sharding-friendly layout.
- Emit synthesized file owners for every indexed file.
- Keep relationship records out of this phase except manifest placeholders.

Acceptance:

- Registry rebuild is deterministic for stable fixture repos.
- `symbolKey` is stable across line-only edits that do not rename or reparent the symbol.
- `symbolInstanceId` changes when file hash, span, or extractor version changes.
- Missing/incompatible registry states are detectable without loading retrieval chunks.
- Existing TS/JS/Python indexing tests still pass.

### Phase 2.5: Symbol-Backed `file_outline`

Status: complete for registry-backed outline and exact resolution.
Relationship-backed navigation is the steady state. Legacy call-graph
sidecars are oracle/compatibility scaffolding only and must not become a
runtime fallback again.

Files:

- MCP registry loader in `packages/mcp/src/core/*`
- `packages/mcp/src/core/file-outline*` or current outline handler location
- file outline tests

Tasks:

- Load compatible symbol registries in MCP.
- Back `file_outline` outline mode from registry records.
- Back exact mode from `symbolInstanceId` or exact label resolution without guessing.
- Preserve current `file_outline` response shape.
- Return deterministic `requires_reindex`, `unsupported`, `ambiguous`, or `not_found` states.

Acceptance:

- Existing TS/JS/Python outline tests still pass.
- Exact mode resolves current `symbolInstanceId` values and returns `not_found` for stale ids absent from the compatible registry.
- Same-label symbols in one file produce `ambiguous`, not guessed output.
- Missing/incompatible registry returns deterministic `requires_reindex` or
  unsupported envelopes without reviving legacy graph identity.

### Phase 3: Tightest Owner Resolution

Status: complete.

Implemented:

- `packages/core` assigns `ownerSymbolKey` and `ownerSymbolInstanceId` to indexed chunks at index time.
- Owner resolution chooses the tightest extracted owner by byte containment when available, otherwise line containment.
- Synthesized `file` symbols remain the fallback owner.
- Retrieval documents preserve owner metadata through `Context.semanticSearch`.
- Grouped search prefers owner metadata when present while preserving raw mode and file grouping.
- Grouped search repairs legacy chunks without owner metadata from a compatible symbol registry using file/span containment.
- Same-line symbol identity and ownership are covered in Core context,
  language-analysis, relationship, and MCP graph fixtures.
- Python decorator-inclusive spans are covered by the completed O3
  remediation and canonical source-repair fixtures.

Files:

- new owner resolver module
- chunk metadata write path in `packages/core/src/core/context.ts`
- search grouping path in `packages/mcp/src/core/handlers.ts`

Tasks:

- Assign `ownerSymbolKey` and `ownerSymbolInstanceId` at index time.
- Prefer byte/AST containment when available, then line containment.
- Add query-time repair for legacy chunks using registry spans.
- Update grouped search to prefer owner symbol.
- Preserve file grouping and raw mode behavior.

Acceptance:

- Large TS/Python fallback chunks map to the method/function owner.
- A class containing multiple methods returns the method owner when chunk span is inside one method.
- Decorators, same-line symbols, and nested symbols use byte/AST ranges when available.
- Every indexed chunk has either a real symbol owner or synthesized file/module owner.
- Ambiguous ownership uses deterministic tie-breaks.
- No response schema break.

### Phase 4: Symbol-Centric Ranking

Status: complete, including the evidence-only R3 ambiguity fixture.

Implemented:

- Grouped `search_codebase` aggregates candidate chunks by owner identity when owner metadata exists.
- Legacy chunks without owner metadata are repaired at query time from compatible registry spans before falling back to legacy `symbolId` or proximity grouping.
- Search groups expose additive `symbolKey`, `symbolInstanceId`, `symbolKind`, `confidence`, and debug `symbolAggregation`.
- Symbol scoring uses best representative score plus a capped logarithmic support boost.
- Reranker remains evidence-only; call graph hints now validate against registry-backed `symbolInstanceId` navigation state.
- Same-label declaration groups with distinct owner identities remain separate.
- Relationship records are the steady-state source of graph hints and
  traversal.
- Overload instances remain separate in grouped and compact-contract tests.
- Implementation queries demote test helpers while explicit test intent can
  select them.

Completed evidence:

- Add one generated/source duplicate fixture only. It must first prove the two
  indexable sources retain distinct `symbolInstanceId` values and distinct
  groups. It must not add a new ambiguity-hint schema or ranking policy merely
  because the old plan used the phrase "ambiguity hints."

Files:

- `packages/mcp/src/core/handlers.ts`
- ideally new `packages/mcp/src/core/symbol-ranking.ts`
- tests near existing search scope/ranking tests

Tasks:

- Aggregate candidate chunks by `ownerSymbolKey`.
- Rank symbols using deterministic scoring.
- Keep reranker as a signal, not identity source.
- Add debug payload entries for symbol aggregation when `debug:true`.

Acceptance:

- Multiple chunks from the same symbol collapse into one high-confidence group.
- Raw chunk count uses saturated support and cannot let large files dominate by size alone.
- Implementation queries prefer implementation owners over tests/docs.
- Test queries can still surface test owners.
- Same-name symbols, overloads, generated/source duplicates, and test-helper
  collisions remain separate candidates. Exact lookup reports ambiguity
  rather than guessing; grouped output retains concrete target identities.
- Ranking is stable across repeated runs.

#### R3: Generated/source duplicate evidence

This is an evidence-only batch. Use one task-owned lexical fixture containing
one ordinary implementation and one separately indexable generated-path
implementation with the same declaration label.

Assert only:

- their `symbolInstanceId` values and grouped candidates remain distinct;
- exact name-only lookup is ambiguous rather than guessed;
- an implementation-intent query does not collapse the generated instance into
  the source instance; and
- the existing generated-noise policy remains the only ranking distinction.

Reuse the existing overload and test-helper fixtures. Do not add a new public
ambiguity field, change scores, or generalize ranking unless this exact fixture
fails because current grouping merges the two identities.

Terminal decision:

- `ambiguity_contract_pass`; or
- `ambiguity_identity_gap` with the exact grouping owner that collapsed the
  instances.

R3 execution record (2026-07-23):

- Decision: `ambiguity_contract_pass`.
- The focused MCP fixture
  `handleSearchCode keeps source and generated implementations as distinct
  exact owners` uses `src/build-artifact.ts` and
  `generated/build-artifact.ts` with the same `buildArtifact` declaration.
- The registry produces different `symbolInstanceId` values. Exact
  name-only registry routing reports `ambiguous`, semantic fallback retains
  both concrete target identities, and grouping does not merge the paths.
- Equal backend scores leave the ordinary source result ahead solely through
  the existing path classification (`neutral` versus `generated`) and its
  existing multiplier. No ranking, score, schema, or production implementation
  changed.
- Existing overload evidence remains in
  `search-compact-contract.test.ts`; exact duplicate-label ambiguity remains in
  `handlers.file_outline.test.ts`; test-helper ordering remains in
  `handlers.scope.test.ts`.

### Phase 5: Relationship Engine v1

Status: relationship storage and traversal are complete for `CALLS`,
`IMPORTS`, and `EXPORTS`. R1 adds relationship-backed `TESTS` evidence for the
existing root-target test-reference contract.

Files:

- new `packages/core/src/relationships/*`
- current call graph extraction inputs
- `packages/mcp/src/core/call-graph.ts`
- `packages/mcp/src/core/search-types.ts`

Tasks:

- Build relationship records in `packages/core` during index/reindex.
- Treat the current call graph as one filtered relationship view.
- Preserve public `call_graph` tool contract.
- Store calls/imports/test refs as typed relationship records without adding new MCP tools.
- Make MCP load and filter relationship sidecars; do not compute relationships at query time.
- Ensure `callGraphHint` is built from relationship capability, not language name alone.

Current implementation:

- Core writes and reads relationship manifests under the navigation sidecar root.
- Relationship manifests are validated against the loaded symbol registry manifest hash.
- Core writes deterministic per-file relationship shards with conservative function/method-owned `CALLS v0` records and TS/JS file-owner `IMPORTS`/`EXPORTS v0` records during completed full indexes.
- Symbol and relationship sidecar subtree rewrites use rollback-aware temp-directory swaps. Symbol registry writes keep the previous symbol subtree until the root manifest commit succeeds; if subtree or manifest commit fails, the previous readable registry or relationship sidecar remains intact. Empty relationship placeholders are created only after the symbol registry commit succeeds.
- Relationship `CALLS v0` extraction intentionally excludes class container spans, skips ambiguous same-name targets, and downgrades unique cross-file name-only matches to `low` confidence until import/receiver-aware resolution exists. `IMPORTS`/`EXPORTS v0` records only resolvable relative module edges and unambiguous local export declarations; package imports, unresolved paths, ambiguous local exports, and multiline module syntax are skipped.
- Registry-backed `search_codebase` and `file_outline` now keep graph hints supported only through a compatible relationship sidecar, and supported `symbolRef.symbolId` carries the registry `symbolInstanceId`. Missing or incompatible relationship state emits deterministic warnings or reindex guidance instead of reviving legacy graph handles.
- `call_graph` now serves traversal directly from relationship records when compatible navigation sidecars exist. Missing or incompatible registry/relationship state returns deterministic `not_ready`, `missing_symbol_registry`, `missing_relationship_sidecar`, `incompatible_symbol_registry`, `incompatible_relationship_sidecar`, `not_found`, or `requires_reindex` behavior rather than falling back to legacy v3 runtime traversal.
- `TESTS` is emitted only beside an already resolved `CALLS` record from an
  admitted test/fixture source to a non-test repository target. It is projected
  separately from traversal into the existing root-target `testReferences`
  response field.

Acceptance:

- TS/JS/Python call graph behavior remains stable.
- Search groups with unsupported graph capability still include executable fallback.
- Relationship engine can represent import/test refs without exposing new MCP tools.
- Relationship sidecar absence degrades only graph hints/call graph when registry remains compatible.

#### R0: Relationship-only navigation repair

Authorized outcome:

> Rebuild and reactivate relationship/navigation state after only
> `relationshipVersion` changes, while proving and reusing the unchanged
> vector/lexical payload.

Primary owners:

- `packages/core/src/core/persisted-index-authority.ts`
- `packages/core/src/core/context.ts`
- their focused tests
- `packages/mcp/src/core/manage-indexing-handlers.ts` and its focused repair
  tests

Contract:

1. Keep complete runtime search admission exact except for the fully proven v4
   component binding defined below. Do not broadly weaken
   `indexFingerprintsEqual()`.
2. Add a repair-only compatibility classifier. It may return
   `relationship_only_upgrade` only when the complete parsed old and new
   fingerprints differ solely in `relationshipVersion`.
3. Require an existing canonical v4 publication binding, canonical root,
   current source observation equal to its owned source checkpoint, expected
   chunk IDs, exact payload membership, collection identity, and
   completion-marker ownership proofs before staging anything. A legacy v3
   binding has no source-checkpoint/receipt authority and remains
   `requires_reindex`; R0 must not upgrade it by inference. Supplied snapshot
   evidence may corroborate the same collection and relationship-only
   fingerprint delta, but it cannot replace the marker or v4 receipt.
   Reopen `FileSynchronizer` against the marker-owned checkpoint with
   `requireExistingCheckpoint`, perform one forced full-hash `prepareChanges`,
   require zero added/removed/modified files and a complete scan, and call its
   source-observation assertion immediately before activation. Do not stage or
   commit that prepared checkpoint.
4. Rebuild symbol and relationship navigation from current source under the
   new relationship identity. `repairIndex()` currently calls
   `writeSymbolRegistryForCompletedIndex(..., deferPublication=false)`; the R0
   path must stage and seal the candidate instead. Follow the existing atomic
   delta pattern: the v4 policy binds the explicit staged generation, so R0
   must not advance root-global `current.json` or import a root-global SQLite
   cache.
5. Do not overwrite the completion marker in the active collection. That
   marker and its marker-owned source checkpoint remain the immutable
   vector/lexical/source-projection proof. Overwriting it before the policy
   switch would invalidate the old tuple and create an ABA/crash window.
6. Extend exact generation proof with one explicit component-upgrade case:
   when the marker differs from the runtime fingerprint only in
   `relationshipVersion`, the canonical v4 policy may bind a different sealed
   navigation generation only when:
   - its source-checkpoint binding still matches the unchanged marker;
   - its graph manifest hash matches the bound generation;
   - the bound relationship manifest carries the current relationship
     identity; and
   - every other marker, policy, collection, source, payload, registry, seal,
     and observation proof is exact.
   No ordinary exact-admission branch may accept this difference without that
   complete v4 component binding.
7. The single canonical policy-file rename is the activation decision. Its new
   publication binding reuses the old source-checkpoint fields, records the new
   graph manifest and mutation receipt, and binds the staged generation.
   `RepairIndexOptions` must receive the current publication authority from the
   MCP mutation lease; production repair must not invent a constant generation
   or operation identity.
   Existing readers retain the old receipt's explicit generation. Restart
   before activation resolves the old policy generation; restart after
   activation resolves the new policy generation. Schedule ordinary retention
   only after activation, keeping both generations until read leases permit
   cleanup. Root-global pointer/cache state remains non-authoritative and may
   stay on the prior generation.
8. The MCP repair branch currently calls the legacy
   `rebuildCallGraphForIndex()` after Core repair. R0 must not rebuild that
   unrelated v3 artifact. It must instead require
   `proveIndexedGeneration()` to match the returned collection, counts,
   unchanged marker/checkpoint identity, current relationship identity, and
   newly bound navigation generation before it records repair completion in
   the snapshot. Extend the internal `RepairIndexResult` with the activated
   navigation binding or proven generation receipt needed for this comparison;
   do not rediscover authority from an unbound `current.json` pointer.
9. Perform no vector-payload writes or deletions, lexical maintenance,
   embedding calls, completion-marker writes, source-checkpoint writes,
   current-pointer writes, SQLite-cache imports, collection copy, or collection
   rename. Staged navigation-generation writes and the canonical v4
   policy/receipt control write are required.
10. A failure before policy activation leaves the previous marker, collection,
    source checkpoint, navigation generation, and v4 policy binding as the
    complete searchable tuple. An unactivated staged generation cannot grant
    authority and remains recoverable or discardable under the existing
    generation lifecycle.
11. Parser, extractor, projection, provider, model, dimension, artifact,
    normalization, vector-store, schema, lexical, policy, source, checkpoint,
    or payload mismatch remains `requires_reindex`.

The existing v4 policy is the component activation authority in R0. This is a
bounded extension of the current explicit-generation reader contract, not a
second marker format or a general component-upgrade framework.

Known assumptions that R0 must update consistently are
`markerMatchesSealedAuthority()`, `resolveActiveIndexedCollection()`,
`proveGenerationAuthorityExactly()`, `proveNavigationGeneration()`,
`acceptPreparedSourceGenerationReceipt()`, and activation-proof recording.
Introduce at most one private effective-navigation-binding helper so those
paths select either the marker's exact navigation or the one proven
relationship-only policy override. Do not scatter independent compatibility
predicates across readers.

Focused proof:

- a marker differing only in `relationshipVersion` completes repair with zero
  vector-payload writes, zero marker/checkpoint writes, and zero embedding
  calls;
- the activated v4 receipt reuses the exact marker, source checkpoint,
  collection, and payload counts while binding a new complete navigation
  generation and graph manifest;
- an injected candidate/activation failure preserves the old durable tuple;
- restart after candidate staging but before policy activation proves the old
  explicit generation, while restart after activation proves the new explicit
  generation;
- a completed repair is accepted by MCP only after the exact new generation is
  proven, and the repair path does not call the legacy graph builder;
- every non-relationship mismatch remains rejected; and
- one instrumented shared-adapter fixture rejects any vector mutation call,
  while the unchanged LanceDB/Milvus query/count contracts remain covered by
  their existing focused adapter tests. R0 adds no backend capability.

Terminal decision:

- `relationship_only_upgrade_pass`; or
- `publication_compatibility_blocked` with the exact proof or activation owner
  that still forces vector replacement.

R0 execution record (2026-07-23):

- Decision: `relationship_only_upgrade_pass`.
- `classifyRepairIndexCompatibility()` admits only an otherwise exact
  `relationshipVersion` delta; normal exact comparison remains unchanged.
- The repair reopens the marker-owned checkpoint with
  `requireExistingCheckpoint`, performs a forced full-hash zero-change scan,
  proves expected IDs and exact payload membership, stages a sealed navigation
  generation, and activates it through the existing v4 policy receipt.
- The activated receipt reuses the exact collection, immutable completion
  marker, source-checkpoint digest, and payload counts. It records the MCP
  mutation lease and the new graph manifest.
- The focused success fixture rejects every embedding call and observes zero
  vector mutations. It also proves byte-identical marker/checkpoint/current
  pointer/SQLite state, committed-receipt acknowledgement recovery, and
  restart admission of the newly bound generation.
- The focused failure fixture injects failure before policy activation and
  proves the previous policy/pointer/vector tuple remains restart-readable.
- A legacy v3 fixture remains `requires_reindex`.
- MCP no longer invokes the legacy `rebuildCallGraphForIndex()` after repair.
  It records completion only after exact generation and source-checkpoint
  proof.

Focused evidence:

```text
Core R0 compatibility/success/failure/v3 fixtures: 4 passed, 0 failed
Core repair-focused regression set:               19 passed, 0 failed
Core generation/receipt/retention set:             5 passed, 0 failed
MCP repair lifecycle/proof set:                   11 passed, 0 failed
Core and MCP direct TypeScript checks:             passed
Focused ESLint and git diff --check:               passed
```

#### R1: Relationship-backed test references

Status: complete with terminal decision
`test_reference_relationship_pass`.

Authorized outcome:

> Restore the existing public root-target `call_graph.testReferences` contract
> demonstrated by the legacy oracle, using the canonical relationship sidecar
> without merging or querying legacy v3 graph state.

Repository alignment:

- `RelationshipType` and sidecar validation already accept `TESTS`.
- `CallGraphTestReference` and the public response schema already exist.
- TS/JS/Python advertise `testReferenceCapability: "production_ready"`.
- The current relationship builder emits only `CALLS`, `IMPORTS`, and
  `EXPORTS`.
- The current relationship-backed handler explicitly returns no legacy test
  references. That anti-fallback rule remains correct.

Primary owners:

- `packages/core/src/relationships/builder.ts`
- one Core-owned relationship test-path helper, reused by MCP
- `packages/mcp/src/core/relationship-backed-call-graph.ts`
- focused relationship builder/delta and MCP call-graph tests

Implementation contract:

1. Move the existing deterministic test/fixture path predicate to one
   Core-owned relationship helper and have the MCP note-prioritization path
   reuse it. Do not maintain two classifiers.
2. For each already resolved `CALLS` record whose source owner is in an
   admitted test/fixture path and whose target is a non-test repository
   symbol, emit one additive `TESTS` record with the same source/target exact
   identities, site span, file, and confidence.
3. Keep the original `CALLS` record. `TESTS` is attached evidence, not a
   replacement graph edge.
4. Do not synthesize a `TESTS` record from filename/name similarity or from an
   unresolved/suppressed call.
5. Relationship-backed `call_graph` performs one bounded inbound `TESTS`
   lookup for the requested root symbol and maps those records to the existing
   `testReferences` shape. `TESTS` records never enter CALLS traversal,
   `nodes`, `edges`, or edge counts.
6. Sort and deduplicate with the existing relationship and public
   test-reference comparators. Preserve the existing response limit.
7. Bump the relationship identity after R0 passes.

Focused proof:

- a resolved test call produces both `CALLS` and `TESTS`;
- a production caller produces `CALLS` only;
- an unresolved, ambiguous, external, or merely same-name test site produces
  no `TESTS`;
- relationship-backed `call_graph` returns the same root test-reference shape
  that the legacy oracle established, without loading legacy state;
- adding, deleting, renaming, or retargeting the test call produces the same
  canonical records through delta publication and a clean rebuild; and
- missing/corrupt relationship state retains current fail-closed behavior.

Terminal decision:

- `test_reference_relationship_pass`; or
- `test_reference_correctness_fail`.

Execution result:

- one Core-owned `isTestOrFixturePath()` predicate now owns both relationship
  publication and MCP test/fixture note classification;
- each resolved test-to-production call retains its original `CALLS` record
  and gains one same-identity `TESTS` record;
- production, unresolved, ambiguous, external, and test-to-test calls do not
  gain test-reference authority;
- relationship-backed `call_graph` performs one generation-bound inbound
  `TESTS` query for the requested root and preserves the existing 50-reference
  limit and response shape;
- `TESTS` records do not enter traversal nodes, edges, or edge counts;
- add, delete, rename, and retarget delta cases equal clean rebuild output; and
- the development relationship identity advanced to
  `relationship-v6+test-references`.

Focused evidence:

```text
Core relationship builder and delta fixtures: 21 passed, 0 failed
MCP relationship-backed and public graph fixtures: 29 passed, 0 failed
Core and MCP direct TypeScript checks: passed
Focused ESLint: passed
```

### Phase 5B: Python Receiver-Aware `CALLS`

Status: Phase 5B0/5B1 and the narrowed R2 portion of Phase 5B2 are implemented
and verified.

Decision boundary:

> Recover demonstrated repository-local Python member-call edges without
> importing a second graph store, parser runtime, or MCP product.

#### 5B0: Freeze the relationship oracle

Before changing extraction or resolution, freeze fixtures for:

- the existing direct-call graph, including the six outgoing edges currently
  returned for `run_validation`;
- `CircuitBreaker.check_drawdown` resolving its same-class `self` calls to
  `_determine_new_state`, `_handle_state_transition`, and
  `_build_state_snapshot`;
- `_handle_state_transition` resolving `_get_threshold_for_state`;
- a unique class-qualified call such as `SpreadModelFactory.create_model`;
- a parameter-annotated local receiver calling one repository method;
- an unresolved external receiver such as `pd.merge` producing no invented
  repository edge; and
- two classes with the same method name remaining unresolved when receiver
  evidence cannot distinguish them.

Use codebase-memory results over the same frozen source revision as comparator
evidence only. Satori's source, symbol registry, and deterministic expected
edges remain the acceptance authority; matching the other project's total edge
count is not a goal.

#### 5B1: Resolve existing member-call facts

Use the `CallSite` facts Satori already extracts before adding new analysis:

1. Accept `kind="member"` at the relationship-builder boundary.
2. Resolve `self.<name>` and `cls.<name>` only inside the source method's
   enclosing class.
3. Resolve `<ClassName>.<name>` only when both the class and member identify one
   repository symbol under the existing import/module authority.
4. Preserve direct-call and constructor behavior unchanged.
5. Fail closed on ambiguous, external, dynamic, or unsupported receivers.
6. Emit the existing `RelationshipRecord`; do not add another graph schema or
   query-time resolver.
7. Preserve deterministic ordering and per-file contribution ownership.

Stop after this slice if it satisfies the frozen same-class and
class-qualified witnesses. Do not add a type system merely to increase an edge
count.

Implementation result:

- the relationship builder accepts exact Python `receiver.method` member facts;
- `self` and `cls` resolve only inside the source method's nearest enclosing
  class;
- a simple class-qualified receiver resolves only when the class is unique in
  the source file or a currently supported relative-import target;
- at the 5B1 boundary, external, chained, computed, arbitrary local,
  typed-local, and ambiguous receivers remained unresolved;
- direct and constructor call behavior is unchanged;
- relationship identity is
  `relationship-v5+python-receiver-calls`; and
- focused delta fixtures prove that class-receiver ambiguity produces the same
  graph through incremental recomputation and a clean rebuild.

#### 5B2: Add only the typed evidence still required

Status: complete with terminal decision `typed_receiver_parameter_pass`.
Import aliases and simple parameter annotations are implemented; broader
local/return-type inference remains deferred.

Frozen witnesses:

```python
from .factory import SpreadModelFactory as Factory

def build():
    Factory.create_model()
```

```python
class MetricsModel:
    def calculate_metrics(self): ...

def inspect(model: MetricsModel):
    model.calculate_metrics()
```

Before R2, the first witness was already fully represented by the persisted
`ModuleBinding`: `importedName="SpreadModelFactory"` and
`localName="Factory"`, but the builder rejected it by requiring the imported
and local names to equal the receiver.

The pinned Python grammar represents the second witness as a
`typed_parameter` with a simple identifier under its `type` field. Before R2,
`RelationshipAnalysisEvidence` persisted only `moduleBindings` and
`callSites`, so the parameter type was lost before relationship construction.

##### R2 contract

Add one internal per-file fact to the existing language-analysis result and
relationship contribution:

```ts
interface ReceiverTypeBinding {
    localName: string;
    typeName: string;
    kind: 'parameter_annotation';
    span: SourceSpan;
}
```

The exact property name may follow existing naming conventions, but its
meaning and allowed value are frozen above. It is not a public schema.

Primary owners:

- `packages/core/src/language-analysis/types.ts`
- `packages/core/src/language-analysis/tree-sitter-adapter.ts`
- `packages/core/src/relationships/builder.ts`
- `packages/core/src/symbols/sidecar.ts` and contribution schema constant
- Context's existing analysis-evidence projections
- their focused language-analysis, builder/delta, sidecar, and Context tests

Implementation:

1. Only in the Python Tree-sitter strategy, extract a directly named
   `typed_parameter` or `typed_default_parameter` whose type is one simple
   identifier.
2. Record the parameter binding in the same Tree-sitter pass that already
   produces symbols, module bindings, and call sites. No regex, second parse,
   subprocess, or query-time source scan is allowed.
3. Extend `LanguageAnalysisResult`, `RelationshipAnalysisEvidence`, the
   per-file relationship contribution writer/validator, and Context's
   analysis-evidence plumbing. Do not introduce another sidecar.
   Bump `RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION` because the persisted
   evidence shape changes; old contributions must be rebuilt, never
   reinterpreted as having an empty binding set.
4. For a member call, consider only receiver bindings whose span belongs to
   the already resolved source callable. Resolve only when all applicable
   bindings name one class after local/import-alias resolution.
5. Resolve a type or class receiver through the current source file or one
   supported relative import. For an alias, match `localName` to the written
   type/receiver and `importedName` to the target class.
6. Require one exact target class and one exact method inside that class.
   Conflicts, external modules, chained receivers, forward-string
   annotations, generics, unions, optionals, attributes, subscripts, and
   computed expressions remain unresolved.
7. Preserve direct, constructor, `self`, `cls`, and unaliased class-qualified
   behavior.
8. Bump the relationship identity after R0 passes.

Focused proof:

- the existing alias witness resolves `Factory.create_model`;
- the existing `MetricsModel` parameter witness resolves
  `model.calculate_metrics`;
- identical parameter names in separate functions cannot leak type authority
  across callable spans;
- two conflicting or ambiguous class candidates remain unresolved;
- `pd.merge`, `object.method`, string annotations, `Optional[T]`, `T | None`,
  and chained receivers remain unresolved;
- persisted evidence rejects missing, extra, malformed, or unsupported
  receiver-binding fields;
- parameter addition/removal/type change and imported-class rename converge
  between delta publication and a clean rebuild; and
- unchanged chunks are not embedded during ordinary source deltas.

Terminal decision:

- `typed_receiver_parameter_pass`; or
- `typed_receiver_correctness_fail`.

Execution result:

- Python Tree-sitter analysis emits `ReceiverTypeBinding` only for directly
  named `typed_parameter`/`typed_default_parameter` nodes whose type is one
  simple identifier;
- the fact is persisted in the existing per-file relationship contribution
  under `relationship_file_contribution_v2`; missing, extra, malformed, retired,
  or unsupported binding shapes are rejected rather than treated as empty;
- exact relative-import aliases now map the written local class name to the
  imported repository class before method resolution;
- parameter receiver facts are scoped to the nearest resolved callable, so the
  same local parameter name in another function cannot lend type authority;
- one exact class and one exact method are required; string, generic, union,
  optional, attribute, chained, external, unknown, and ambiguous receivers
  remain unresolved;
- annotation add/remove/type changes and imported-class changes converge
  between relationship delta and clean rebuild output;
- Context persists and reads the new evidence, and an ordinary changed-file
  delta embeds only that file's changed chunks; and
- the final relationship identity is
  `relationship-v7+test-references+python-typed-receivers`.

Focused evidence:

```text
Language-analysis, relationship builder/delta, and sidecar fixtures: 121 passed, 0 failed
Context persisted-receiver and unchanged-embedding fixtures:          2 passed, 0 failed
R0 relationship-only compatibility fixtures under the final identity: 4 passed, 0 failed
Core direct TypeScript and focused ESLint:                             passed
```

##### Explicitly deferred 5B2 candidates

Do not add these without a new named repository witness and a separately
frozen syntactic/data-flow contract:

- constructor assignment types;
- simple annotated assignments;
- repository-local return types;
- optional/union normalization; or
- arbitrary assignment/reassignment inference.

The pinned upstream implementation remains a behavioral reference only. Reuse
Satori's existing parse, symbol registry, relationship sidecars, publication
generation, and delta-contribution lifecycle. Do not introduce the upstream C
runtime, SQLite graph, subprocess, second source parse, synthetic built-in or
stdlib nodes, or query-time type inference.

If implementation substantially copies upstream code, mappings, or tests,
update `THIRD_PARTY.md` from its current reference-only statement to record the
exact imported scope, revision, and source hashes. Relevant reviewed source
identities are:

| Upstream source | SHA-256 |
| --- | --- |
| `internal/cbm/extract_calls.c` | `94b9ae1443ac1ef7d8fb06af7fcef60aa5d450575ad4bad320a9557e6bf0128d` |
| `internal/cbm/lsp/py_lsp.c` | `a2ed9a43117444e6603b01bccce1f556a608b4f958a32ac14559ab1b9852e84c` |
| `src/pipeline/pass_calls.c` | `e81e1a26adff762b82aa6b3d455dd40c3e966b3c97682e46dc0bfc71329ebd14` |
| `src/pipeline/pass_lsp_cross.c` | `a31cefdb4d0298d855f3498a6378a085b5c1dc9a598fe593c4ab429f25fc9b5a` |
| `src/pipeline/lsp_resolve.h` | `6eac160edb34a8bb3ca6e06a1a43f1d530aed516ccc48e7b5a7b5bcc63b6d13c` |

#### 5B3: Publication and compatibility

- Bump `relationshipVersion` when persisted relationship meaning changes.
- Complete R0 before the next bump so a relationship-only compatibility change
  can rebuild navigation and rebind the proven unchanged vector/lexical
  payload without embedding.
- Never mix relationship shards produced under different resolver identities.
- Preserve delta publication: changed resolution facts may recompute a
  deterministic conservative set of reference owners, but must not silently
  rebuild every unrelated file for an ordinary body edit.
- Preserve old-or-new generation activation, restart recovery, and missing or
  corrupt sidecar behavior.

Acceptance:

- Delta publication and a clean full rebuild produce the same canonical graph
  for the bounded mutation fixtures.
- Existing direct and constructor edges do not regress.
- Frozen same-class and class-qualified edges resolve without name-only
  cross-class fabrication.
- External and ambiguous calls remain unresolved rather than creating false
  repository edges.
- R0 performs zero vector-payload writes and zero embedding calls for a proven
  relationship-only upgrade; ordinary R1/R2 source deltas embed only actually
  changed chunks.
- Shared relationship state contains no Potion-, LanceDB-, Voyage-, or
  Milvus-specific assumptions.
- The public MCP tool surface and `call_graph` response contract remain fixed.
- The completed O1 repair makes `symbolId` authoritative over optional
  `symbolLabel`; this phase must preserve that contract rather than changing
  stored labels to hide identity drift.

### Phase 6: Language Expansion

Status: complete through
`docs/plans/MULTI_LANGUAGE_SYMBOL_DEFINITION_PARITY_PLAN.md`.

The order and tasks below are retained as historical planning context. Basic
symbol extraction, ownership, outline, and exact-open support have since shipped
for Go, Java, Rust, C#, C++, and Scala. Do not execute this section as written.
The replacement plan records terminal D0-D6 decisions, current extractor
truth, pinned upstream definition authorities, and the C/C++ parser boundary.
No executable symbol-definition work remains there. Kotlin and Swift were not
promoted by that completed program and are not implicitly authorized here.

Order:

1. Go
2. Java
3. Rust
4. C#
5. C/C++
6. Kotlin
7. Swift

Tasks per language:

- Add fixtures.
- Add symbol extraction.
- Add owner resolution tests.
- Add outline tests.
- Add import extraction where simple and deterministic.
- Add call graph only after import/symbol support is stable.

Acceptance per language:

- `search_codebase` returns symbol-owned groups.
- `file_outline` returns deterministic symbols.
- `read_file(open_symbol)` can open exact symbols.
- `call_graph` either works or returns structured unsupported state with fallback.

### Phase 7 / R4: Direct Qualification Record

Status: complete through the bounded R4 consolidation record. This is not
authority for a new benchmark framework.

Reusable evidence:

- `packages/mcp/src/core/search.eval.test.ts` covers deterministic search scope
  and ordering.
- grouped ownership, exact registry, compact response, outline, exact-open, and
  call-graph tests cover the public symbol-owned workflow.
- the frozen 30-task Potion/Voyage comparison used complete Satori hybrid
  retrieval and recorded required-owner top-five reach on 23/30 and 25/30
  tasks respectively. It is retrieval evidence, not a codebase-memory
  comparison or proof of provider parity.

R4 executed tasks:

1. Inventory the smallest existing tests that prove:
   - an implementation query returns a concrete symbol-owned target;
   - the target's canonical `read_file(open_symbol)` action is executable;
   - overload/same-name instances do not collapse;
   - implementation intent demotes tests/generated evidence;
   - file-owned fallback remains readable; and
   - repeated fixed input produces fixed ordering.
2. Add at most one focused MCP fixture only if one of those observable links
   has no existing proof.
3. Record serialized grouped and raw response byte counts for the same fixed
   fixture as descriptive context only. Do not invent a pass threshold without
   a previously frozen baseline.
4. Do not invoke codebase-memory, an answering agent, a judge, a paid provider,
   or a live repository benchmark. Those layers cannot change this plan's
   remaining implementation decisions.

Acceptance:

- every observable workflow link above has direct, named evidence;
- no public tool or response schema was added for the qualification;
- the 30-task owner-retrieval result is cited without converting it into a
  symbol-ranking or token-efficiency claim; and
- response-size observations are labeled descriptive.

Terminal decision:

- `symbol_owned_program_complete`; or
- `qualification_contract_gap` naming the one unproven observable link. This
  decision does not authorize unrelated retrieval tuning.

R4 execution record (2026-07-23):

- Decision: `symbol_owned_program_complete`.
- The smallest direct workflow inventory is:
  - concrete implementation owner:
    `handleSearchCode ranks canonical owners above tool wrappers for
    implementation queries`;
  - executable exact and span reads:
    `documented grouped navigation mappings validate and execute through
    registered tools`;
  - same-name/overload preservation:
    `grouped v2 keeps concrete symbol instances distinct and removes internal
    grouping identities`;
  - implementation-versus-test policy:
    `handleSearchCode demotes tests below implementation owners unless test
    intent is explicit`;
  - generated/source identity and ordering: the R3 fixture above;
  - file-owned fallback readability: the span-read branch of the documented
    navigation-mapping test; and
  - repeated deterministic ordering:
    `search eval matrix invariants hold for runtime/docs scope and
    deterministic ordering`.
- Those seven focused checks passed together. No additional workflow fixture
  was needed beyond the R3 witness.
- For one fixed one-result `result()` fixture, UTF-8 JSON serialization was
  1,234 bytes in grouped mode and 1,034 bytes in raw mode. These are
  descriptive observations only, not a quality or token-efficiency threshold.
- The existing 30-task Potion/Voyage result remains only owner-retrieval
  evidence (required owner in the top five on 23/30 and 25/30 tasks). It is not
  reinterpreted as symbol-ranking or provider-parity evidence.

## Test Plan

This is the program-level consolidation inventory. The completed bullets and
recorded command results are reusable historical evidence.

No test in this section is an instruction to reopen R0-R4. Future changes may
reuse this evidence only while the named code, fixtures, schemas, parser
assets, configuration, and relevant dependencies remain unchanged.

### Unit Tests

- Language router maps new extensions and special filenames.
- `symbolKey` generation is stable across line-only edits.
- `symbolInstanceId` changes for exact snapshot changes.
- Exact symbol open rejects stale `symbolInstanceId` / file hash mismatches.
- Owner resolver chooses tightest byte/AST span before line span.
- Owner resolver tie-breaks are deterministic.
- Evidence composer emits fallback when relationship support is missing.
- Overloads, nested symbols, and same-label symbols do not collapse incorrectly.

### Integration Tests

- Index fixture repo and assert symbol registry manifest.
- Search query returns symbol-owned groups.
- `file_outline` reads registry-backed symbols.
- `read_file(open_symbol)` resolves exact symbol from grouped search hint.
- `call_graph` remains compatible for TS/JS/Python.
- Legacy index without `ownerSymbolKey` degrades or repairs deterministically.
- Generated/source duplicates and test-helper name collisions retain distinct
  identities; exact lookup fails ambiguous rather than guessing.
- Relationship-backed TESTS records populate the existing root
  `testReferences` field without entering CALLS traversal.
- A relationship-only version repair proves and reuses the exact vector
  payload without vector writes.

### Regression Tests

- No public tool count change.
- `scope=runtime` still excludes docs.
- Test files remain demoted unless query asks for tests.
- `requires_reindex` still blocks stale sidecar/index states.
- Hard-denied build outputs, ignored files, and secret-bearing files remain
  excluded. A separately indexable `generated/` fixture remains eligible but
  is deterministically classified and demoted by the existing search policy.

## Documentation Policy Applied During Implementation

- Public behavior changes made by R0-R4 required corresponding updates to
  `docs/SATORI_FEATURES_AND_USE_CASES.md`.
- The root README changes only when public language-support or product claims
  change.
- Any future copied upstream material requires a separately authorized
  `THIRD_PARTY.md` update.

## Resolved Decisions

1. Multi-language symbol-definition parity is complete under its own D0-D6
   plan. This plan does not choose another language target.
2. Canonical-root, generation, receipt, and source-observation identity are
   established publication authorities. The completed batches required no
   root-fingerprint redesign.
3. Relationship-backed test references preceded additional receiver inference
   because the public capability already claimed them while steady-state
   traversal omitted them.
4. Import aliases and one simple parameter-annotation fact are the only
   receiver additions with frozen witnesses. Broader type inference is
   deferred.
5. Existing confidence thresholds and ranking policy remain unchanged.
6. Legacy `metadata.symbolId` cleanup is not required for any remaining
   observable outcome and is excluded.

## Completed Execution Sequence

```text
R0 relationship-only navigation repair
    -> complete: relationship_only_upgrade_pass

R1 relationship-backed TESTS
    -> complete: test_reference_relationship_pass

R2 Python import-alias and parameter receiver evidence
    -> complete: typed_receiver_parameter_pass

R3 generated/source duplicate evidence
    -> complete: ambiguity_contract_pass

R4 direct qualification record
    -> complete: symbol_owned_program_complete
```

Verification followed the ownership boundaries below. These commands and
boundaries are retained as reusable evidence, not as authorization to rerun or
extend the completed batches.

- R0 owns persisted-index compatibility, repair, publication activation, and
  backend-neutral no-vector-write evidence.
- R1 owns relationship construction, test-path classification, relationship
  query projection, delta equivalence, and the existing MCP
  `testReferences` contract.
- R2 owns Tree-sitter evidence extraction, persisted evidence validation,
  Python member resolution, and delta equivalence.
- R3 and R4 are evidence-only and add no implementation unless their exact
  frozen oracle fails.

## Terminal Decisions

Each batch records exactly one:

| Batch | Pass | Fail/block |
| --- | --- | --- |
| R0 | `relationship_only_upgrade_pass` | `publication_compatibility_blocked` |
| R1 | `test_reference_relationship_pass` | `test_reference_correctness_fail` |
| R2 | `typed_receiver_parameter_pass` | `typed_receiver_correctness_fail` |
| R3 | `ambiguity_contract_pass` | `ambiguity_identity_gap` |
| R4 | `symbol_owned_program_complete` | `qualification_contract_gap` |

An implementation batch passes only when its new behavior, directly
invalidated existing contracts, compatibility identity, and directly affected
documentation are complete. An evidence-only failure identifies its concrete
owner but does not authorize an unrelated redesign.

## Final Consolidation Record

The final affected build and verification surface passed on 2026-07-23:

- Core language-analysis, relationship-builder, relationship-sidecar,
  relationship-only repair, and two-file index-path checks passed under the
  final `relationship-v7+test-references+python-typed-receivers` identity.
- MCP relationship-backed and public call-graph checks passed 29/29.
- The focused R3/R4 workflow consolidation passed 7/7.
- Core and MCP builds and direct package typechecks passed.
- Focused ESLint over every changed TypeScript file passed.
- `git diff --check` passed.

No paid provider, live repository benchmark, release suite, installer
qualification, or broad retrieval evaluation was run.

## Handoff State

The repository is aligned with the completed symbol-owned retrieval
architecture, the completed multi-language definition program, and all R0-R4
batches in this plan. R0 provides the proven v4 relationship-only upgrade path
without importing codebase-memory or adding a second graph or parser
authority. R1 restores persisted test-reference evidence, R2 adds only the
frozen exact Python receiver cases, and R3/R4 close the remaining direct
evidence contracts. Ordinary fingerprint admission remains exact, and vector
reuse is not authorized for any compatibility delta beyond the proven R0
relationship-only case. No further implementation is authorized or required
by this plan.
