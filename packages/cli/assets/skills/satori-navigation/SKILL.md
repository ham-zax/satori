---
name: satori-navigation
description: Use when search has returned candidate code and exact spans, symbol reads, or call relationships are needed.
---

# Satori Navigation

Use this skill after `search_codebase` has returned candidate results and you need exact symbol/file navigation.

## Tools

Use only:
1. `file_outline`
2. `call_graph`
3. `read_file`

For lifecycle remediation (`requires_reindex`, `not_indexed`, indexing waits), switch to `satori-indexing`.

## Workflow

1. Use grouped `search_codebase` results as the starting point.
2. Use `file_outline(resolveMode="exact", symbolIdExact|symbolLabelExact)` to lock the symbol span when exact identity is available.
3. If `callGraphHint.supported=true`, call `call_graph(path=..., symbolRef=..., direction="both", depth=1)`.
4. If `callGraphHint.supported=false`, execute `navigationFallback.readSpan.args` exactly.
5. Use `read_file(path=..., open_symbol=...)` or deterministic line spans for the final read.

## Rules

- Treat `navigationFallback` as authoritative. Do not invent spans.
- `open_symbol` must resolve deterministically. Do not guess on ambiguity.
- `read_file(mode="annotated")` is preferred when outline metadata is useful.
- Follow continuation hints when plain reads are truncated.
- Other tools do not run search freshness; remediate stale index state before trusting navigation.

## Remediation

- `requires_reindex`: switch to `satori-indexing` and reindex before retrying navigation.
- `not_ready` or `not_indexed`: switch to `satori-indexing`; wait or create before retrying navigation.
- `unsupported`: fall back to deterministic `read_file` spans when supplied by `navigationFallback`.
