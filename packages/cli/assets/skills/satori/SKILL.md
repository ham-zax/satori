---
name: satori
description: "Satori MCP workflow for repository code intelligence: finding where unfamiliar behavior lives, tracing ownership and callers, reviewing change impact, and handling index readiness (create, sync, reindex, cancel). Use when a task needs Satori search, navigation, or index lifecycle decisions beyond a known path or literal."
---

<!-- satori-managed-skill: installed by satori-cli; edits are replaced on reinstall -->

# Satori

The Satori MCP server already sends its short tool guidance at session start.
This skill adds the working procedure for multi-step investigations.

## When to use native tools instead

Use the host's own file read, grep, or edit tools when the path, literal, or
symbol is already known, or the change is small and local. Use Satori when
ownership, behavior location, or related implementation is not yet known.

## Investigation loop

1. Pass the path the user asked about. If Satori resolves an indexed parent,
   use the returned `codebaseRoot` afterwards.
2. `search_codebase` with a plain-language description of the behavior. Switch
   to exact identifiers, error codes, or `path:`/`lang:`/`must:` prefixes only
   for proof lookups.
3. Follow `recommendedNextAction`. It is the ranked next proof step, usually a
   canonical `read_file` request. Do not invent spans.
4. Use `continue_search` only with a returned continuation handle and its exact
   `nextOffset`; it pages the same frozen ranking and never searches again.
5. Before editing, read the implementation and its call sites.

## Relationships and impact

- `architecture_overview`: repository areas, cross-area boundaries, hotspots.
- `call_graph`: only when a grouped result has `navigation.graph="ready"`; pass
  its `target` as `symbolRef` and `codebaseRoot` as `path`.
- `trace_path`: one bounded path between two known symbol IDs.
- `find_references`: exact textual occurrences, independent of ranking.
- `detect_changes`: symbols and bounded callers affected by a Git diff.

These are navigation evidence, not proof of complete blast radius. Empty or
short results do not prove there are no callers; confirm important inbound
impact with `find_references`, tests, or direct reads.

## Index lifecycle

- Unknown readiness: `list_codebases`, then `manage_index` with
  `action="status"`.
- `not_indexed`: report it and get the user's approval before
  `manage_index action="create"`; a full index build is expensive.
- `not_ready` while indexing: wait for the operation to finish; do not start
  another mutation.
- Stale or noisy results: update `.satoriignore` if needed, then
  `manage_index action="sync"`.
- `requires_reindex`: stop relying on search or navigation, report the reason,
  and get approval before `action="reindex"`. Managed offline runtimes may
  already be rebuilding in the background; retry after the returned hint.
- Never run `action="clear"` unless the user explicitly asks for a reset.

## Warnings

Read every `warnings[].action`. A warning without `blocksUse=true` means the
result is usable but degraded; follow the action before trusting details it
names.
