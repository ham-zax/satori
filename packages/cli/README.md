# @zokizuan/satori-cli

Shell CLI for Satori installation, skill packaging, and direct tool invocation without a resident MCP client.

## What It Does

- installs and removes Satori MCP client config for supported clients
- copies packaged first-party skills:
  - `satori-search`
  - `satori-navigation`
  - `satori-indexing`
- starts a local stdio session against `@zokizuan/satori-mcp` for direct shell workflows

## Install / Uninstall

```bash
npx -y @zokizuan/satori-cli@0.1.1 install --client codex
npx -y @zokizuan/satori-cli@0.1.1 install --client claude
npx -y @zokizuan/satori-cli@0.1.1 install --client all --dry-run
npx -y @zokizuan/satori-cli@0.1.1 uninstall --client codex
```

Managed install writes MCP config that launches:

```toml
[mcp_servers.satori]
command = "npx"
args = ["-y", "@zokizuan/satori-mcp@4.4.1"]
startup_timeout_ms = 180000
```

## Commands

```bash
satori-cli tools list
satori-cli tool call <toolName> --args-json '{"path":"/abs/repo","query":"auth"}'
satori-cli tool call <toolName> --args-file ./args.json
satori-cli tool call <toolName> --args-json @-
satori-cli <toolName> [schema-subset flags]
```

Global flags (`--startup-timeout-ms`, `--call-timeout-ms`, `--format`, `--debug`) must appear before the command token.

## Development

```bash
pnpm --filter @zokizuan/satori-cli build
pnpm --filter @zokizuan/satori-cli test
pnpm --filter @zokizuan/satori-cli release:smoke
```
