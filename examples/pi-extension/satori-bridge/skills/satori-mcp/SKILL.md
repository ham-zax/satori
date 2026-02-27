---
name: satori-mcp
description: Use Satori MCP bridge tools for deterministic codebase indexing and semantic navigation. Use when the user asks to index a project, run semantic search, inspect call graphs, or open exact symbol spans.
---

# Satori MCP Workflow

Use these tools in this order by default:

1. `list_codebases`
2. `manage_index` (`action=create` or `status`)
3. `search_codebase`
4. `file_outline`
5. `call_graph`
6. `read_file`

## Requires-reindex handling

If any response says `requires_reindex`:

1. Run `manage_index` with `action=reindex` on the same codebase root.
2. Retry the previous tool call.

Do not substitute `sync` when `requires_reindex` is explicitly returned.

## Recommended search defaults

When you are not sure what to set:

- `scope=runtime`
- `resultMode=grouped`
- `groupBy=symbol`
- `rankingMode=auto_changed_first`

## Noise mitigation

If search returns a `noiseMitigation` hint:

1. Update `.satoriignore` at repo root.
2. Wait debounce interval if provided.
3. Re-run `search_codebase`.
4. For immediate convergence, run `manage_index` with `action=sync`.

## Symbol navigation

When grouped search returns `navigationFallback`, use it exactly.
Do not invent spans.
