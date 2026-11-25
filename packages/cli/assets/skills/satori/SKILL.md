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
   for proof lookups. When the description uses words the code likely does
   not, also pass up to 4 likely identifiers or code terms in `alt_terms`
   (e.g. `["destroy", "unmount"]` for "cleanup of useEffect"). Keep them
   grounded in the question; unrelated terms can rank worse than none.
3. Follow `recommendedNextAction`. It is the ranked next proof step, usually a
   canonical `read_file` request. Do not invent spans.
4. Use `continue_search` only with a returned continuation handle and its exact
   `nextOffset`; it pages the same frozen ranking and never searches again.
5. Before editing, read the implementation and its call sites.
6. Keep parallel `search_codebase` calls to 1–3 focused queries (using `alt_terms`
   up to 4 grounded terms); local reranking serializes concurrent searches,
   whereas `read_file`, `file_outline`, and `find_references` parallelize cheaply.
7. When line numbers are already known (from `file_outline` or search), prefer
   `read_file` with `start_line`/`end_line` (raw source is default) or pass
   `format="text"` on `open_symbol` when compact text is preferred.

## Relationships and impact

- `architecture_overview`: repository areas, cross-area boundaries, hotspots.
- `file_outline`: indexed symbols of one published file, with `call_graph`
  jump handles when available.
- `call_graph`: only when a grouped result has `navigation.graph="ready"`; pass
  its `target` as `symbolRef` and `codebaseRoot` as `path`.
- `trace_path`: one bounded path between two known symbol IDs.
- `find_references`: exact textual occurrences, independent of ranking.
- `detect_changes`: symbols and bounded callers affected by a Git diff.

These are navigation evidence, not proof of complete blast radius. Empty or
short results do not prove there are no callers; confirm important inbound
impact with `find_references`, tests, or direct reads.

Parse-error and conditional-preprocessing regions are excluded from structure
and calls. `CALL_GRAPH_INBOUND_PARTIAL_FILES:n` and
`OUTLINE_PARTIAL_STRUCTURAL_COVERAGE:<reason>` mark such partial files; read
those files directly before relying on missing symbols or callers.

## Index lifecycle

- **Byte-budgeted background auto-indexing (`<= 50,000`-file OOM fuse):**
  - **Offline ($0 local cost):** Git workspaces `<= 20 MiB` of eligible source
    auto-index silently on session start; repositories up to `<= 150 MiB` defer
    on idle open and auto-index on first Satori tool call; incompatible
    Publications rebuild automatically in the background.
  - **Connected / Voyage API:** Defers on idle open; repositories `<= 8 MiB`
    (`~2M` tokens, `< 1%` of the 200M free tier) auto-index on first Satori tool
    call.
  - Never ask the user whether to index or migrate within these automatic
    budgets.
- **`not_ready` / `auto_indexing`:** Check `indexing.mode` (`"auto_indexing"` or
  `"indexing"`). Indexing runs in the background, so keep working instead of
  running `sleep` or polling in a loop: read the entry files named in the
  question (for example with `read_file`) or search with `rg`/grep, then retry
  after `retryAfterMs`. Do not start a duplicate mutation.
- **When to ask the user (`not_indexed` / `requires_reindex`):** Satori only
  skips automatic indexing when a repository exceeds the **paid API budget
  (`> 8 MiB` on Voyage)** or **massive monorepo limits (`> 150 MiB` or
  `> 50,000` files)**. In those cases, use native grep/read tools for quick
  tasks and ask the user once before running `manage_index` `action="create"` or
  `action="reindex"` (or suggest `.satoriignore` / `--runtime offline`).
- Stale or noisy results: update `.satoriignore` if needed, then
  `manage_index action="sync"`.
- Never run `action="clear"` unless the user explicitly asks for a reset.

## Warnings

Read every `warnings[].action`. A warning without `blocksUse=true` means the
result is usable but degraded; follow the action before trusting details it
names.
