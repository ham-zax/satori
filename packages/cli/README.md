# @zokizuan/satori-cli

Installer, doctor, and shell client for Satori MCP. Use this package to configure supported MCP clients, verify provider and runtime health, and call the six public Satori tools from a terminal without a resident MCP client session.

This package does **not** implement the MCP tools itself; it installs and drives `@zokizuan/satori-mcp`. Full tool contracts live in the [MCP package README](https://github.com/ham-zax/satori/blob/master/packages/mcp/README.md) and the monorepo root README.

## Quick Start

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```

Supported clients are `codex`, `claude`, `opencode`, and `all`.

The installer performs package resolution once, stores the MCP server under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and writes client-specific config that starts the launcher directly with Node. Resident MCP startup should not run `npx` or require a custom long startup timeout.

After a non-dry-run install, the CLI runs a bounded postflight against that exact launcher. It verifies managed client wiring, MCP initialization and installed server version, the fixed six-tool list in canonical order, runtime-owner registration, and complete child shutdown. Provider and vector settings are validated statically only: incomplete settings produce a warning and a successful install exit, while launcher, protocol, tool-list, owner, or shutdown failures produce a non-zero exit without removing the installed artifacts. The postflight uses a dedicated non-mutating runtime mode and never calls `manage_index`, search, or another provider-backed tool.

Treat `~/.satori/` as installer-owned state. The public setup path is the installer command above, not manual copying of runtime cache paths into each harness.

The installer only manages Satori-owned config and the first-party workflow skill:

- `satori`

After a repo is indexed, Satori keeps the public MCP surface fixed (six tools) while building derived navigation data behind it: grouped search is symbol-owned, exact navigation uses `symbolInstanceId`, `call_graph` reads relationship sidecars, and completed full indexes write canonical JSON navigation state while optionally importing an additive SQLite cache. The installer verifies wiring but does not run indexing or provider-backed work during setup.

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

`doctor` is read-only. It checks Node, package visibility, supported provider/model/dimension settings, required provider keys, Milvus configuration, the installed Satori package set, the stable managed launcher target, and every configured Codex/Claude/OpenCode Satori entry. It reads runtime owners with process-start evidence when the platform provides it, errors on stale installed versions or conflicting fingerprints/config identities, and reports active, abandoned, or corrupt mutation leases without expiring or rewriting them by age.

Direct MCP tool calls made through `satori-cli` also write a capped, local-only diagnostics log. `doctor` reports its aggregate under `localDiagnostics`: tool category, duration, outcome, returned `search_codebase` result count, known warning codes, fallback use, lifecycle outcome, and repair success. Outline symbols, graph nodes or edges, listed roots, and read bytes are not combined into the search-result metric. The log stores no source, query text, path, symbol name, or repository identifier, is limited to 1,000 validated events, and is never uploaded. Writes use a bounded interprocess lock and same-directory atomic replacement, refuse symlinked log paths, and remove malformed or extra fields during compaction. Recording is best-effort and cannot change a tool call's result.

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

Public tool paths must be **absolute**. Relative paths are rejected by the MCP server (not resolved against the CLI process CWD).

```bash
satori-cli tools list
satori-cli tool call search_codebase --args-json '{"path":"/abs/repo","query":"auth flow"}'
satori-cli tool call search_codebase --args-file ./args.json
satori-cli tool call search_codebase --args-json @-
satori-cli search_codebase --path /abs/repo --query "auth flow"
```

Global flags such as `--startup-timeout-ms`, `--call-timeout-ms`, `--format`, and `--debug` must appear before the command token.

After changing embedding/vector runtime config or the installed Satori package version, restart every Satori MCP client before `manage_index` mutations (`create` / `reindex` / `sync` / `clear` / `repair`). On `runtime_owner_conflict`, follow the manage envelope’s pids/versions and `hints.nextStep`; CLI and MCP tools never kill other processes.

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
