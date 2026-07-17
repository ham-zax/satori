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

Before managed configuration mutation, install resolves or installs an immutable
MCP runtime candidate, verifies its resolved package name and exact version, and
starts that candidate to prove MCP initialization and the canonical seven-tool
surface. Tags and ranges are resolved again instead of reusing an older package
merely because its entry file still exists. A rejected newly installed candidate
is removed without touching the active launcher target.
A selected LanceDB backend proves native write/FTS/reopen behavior on the configured target
filesystem; a selected Milvus backend does not load or validate LanceDB. The
offline profile additionally resolves and probes the selected local Ollama
artifact. A rejected preflight leaves the prior launcher target and managed client
files unchanged. After a
non-dry-run install, the CLI runs a bounded postflight against that exact
launcher. It verifies managed client
wiring, MCP initialization and installed server version, the fixed seven-tool
list in canonical order, runtime-owner registration, and complete child
shutdown. The postflight uses a dedicated non-mutating runtime mode and never
calls `manage_index`, search, or another provider-backed tool.

Treat `~/.satori/` as installer-owned state. The public setup path is the installer command above, not manual copying of runtime cache paths into each harness.

The installer only manages Satori-owned config and the first-party workflow skill:

- `satori`

After a repo is indexed, Satori keeps the public MCP surface fixed (seven tools) while building derived navigation data behind it: grouped search is symbol-owned, `continue_search` pages a frozen ranked result set without provider work, exact navigation uses `symbolInstanceId`, `call_graph` reads relationship sidecars, and completed full indexes write canonical JSON navigation state while optionally importing an additive SQLite cache. The installer never indexes or searches a repository during setup; its provider work is limited to the selected preflight probes. `--dry-run` performs static runtime/backend selection and path-syntax validation but does not inspect target filesystem shape, install a package, load LanceDB, contact Ollama, or write filesystem state.

Grouped search responses use `formatVersion: 2`: each result has one canonical `target`, bounded source evidence, quality, and compact graph readiness. Use the envelope `codebaseRoot` with that target for `read_file` or graph-ready `call_graph` calls; graph-ready results explicitly require inbound verification, and the removed per-result action/fallback trees are not part of the 6.0 contract.

## Commands

```bash
npx -y @zokizuan/satori-cli@latest install --client codex
npx -y @zokizuan/satori-cli@latest install --client all --runtime voyage
npx -y @zokizuan/satori-cli@latest install --client all --runtime voyage --vector-store milvus
npx -y @zokizuan/satori-cli@latest install --client all --runtime offline --ollama-model nomic-embed-text
npx -y @zokizuan/satori-cli@latest install --client all --profile minimal
npx -y @zokizuan/satori-cli@latest install --client codex --install-guidance-hook
npx -y @zokizuan/satori-cli@latest install --client claude
npx -y @zokizuan/satori-cli@latest install --client opencode
npx -y @zokizuan/satori-cli@latest install --client all --dry-run
npx -y @zokizuan/satori-cli@latest uninstall --client codex
```

`doctor` does not write configuration or database state. It checks Node, package
visibility, the runtime profile persisted by the managed launcher,
provider/model/dimension settings, required provider keys, optional Milvus
configuration, and every configured Codex/Claude/OpenCode Satori entry. For a
managed LanceDB runtime it read-only loads that runtime's Core LanceDB subpath
and native dependency; the install preflight, not doctor, owns the temporary
write/FTS/reopen capability proof. Offline diagnostics also resolve the local
Ollama artifact and compare its digest with the installer-recorded identity.
Doctor reads runtime owners with process-start
evidence when the platform provides it, errors on stale installed versions or
conflicting fingerprints/config identities, and reports active, abandoned, or
corrupt mutation leases without expiring or rewriting them by age.

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

The installer writes the managed launcher and client wiring. The launcher
persists the selected non-secret runtime profile/backend/model identity and
combines it with secret credentials forwarded by the MCP client at startup.
For connected installs, LanceDB is the default. Pass `--vector-store milvus` to
retain a Milvus deployment; a consistent literal Milvus selection already
stored in any configured Satori client is also preserved on reinstall. The
launcher is shared by every installed client, so an explicit `--vector-store`
changes the effective backend for all of them regardless of `--client`.
Conflicting environment, managed-launcher, or literal client selections fail
until literal settings are reconciled and the backend is chosen explicitly.
Reinstall preserves the managed LanceDB path and offline Ollama endpoint unless
the current installer environment explicitly supplies replacements.

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
SATORI_RUNTIME_PROFILE = "connected"
VECTOR_STORE_PROVIDER = "LanceDB"
EMBEDDING_PROVIDER = "VoyageAI"
EMBEDDING_MODEL = "voyage-code-3"
EMBEDDING_OUTPUT_DIMENSION = "1024"
VOYAGEAI_API_KEY = "pa-..."
VOYAGEAI_RERANKER_MODEL = "rerank-2.5"
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

Node.js 22.13 or newer is required.

The installer defaults to `--runtime voyage`, which freezes a connected
VoyageAI identity and an installer-owned LanceDB path only after the LanceDB
native write, FTS, close, and reopen preflight succeeds. Milvus remains an
explicit supported backend for existing cloud/local deployments through
`--vector-store milvus`; Milvus credentials and addresses remain client-owned
environment values. MCP startup and `tools list` do not require provider
credentials; provider-backed tool calls return `MISSING_PROVIDER_CONFIG` when
setup is incomplete.

The offline installer candidate requires a local Ollama model and rejects
non-loopback endpoints before changing managed client configuration:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime offline --ollama-model nomic-embed-text
```

It persists the resolved model name/digest and selected LanceDB path in the
non-secret managed launcher environment. The runtime prohibits cloud embedding,
reranking, and Milvus construction even if old cloud credentials remain in the
ambient environment. Offline release qualification remains pending until the
live Ollama lifecycle and paired quality matrix pass.

## Development

```bash
pnpm --filter @zokizuan/satori-cli build
pnpm --filter @zokizuan/satori-cli test
pnpm run release:smoke:cli
```
