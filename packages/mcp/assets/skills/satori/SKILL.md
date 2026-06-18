---
name: satori
description: Use when working with Satori MCP for code search, exact navigation, call graph context, bounded reads, indexing, sync, reindex, or stale index recovery.
---

# Satori

Use this skill when a task needs Satori MCP for code discovery, navigation, or index lifecycle work.

## Tools

Satori exposes exactly six MCP tools:

1. `list_codebases`
2. `manage_index`
3. `search_codebase`
4. `file_outline`
5. `call_graph`
6. `read_file`

## Default Workflow

1. Use `manage_index(action="status", path=...)` when index state is unknown.
2. If the codebase is not indexed, use `manage_index(action="create", path=...)`.
3. Search the requested path with `search_codebase(path=..., query=..., scope="runtime", resultMode="grouped", groupBy="symbol", rankingMode="auto_changed_first")`; exact identifier-like queries may return from the registry before semantic/vector search.
4. Use `file_outline(resolveMode="exact", symbolIdExact|symbolLabelExact)` to lock exact symbol spans when identity is available.
5. If `callGraphHint.supported=true`, call `call_graph(path=..., symbolRef=..., direction="both", depth=1)`.
6. Use `read_file(path=..., open_symbol=...)` or deterministic line spans for final evidence before editing.

## Search Rules

- Start with natural-language intent for fuzzy discovery; use exact identifiers for symbol, constant, warning-code, or path-scoped lookups.
- Default to `scope="runtime"`.
- Use operators only when useful: `lang:`, `path:`, `-path:`, `must:`, `exclude:`.
- Pass the user's requested path; if Satori resolves an indexed parent, follow returned fallback payloads exactly.
- Treat warnings as usable-but-degraded results, not fatal errors.
- Use `debug=true` only when ranking, filter, freshness, exact-registry, tracked-lexical, or latency explanations are required; inspect `debugSearch.exactRegistry`, `phaseTimingsMs`, `trackedLexical`, and `passesUsed`.

## Navigation Rules

- Treat `navigationFallback` as authoritative. Do not invent spans.
- `open_symbol` must resolve deterministically. Do not guess on ambiguity.
- Prefer `read_file(mode="annotated")` when outline metadata helps.
- Follow continuation hints when plain reads are truncated.
- Read the relevant implementation and call sites before editing behavior.

## Index Rules

- If any tool returns `requires_reindex`, run `manage_index(action="reindex")`, then retry the original call. Do not substitute `sync`.
- Use `manage_index(action="sync")` for freshness convergence and ignore-rule updates.
- Never call `manage_index(action="clear")` unless the user explicitly requests destructive reset.
- Respect blocked and actively indexing states instead of forcing retries blindly.
- `MISSING_PROVIDER_CONFIG` is active only when it appears as the tool response `code` or `reason`. If it appears inside search results, it may just be matched code content.

## Status Handling

- `not_indexed`: create the index.
- `not_ready` with indexing reason: check status and wait for terminal completion.
- `requires_reindex`: reindex before trusting search or navigation.
- `unsupported`: fall back to deterministic `read_file` spans when supplied by `navigationFallback`.
- Noise mitigation hint: update `.satoriignore`, wait debounce, rerun search, and use `manage_index(action="sync")` only for immediate convergence.
