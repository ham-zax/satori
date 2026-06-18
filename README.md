# Satori

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/ham-zax/satori/actions/workflows/ci.yml/badge.svg)](https://github.com/ham-zax/satori/actions/workflows/ci.yml)
[![npm CLI](https://img.shields.io/npm/v/@zokizuan/satori-cli?label=satori-cli)](https://www.npmjs.com/package/@zokizuan/satori-cli)

Agent-safe code retrieval for developers who use MCP coding agents on real repos.

Satori indexes a repository, keeps the index fresh, and gives agents a fixed six-tool MCP surface for finding code, opening exact spans, checking callers/callees, and reading bounded evidence before an edit. It is read-only from MCP: source edits stay in your editor or agent host.

## What You Get

- Find behavior by intent, not just filenames or exact tokens.
- Keep search focused on runtime code before pulling in docs or tests.
- Group search around owner symbols; chunks are supporting evidence, not the final unit of navigation.
- Open exact files, line ranges, and symbols instead of dumping broad context.
- Trace nearby callers/callees from relationship-backed navigation when compatible sidecars are ready.
- Build derived symbol registry and relationship sidecars during completed full indexes.
- Get explicit `requires_reindex`, partial-index, stale-state, and precise sidecar guidance instead of silent bad context.
- Compare Satori against another code-intelligence MCP on the same deterministic task suite.
- Install the MCP server and first-party workflow skill with one command.
- Avoid resident MCP startup through `npx`; clients launch an installer-owned Node launcher.

## Packages

| Package | Purpose |
|---|---|
| `@zokizuan/satori-core` | Indexing, AST chunking, embeddings, Milvus/Zilliz storage, retrieval, incremental sync |
| `@zokizuan/satori-mcp` | MCP server with the six agent-facing tools and lifecycle gates |
| `@zokizuan/satori-cli` | Installer, doctor command, and shell access to MCP tools |

## Quick Start

Install managed MCP config for every supported local client:

```bash
npx -y @zokizuan/satori-cli@0.4.4 install --client all
npx -y @zokizuan/satori-cli@0.4.4 doctor
```

Supported installers: `codex`, `claude`, `opencode`, and `all`.

Choose an index profile during install when the repo should not use the default safe-broad policy:

```bash
npx -y @zokizuan/satori-cli@0.4.4 install --client all --profile minimal
```

The installer writes or updates repo-local `satori.toml` in the current working directory:

```toml
[index]
profile = "minimal"
```

`satori.toml` is repository policy, not MCP client config and not provider config. Keep API keys, tokens, model names, and vector-store endpoints in the MCP client's runtime environment instead.

Profiles are:

- `default`: safe-broad indexing for source, docs/text, config, scripts, infra/query files, and known extensionless files such as `Dockerfile`, `Makefile`, `Justfile`, `Taskfile`, `Procfile`, `Jenkinsfile`, and `.dockerignore`.
- `minimal`: source plus docs/text only; useful when you want lower index cost and do not need config/script/infra files in the index.
- `all-text`: safe-broad plus unknown UTF-8 text files under the configured size limit; useful for uncommon text extensions after the denylist has removed unsafe paths.

All profiles still honor `.satoriignore`, `.gitignore`, and the hard denylist for secrets, generated output, dependency folders, lockfiles, binaries, logs, databases, bundles, source maps, and snapshots. `all-text` also probes files as UTF-8 and uses `SATORI_ALL_TEXT_MAX_BYTES` as the size cap override.

Index profiles control what enters the index; `search_codebase` scope controls what gets searched. Search still defaults to `scope=runtime` for implementation-first discovery, so indexing docs/config does not make documentation outrank runtime code by default. `satori.toml` is treated as an index-policy control file with `.gitignore` and `.satoriignore`: ordinary changes can reconcile through search freshness or `manage_index action="sync"`, while incompatible fingerprints still return `requires_reindex`.

The installer writes Satori-managed config and copies the first-party workflow skill:

- `satori`

It also installs the MCP server once under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and points client config at that launcher with Node. Resident MCP startup should not perform package-manager resolution.

Treat `~/.satori/` paths as installer-owned. Do not hand-write `npx @zokizuan/satori-mcp` into resident MCP config unless you are intentionally accepting package-manager startup latency.

For Codex, the installer also writes a marked Satori guidance block to `~/.codex/AGENTS.md` by default. That block positions Satori as semantic-first code exploration: start with `search_codebase` for behavior/ownership context, then narrow with `file_outline`, `call_graph`, and `read_file` for proof.

Restart every Satori MCP client after changing runtime config. In particular, after changing `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, embedding dimension, `HYBRID_MODE`, vector backend settings, or the Satori runtime version, stop old clients before running `manage_index create`, `reindex`, `sync`, or `clear`. Satori records live runtime owners under `~/.satori/runtime/owners.json` and blocks index mutations with `status="blocked"` / `reason="runtime_owner_conflict"` when multiple live Satori runtimes with different fingerprints/configs are active.

For Codex, `satori-cli install --client codex --install-guidance-hook` also installs a marked `SessionStart` reminder that prints the Satori tool workflow. The hook is guidance-only, suppresses duplicate startup prints for the same working directory, and does not run indexing, search, or provider-backed work.

## First Repo Workflow

1. Run the CLI installer and `doctor`.
2. Restart your MCP client.
3. Index one absolute repository path.
4. Search with plain-English intent, then outline, graph, and read exact spans before edits.

```text
manage_index action="create" path="/absolute/path/to/repo"
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

If any tool returns `requires_reindex`, run the hinted `manage_index action="reindex"` call first, then retry the original tool call. Use `manage_index action="sync"` for ordinary file or ignore-rule convergence.

If `manage_index` returns `reason="runtime_owner_conflict"`, restart all Satori MCP clients so only one runtime identity is active, then retry the mutation. MCP tools never kill processes or ask interactive cleanup questions.

## Runtime Setup

Satori needs an embedding provider and a Milvus-compatible vector store before indexing. MCP startup, `tools list`, and `doctor` do not require provider credentials; provider-backed tool calls report `MISSING_PROVIDER_CONFIG` when setup is incomplete.

Run `npx -y @zokizuan/satori-cli@0.4.4 doctor` after setting env values to check the local setup before indexing.

Installer config and runtime config are intentionally separate:

- The installer owns the launcher and MCP client wiring.
- Satori runtime settings come from environment variables at MCP startup.
- Supported client installs expose the Satori runtime variable names in native client config so the setup is visible and editable:
  - Codex writes active `env_vars` forwarding plus an optional commented `[mcp_servers.satori.env]` template in `~/.codex/config.toml`.
  - Claude Code writes per-server `mcpServers.satori.env` entries in `~/.claude.json` using `${VAR:-}` pass-through values.
  - OpenCode writes per-server `mcp.satori.environment` entries in `~/.config/opencode/opencode.json` using `{env:VAR}` pass-through values.
- If you prefer storing literal values in a client config, replace the generated pass-through value for that client. In Codex, uncomment or add this table outside the installer-managed launcher block so reinstalls keep your edits:

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

Claude example:

```json
{
  "mcpServers": {
    "satori": {
      "env": {
        "VOYAGEAI_API_KEY": "pa-...",
        "MILVUS_TOKEN": "your-zilliz-token"
      }
    }
  }
}
```

OpenCode example:

```json
{
  "mcp": {
    "satori": {
      "environment": {
        "VOYAGEAI_API_KEY": "pa-...",
        "MILVUS_TOKEN": "your-zilliz-token"
      }
    }
  }
}
```

Cloud quality start:

```bash
EMBEDDING_PROVIDER=VoyageAI
EMBEDDING_MODEL=voyage-4-large
EMBEDDING_OUTPUT_DIMENSION=1024
VOYAGEAI_API_KEY=your-api-key
VOYAGEAI_RERANKER_MODEL=rerank-2.5
MILVUS_ADDRESS=your-milvus-endpoint
MILVUS_TOKEN=your-milvus-token
```

Get `VOYAGEAI_API_KEY` from the Voyage AI dashboard API keys page. For Zilliz Cloud, use the cluster public endpoint as `MILVUS_ADDRESS` and the API key or cluster credential as `MILVUS_TOKEN`. Local unauthenticated Milvus usually uses `MILVUS_ADDRESS=localhost:19530` and no token.

Local-first start:

```bash
EMBEDDING_PROVIDER=Ollama
EMBEDDING_MODEL=nomic-embed-text
OLLAMA_HOST=http://127.0.0.1:11434
MILVUS_ADDRESS=localhost:19530
```

Provider, model, dimension, vector store, and schema are part of the index fingerprint. If they change, Satori blocks search with `requires_reindex` until you rebuild the index.

## Search Defaults

Default search behavior is developer-oriented:

- `scope="runtime"` so docs/tests do not dominate first results.
- `resultMode="grouped"` and `groupBy="symbol"` to reduce duplicate chunks.
- `rankingMode="auto_changed_first"` to prefer active work when safe.
- `debug=false` unless you are inspecting ranking/filter behavior.

Search is freshness-aware. It can sync on read, warn when dirty files were not freshened, and supplement exact path-scoped dirty-file evidence with bounded live reads so recent test or regression lines are not hidden behind stale vector chunks. If a full index stops at `limit_reached`, search may still return partial chunks, but it warns that results may be incomplete and navigation sidecars were not published as complete.

## Symbol-Owned Navigation

Satori's grouped search is symbol-owned: retrieval finds candidate chunks, ownership maps those chunks to a derived symbol registry, and `search_codebase` returns symbol groups with supporting evidence. Files remain the source of truth; the symbol registry is a deterministic navigation view for the indexed snapshot.

Completed full indexes write navigation sidecars:

- Symbol registry sidecar with candidate-lookup `symbolKey`, exact `symbolInstanceId`, file-owner fallback symbols, and outline data for exact navigation.
- Relationship sidecar with conservative `CALLS v0` edges plus TypeScript/JavaScript `IMPORTS`/`EXPORTS v0` edges used by `call_graph`.
- Compatibility manifests so stale, missing, or incompatible sidecars degrade explicitly instead of being silently trusted.
- Canonical JSON navigation state plus an additive `navigation.sqlite` cache. JSON remains the source that runtime navigation serves by default; SQLite is optional for validation or explicit experimental reads and may serve only after proving parity with the canonical JSON registry and relationship sidecars.

Current relationship limits are intentional. `CALLS v0` is heuristic/name-based: unique same-file targets can be high confidence, unique cross-file name-only targets are low confidence, and ambiguous same-name targets are skipped. `IMPORTS`/`EXPORTS v0` records only resolvable relative module edges and unambiguous local export declarations; package imports, unresolved paths, ambiguous local exports, and multiline module syntax are skipped.

Language capability is explicit. TypeScript, JavaScript, and Python are the only production-ready `call_graph` languages. Go and Rust are `symbol_only`: `file_outline` can return compatible sidecar symbols, but `call_graph` returns `unsupported_language`. Broader catalog/parser support does not imply graph-ready navigation.

Exact navigation is keyed by `symbolInstanceId`. `symbolKey` stays stable-ish across small edits, but it is candidate lookup only and is not exact identity.

`call_graph` now uses compatible relationship sidecars as the canonical traversal source for symbol-owned navigation. Completed incremental syncs reuse changed-file symbol output, preserve unchanged registry state, and recompute relationships against the merged registry without re-splitting unchanged files. If changed-file indexing stops early, recovery fails, or a partial full index hits a limit, Satori clears or withholds navigation state instead of publishing a mixed generation. Public reasons prefer precise values such as `missing_symbol_registry`, `missing_relationship_sidecar`, `incompatible_symbol_registry`, `incompatible_relationship_sidecar`, `stale_symbol_ref`, `navigation_recovery_failed`, and `partial_index_navigation_unavailable`.

## Six MCP Tools

| Tool | Use it for |
|---|---|
| `list_codebases` | See indexed roots and their lifecycle buckets |
| `manage_index` | Create, sync, reindex, inspect status, or explicitly clear indexes |
| `search_codebase` | Runtime-first plain-English semantic discovery with exact operators, grouping, freshness, and navigation hints |
| `file_outline` | Read sidecar symbol outlines and resolve exact symbols without guessing |
| `call_graph` | Traverse bounded caller/callee context from a search-provided `symbolRef` when relationship-backed navigation is ready |
| `read_file` | Read bounded files, ranges, annotations, or exact symbol spans |

## What Satori Is Not

- Not an agent framework.
- Not a source-code write server.
- Not a replacement for tests, typecheck, code review, or grep.
- Not a promise that static call graph hints prove runtime or assertion coverage.

Satori gives the agent better evidence. It does not remove engineering judgment.

## Repository Layout

```text
packages/core   indexing, retrieval, embeddings, vector store, sync
packages/mcp    MCP server, tool schemas, lifecycle gates, generated tool docs
packages/cli    managed installer, doctor, direct shell tool calls
docs/           behavior specs, feature inventory, architecture notes
satori-landing/ static website HTML source
```

## Development

```bash
pnpm install
pnpm build
pnpm run versions:check
pnpm -C packages/mcp docs:check
pnpm -C packages/mcp manifest:check
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
pnpm test:integration
```

Run the deterministic Satori-vs-codebase-memory comparison harness:

```bash
pnpm run build:mcp
pnpm run vs:code-intelligence -- \
  --cmm-command /home/hamza/.local/bin/codebase-memory-mcp \
  --out /tmp/satori-vs-both.json
```

To test the current checkout in your local MCP clients before publishing, rewrite the existing stable Satori launcher to point at this repo's built MCP runtime:

```bash
pnpm run dev:install-local-mcp
```

Use `pnpm run dev:install-local-mcp:no-build` after a previous build when you only need to rewrite the launcher. Restart the MCP client after either command.

## Release Commands

Current release versions:

- `@zokizuan/satori-core@1.6.2`
- `@zokizuan/satori-mcp@4.11.5`
- `@zokizuan/satori-cli@0.4.4`

Preflight before publishing:

```bash
pnpm install --frozen-lockfile
pnpm run versions:check
pnpm build
pnpm -C packages/mcp docs:check
pnpm -C packages/mcp manifest:check
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
pnpm run release:smoke:mcp
pnpm run release:smoke:cli
```

Recommended public release path:

```bash
git tag v0.5.1
git push origin v0.5.1
```

The GitHub Actions release uses npm provenance and requires the `NPM_TOKEN` secret. Use the manual fallback only when you intentionally want to publish from a local authenticated shell without CI provenance:

```bash
pnpm run release:login
pnpm run release:all
pnpm run release:verify
```

## Release Proof

The tag release workflow runs generated-doc checks, manifest checks, MCP tarball smoke tests, and CLI tarball smoke tests before publishing. The CLI installer tests also smoke `install --client all` against Codex, Claude, and OpenCode config in a temp home, asserting that resident client config launches the installer-owned Node launcher without `npx`, runtime cache paths, or custom startup timeout fields.

Release publishes use npm provenance from GitHub Actions. After publish, inspect registry integrity metadata with:

```bash
npm view @zokizuan/satori-core@<version> dist.integrity dist.shasum
npm view @zokizuan/satori-mcp@<version> dist.integrity dist.shasum
npm view @zokizuan/satori-cli@<version> dist.integrity dist.shasum
```

## More Docs

- [Architecture](./ARCHITECTURE.md)
- [End-to-end behavior spec](./docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md)
- [Features and use cases](./docs/SATORI_FEATURES_AND_USE_CASES.md)
- [Public launch checklist](./docs/LAUNCH_CHECKLIST.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of conduct](./CODE_OF_CONDUCT.md)
- [MCP package README](./packages/mcp/README.md)

## Open Source

Satori is open source under the MIT License. The public MCP surface is intentionally read-only and fixed to six tools, so users can inspect behavior, self-host the index runtime, and contribute without expanding the agent write surface.

## License

Satori is released under the [MIT License](./LICENSE).
