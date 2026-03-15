---
name: satori-search
description: Semantic-first code search with Satori. Use for intent-based code discovery before file reads or grep.
---

# Satori Search

Use this skill when the task is to find where behavior lives, identify candidate symbols, or narrow the search space before deeper navigation.

## Tools

Use only:
1. `list_codebases`
2. `manage_index`
3. `search_codebase`

## Workflow

1. Check readiness with `manage_index(action="status", path=...)`.
2. If not indexed, use `manage_index(action="create", path=...)`.
3. If `requires_reindex` appears, stop and use `manage_index(action="reindex", path=...)`, then retry.
4. Search with `search_codebase(path=..., query=..., scope="runtime", resultMode="grouped", groupBy="symbol", rankingMode="auto_changed_first")`.

## Search Rules

- Start with natural-language intent, not filenames.
- Default to `scope="runtime"`.
- Use operators only when needed: `lang:`, `path:`, `-path:`, `must:`, `exclude:`.
- Treat warnings as usable-but-degraded results, not fatal errors.
- Use `debug=true` only when ranking or filter explanations are required.

## Remediation

- `requires_reindex`: run `manage_index(action="reindex")`, not `sync`.
- `not_ready` with indexing reason: wait or check `manage_index(action="status")`.
- Noise mitigation hint: update `.satoriignore`, wait debounce, rerun search, and use `manage_index(action="sync")` only for immediate convergence.
