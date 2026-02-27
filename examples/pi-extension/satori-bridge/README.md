# pi-satori-bridge

Pi extension that exposes Satori MCP tools directly inside Pi.

## What this gives you

This extension registers these Pi tools and proxies them to a running Satori MCP server:

- `list_codebases`
- `manage_index`
- `search_codebase`
- `call_graph`
- `file_outline`
- `read_file`

## Setup

### 1) Build Satori MCP (local repo mode)

From repo root:

```bash
pnpm --filter @zokizuan/satori-mcp build
```

### 2) Install extension dependencies

```bash
cd examples/pi-extension/satori-bridge
pnpm install
```

### 3) Load extension in Pi

From repo root:

```bash
pi -e ./examples/pi-extension/satori-bridge/index.ts
```

Or copy/symlink this directory into:

- `~/.pi/agent/extensions/satori-bridge/` (global)
- `.pi/extensions/satori-bridge/` (project-local)

## Default MCP launch behavior

The extension tries, in order:

1. Local built server in current project: `packages/mcp/dist/index.js`
2. Fallback to npm: `npx -y @zokizuan/satori-mcp@latest`

## Optional environment overrides

- `SATORI_MCP_COMMAND` (example: `node`)
- `SATORI_MCP_ARGS_JSON` (JSON array string, example: `[
  "/absolute/path/to/packages/mcp/dist/index.js"
]`)
- `SATORI_MCP_CWD` (working directory for MCP process)
- `SATORI_MCP_LOCAL_PATH` (override default local dist path)
- `SATORI_MCP_FORCE_NPX=true` (skip local dist auto-detect)

## Quick check

Use command:

```text
/satori-mcp
```

It notifies whether the bridge can connect.

## Notes

- Set required Satori env vars (embedding/vector DB/API keys) before starting Pi.
- Tool cancellation is forwarded to MCP via `AbortSignal`.
