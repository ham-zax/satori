# Satori

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/ham-zax/satori/actions/workflows/ci.yml/badge.svg)](https://github.com/ham-zax/satori/actions/workflows/ci.yml)
[![npm CLI](https://img.shields.io/npm/v/@zokizuan/satori-cli?label=satori-cli)](https://www.npmjs.com/package/@zokizuan/satori-cli)

Agent-safe code retrieval for developers who use MCP coding agents on real repos.

Satori indexes a repository, keeps the index fresh, and gives agents a fixed six-tool MCP surface for finding code, opening exact spans, checking callers/callees, and reading bounded evidence before an edit. It is read-only from MCP: source edits stay in your editor or agent host.

## What You Get

- Find behavior by intent, not just filenames or exact tokens.
- Keep search focused on runtime code before pulling in docs or tests.
- Open exact files, line ranges, and symbols instead of dumping broad context.
- Trace nearby callers/callees when sidecar data is ready.
- Get explicit `requires_reindex`, stale-state, and noise guidance instead of silent bad context.
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
npx -y @zokizuan/satori-cli@0.4.2 install --client all
npx -y @zokizuan/satori-cli@0.4.2 doctor
```

Supported installers: `codex`, `claude`, `opencode`, and `all`.

The installer writes Satori-managed config and copies the first-party workflow skill:

- `satori`

It also installs the MCP server once under `~/.satori/mcp-runtime/`, writes a stable launcher at `~/.satori/bin/satori-mcp.js`, and points client config at that launcher with Node. Resident MCP startup should not perform package-manager resolution.

Treat `~/.satori/` paths as installer-owned. Do not hand-write `npx @zokizuan/satori-mcp` into resident MCP config unless you are intentionally accepting package-manager startup latency.

Restart the MCP client after changing config.

## First Repo Workflow

1. Run the CLI installer and `doctor`.
2. Restart your MCP client.
3. Index one absolute repository path.
4. Search, outline, graph, and read exact spans before edits.

```text
manage_index action="create" path="/absolute/path/to/repo"
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

If any tool returns `requires_reindex`, run the hinted `manage_index action="reindex"` call first, then retry the original tool call. Use `manage_index action="sync"` for ordinary file or ignore-rule convergence.

## Runtime Setup

Satori needs an embedding provider and a Milvus-compatible vector store before indexing. MCP startup, `tools list`, and `doctor` do not require provider credentials; provider-backed tool calls report `MISSING_PROVIDER_CONFIG` when setup is incomplete.

Run `npx -y @zokizuan/satori-cli@0.4.2 doctor` after setting env values to check the local setup before indexing.

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

## Six MCP Tools

| Tool | Use it for |
|---|---|
| `list_codebases` | See indexed roots and their lifecycle buckets |
| `manage_index` | Create, sync, reindex, inspect status, or explicitly clear indexes |
| `search_codebase` | Runtime-first semantic search with operators, grouping, freshness, and navigation hints |
| `file_outline` | Read sidecar symbol outlines and resolve exact symbols without guessing |
| `call_graph` | Traverse bounded caller/callee context from a search-provided `symbolRef` |
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

## Release Commands

Current release versions:

- `@zokizuan/satori-core@1.6.2`
- `@zokizuan/satori-mcp@4.11.2`
- `@zokizuan/satori-cli@0.4.2`

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
