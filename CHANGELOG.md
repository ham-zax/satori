# Changelog

All notable changes to this repository are documented in this file.

## [2026-02-25] Language Adapter Registry and JavaScript Symbol Flow

### Release Versions
- `@zokizuan/satori-mcp`: `3.5.0`
- `@zokizuan/satori-core`: `0.1.7`

### Added
- Added a shared language adapter registry in `@zokizuan/satori-core` to centralize language IDs, aliases, extensions, and capabilities (`astSplitter`, `symbolMetadata`, `callGraphBuild`, `callGraphQuery`, `fileOutline`).

### Modified
- Refactored splitter/runtime language mapping to use the shared registry as the single source of truth.
- Extended JS support across symbol/navigation flow:
  - `call_graph` query gating now supports JavaScript extensions (`.js`, `.jsx`, `.mjs`, `.cjs`) in addition to TS/Python.
  - `file_outline` support gating now includes JavaScript files.
  - `read_file(mode:"annotated")` now treats JavaScript files as outline-capable.
- Updated MCP docs/tool descriptions to reflect TS/JS/Python call-graph support.

### Tests
- Added regression coverage for JavaScript call-graph query routing and JavaScript outline-capable paths (`file_outline`, `read_file(mode:"annotated")`).

## [2026-02-26] Fingerprint Diagnostics and Version-Bump Guard

### Release Versions
- `@zokizuan/satori-mcp`: `3.4.0`
- `@zokizuan/satori-core`: `0.1.7`

### Added
- Added explicit compatibility diagnostics for migration visibility:
  - `search_codebase` requires-reindex responses now include `compatibility` with runtime/index fingerprints and reindex metadata.
  - `call_graph` requires-reindex responses now include the same `compatibility` diagnostics.
  - `manage_index action:"status"` now prints runtime/index fingerprint diagnostics and reindex reason when available.
- Added CI enforcement for MCP package versioning:
  - New script `scripts/check-mcp-version-bump.sh`.
  - CI now fails when package-relevant MCP source changes are made without a `packages/mcp/package.json` version bump.

### Tests
- Added/expanded regression coverage for:
  - `search_codebase` requires-reindex compatibility diagnostics.
  - `call_graph` requires-reindex compatibility diagnostics.
  - `manage_index status` fingerprint diagnostics (including access-gate blocked paths).

## [2026-02-25] Call Graph Alias Compatibility and Search Fault-Injection Coverage

### Release Versions
- `@zokizuan/satori-mcp`: `3.3.0`
- `@zokizuan/satori-core`: `0.1.7`

### Fixed
- Added `call_graph.direction="bidirectional"` compatibility and normalized dispatch to canonical `direction:"both"`.
- Preserved strict validation for invalid direction values outside the supported canonical/alias set.

### Tests
- Added `call_graph` tool tests for alias normalization and invalid-direction validation.
- Added deterministic, test-only fault-injection coverage for `search_codebase` semantic pass failures (`primary|expanded|both`), including:
  - partial failure warning emission
  - full failure structured error path
  - non-test-mode guard behavior

## [2026-02-26] Call Graph Declaration Parsing Hardening

### Release Versions
- `@zokizuan/satori-mcp`: `3.2.0`
- `@zokizuan/satori-core`: `0.1.7`

### Fixed
- Prevented false-positive self-loop edges in `call_graph` caused by declaration lines being parsed as call sites.
- Hardened definition detection to be case-insensitive for `function|class|def` and method signatures.

### Tests
- Added regression coverage that asserts non-recursive symbols do not emit declaration self-loop edges.

## [2026-02-26] Runtime Scope Filter Hardening

### Release Versions
- `@zokizuan/satori-mcp`: `3.1.0`
- `@zokizuan/satori-core`: `0.1.7`

### Fixed
- Hardened `search_codebase` path categorization for strict scope filtering:
  - Top-level `tests/` and `test/` paths are now classified as test paths.
  - Top-level `docs/` plus `doc/`, `documentation/`, `guide/`, and `guides/` paths are now classified as docs paths.
- Closed runtime leakage where `scope:"runtime"` could include top-level test fixture files (for example `tests/fixtures/...`).

### Tests
- Extended scope regression coverage:
  - Runtime scope now explicitly verifies exclusion of `tests/fixtures/offline-corpus/...`.
  - Docs scope now verifies inclusion of non-markdown files under `docs/` (for example `docs/runtime-helper.ts`).

## [2026-02-26] Navigation-First Fast Path

### Added
- New first-class `file_outline` MCP tool:
  - Input: `{ path: <codebaseRoot>, file: <relativePath>, start_line?, end_line?, limitSymbols? }`
  - Output statuses: `ok | not_found | requires_reindex | unsupported`
  - Sidecar-backed symbol navigation with deterministic ordering and per-symbol `callGraphHint`
  - `hasMore` flag for truncation awareness after line-window filtering
- New handler-level and tool-level regression tests for `file_outline`.

### Modified
- `read_file` now supports `mode: "plain" | "annotated"`:
  - `plain` behavior remains backward-compatible text output.
  - `annotated` returns content plus `outlineStatus`, `outline`, and `hasMore`.
  - Content reads no longer fail when outline metadata is unavailable (`requires_reindex`/`unsupported` graceful degradation).
- `search_codebase` internal two-pass retrieval is now concurrent via `Promise.allSettled`:
  - deterministic fusion order preserved
  - partial-pass degradation is explicit via `warnings[]`
  - full pass failure returns structured tool error
- Search telemetry now includes pass diagnostics:
  - `search_pass_count`
  - `search_pass_success_count`
  - `search_pass_failure_count`
  - `parallel_fanout`
- Search response envelope now formally includes optional `warnings?: string[]`.

### Docs
- Updated:
  - `README.md`
  - `docs/ARCHITECTURE.md`
  - `packages/mcp/README.md`
  - `satori-landing/index.html`
  - `satori-landing/architecture.html`
- Documentation now reflects:
  - 6-tool MCP surface
  - `file_outline` workflow
  - `read_file(mode="annotated")`
  - parallel search pass warning behavior

## [2026-02-25] Satori UX Overhaul

### Release Versions
- `@zokizuan/satori-mcp`: `3.0.0`
- `@zokizuan/satori-core`: `0.1.7`

### Added
- New first-class `call_graph` MCP tool for callers/callees traversal.
- Persistent call-graph sidecar index (built during index/sync lifecycle, loaded via snapshot state).
- Structured call-graph diagnostic notes:
  - `missing_symbol_metadata`
  - `dynamic_edge`
  - `unresolved_edge`
- Deterministic sorting guarantees for:
  - search groups
  - call-graph nodes
  - call-graph edges (`src`, `dst`, `kind`, `site.startLine`)
  - call-graph notes
- Hard `requires_reindex` response envelopes with explicit remediation (`hints.reindex`) in `search_codebase` and `call_graph`.
- `manage_index` action `reindex` (idempotent rebuild path).
- New regression coverage for sidecar metadata gaps, deterministic ordering, requires-reindex envelopes, and tool-surface registration.

### Removed
- Embedded call-graph flags from `search_codebase` (graph traversal is now isolated to `call_graph`).
- Synthetic/fabricated symbol ID generation in call-graph sidecar build.
- Regex fallback symbol extraction path used to invent symbol identities when metadata was missing.
- Legacy `search_codebase` parameter surface (`extensionFilter`, `excludePatterns`, ignore toggles, and related legacy switches).

### Modified
- `search_codebase` public contract now uses:
  - `scope: runtime | mixed | docs`
  - `resultMode: grouped | raw`
  - `groupBy: symbol | file`
  - `limit` semantics: max groups (grouped) / max chunks (raw)
  - optional `debug` traces
- Grouped search results now include:
  - stable `groupId`
  - nullable `symbolId` / `symbolLabel`
  - `collapsedChunkCount`
  - aggregated `indexedAt` (`indexedAtMax`)
  - `stalenessBucket`
  - discriminated `callGraphHint` (`supported: true|false`)
- Freshness reporting now returns structured `freshnessDecision` envelopes.
- Staleness bucketing standardized to:
  - Fresh: `<= 30m`
  - Aging: `<= 24h`
  - Stale: `> 24h`
- Sidecar behavior for missing metadata now skips node/edge emission and records explicit notes.

### Docs
- Updated root `README.md`, architecture docs, and landing pages (`satori-landing/index.html`, `satori-landing/architecture.html`) to reflect:
  - 5-tool MCP surface
  - runtime-first grouped search contract
  - first-class call-graph workflow
  - v3 reindex gate semantics
