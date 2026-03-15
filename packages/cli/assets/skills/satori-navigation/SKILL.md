---
name: satori-navigation
description: Deterministic symbol navigation with Satori. Use after search results are found to lock exact spans and inspect call relationships.
---

# Satori Navigation

Use this skill after `search_codebase` has returned candidate results and you need exact symbol/file navigation.

## Tools

Use only:
1. `file_outline`
2. `call_graph`
3. `read_file`

## Workflow

1. Use grouped `search_codebase` results as the starting point.
2. If `callGraphHint.supported=true`, call `call_graph(path=..., symbolRef=..., direction="both", depth=1)`.
3. If `callGraphHint.supported=false`, execute `navigationFallback.readSpan.args` exactly.
4. Use `file_outline(resolveMode="exact", symbolIdExact|symbolLabelExact)` to lock the symbol span.
5. Use `read_file(path=..., open_symbol=...)` or deterministic line spans for the final read.

## Rules

- Treat `navigationFallback` as authoritative. Do not invent spans.
- `open_symbol` must resolve deterministically. Do not guess on ambiguity.
- `read_file(mode="annotated")` is preferred when outline metadata is useful.
- Follow continuation hints when plain reads are truncated.

## Remediation

- `requires_reindex`: reindex before retrying navigation.
- `not_ready`: wait for indexing to finish.
- `unsupported`: fall back to deterministic `read_file` spans when supplied by `navigationFallback`.
