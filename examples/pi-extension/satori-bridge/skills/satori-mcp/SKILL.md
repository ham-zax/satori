---
name: satori-mcp
description: Semantic code search + symbol navigation for Satori MCP. Use when users ask to search codebases (for example lazy loading, prefetch/preload, “where is X implemented”, trace callers/callees), and prefer search_codebase/file_outline/call_graph/read_file over ad-hoc grep.
---

# Satori MCP (Semantic Search + Symbol Navigation)

Use this skill for codebase discovery/navigation requests, especially:
- "search my codebase"
- "where is X implemented"
- "find lazy loading / prefetch / preload"
- "trace call path / callers / callees"

## Tool Surface (fixed)

Use exactly these 6 tools:
1. `list_codebases`
2. `manage_index`
3. `search_codebase`
4. `file_outline`
5. `call_graph`
6. `read_file`

## Semantic-First Execution Plan

1. Check/index status for target path:
   - `manage_index(action="status", path=...)`
   - if needed: `manage_index(action="create", path=...)`
2. Run semantic retrieval first (not grep-first):
   - `search_codebase(path, query, scope="runtime", resultMode="grouped", groupBy="symbol", rankingMode="auto_changed_first")`
3. Use symbol-aware navigation from grouped results:
   - if `callGraphHint.supported=true`, call `call_graph(path, symbolRef=callGraphHint.symbolRef, direction="both", depth=1)`
   - if unsupported, execute `navigationFallback.readSpan.args` exactly
4. Lock spans deterministically:
   - `file_outline(resolveMode="exact", symbolIdExact|symbolLabelExact)`
   - `read_file(open_symbol={...})`

## Query Strategy (semantic search)

- Start with natural-language intent (example: "lazy loading prefetch preload flow in landing page").
- Use operators only when needed:
  - `lang:` `path:` `-path:` `must:` `exclude:`
- Scope policy:
  - `runtime` excludes docs/tests (default)
  - `docs` for docs/tests only
  - `mixed` for everything
- Keep grouped symbol mode for architecture tracing; use raw mode only for chunk-level deep inspection.

## Symbol Reference Features (must use)

- In grouped results, treat `callGraphHint.symbolRef` as canonical call-graph input.
- Treat `navigationFallback` as authoritative when call graph is unavailable.
- Do not invent spans; use returned spans/args directly.

## Gating + Reason Contract

For gating responses, always read both `status` and `reason`:
- `status="requires_reindex"` -> `reason="requires_reindex"`
- `status="not_ready"` -> `reason="indexing"`
- `status="not_indexed"` -> `reason="not_indexed"`

Gate precedence:
1. `requires_reindex`
2. `not_ready` (`reason=indexing`)
3. `not_indexed`

If `requires_reindex` appears:
- run `manage_index(action="reindex", path=<hinted/effective root>)`
- retry original call
- do **not** replace with `sync`

Never call `manage_index(action="clear")` unless user explicitly requests destructive reset.

## Indexing Lock Behavior

During active indexing for a codebase, index-dependent tools can return `not_ready` envelopes.
Blocked envelopes should include:
- `message`
- `hints.status` (status-check call)
- indexing metadata (`progressPct`, `lastUpdated`, `phase`)

`read_file` may return structured blocked JSON during indexing lock.

## Freshness + Noise

- `search_codebase` is freshness-gated and may return `freshnessDecision="skipped_indexing"`.
- If `hints.noiseMitigation` appears:
  1. update repo-root `.satoriignore`
  2. wait debounce
  3. rerun search
  4. optionally `manage_index(action="sync")` for immediate convergence

## Fallback Rule

Use ad-hoc `bash/rg` only when:
- user explicitly requests regex/grep behavior, or
- Satori index is unavailable and user does not want to create/reindex now.
