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

`symbolKey` lookup may return multiple records across snapshots, overloads, or stale-compatible cases. Callers must disambiguate with `symbolInstanceId`, file hash, manifest compatibility, exact file constraints, or exact label constraints.

Within one compatible registry snapshot, duplicate `symbolKey` records are allowed only for language-supported overloads or extractor-declared ambiguity. Unexpected duplicate keys must emit a registry warning.

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
- If repair is ambiguous or impossible, downgrade to the synthesized file owner with a warning.
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
| Language has `SEARCH` only | normal retrieval with synthesized file owner and low/medium confidence | unsupported outline | file/range only | unsupported with fallback |
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
- Exact mode rejects stale `symbolInstanceId` / file hash mismatches.
- Same-label symbols in one file produce `ambiguous`, not guessed output.
- Missing/incompatible registry returns existing `requires_reindex` or unsupported envelopes.

### Phase 3: Tightest Owner Resolution

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
- Make MCP load and filter relationship sidecars; do not compute relationships at query time except compatibility fallback.
- Ensure `callGraphHint` is built from relationship capability, not language name alone.

Acceptance:

- TS/JS/Python call graph behavior remains stable.
- Search groups with unsupported graph capability still include executable fallback.
- Relationship engine can represent import/test refs without exposing new MCP tools.
- Relationship sidecar absence degrades only graph hints/call graph when registry remains compatible.

### Phase 6: Language Expansion

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

- Update `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` when behavior changes land.
- Update `docs/ARCHITECTURE.md` with symbol registry/navigation index diagrams.
- Update README language support matrix after capabilities are implemented.
- Add third-party/MIT attribution before copying any code or tables.

## Open Questions

1. What is the first non-TS/JS/Python language target: Go for backend coverage or Rust/C++ for systems coverage?
2. What exact root fingerprint strategy should handle moved repos, symlinks, and CI path differences?
3. Should relationship extraction v1 include import/export edges for TS/JS/Python in the same patch as calls, or land calls first?
4. What confidence thresholds should downgrade a symbol group from high to medium or low?
5. How long should legacy `metadata.symbolId` compatibility remain before requiring reindex?

## Recommended First Patch

Implement the lowest-risk slice of Phase 1 plus contracts only:

- Expand language router and extension coverage.
- Add capability flags.
- Add symbol registry TypeScript interfaces and manifest schema without writing sidecars yet.
- Add tests proving route/capability honesty.
- Add docs describing capability semantics and stable/exact symbol identity.
- Do not change index-profile defaults or broaden the default indexed corpus yet.
- Do not change search ranking yet.
- Do not change `file_outline`, `call_graph`, or `search_codebase` behavior yet.

This creates the stable internal vocabulary needed for the larger migration without risking MCP response regressions.

## Handoff State

Ready for architecture review, then direct implementation in small phases. The first coding lane should be `tdd-workflow` plus `verification-loop` because this changes indexing contracts and search behavior.
