# Changelog

All notable changes to this repository are documented in this file.

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
