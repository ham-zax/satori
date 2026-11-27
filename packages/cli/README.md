# @satori-code/cli

Install [Satori](https://github.com/ham-zax/satori) and connect it to your coding agent. The CLI configures MCP clients and verifies the runtime. Use it from the terminal to inspect indexes or call Satori tools directly.

## Install

Requires Node.js 22.22 or newer on Linux x64 or ARM64 with glibc, including WSL2.

```bash
npx -y @satori-code/cli@latest install
npx -y @satori-code/cli@latest doctor
```

The default offline runtime downloads Potion and LateOn models, then uses local embeddings, reranking, and LanceDB without a model API key. The installer detects Codex, Claude Code, OpenCode, Cursor, VS Code, Windsurf, and Pi. Select one with `--client <name>`, or use `--client agy` for Antigravity.

Run `install --dry-run` to see the planned changes. Use `--index` inside a Git repository to index it during setup. Restart your coding agent after installation.

For a persistent command, run `npm install -g @satori-code/cli@latest`. The examples below use the global command. With a temporary install, replace `satori` with `npx -y @satori-code/cli@latest`.

## Commands

| Command | Purpose |
| --- | --- |
| `satori install --help` | List install options, including clients, runtimes, index profiles, and rerankers. |
| `satori doctor --verbose` | Check managed launcher, active runtime, and client settings. Use `--json` for structured results. |
| `satori -v` | Print CLI, MCP, and Core versions. |
| `satori upgrade` | Verify and activate the MCP and Core versions pinned by the CLI release. |
| `satori reranker status` | Inspect the active reranker. |
| `satori gc --dry-run` | Preview index and runtime cleanup. |
| `satori terminate` | Gracefully stop verified Satori runtimes. |
| `satori uninstall --dry-run` | Preview removal of managed client configuration. |
| `satori uninstall --purge` | Remove managed configuration and delete stored models and indexes. |

The managed launcher lives at `~/.satori/bin/satori-mcp.js`. Upgrade switches it only after activating a verified release pair. Existing clients can load the new runtime when restarted.

## Call a tool from the terminal

```bash
satori tools list
satori tool call search_codebase --args-json '{"path":"/absolute/path/to/repo","query":"where are failed jobs retried?"}'
```

Use an actual absolute repository path. For longer requests, pass `--args-file` instead. See the [Satori reference](https://github.com/ham-zax/satori/blob/master/docs/REFERENCE.md) for client configuration, indexing behavior, and tool contracts.

## Development

```bash
pnpm --filter @satori-code/cli build
pnpm --filter @satori-code/cli test
```

See the [release guide](https://github.com/ham-zax/satori/blob/master/docs/RELEASING.md) for packed smoke tests and publication.

## License

[AGPL-3.0-only](LICENSE). [Commercial licensing](https://github.com/ham-zax/satori/blob/master/COMMERCIAL-LICENSING.md) is available.
