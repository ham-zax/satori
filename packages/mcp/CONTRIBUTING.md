# Contributing to @zokizuan/satori-mcp

This guide covers contribution rules specific to the MCP server package.

## Current Tool Surface (v1.0.0+)

Only these tools are supported:

- `list_codebases`
- `manage_index` (`action`: `create | reindex | sync | status | cancel | clear`)
- `search_codebase`
- `architecture_overview`
- `continue_search`
- `file_outline`
- `call_graph`
- `find_references`
- `detect_changes`
- `read_file`

Legacy tool names from pre-1.0 are intentionally removed.

## Quick Commands

```bash
# Build MCP server
pnpm build:mcp

# Watch mode
pnpm dev:mcp

# Start server
pnpm --filter @zokizuan/satori-mcp start

# Typecheck
pnpm --filter @zokizuan/satori-mcp typecheck

# Unit tests
pnpm --filter @zokizuan/satori-mcp test

# Check README tool docs are in sync
pnpm --filter @zokizuan/satori-mcp docs:check
```

`pnpm --filter @zokizuan/satori-mcp build` already runs docs generation.

## Development Notes

- Keep routing and tool exposure capability-driven (no direct env checks in handlers).
- Keep tool schemas canonical in `src/tools/*` Zod definitions; JSON Schema must be generated from those definitions.
- Treat the selected immutable Publication as the sole durable indexed/source/navigation/policy authority; unsupported pre-clean-break state requires a fresh index/reindex.
- Managed offline runtimes should transparently start or join rebuild-safe reindex maintenance for already-tracked incompatible Publications. Preserve deterministic `requires_reindex` recovery responses for states where automatic maintenance is unavailable, suppressed after failure, or unsafe.
- Do not reintroduce compatibility aliases for removed tools.
- Keep `search_codebase` telemetry as structured stderr JSON (`event=search_executed`).
- Keep `read_file` line-range semantics 1-based and inclusive (`start_line`/`end_line`), with deterministic truncation hints when capped by `READ_FILE_MAX_LINES`.
- If watcher mode is enabled, keep filesystem events observation-only: record source/freshness epochs, exclude ignored/hidden paths, and leave publication work to explicit or background freshness synchronization.
