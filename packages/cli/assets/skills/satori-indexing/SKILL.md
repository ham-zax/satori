---
name: satori-indexing
description: Index lifecycle and remediation for Satori. Use when codebases are not indexed, stale, blocked, or need freshness recovery.
---

# Satori Indexing

Use this skill when the task is to create, reindex, sync, inspect readiness, or recover from stale index state.

## Tools

Use only:
1. `list_codebases`
2. `manage_index`

## Workflow

1. Use `list_codebases` for a global view of tracked roots.
2. Use `manage_index(action="status", path=...)` for the specific codebase.
3. Use `manage_index(action="create", path=...)` when the codebase is not indexed.
4. Use `manage_index(action="reindex", path=...)` only for compatibility gates or explicit rebuilds.
5. Use `manage_index(action="sync", path=...)` for freshness convergence and ignore-rule updates.

## Rules

- If any tool returns `requires_reindex`, stop and reindex. Do not substitute `sync`.
- Never call `manage_index(action="clear")` unless the user explicitly requests destructive reset.
- Treat ignore-only churn as a `sync` problem first.
- Respect blocked and indexing states instead of forcing retries blindly.

## Status Handling

- `requires_reindex`: run `manage_index(action="reindex")`.
- `not_ready` with indexing reason: check status and wait for terminal completion.
- `not_indexed`: create the index.
- Ignore-rule noise mitigation: update `.satoriignore`, wait debounce, and run `sync` for immediate convergence.
