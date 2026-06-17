# Satori Plan 2: Relationship-Backed Navigation, Then SQLite Store

## Capability

Plan 2 makes Plan 1's symbol registry and relationship sidecars become Satori's real navigation backend. The order matters:

```text
current JSON symbol/relationship sidecars
  -> relationship-backed navigation
  -> shared navigation store interface
  -> SQLite-backed store
  -> incremental navigation updates
```

This is an internal architecture change. The public MCP product surface stays fixed.

## Current Baseline

Plan 1 is far enough along that Plan 2 should extend it, not replace it.

Current live-tree state:

- JSON navigation sidecars are canonical.
- Full index writes symbol registry sidecars.
- Full index assigns `ownerSymbolKey` and `ownerSymbolInstanceId` to every chunk.
- Search-only files get synthesized file owners.
- `search_codebase groupBy=symbol` is owner-first.
- Registry repair only runs when grouped symbol search needs it.
- `file_outline` prefers the symbol registry, and exact navigation treats `symbolInstanceId` as the only steady-state exact symbol identity.
- `read_file(open_symbol)` routes through registry-aware `file_outline exact`.
- Relationship sidecars exist and write `CALLS`, `IMPORTS`, and `EXPORTS`.
- `call_graph` uses relationship-backed traversal for compatible symbol-owned indexes and promotes low-confidence cross-file `CALLS v0` edges only when current `IMPORTS`/`EXPORTS` evidence supports the target symbol.
- Incremental sync now reuses changed-file symbol output plus the previous compatible registry to rebuild canonical JSON navigation state after chunk updates, refreshes `navigation.sqlite`, and avoids re-splitting unchanged files. Relationship records are still recomputed against the merged registry for correctness, and incomplete changed-file indexing clears navigation state instead of publishing a mixed generation.
- `packages/core/src/navigation/store.ts` now defines `NavigationStore`, and `packages/core/src/navigation/runtime.ts` now serves canonical JSON navigation state while offering opt-in SQLite parity checks through the same wrapper.
- `search_codebase`, `file_outline`, `read_file(open_symbol)` via `file_outline exact`, and the registry/compatibility portions of `call_graph` now read through the runtime `NavigationStore` wrapper instead of direct sidecar calls in `handlers.ts`.
- Relationship query helpers now also route through `NavigationStore`, so relationship-backed traversal and compatibility checks can switch backends without changing MCP handlers.
- `packages/core/src/navigation/sqlite.ts` now implements `SQLiteNavigationStore`, a JSON-to-SQLite importer, a deterministic parity validator, and the shared `navigation.sqlite` path under the existing navigation root.
- Completed full indexes now import an additive `navigation.sqlite` cache immediately after JSON sidecar writes; JSON sidecars remain canonical, runtime reads stay on JSON by default, the default shared runtime store can opt into dual-read validation that compares SQLite in parallel, the same shared runtime store can serve SQLite experimentally with `SATORI_NAVIGATION_BACKEND=sqlite` plus warning-backed JSON fallback, and SQLite import failures are warning-only.

## Resolved Clarifications Before Coding

1. No copied code has been intentionally introduced in Plan 1. If later review finds copied or substantially adapted code, tables, tests, or schemas, attribution must be added before merge.
2. Current Satori work appears to borrow ideas and architecture patterns, not copied implementation. Even so, attribution discipline should be established now rather than deferred until copied code lands.
3. Symbol registry writes are rollback-safe for manifest-commit failure, and relationship placeholder creation happens only after the symbol registry commit succeeds.
4. Current `IMPORTS` and `EXPORTS` semantics are narrower than a full graph:
   - `IMPORTS`: resolvable relative-module file-owner edges for TS/JS-family files
   - `EXPORTS`: either file-to-file `export ... from` edges or file-owner to unambiguous local export symbol edges
5. Current relationship records are sufficient to make relationship-backed navigation the canonical implementation target. Remaining gaps such as receiver-aware resolution and alias-aware import resolution should be closed in the new model or explicitly dropped; they are not reasons to preserve legacy v3 behavior as a long-lived product contract.

## MIT Reuse and Attribution Policy

Both Satori and `codebase-memory-mcp` are MIT-licensed. Satori may copy, adapt, or port implementation details from `codebase-memory-mcp`, but copied substantial code, tables, tests, schemas, fixtures, or generated artifacts must preserve the upstream copyright and permission notice.

Current status:

- No copied `codebase-memory-mcp` implementation has been intentionally introduced in Plan 1.
- Current Satori work appears to borrow architecture patterns and product lessons, not copied code.
- Architectural inspiration alone does not require MIT notice inclusion, but copied code, tables, tests, or schemas do.

Required rule:

- If any code, table, grammar mapping, schema, fixture, test, or substantial implementation pattern is copied or ported from `codebase-memory-mcp`, the same patch must add attribution.

Suggested attribution file:

```text
THIRD_PARTY.md
```

Suggested entry:

```text
## codebase-memory-mcp

Source: https://github.com/DeusData/codebase-memory-mcp
License: MIT
Copyright: Copyright (c) 2025 DeusData

Satori may copy or adapt selected MIT-licensed implementation details from codebase-memory-mcp for repository graph storage, language coverage, relationship indexing, or test fixtures. Copied or substantially adapted material must preserve the upstream MIT copyright and permission notice.
```

Do not copy:

- public MCP tool surface
- Cypher/query UX
- graph visualization product surface
- ADR/dead-code/cross-service product claims
- marketing or benchmark claims

Allowed to copy or adapt with attribution:

- extension or language tables
- SQLite schema patterns
- relationship edge taxonomy ideas
- graph traversal implementation details
- parser fixture patterns
- migration, import, or export patterns
- tests that validate graph correctness

## Fixed Public Contract

The MCP tool surface remains frozen:

- `list_codebases`
- `manage_index`
- `search_codebase`
- `file_outline`
- `call_graph`
- `read_file`

Do not add new MCP tools, raw SQL/Cypher surfaces, or graph-query UX.

## Core Constraints

1. Files on disk plus snapshot/fingerprint state remain the source of truth.
2. Symbol and relationship data remain derived navigation state.
3. `search_codebase`, `file_outline`, `call_graph`, and `read_file` response shapes remain compatible.
4. `requires_reindex` and `hints.reindex` remain authoritative.
5. Public field names may still say `symbolId` or `symbolIdExact`, but on symbol-owned flows the canonical exact value is `symbolInstanceId`. `symbolKey` remains candidate lookup only. Legacy v3 graph ids are not steady-state runtime inputs.
6. Low-confidence relationships must not be presented as graph truth.
7. JSON sidecars remain canonical until SQLite parity is proven.
8. Incremental sync now preserves navigation readiness by reusing changed-file symbol output, merging it with unchanged registry state, and then rewriting navigation sidecars plus `navigation.sqlite`; future work is to reduce global relationship recomputation down to proven file-level deltas.
9. SQLite must not be the first patch.
10. Any copied MIT code, tables, schemas, fixtures, or tests must add attribution in the same patch.

## Non-Goals

- Do not add new MCP tools.
- Do not expose raw SQL, Cypher, or graph-query UX.
- Do not copy codebase-memory's public product surface.
- Do not make `CALLS v0` look stronger than it is.
- Do not remove JSON sidecars yet.
- Do not make SQLite the first patch.
- Do not claim fully file-local relationship sidecar rewrites yet; the current implementation avoids re-splitting unchanged files but still recomputes relationship artifacts against the merged registry for correctness.

## Plan 2A Freeze

Plan 2A should now be treated as the frozen baseline, not as future sequencing.

Completed baseline:

- Relationship-backed navigation exists over canonical JSON sidecars.
- Exact symbol resolution, `NavigationStore`, JSON-to-SQLite import, parity validation, optional dual-read validation, and optional explicit SQLite serving already exist.
- Incremental sync preserves navigation readiness by rebuilding navigation artifacts after chunk updates when a compatible registry-backed state already existed.

Do not reopen Plan 2A in the same patch as later work unless a defect is discovered in the frozen baseline.

## Active Direction Override

This section overrides older compatibility-oriented wording elsewhere in this document.

1. Relationship-backed navigation is the canonical implementation to finish.
2. JSON sidecars remain canonical storage until explicitly changed later.
3. Legacy v3 call-graph behavior is removed from steady-state product behavior. Keep any surviving v3 code only as temporary cleanup or oracle-test scaffolding.
4. `call_graph` must be sourced from relationship records. If the new model cannot represent a behavior we still need, add that behavior to the new model or delete the requirement; do not re-entrench legacy fallback.
5. The public field names may still say `symbolId` or `symbolIdExact`, but on symbol-owned flows the expected exact value is `symbolInstanceId`. `symbolKey` remains candidate lookup only.
6. SQLite stays optional and additive. Do not plan around SQLite-default serving.

## Remaining Work After Plan 2A

### Phase 2B: Legacy Removal / Relationship Replacement

Goal:

```text
replace legacy graph navigation with symbol-owned relationship navigation
prove the replacement directly in tests
delete transitional legacy paths instead of broadening compatibility
```

Code targets:

- `packages/mcp/src/core/handlers.ts`
- `packages/mcp/src/tools/read_file.ts`
- `packages/mcp/src/core/handlers.call_graph.test.ts`
- `packages/mcp/src/core/handlers.file_outline.test.ts`
- `packages/mcp/src/core/handlers.scope.test.ts`

Tasks:

1. Make registry/relationship identity canonical in hints and exact opens.
   - `buildRegistrySymbolCallGraphHint(...)` should emit `symbolInstanceId`-backed hints, not prefer legacy v3 node ids.
   - `buildSearchGroupCallGraphHint(...)` should stop treating legacy `symbolId` as first-class navigation identity.
   - `read_file(open_symbol)` should resolve the exact symbol by `symbolInstanceId` on symbol-owned flows; if the public field name remains `symbolId`, document that its canonical value is `symbolInstanceId`.
2. Remove legacy v3 ids from the steady-state exact resolver.
   - `findExactRegistrySymbols(...)` should match `symbolInstanceId` and unambiguous `symbolKey` only.
   - Stale exact ids must return `not_found` or `requires_reindex`, never silently route through legacy aliases.
3. Make relationship-backed `call_graph` authoritative.
   - Remove the path that returns the legacy graph as the primary answer when relationship traversal is empty.
   - Remove wholesale legacy fallback from `handleCallGraph(...)` unless a test proves the relationship model still cannot represent a required behavior.
   - Stop merging legacy `notes` and `testReferences` into relationship-backed results. If those concepts still matter, reintroduce them through relationship records or explicit new-model evidence.
4. Remove registry-outline dependence on the legacy sidecar.
   - Registry-backed `file_outline` should remain the only normal outline path on symbol-owned indexes.
   - Missing relationship sidecars should produce deterministic `requires_reindex` or `not_ready` behavior, not legacy graph hints.
5. Remove grouped-search fallback that treats legacy retrieval `symbolId` as the owner identity.
   - Group by `ownerSymbolInstanceId`, `symbolKey` candidate repair, or deterministic file fallback only.

Acceptance tests:

- `search_codebase -> call_graph` works with `symbolInstanceId` from `callGraphHint.symbolRef`.
- `file_outline -> call_graph` works with `symbolInstanceId` from outline hints.
- `read_file(open_symbol)` works with `symbolInstanceId`.
- Stale `symbolInstanceId` returns `not_found` or `requires_reindex`, not legacy fallback.
- Relationship-backed `call_graph` returns correct callers/callees without a legacy sidecar.
- Missing relationship sidecar returns deterministic `requires_reindex` or `not_ready`, not legacy fallback.
- Legacy-v3-only tests move to temporary oracle coverage or are deleted when the replacement is proven.

### Phase 2C: JSON-Canonical Incremental Navigation

Goal:

```text
keep JSON sidecars authoritative
reduce sync rebuild cost without weakening freshness, rollback, or manifest honesty
```

Tasks:

1. Preserve the current safe fallback.
   - When changed-file indexing does not complete, keep serving behavior fail-closed by clearing navigation state and forcing reindex rather than publishing a mixed generation.
2. Reduce sync work against the JSON sidecars first.
   - reuse changed-file symbol output from incremental indexing
   - keep unchanged file symbols from the previous compatible registry
   - recompute relationship artifacts against the merged registry
   - refresh owner metadata for changed chunks
   - update manifests through the existing rollback-safe writers
3. Keep index-policy and scope rules identical to full indexing.
   - No navigation data for files the active index would not serve.
4. Preserve rollback-safe writes and explicit `requires_reindex` when compatibility is uncertain.

Acceptance:

- Successful sync keeps relationship-backed `file_outline`, `call_graph`, and `read_file(open_symbol)` runnable without full reindex while avoiding unchanged-file symbol extraction.
- Failed incremental updates do not leave partially updated navigation state.
- Incremental navigation rebuilds respect the same profile, denylist, ignore, and partial-index rules as full indexing.

### Phase 2D: SQLite Additive Validation

Goal:

```text
keep SQLite as an optional cache and validation path
prove parity on larger repos
do not make SQLite default-serving as part of this roadmap
```

Tasks:

1. Keep `SATORI_NAVIGATION_DUAL_READ=1` warning-only and low-latency.
2. Run parity on larger repos and fix deterministic mismatches.
3. Keep `SATORI_NAVIGATION_BACKEND=sqlite` as explicit opt-in only while JSON remains canonical.
4. Use SQLite for debugging, performance experiments, and canary coverage, not as the authoritative product path.

Acceptance:

- JSON remains the default serving backend.
- SQLite mismatches never fail user requests.
- SQLite import/parity evidence is strong enough to keep the optional backend healthy without changing the product contract.

## Historical Pre-2B Notes (Superseded)

These notes describe pre-Phase-2B sequencing assumptions. Keep them only as historical context while cleaning up the replacement patch. They are not active contract, and they must not be read as permission to preserve legacy-id fallback.

### 1. Historical exact-id normalization step before `call_graph` migration

`call_graph` still uses the public `symbolRef` shape `{ file, symbolId }`, but on symbol-owned flows the `symbolId` value is the canonical `symbolInstanceId`. Exact navigation no longer accepts `symbolKey` as an exact id. Pre-2B legacy graph-id aliasing was transition scaffolding, not future-state behavior.

Before relationship-backed `call_graph` traversal, the plan expected a small normalization layer:

```text
symbolRef input
  -> exact symbol resolver
  -> registry symbol
  -> relationship traversal
  -> existing call_graph response
```

This historical step maps to old Phase `2.0` framing. Phase 2B should delete the compatibility path rather than preserve it.

### 2. Put the new abstraction under `packages/core/src/navigation`

The next store is not only about relationships. It will own:

- symbol reads
- relationship reads
- manifest compatibility
- exact lookup
- owner lookup
- backend selection

`packages/core/src/navigation` is the cleanest long-term home.

### 3. Keep current import/export semantics explicit

Plan 2 must not pretend the current `IMPORTS` and `EXPORTS` records are already full symbol-to-symbol graph edges.

Current behavior is narrower:

- `IMPORTS` is mostly file-owner to file-owner for resolvable relative modules.
- `EXPORTS` is either file-owner to file-owner or file-owner to a unique local export symbol.

That means Phase `2.4` should be framed as import/export-assisted resolution, not import/export-complete traversal.

### 4. Keep SQLite colocated with the current navigation root

Do not invent a second storage root. The SQLite path should be derived from the same navigation root used by JSON sidecars:

```text
resolveNavigationSidecarRoot(...)
  -> navigation.sqlite
```

That keeps cleanup, migration, and compatibility checks aligned with current sidecar behavior.

### 5. Use warnings and gating before new response fields

The current public `call_graph` surface does not have a confidence model. Plan 2 should prefer:

- internal confidence gating
- deterministic warnings
- suppressing low-confidence edges until new-model evidence supports them

before adding any new response fields.

### 6. Keep the latest regression fixes in the Plan 2 test matrix

Plan 2 must keep these now-fixed behaviors covered:

- transition-era tests covered legacy call-graph `symbolId` aliases; remove those assertions once Phase 2B lands
- grouped symbol diversity is keyed by `symbolInstanceId`, not only `symbolKey`

The diversity constraint remains active. Legacy-id alias coverage is transitional and should disappear with the replacement patch.

## Historical Phase 2.0: SymbolRef Normalization (Superseded By Phase 2B)

This section captures the pre-2B normalization idea. Keep only the canonical exact-resolution pieces; do not treat it as ongoing justification for legacy-id fallback.

Add a shared exact symbol resolver for navigation callers before changing `call_graph`.

Responsibilities:

- Resolve:
  - `symbolInstanceId`
  - unambiguous `symbolKey`
- Return deterministic `ok`, `ambiguous`, `not_found`, `incompatible`, and `requires_reindex` states.

Acceptance:

- `file_outline exact` and future relationship-backed `call_graph` share the same exact symbol resolution rules.
- Stale or incompatible ids do not silently open nearby code.

## Phase 2.1: Relationship Reader API

Status:

- Implemented through `packages/core/src/navigation/query.ts`.
- The query helpers now consume `NavigationStore` rather than reading sidecar files directly, and tests cover an injected store seam explicitly.

Create a focused internal reader over the current JSON relationship sidecars.

Suggested module:

```text
packages/core/src/navigation
```

Suggested API:

```ts
getRelationshipManifest(root): RelationshipManifestState

getRelationshipsForSymbol(input):
  sourceInstanceId?
  sourceKey?
  targetInstanceId?
  targetKey?
  direction: "callers" | "callees" | "both"
  types?: RelationshipType[]

getRelationshipsForFile(input):
  file
  types?: RelationshipType[]

getGraphNeighbors(input):
  symbolInstanceId
  depth
  direction
  allowedTypes
```

Acceptance:

- Reads existing JSON relationship shards.
- Validates relationship manifest against symbol registry manifest hash.
- Returns deterministic missing/incompatible states.
- Does not require SQLite.
- Does not change MCP responses yet.

## Phase 2.2: Relationship-Backed `call_graph`

Status:

- Implemented in `packages/mcp/src/core/handlers.ts`.
- Relationship-backed traversal now uses `getGraphNeighbors(...)` through the shared store seam.

Migrate `call_graph` to use relationship records when available.

Priority order:

1. Resolve requested symbol through the shared exact symbol resolver.
2. Load a compatible relationship sidecar.
3. Traverse `CALLS` records by `sourceInstanceId` and `targetInstanceId`.
4. Return the existing `call_graph` response shape.
5. Use legacy v3 only as a temporary oracle while deleting the old path; do not keep fallback in steady-state runtime behavior.

Acceptance:

- Existing `call_graph` tests continue to pass.
- New tests prove relationship-backed caller/callee traversal works.
- Legacy-v3-only coverage moves to temporary oracle tests or is deleted when the replacement is proven.
- Missing or incompatible relationship sidecars converge on deterministic unsupported/reindex behavior from the new path.
- The implementation does not overstate `CALLS v0`.

## Phase 2.3: Confidence-Gated Traversal

Define how `call_graph` uses relationship confidence.

Recommended rules:

```text
high confidence:
  safe for default traversal

medium confidence:
  safe only when deterministically supported by other evidence or surfaced with warning

low confidence:
  not primary graph truth; include only through explicit fallback policy or when no stronger edge exists
```

Codebase-specific guidance:

- Same-file unique `CALLS v0` edges are normal traversal candidates.
- Cross-file name-only `CALLS v0` edges should remain weak.
- Import/export-supported cross-file calls can be promoted by deterministic evidence.

Acceptance:

- Same-file unique calls traverse normally.
- Cross-file name-only calls are not over-promoted.
- Ambiguous same-name calls remain skipped.
- Response warnings stay deterministic.

## Phase 2.4: Import/Export-Assisted Call Resolution

Use existing `IMPORTS` and `EXPORTS` records to improve cross-file call confidence.

Tasks:

- Map imported names to exporting files or symbols when the evidence is deterministic.
- Upgrade cross-file `CALLS` only when import/export evidence supports the target.
- Keep unresolved cross-file name-only calls low confidence.
- Skip ambiguous imports and exports rather than guessing.

Acceptance:

- `import { login } from "./auth"` plus `login()` resolves better than global same-name matching.
- Alias imports are either handled deterministically or skipped.
- Ambiguous exports stay skipped.
- Tests cover same-name functions across multiple files.

## Historical Phase 2.5: `read_file(open_symbol)` Hardening (Folded Into Phase 2B)

`read_file(open_symbol)` already routes through `file_outline exact`. The active requirement is canonical exact identity only; this section remains as historical context for work now absorbed by Phase 2B.

Tasks:

- Ensure `open_symbol.symbolId` can resolve:
  - canonical `symbolInstanceId` on symbol-owned flows
  - stable `symbolKey` only when unambiguous
- Reject stale `symbolInstanceId`.
- Return `ambiguous` for same-label or same-key candidates.
- Preserve outline metadata behavior.

Acceptance:

- Exact registry symbol opens are deterministic.
- Stale ids do not silently open nearby code.
- Same-label symbols do not collapse.

## Phase 2.6: NavigationStore Interface

After relationship-backed `call_graph` works, introduce the shared storage abstraction.

Status:

- Implemented for the JSON sidecar backend.
- The current interface returns rich state envelopes rather than bare arrays so MCP callers can preserve manifest hashes, warnings, and missing/incompatible reasons without guessing.

Suggested module:

```text
packages/core/src/navigation
```

Interface:

```ts
interface NavigationStore {
  getManifest(root: string): Promise<NavigationManifestState>;

  getSymbolsByFile(root: string, file: string): Promise<SymbolRecord[]>;

  getSymbolByInstanceId(
    root: string,
    symbolInstanceId: string
  ): Promise<SymbolRecord | null>;

  getSymbolCandidatesByKey(
    root: string,
    symbolKey: string
  ): Promise<SymbolRecord[]>;

  findOwnerForSpan(
    root: string,
    file: string,
    span: SymbolSpan
  ): Promise<SymbolRecord | null>;

  getRelationships(
    root: string,
    query: RelationshipQuery
  ): Promise<RelationshipRecord[]>;

  getCompatibilityState(root: string): Promise<NavigationCompatibilityState>;
}
```

Acceptance:

- JSON sidecars implement `NavigationStore`.
- MCP can read symbols and relationships through the interface.
- No behavior change when using the JSON backend.

## Phase 2.7: JsonNavigationStore Adapter

Wrap existing Plan 1 sidecars.

Status:

- Implemented for current MCP handler reads.
- Direct `readSymbolRegistrySidecar(...)` and `readRelationshipSidecar(...)` calls have been removed from `packages/mcp/src/core/handlers.ts`.
- Registry-backed outline now has an explicit injected-store test to prove the seam is real rather than accidental.

Tasks:

- Move direct sidecar reads behind `JsonNavigationStore`.
- Preserve current missing/incompatible behavior.
- Preserve warnings.
- Preserve exact output shapes.
- Add parity tests against current direct sidecar readers.

Acceptance:

- `search_codebase`, `file_outline`, `read_file(open_symbol)`, and `call_graph` read through `NavigationStore`.
- JSON remains canonical.
- No public schema changes.

## Phase 2.8: SQLiteNavigationStore Prototype

Status:

- Implemented as an additive backend in `packages/core/src/navigation/sqlite.ts`.
- SQLite is still not the default reader; it mirrors canonical JSON sidecars and is verified by parity tests before any future default switch.

Only after the JSON store abstraction is stable, add SQLite.

Storage location:

```text
resolveNavigationSidecarRoot(stateRoot, normalizedRootPath)/navigation.sqlite
```

Proposed schema:

```sql
navigation_manifest(
  key text primary key,
  value text not null
);

files(
  path text primary key,
  hash text not null,
  language text not null,
  symbol_count integer not null
);

symbols(
  symbol_instance_id text primary key,
  symbol_key text not null,
  file_path text not null,
  language text not null,
  kind text not null,
  name text not null,
  qualified_name text not null,
  label text not null,
  start_line integer not null,
  end_line integer not null,
  start_byte integer,
  end_byte integer,
  start_column integer,
  end_column integer,
  parent_key text,
  parent_qualified_name_path_json text not null,
  file_hash text not null,
  extractor_version text not null,
  ontology_tags_json text
);

relationships(
  id integer primary key,
  source_key text not null,
  source_instance_id text,
  target_key text,
  target_instance_id text,
  target_path text,
  type text not null,
  file_path text not null,
  start_line integer,
  end_line integer,
  confidence text not null
);
```

Suggested indexes:

```sql
create index idx_symbols_key on symbols(symbol_key);
create index idx_symbols_file_span on symbols(file_path, start_line, end_line);
create index idx_relationship_source on relationships(source_instance_id, type);
create index idx_relationship_target on relationships(target_instance_id, type);
create index idx_relationship_file on relationships(file_path, type);
```

Acceptance:

- SQLite can answer outline, exact symbol lookup, owner repair, and relationship-backed call graph queries.
- JSON and SQLite return equivalent results on fixture repos.

## Phase 2.9: JSON-to-SQLite Importer

Status:

- Implemented. Full indexes now write JSON sidecars first and then import them into `navigation.sqlite`.
- Import failures do not fail indexing; they emit deterministic warnings and leave JSON sidecars as the authoritative backend.

Do not make the indexer write SQLite directly at first.

Add:

```text
current JSON sidecars -> navigation.sqlite
```

Tasks:

- Import manifest.
- Import files.
- Import symbols.
- Import relationships.
- Validate row counts.
- Store source manifest hash.
- Add import diagnostics.

Acceptance:

- Existing full indexes can build SQLite without reindexing source.
- SQLite can be rebuilt from JSON sidecars.
- Import failure does not break JSON behavior.

## Phase 2.10: Dual-Read Validation Mode

Status:

- Partially implemented as an explicit parity validator in `packages/core/src/navigation/sqlite.ts`.
- The current validator compares registry manifests, symbols-by-file, exact symbol lookup, owner lookup by span, and relationship records between JSON and SQLite.
- Runtime dual-read warning mode is now available through the default shared runtime store factory; creating that shared store with `SATORI_NAVIGATION_DUAL_READ=1` keeps JSON as the serving backend, runs a once-per-root SQLite parity check in parallel, and logs deterministic mismatch warnings without failing the request.

Add internal parity validation:

```text
read primary backend
shadow-validate JSON vs SQLite once per root
serve primary result
warn on mismatch
```

Compare:

- symbols by file
- exact symbol lookup
- owner lookup by span
- caller/callee relationships
- relationship counts by type

Acceptance:

- Fixture repos show parity.
- Mismatches are deterministic and actionable.
- SQLite can be trusted before it becomes the default backend.

## Phase 2.11: Add Optional SQLite Backend Flag

Once dual-read parity is proven across larger repos:

```text
default read path: JSON
explicit SQLite backend flag: optional
fallback/debug/export: JSON retained
```

Status:

- Implemented experimentally through the default shared `RuntimeNavigationStore` created by `createRuntimeNavigationStore()`.
- `SATORI_NAVIGATION_BACKEND=sqlite` now selects SQLite as the preferred serving backend for that shared runtime store while keeping JSON as the canonical default when the flag is unset.
- When explicit SQLite serving hits missing, incompatible, or unavailable SQLite state, runtime falls back to JSON and emits a deterministic warning instead of failing the MCP request.

Acceptance:

- MCP behavior is unchanged when the flag is unset.
- SQLite can be exercised explicitly without changing the public MCP surface.
- JSON remains the authoritative serving backend by default for debugging and migration safety.

Future phase:

- No SQLite-default backend switch is planned in this roadmap. Explicit opt-in remains sufficient while JSON sidecars are canonical.

## Phase 2.12: Incremental Navigation Updates

Only after full-index SQLite is stable, improve incremental sync.

Tasks:

- Rebuild navigation sidecars and `navigation.sqlite` after chunk updates so successful syncs preserve registry-backed outline/call-graph readiness.
- Longer-term optimization: shrink this from whole-navigation rebuilds to file-level symbol/relationship rewrites.
- Keep owner metadata, registry manifests, relationship manifests, and SQLite imports aligned with the post-sync file set.
- Keep manifest compatibility honest and preserve rollback-safe writes.

Acceptance:

- Incremental sync no longer invalidates all navigation state.
- Successful syncs keep registry-backed `file_outline`, `read_file(open_symbol)`, and relationship-backed `call_graph` runnable without requiring a full reindex.
- Failed incremental updates do not create silently stale navigation.
- `requires_reindex` remains authoritative when compatibility is uncertain.

## Recommended Immediate Patch

The next patch should focus on Phase 2B only:

```text
remove legacy v3 ids from emitted navigation handles
remove legacy exact-id aliases from steady-state symbol resolution
make relationship-backed call_graph authoritative
flip tests to assert replacement behavior directly
```

Do not bundle SQLite-serving changes or file-level delta work into the same patch.

After Phase 2B is complete, move to Phase 2C file-level JSON navigation deltas. Keep SQLite work in Phase 2D as additive validation and optional experimentation only.
