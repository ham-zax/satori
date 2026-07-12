---
name: satori
description: Use when working with Satori MCP for plain-English semantic code discovery, exact navigation, call graph context, bounded reads, indexing, sync, reindex, or stale index recovery.
---

# Satori

Use this skill when a task needs Satori MCP for behavior-level code discovery, deterministic proof navigation, or index lifecycle work.

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
3. Search the requested path with `search_codebase(path=..., query=..., scope="runtime", resultMode="grouped", groupBy="symbol", rankingMode="auto_changed_first")`; start with plain-English behavior/concept queries unless you already know the exact identifier, constant, warning code, or path.
4. Prefer the envelope `recommendedNextAction` when present; it is Satori's ranked next proof step.
5. Use `file_outline(resolveMode="exact", symbolIdExact|symbolLabelExact)` to lock exact symbol spans when identity is available.
6. If a grouped result has `navigation.graph="ready"`, call `call_graph(path=codebaseRoot, symbolRef=target, direction="both", depth=1)`.
7. Use `read_file(path=..., open_symbol=...)` or deterministic line spans for final evidence before editing.

## Search Rules

- Start with natural-language intent for fuzzy discovery: ask where behavior lives, what owns a flow, or how a policy is enforced.
- Use exact identifiers for symbol, constant, warning-code, or path-scoped proof lookups.
- Default to `scope="runtime"`.
- Use operators only when useful: `lang:`, `path:`, `-path:`, `must:`, `exclude:`.
- Pass the user's requested path; if Satori resolves an indexed parent, use the returned `codebaseRoot` for result navigation.
- Treat `warnings[]` as usable-but-degraded results unless `blocksUse=true`; read each warning's `action` before deciding whether to sync, narrow, or verify.
- `NAVIGATION_REPAIR_REQUIRED` means vector completion evidence remains valid but local symbol/relationship sidecars are missing, corrupt, or incompatible; run `manage_index(action="repair")`, not reindex, to rebuild local navigation.
- Grouped `formatVersion: 2` results contain canonical facts, not per-result tool calls: inspect `target`, `quality`, `navigation.graph`, required graph-ready `navigation.inbound="verify"`, and optional `callerSearchTerm`.
- Use `debugMode=summary|ranking|freshness|full` only when the corresponding diagnostics are required. Existing `debug=true` selects `full`. Inspect `hints.debugSummary` before deeper `debugSearch` evidence.

## Navigation Rules

- Treat the envelope `recommendedNextAction` as the default next move unless the user requested a different proof path.
- For a grouped target with `symbolId`, open the absolute `codebaseRoot + target.file` path with `read_file(open_symbol={symbolId})`; without `symbolId`, read the 1-based inclusive `target.span`. Do not invent spans.
- Pass `target` directly to `call_graph` only when `navigation.graph="ready"`. That state always requires inbound verification; if `callerSearchTerm` exists, use it in a separate `must:<term> <term>` search.
- `open_symbol` must resolve deterministically. Do not guess on ambiguity.
- Do not treat call_graph inbound results as sole authority for blast radius; verify inbound impact with `rg`, tests, or direct references.
- Prefer `read_file(mode="annotated")` when outline metadata helps.
- Follow continuation hints when plain reads are truncated.
- Read the relevant implementation and call sites before editing behavior.

## Index Rules

- `manage_index` actions are `create`, `reindex`, `sync`, `status`, `clear`, and `repair`. Responses are JSON envelopes in MCP text content (`tool`, `version`, `action`, `path`, `status`, `message`/`humanText`, optional `reason`/`hints`/`warnings`/`preflight`) — parse structured fields for branching.
- `manage_index status` defaults to `detail=summary`. Request `capabilities` for full symbol/language evidence, `diagnostics` for compatibility/runtime-owner evidence, or `full` for both.
- If any tool returns `requires_reindex`, stop normal navigation and report the exact proof failure. Provider-backed `create` and `reindex` are expensive full rebuilds and require explicit user approval before invocation; do not substitute `sync` for a required rebuild.
- Use `manage_index(action="sync")` for freshness convergence and ignore-rule updates.
- Use `manage_index(action="repair")` only to rebuild local readiness when vector payload and trusted fingerprint proof already match; if repair refuses, report its proof failure and request approval before following a create/reindex hint.
- Never call `manage_index(action="clear")` unless the user explicitly requests destructive reset.
- Respect blocked and actively indexing states instead of forcing retries blindly.
- `MISSING_PROVIDER_CONFIG` is active only when it appears as the tool response `code` or `reason`. If it appears inside search results, it may just be matched code content.

## Status Handling

- `not_indexed`: create the index.
- `not_indexed` with `reason:"index_failed"`: inspect `indexingFailure`, then use the hinted `manage_index(action="create")` when restarting the failed partial attempt. Do not treat this as `requires_reindex`.
- `not_ready` with indexing reason: check status and wait for terminal completion.
- `requires_reindex`: reindex before trusting search or navigation.
- `unsupported`: use the grouped target's deterministic `read_file` symbol or span mapping; do not call `call_graph`.
- Noise mitigation hint: update `.satoriignore`, wait debounce, rerun search, and use `manage_index(action="sync")` only for immediate convergence.
