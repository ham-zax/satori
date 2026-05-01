---
name: satori-search
description: Use when finding code by behavior, concept, or symbol before opening files or falling back to grep.
---

# Satori Search

Use this skill when the task is to find where behavior lives, identify candidate symbols, or narrow the search space before deeper navigation.

## Tools

Use only:
1. `list_codebases`
2. `manage_index`
3. `search_codebase`

## Workflow

1. Check readiness with `manage_index(action="status", path=...)` when index state is unknown.
2. If not indexed, use `manage_index(action="create", path=...)`.
3. If `requires_reindex` appears, stop and use `manage_index(action="reindex", path=...)`, then retry.
4. Search the user-requested path with `search_codebase(path=..., query=..., scope="runtime", resultMode="grouped", groupBy="symbol", rankingMode="auto_changed_first")`.

## Search Rules

- Start with natural-language intent, not filenames.
- Default to `scope="runtime"`.
- Use operators only when needed: `lang:`, `path:`, `-path:`, `must:`, `exclude:`.
- Pass the user's requested path; if Satori resolves an indexed parent, follow returned `navigationFallback` exactly.
- Treat warnings as usable-but-degraded results, not fatal errors.
- Use `debug=true` only when ranking or filter explanations are required.

## Remediation

- `requires_reindex`: run `manage_index(action="reindex")`, not `sync`.
- `not_ready` with indexing reason: wait or check `manage_index(action="status")`.
- `not_indexed`: run `manage_index(action="create")` on the repository root or requested indexed root.
- `MISSING_PROVIDER_CONFIG` is active only when it appears as the tool response `code` or `reason`. If it appears inside `search_codebase` results, it may just be matched code content.
- Noise mitigation hint: update `.satoriignore`, wait debounce, rerun search, and use `manage_index(action="sync")` only for immediate convergence.
