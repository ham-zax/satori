# Testing unreleased Satori from this checkout

`scripts/dev-mcp.mjs` runs the MCP server from this working tree as a separate
`satori-dev` server, next to the installed Satori runtime. Use it to try
uncommitted or unreleased changes in any MCP client (Claude Code, Codex,
OpenCode, ...) without publishing or replacing the installed runtime.

## What it does

- Runs `packages/mcp/dist/index.js` (and therefore `packages/core/dist`) from
  this checkout.
- Reuses the provider and model settings of the installed launcher
  (`~/.satori/bin/satori-mcp.js`): embedding model, reranker, CBM extractors.
  Downloaded models are read in place; assets bundled in the installed
  `@satori-code/mcp` package (the Potion helper) are redirected to
  `packages/mcp/assets`.
- Keeps all state in `~/.satori-dev`: index registry, runtime ownership, and
  LanceDB. The installed runtime and its index under `~/.satori` are never
  read or written.

This differs from `pnpm run dev:install-local-mcp`, which builds the checkout
and *activates it as the managed runtime* behind `~/.satori/bin/satori-mcp.js`,
so every client sharing that launcher switches to it.

Requirements: Satori installed once (for the downloaded models and the
launcher's settings), and `pnpm install` in this repository.

## Build

The server runs build output, not sources. Rebuild after every source change
you want to test, then restart the MCP client (or reconnect the server):

```bash
(cd packages/core && pnpm build) && (cd packages/mcp && pnpm build:runtime)
```

Changes under `third_party/cbm-semantic` also need
`node scripts/build-semantic-engine.mjs` first, so that
`packages/core/assets/semantic-engine/*.wasm` is current.

## Register with a client

Use absolute paths. The server's workspace is the directory the client starts
in, so start the client inside the repository you want to test; paths outside
it are rejected.

```bash
# Claude Code (user scope)
claude mcp add satori-dev -s user -- "$(command -v node)" "$PWD/scripts/dev-mcp.mjs"

# Codex
codex mcp add satori-dev -- "$(command -v node)" "$PWD/scripts/dev-mcp.mjs"
```

Any other stdio MCP client: command `node`, argument
`<repo>/scripts/dev-mcp.mjs`.

Disable or remove the regular `satori` server in that client while testing,
otherwise the agent may call the installed version instead. Note that the
Satori installer manages the `satori` entry and may add it back on reinstall.

## Use

1. Build (above), then start the client in the target repository.
2. Check `manage_index` with `action="status"`. Wait for automatic indexing
   when it has started. If the test repository still needs an index, create it
   with `action="create"`. The first index under `~/.satori-dev` is built
   from scratch. Later source changes can be picked up by sync.
3. Exercise the change through the normal tools (`search_codebase`,
   `call_graph`, `find_references`, `detect_changes`, ...).

When a change alters persisted evidence (for example a bumped provider
version), the next sync or reindex in `~/.satori-dev` rebuilds the affected
data; the installed runtime is unaffected.

## Options

| Variable | Default | Purpose |
|---|---|---|
| `SATORI_DEV_STATE` | `~/.satori-dev` | State root for the dev server |
| `SATORI_DEV_LAUNCHER` | `~/.satori/bin/satori-mcp.js` | Installed launcher whose settings are reused |
| `SATORI_SESSION_ROOTS_JSON` | client working directory | JSON array of absolute workspace roots the session may access |

Other environment variables set by the client are passed through; the
launcher's settings take precedence, then the dev state paths.

## Remove

```bash
claude mcp remove satori-dev -s user   # or: codex mcp remove satori-dev
```

The dev index lives at `~/.satori-dev` by default. You can delete that directory
after stopping its MCP sessions if you no longer need the dev indexes.

Re-add the installed server if you removed it. For example, in Claude Code:

```bash
claude mcp add satori -s user -- "$(command -v node)" ~/.satori/bin/satori-mcp.js
```
