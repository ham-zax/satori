# @zokizuan/satori-cli

Shell CLI for installing Satori MCP config, copying first-party skills, checking setup, and calling Satori tools without a resident MCP client.

## Install Satori for a Client

```bash
npx -y @zokizuan/satori-cli@0.3.2 install --client codex
npx -y @zokizuan/satori-cli@0.3.2 install --client claude
npx -y @zokizuan/satori-cli@0.3.2 install --client all --dry-run
npx -y @zokizuan/satori-cli@0.3.2 uninstall --client codex
npx -y @zokizuan/satori-cli@0.3.2 doctor
```

Managed installs write config that launches:

```toml
[mcp_servers.satori]
command = "npx"
args = ["-y", "@zokizuan/satori-mcp@4.10.1"]
startup_timeout_ms = 180000
```

The installer only manages Satori-owned config and skills:

- `satori-search`
- `satori-navigation`
- `satori-indexing`

## Direct Tool Calls

```bash
satori-cli tools list
satori-cli tool call search_codebase --args-json '{"path":"/abs/repo","query":"auth flow"}'
satori-cli tool call search_codebase --args-file ./args.json
satori-cli tool call search_codebase --args-json @-
satori-cli search_codebase --path /abs/repo --query "auth flow"
```

Global flags such as `--startup-timeout-ms`, `--call-timeout-ms`, `--format`, and `--debug` must appear before the command token.

`doctor` checks Node, package visibility, provider env, and Milvus env without starting an MCP client.

## Development

```bash
pnpm --filter @zokizuan/satori-cli build
pnpm --filter @zokizuan/satori-cli test
```
