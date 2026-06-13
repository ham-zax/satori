# @zokizuan/satori-cli

Installer and shell client for Satori MCP. Use this package to configure supported MCP clients, check provider setup, and call Satori tools from a terminal without starting a resident MCP client.

## Quick Start

```bash
npx -y @zokizuan/satori-cli@0.4.2 install --client all
npx -y @zokizuan/satori-cli@0.4.2 doctor
```

Supported clients are `codex`, `claude`, `opencode`, and `all`.

The installer performs package resolution once, stores the MCP server under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and writes client-specific config that starts the launcher directly with Node. Resident MCP startup should not run `npx` or require a custom long startup timeout.

Treat `~/.satori/` as installer-owned state. The public setup path is the installer command above, not manual copying of runtime cache paths into each harness.

The installer only manages Satori-owned config and the first-party workflow skill:

- `satori`

## Commands

```bash
npx -y @zokizuan/satori-cli@0.4.2 install --client codex
npx -y @zokizuan/satori-cli@0.4.2 install --client claude
npx -y @zokizuan/satori-cli@0.4.2 install --client opencode
npx -y @zokizuan/satori-cli@0.4.2 install --client all --dry-run
npx -y @zokizuan/satori-cli@0.4.2 uninstall --client codex
```

`doctor` checks Node, package visibility, provider env, and Milvus env without starting an MCP client.

Typical first run:

```bash
npx -y @zokizuan/satori-cli@0.4.2 install --client all
npx -y @zokizuan/satori-cli@0.4.2 doctor
# restart your MCP client
```

The installer writes launcher config only. Runtime provider settings are read when the MCP client starts.

Supported client installs expose the Satori runtime variable names in the client config:

- Codex writes active `env_vars` forwarding plus an optional commented `[mcp_servers.satori.env]` template in `~/.codex/config.toml`.
- Claude Code writes `mcpServers.satori.env` in `~/.claude.json` with `${VAR:-}` pass-through values.
- OpenCode writes `mcp.satori.environment` in `~/.config/opencode/opencode.json` with `{env:VAR}` pass-through values.

If you want a client to store literal values, replace the generated pass-through value for that client. In Codex, uncomment or add this table outside the installer-managed launcher block so reinstalls keep your edits:

```toml
[mcp_servers.satori.env]
EMBEDDING_PROVIDER = "VoyageAI"
EMBEDDING_MODEL = "voyage-4-large"
EMBEDDING_OUTPUT_DIMENSION = "1024"
VOYAGEAI_API_KEY = "pa-..."
VOYAGEAI_RERANKER_MODEL = "rerank-2.5"
MILVUS_ADDRESS = "https://your-zilliz-endpoint"
MILVUS_TOKEN = "your-zilliz-token"
```

## Direct Tool Calls

```bash
satori-cli tools list
satori-cli tool call search_codebase --args-json '{"path":"/abs/repo","query":"auth flow"}'
satori-cli tool call search_codebase --args-file ./args.json
satori-cli tool call search_codebase --args-json @-
satori-cli search_codebase --path /abs/repo --query "auth flow"
```

Global flags such as `--startup-timeout-ms`, `--call-timeout-ms`, `--format`, and `--debug` must appear before the command token.

## Runtime Requirements

Indexing and search require an embedding provider plus a Milvus-compatible backend. MCP startup and `tools list` do not require those credentials; provider-backed tool calls return `MISSING_PROVIDER_CONFIG` when setup is incomplete.

Common local setup:

```bash
EMBEDDING_PROVIDER=Ollama
EMBEDDING_MODEL=nomic-embed-text
OLLAMA_HOST=http://127.0.0.1:11434
MILVUS_ADDRESS=localhost:19530
```

## Development

```bash
pnpm --filter @zokizuan/satori-cli build
pnpm --filter @zokizuan/satori-cli test
pnpm run release:smoke:cli
```
