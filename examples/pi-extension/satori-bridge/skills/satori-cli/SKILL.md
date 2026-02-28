---
name: satori-cli
description: Semantic code search + symbol navigation for Satori CLI (MCP-backed). Use when users ask to search codebases (for example lazy loading, prefetch/preload, “where is X implemented”, trace callers/callees), and prefer search_codebase/file_outline/call_graph/read_file over ad-hoc grep.
---

# Satori CLI (Semantic Search + Symbol Navigation)

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
   - `file_outline(path=<codebaseRootAbs>, file=<relative file path>, resolveMode="exact", symbolIdExact|symbolLabelExact)`
   - `read_file(path=<absolute file path>, open_symbol={...})`
   - Use `file` from grouped result metadata or `navigationFallback.fileOutlineWindow.args.file`.
   - Use absolute read path from `navigationFallback.readSpan.args.path` when available; otherwise derive from codebase root + relative file.

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

Status may be returned inside JSON text blocks in tool content payloads. Parse those text blocks before branching logic.

Gate precedence:
1. `requires_reindex`
2. `not_ready` (`reason=indexing`)
3. `not_indexed`

If `requires_reindex` appears:
- run `manage_index(action="reindex", path=<hinted/effective root>)`
- retry original call
- do **not** replace with `sync`

Use `manage_index(action="sync")` only for freshness/noise convergence (for example after `.satoriignore` updates).

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

## CLI-Only Operation

Use Satori via one of these two paths only:
1. Registered extension tools (`list_codebases`, `manage_index`, `search_codebase`, `call_graph`, `file_outline`, `read_file`)
2. `satori-cli` shell commands when extension tools are unavailable

Do not use or suggest any direct MCP client fallback path.

Treat tools as unavailable only when the runtime reports missing/unregistered tool bindings (or explicit unknown-tool errors).

If Satori tools are not registered in the current runtime, use shell CLI:

```bash
satori-cli tools list
satori-cli tool call search_codebase --args-json '{"path":"/abs/repo","query":"lazy loading prefetch preload","scope":"runtime","resultMode":"grouped","groupBy":"symbol"}'
```

Then continue with `file_outline`, `call_graph`, and `read_file` via `satori-cli tool call ... --args-json ...`.

Bridge reliability note:
- Default stdout guard mode is `drop`.
- Bridge may perform one protocol-failure-only recovery retry with `SATORI_CLI_STDOUT_GUARD=off`.
- Non-ok tool envelopes (for example `status="not_ready"`) are valid responses and are not retried.

Bridge config semantics:
- Config precedence is deterministic: `SATORI_CLI_CONFIG` (explicit) -> project-local `.pi/satori-bridge.json` -> global `~/.pi/agent/extensions/satori-bridge/config.json` fallback.
- Keep global config repo-agnostic; set repo-specific `cwd` / `cliPath` only in project-local config.
- Missing `envFile` is non-fatal (bridge continues with process/config env values).

## Fallback Rule

Use ad-hoc `bash/rg` only when:
- user explicitly requests regex/grep behavior, or
- Satori index is unavailable and user does not want to create/reindex now.
