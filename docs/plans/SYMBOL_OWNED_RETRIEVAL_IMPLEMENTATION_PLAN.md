# Symbol-Owned Retrieval Implementation Plan

## Capability

Satori will shift from chunk-first semantic retrieval to symbol-owned repository intelligence. After this ships, agents will discover implementation concepts as stable symbols first, then navigate to supporting chunks, callers, tests, and file spans through the existing MCP tools.

The public MCP tool surface stays fixed:

- `list_codebases`
- `manage_index`
- `search_codebase`
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
  schemaVersion: 'relationship_v1';
  symbolRegistryManifestHash: string;
  relationshipVersion: string;
  builtAt: string;
}
```

`symbolRegistryManifestHash` must cover schema version, root fingerprint, index policy hash, language router version, extractor version, and file hashes. MCP must load relationship sidecars only when this hash matches the loaded compatible symbol registry manifest.

Initial scope:

- Preserve current TS/JS/Python call graph behavior.
- Add import/export edges where extractors already provide enough data.
- Add test references using filename and static reference heuristics.
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
- Emit ambiguity hints for same-name symbols, overloads, generated/source duplicates, or test helper collisions.

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

## Language Capability Roadmap

### Baseline: current full support

```text
TypeScript: SEARCH, AST_SPLIT, SYMBOLS, OWNER, CALL_GRAPH, TEST_LINKS
JavaScript: SEARCH, AST_SPLIT, SYMBOLS, OWNER, CALL_GRAPH, TEST_LINKS
Python:     SEARCH, AST_SPLIT, SYMBOLS, OWNER, CALL_GRAPH, TEST_LINKS
```

`IMPORTS` is intentionally not claimed until relationship extraction stores import/export edges.

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

Status: implemented for registry-backed outline/exact resolution with legacy call-graph-sidecar fallback.

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
- Missing/incompatible registry falls through to existing call-graph-sidecar `requires_reindex` or unsupported envelopes.

### Phase 3: Tightest Owner Resolution

Status: partially implemented.

Implemented:

- `packages/core` assigns `ownerSymbolKey` and `ownerSymbolInstanceId` to indexed chunks at index time.
- Owner resolution chooses the tightest extracted owner by byte containment when available, otherwise line containment.
- Synthesized `file` symbols remain the fallback owner.
- Retrieval documents preserve owner metadata through `Context.semanticSearch`.
- Grouped search prefers owner metadata when present while preserving raw mode and file grouping.
- Grouped search repairs legacy chunks without owner metadata from a compatible symbol registry using file/span containment.

Remaining:

- Exact same-line/decorator byte fixtures once extractors expose byte spans for those cases.

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

Status: partially implemented.

Implemented:

- Grouped `search_codebase` aggregates candidate chunks by owner identity when owner metadata exists.
- Legacy chunks without owner metadata are repaired at query time from compatible registry spans before falling back to legacy `symbolId` or proximity grouping.
- Search groups expose additive `symbolKey`, `symbolInstanceId`, `symbolKind`, `confidence`, and debug `symbolAggregation`.
- Symbol scoring uses best representative score plus a capped logarithmic support boost.
- Reranker remains evidence-only; call graph hints now validate against registry-backed `symbolInstanceId` navigation state.
- Same-label declaration groups with distinct owner identities remain separate.

Remaining:

- Relationship edge records as the source of graph hints/call graph traversal.
- Broader ambiguity fixtures for overloads, generated/source duplicates, and test-helper collisions.

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
- Same-name symbols, overloads, generated/source duplicates, and test-helper collisions remain separate candidates with ambiguity hints.
- Ranking is stable across repeated runs.

### Phase 5: Relationship Engine v1

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

Current partial implementation:

- Core writes and reads relationship manifests under the navigation sidecar root.
- Relationship manifests are validated against the loaded symbol registry manifest hash.
- Core writes deterministic per-file relationship shards with conservative function/method-owned `CALLS v0` records and TS/JS file-owner `IMPORTS`/`EXPORTS v0` records during completed full indexes.
- Symbol and relationship sidecar subtree rewrites use rollback-aware temp-directory swaps. Symbol registry writes keep the previous symbol subtree until the root manifest commit succeeds; if subtree or manifest commit fails, the previous readable registry or relationship sidecar remains intact. Empty relationship placeholders are created only after the symbol registry commit succeeds.
- Relationship `CALLS v0` extraction intentionally excludes class container spans, skips ambiguous same-name targets, and downgrades unique cross-file name-only matches to `low` confidence until import/receiver-aware resolution exists. `IMPORTS`/`EXPORTS v0` records only resolvable relative module edges and unambiguous local export declarations; package imports, unresolved paths, ambiguous local exports, and multiline module syntax are skipped.
- Registry-backed `search_codebase` and `file_outline` now keep graph hints supported only through a compatible relationship sidecar, and supported `symbolRef.symbolId` carries the registry `symbolInstanceId`. Missing or incompatible relationship state emits deterministic warnings or reindex guidance instead of reviving legacy graph handles.
- `call_graph` now serves traversal directly from relationship records when compatible navigation sidecars exist. Missing or incompatible registry/relationship state returns deterministic `not_ready`, `missing_symbol_registry`, `missing_relationship_sidecar`, `incompatible_symbol_registry`, `incompatible_relationship_sidecar`, `not_found`, or `requires_reindex` behavior rather than falling back to legacy v3 runtime traversal.

Acceptance:

- TS/JS/Python call graph behavior remains stable.
- Search groups with unsupported graph capability still include executable fallback.
- Relationship engine can represent import/test refs without exposing new MCP tools.
- Relationship sidecar absence degrades only graph hints/call graph when registry remains compatible.

### Phase 5B: Python Receiver-Aware `CALLS`

Status: Phase 5B0/5B1 implemented and verified; Phase 5B2 not entered.

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
- an annotated or constructor-bound local receiver calling one repository
  method;
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
- external, chained, computed, arbitrary local, typed-local, and ambiguous
  receivers remain unresolved;
- direct and constructor call behavior is unchanged;
- relationship identity is
  `relationship-v5+python-receiver-calls`; and
- focused delta fixtures prove that class-receiver ambiguity produces the same
  graph through incremental recomputation and a clean rebuild.

#### 5B2: Add only the typed evidence still required

Status: not entered; requires separate evidence and authorization.

Enter this slice only if 5B1 passes its own fixtures but a frozen, important
receiver-bound witness such as `model.calculate_metrics` remains unresolved.

Port the minimum applicable behavior from the pinned codebase-memory Python
resolver into Satori's existing TypeScript/tree-sitter pipeline:

- import aliases and imported class bindings;
- parameter annotations;
- constructor assignment types;
- simple annotated assignments;
- repository-local return types; and
- the narrow optional/union normalization needed by a frozen fixture.

These facts must be deterministic per-file derived state. Reuse Satori's
existing parse, symbol registry, relationship sidecars, publication generation,
and delta-contribution lifecycle. Do not introduce the upstream C runtime,
SQLite graph, subprocess, second source parse, synthetic built-in/stdlib nodes,
or query-time type inference.

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
- Invalidate and rebuild relationship/navigation state without invalidating
  compatible lexical or embedding state.
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
- Unchanged chunks are not re-embedded.
- Shared relationship state contains no Potion-, LanceDB-, Voyage-, or
  Milvus-specific assumptions.
- The public MCP tool surface and `call_graph` response contract remain fixed.
- The completed O1 repair makes `symbolId` authoritative over optional
  `symbolLabel`; this phase must preserve that contract rather than changing
  stored labels to hide identity drift.

### Phase 6: Language Expansion

Status: superseded for remaining symbol-definition parity by
`docs/plans/MULTI_LANGUAGE_SYMBOL_DEFINITION_PARITY_PLAN.md`.

The order and tasks below are retained as historical planning context. Basic
symbol extraction, ownership, outline, and exact-open support have since shipped
for Go, Java, Rust, C#, C++, and Scala. Do not execute this section as written.
The replacement plan records the current extractor truth, pinned upstream
definition authorities, the C/C++ parser boundary, and the remaining
per-language parity work. It does not reopen Phase 5B call-graph work.

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

### Phase 7: Eval Harness and Regression Matrix

Files:

- existing tests
- possible new `tests/integration/symbol-owned-retrieval.*`
- docs/eval notes if added

Tasks:

- Build 8-12 representative tasks across web/backend/AI/systems/mobile.
- Compare Satori before/after against codebase-memory on:
  - first useful result
  - whether result is a symbol
  - whether next action is executable
  - token size of response
  - false positives from tests/docs
- Keep results reproducible with local fixture repos where possible.

Acceptance:

- Satori returns a symbol-owned group for target implementation queries.
- Satori response token footprint does not grow materially for common searches.
- Satori no longer requires fallback to grep/codebase-memory for common TS/JS/Python/Python-large-file navigation.

## Test Plan

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
- Generated/source duplicates and test-helper name collisions produce deterministic ambiguity hints.

### Regression Tests

- No public tool count change.
- `scope=runtime` still excludes docs.
- Test files remain demoted unless query asks for tests.
- `requires_reindex` still blocks stale sidecar/index states.
- Generated/ignored/secret files remain excluded.

## Documentation Updates Required With Implementation

- Update `docs/SATORI_FEATURES_AND_USE_CASES.md` when public behavior changes.
- Update the root README only when its language-support or product claims change.
- Add third-party/MIT attribution before copying any upstream code or tables.

## Open Questions

1. What is the first non-TS/JS/Python language target: Go for backend coverage or Rust/C++ for systems coverage?
2. What exact root fingerprint strategy should handle moved repos, symlinks, and CI path differences?
3. Should relationship extraction v1 add test-reference edges next, or first strengthen receiver-aware and alias-aware relationship resolution now that MCP `call_graph` already traverses relationship records?
4. What confidence thresholds should downgrade a symbol group from high to medium or low?
5. Which remaining legacy `metadata.symbolId` cleanup can be deleted immediately now that runtime navigation treats `symbolInstanceId` as the exact steady-state identity?

## Completed Patch And Stopping Point

Phase 5B0/5B1 froze direct-call preservation and member-call
positive/negative fixtures, consumed existing member `CallSite` facts, resolved
exact same-class and unique class-qualified calls, and preserved ambiguity by
omission. No codebase-memory implementation was copied, the public tool
contract did not change, and no retrieval architecture was added.

Stop here. Phase 5B2 requires a separately frozen important typed-receiver
witness and separate implementation authority.

## Handoff State

This document records the reviewed architecture and the completed bounded
Phase 5B0/5B1 follow-up. It performed no user reindex and imported no
codebase-memory implementation. Phase 5B2 remains unimplemented and
unauthorized.
