# Changelog

All notable changes to this repository are documented in this file.

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
