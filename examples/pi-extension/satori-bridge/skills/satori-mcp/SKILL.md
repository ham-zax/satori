---
name: satori-mcp
description: Deterministic Satori MCP workflow for indexing, runtime-first semantic search, call graph traversal, and exact symbol/file navigation with strict reindex and noise-remediation rules.
---

# Satori MCP (Deterministic Contract)

Use this skill when working with Satori’s MCP tools for code discovery/navigation.

## Hard Rules (must follow)

1. Satori exposes **exactly 6 tools**:
   - `list_codebases`
   - `manage_index`
   - `search_codebase`
   - `file_outline`
   - `call_graph`
   - `read_file`
2. If any response indicates `requires_reindex` (status and/or `hints.reindex`):
   - Run `manage_index` with `action="reindex"` on hinted path (or same indexed root).
   - Retry the original tool call.
   - **Do not substitute `sync` for this.**
3. Never call `manage_index(action="clear")` unless user explicitly requested destructive wipe/reset.
4. When `navigationFallback` is returned, treat it as authoritative and execute its args exactly.

## Output Shapes (important)

- `list_codebases` -> plain text buckets.
- `manage_index` -> plain text action responses.
- `search_codebase` -> JSON envelope (`status`, `results`, `warnings`, `hints`, `freshnessDecision`).
- `file_outline` -> JSON envelope (`ok|ambiguous|not_found|unsupported|requires_reindex`).
- `call_graph` -> JSON envelope (`ok|not_found|unsupported|not_ready|not_indexed|requires_reindex`).
- `read_file`:
  - `mode=plain` (default): plain text with truncation continuation hints.
  - `mode=annotated`: JSON with `content`, `outlineStatus`, `outline`, `hasMore`, `warnings/hints`.
  - `open_symbol`: deterministic exact open; no guessing on ambiguity.

## Default Workflow

1. **Inventory**
   - `list_codebases`
2. **Ensure index exists/healthy**
   - `manage_index(action="status", path=...)`
   - If not indexed: `manage_index(action="create", path=...)`
3. **Search first (runtime-first defaults)**
   - `search_codebase(path, query, scope="runtime", resultMode="grouped", groupBy="symbol", rankingMode="auto_changed_first")`
4. **Navigate deterministically**
   - If `callGraphHint.supported=true`: run `call_graph(path, symbolRef, direction="both", depth=1)`.
   - Else: run `read_file` from `navigationFallback.readSpan.args` exactly.
5. **Lock symbol spans**
   - `file_outline(path, file, resolveMode="exact", symbolIdExact|symbolLabelExact)`
6. **Open exact symbol**
   - `read_file(path, open_symbol={...})`

## Search Semantics

- Scope:
  - `runtime`: excludes docs/tests
  - `docs`: docs/tests only
  - `mixed`: all
- Operator prefixes (prefix block):
  - `lang:` `path:` `-path:` `must:` `exclude:`
- Deterministic filter precedence:
  - `scope -> lang -> path include -> path exclude -> must -> exclude`
- Use `debug=true` only when you need ranking/filter explanations.

## Noise Remediation

If `search_codebase` returns `hints.noiseMitigation`:

1. Add recommended patterns to repo-root `.satoriignore`.
2. Wait `debounceMs` when provided (or watcher debounce default).
3. Rerun `search_codebase`.
4. For immediate convergence, run `manage_index(action="sync", path=<same root>)`, then rerun search.

## Symbol + Read Guidance

- Prefer `read_file(open_symbol)` after exact symbol resolution.
- If `open_symbol` is `ambiguous`/`not_found`, use `file_outline(resolveMode="exact")` to disambiguate.
- In plain `read_file`, follow continuation hints (`offset`/line windows) rather than issuing huge reads.

## Operational Runbook

- First-time indexing: `create -> status -> search`.
- `requires_reindex`: always `manage_index(action="reindex")` then retry original tool.
- `call_graph` `not_ready`: reindex; meanwhile use `navigationFallback` + `file_outline`.
- Subdirectory searches: pass user-requested subdir `path`; rely on returned fallback spans/paths.

## Warnings/Hints Policy

- `warnings[]` means degraded-but-usable, not fatal.
- Prefer deeper reads and less ranking trust when warnings exist.
- Treat warning codes as stable identifiers (not freeform prose).
