# @zokizuan/satori-cli

Shell CLI for installing Satori MCP config, copying the first-party workflow skill, checking setup, and calling Satori tools without a resident MCP client.

## Install Satori for a Client

```bash
npx -y @zokizuan/satori-cli@0.3.2 install --client all
npx -y @zokizuan/satori-cli@0.3.2 install --client all --dry-run
npx -y @zokizuan/satori-cli@0.3.2 uninstall --client codex
npx -y @zokizuan/satori-cli@0.3.2 doctor
```

Supported clients are `codex`, `claude`, `opencode`, and `all`.

The install command performs package resolution once, stores the MCP server under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and writes client-specific config that starts the launcher directly with Node. Treat `~/.satori/` as installer-owned; public setup should not require copying those paths by hand.

The installer only manages Satori-owned config and skills:

- `satori`

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
