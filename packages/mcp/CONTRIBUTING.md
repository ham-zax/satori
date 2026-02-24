# Contributing to @zokizuan/satori-mcp

This guide covers contribution rules specific to the MCP server package.

## Current Tool Surface (v1.0.0+)

Only these tools are supported:

- `manage_index` (`action`: `create | sync | status | clear`)
- `search_codebase`
- `read_file`
- `list_codebases`

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
- Keep snapshot format at `v3` with fingerprints.
- Preserve deterministic "train in the error" responses for reindex requirements.
- Do not reintroduce compatibility aliases for removed tools.
- Keep `search_codebase` telemetry as structured stderr JSON (`event=search_executed`).
- Keep `read_file` line-range semantics 1-based and inclusive (`start_line`/`end_line`), with deterministic truncation hints when capped by `READ_FILE_MAX_LINES`.
- If watcher mode is enabled, keep it debounced (`MCP_WATCH_DEBOUNCE_MS`) and status-gated (`indexed`/`sync_completed` only), and ensure ignored/hidden paths are excluded from watch triggers.
