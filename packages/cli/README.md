# @zokizuan/satori-cli

Installer and shell client for Satori MCP. Use this package to configure supported MCP clients, check provider setup, and call Satori tools from a terminal without starting a resident MCP client.

## Quick Start

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```

Supported clients are `codex`, `claude`, `opencode`, and `all`.

The installer performs package resolution once, stores the MCP server under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and writes client-specific config that starts the launcher directly with Node. Resident MCP startup should not run `npx` or require a custom long startup timeout.

Treat `~/.satori/` as installer-owned state. The public setup path is the installer command above, not manual copying of runtime cache paths into each harness.

The installer only manages Satori-owned config and the first-party workflow skill:

- `satori`

After a repo is indexed, Satori keeps the public MCP surface fixed while building derived navigation data behind it: grouped search is symbol-owned, exact navigation uses `symbolInstanceId`, `call_graph` reads relationship sidecars, and completed full indexes write canonical JSON navigation state while optionally importing an additive SQLite cache. The installer wires clients; it does not run indexing or provider-backed work during setup.

## Commands

```bash
npx -y @zokizuan/satori-cli@latest install --client codex
npx -y @zokizuan/satori-cli@latest install --client all --profile minimal
npx -y @zokizuan/satori-cli@latest install --client codex --install-guidance-hook
npx -y @zokizuan/satori-cli@latest install --client claude
npx -y @zokizuan/satori-cli@latest install --client opencode
npx -y @zokizuan/satori-cli@latest install --client all --dry-run
npx -y @zokizuan/satori-cli@latest uninstall --client codex
```

`doctor` checks Node, package visibility, provider env, and Milvus env without starting an MCP client.

`--profile default|minimal|all-text` writes or updates repo-local `satori.toml` for the current working directory. It is repo index policy only; it is not MCP client config and must not contain provider credentials.

Profile behavior:

- `default`: safe-broad indexing for source, docs/text, config, scripts, infra/query files, and known extensionless files such as `Dockerfile`, `Makefile`, `Justfile`, `Taskfile`, `Procfile`, `Jenkinsfile`, and `.dockerignore`.
- `minimal`: source plus docs/text only.
- `all-text`: safe-broad plus unknown UTF-8 text files under the size limit. `SATORI_ALL_TEXT_MAX_BYTES` can override the cap.

All profiles still honor ignore rules and hard-deny secrets, lockfiles, binaries, generated output, bundles, source maps, logs, snapshots, and database dumps.

Codex installs write two companion artifacts by default: the first-party `satori` skill under `~/.codex/skills` and a marked Satori guidance block in `~/.codex/AGENTS.md`. The AGENTS block tells Codex to use Satori for semantic ownership/context discovery first, then use exact navigation and reads for proof.

`--install-guidance-hook` is Codex-only. It adds a marked `SessionStart` reminder hook to `~/.codex/config.toml` that prints the Satori discovery workflow, suppresses duplicate startup prints for the same working directory, and does not run indexing, search, or provider-backed work.

Typical first run:

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
# restart your MCP client
```

The installer writes launcher config only. Runtime provider settings are read when the MCP client starts.

Repo profile config is separate from client/provider config:

```toml
[index]
profile = "minimal"
```

Changing `satori.toml` is treated as an index-policy control-file change. `search_codebase` can reconcile ordinary profile/ignore changes through freshness checks, while incompatible index fingerprints still return `requires_reindex`.

Supported client installs expose the Satori runtime variable names in the client config:

- Codex writes active `env_vars` forwarding plus an optional commented `[mcp_servers.satori.env]` template in `~/.codex/config.toml`.
- Claude Code writes `mcpServers.satori.env` in `~/.claude.json` with `${VAR:-}` pass-through values.
- OpenCode writes `mcp.satori.environment` in `~/.config/opencode/opencode.json` with `{env:VAR}` pass-through values.

If you want a client to store literal values, replace the generated pass-through value for that client. In Codex, uncomment or add this table outside the installer-managed launcher block so reinstalls keep your edits:

```toml
[mcp_servers.satori.env]
EMBEDDING_PROVIDER = "VoyageAI"
EMBEDDING_MODEL = "voyage-code-3"
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
