# pi-satori-bridge

Pi extension that exposes Satori tools through `satori-cli` only.

## What this gives you

This extension registers and proxies these tools:

- `list_codebases`
- `manage_index`
- `search_codebase`
- `call_graph`
- `file_outline`
- `read_file`

Every tool call is delegated to:

```bash
satori-cli tool call <toolName> --args-json '<json>'
```

## Setup

### 1) Build Satori MCP package (for local dist usage)

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

```bash
pi -e ./examples/pi-extension/satori-bridge/index.ts
```

Or copy/symlink into:
- `~/.pi/agent/extensions/satori-bridge/`
- `.pi/extensions/satori-bridge/`

## Command

```text
/satori-mcp
```

Health check that runs `satori-cli tools list` and confirms reflection.

## Resolution order (CLI only)

The extension resolves CLI execution in this order:

1. Explicit CLI command (`SATORI_CLI_COMMAND` or config `command`)
2. Local dist CLI (`packages/mcp/dist/cli/index.js`, with legacy `dist/index.js` auto-upgrade to `dist/cli/index.js`)
3. npm fallback:
   - `npx -y --package @zokizuan/satori-mcp@latest satori-cli ...`

## Config file

Supported config path (auto):

- project-local `.pi/satori-bridge.json`
- `~/.pi/agent/extensions/satori-bridge/config.json` (fallback)

Optional override path:

- `SATORI_CLI_CONFIG`

Example `config.json`:

```json
{
  "envFile": ".env.satori",
  "guardRecovery": "auto",
  "forceNpx": false,
  "npmPackage": "@zokizuan/satori-mcp@latest",
  "startupTimeoutMs": 180000,
  "callTimeoutMs": 600000,
  "debug": false
}
```

## Env keys (optional)

- `SATORI_CLI_COMMAND`
- `SATORI_CLI_ARGS_JSON`
- `SATORI_CLI_CWD`
- `SATORI_CLI_LOCAL_PATH`
- `SATORI_CLI_FORCE_NPX`
- `SATORI_CLI_NPM_PACKAGE`
- `SATORI_CLI_STARTUP_TIMEOUT_MS`
- `SATORI_CLI_CALL_TIMEOUT_MS`
- `SATORI_CLI_DEBUG`
- `SATORI_CLI_STDOUT_GUARD` (`drop` default, `redirect`, or `off`)
- `SATORI_CLI_GUARD_RECOVERY` (`auto` default, `never`)
- `SATORI_CLI_CONFIG`

## Notes

- Provide required Satori runtime env vars (embedding/vector DB/API keys) through your shell or `envFile`.
- Tool `path` inputs are absolute paths; `file_outline.file` is repo-relative to the indexed codebase root.
- Default timeouts are `startupTimeoutMs=180000` and `callTimeoutMs=600000`; `/satori-mcp` health check clamps both to `15000`.
- Keep global config repo-agnostic; set repo-specific `cwd` / `cliPath` only in project-local `.pi/satori-bridge.json`.
- Bridge auto-recovery retries once with `SATORI_CLI_STDOUT_GUARD=off` only for protocol/transport failures.
- Missing `envFile` is non-fatal (bridge continues and uses process/config env values).
- Tool-level responses (including non-ok structured envelopes such as `not_ready/indexing`) do not trigger auto-retry.
- Tool cancellation is forwarded to child process kill via `AbortSignal`.
- Tool output is compact by default and progressively disclosed via `Ctrl+O` in Pi.
