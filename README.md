# Satori

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/ham-zax/satori/actions/workflows/ci.yml/badge.svg)](https://github.com/ham-zax/satori/actions/workflows/ci.yml)
[![npm CLI](https://img.shields.io/npm/v/@zokizuan/satori-cli?label=satori-cli)](https://www.npmjs.com/package/@zokizuan/satori-cli)

A codebase map for AI coding agents working on real repos.

Grep finds strings. Satori gives coding agents a route through the codebase before they edit.

Satori indexes a repo and gives MCP-compatible agents a fixed investigation path from plain-English intent to structured code evidence: symbol-owned results, file outlines, exact symbol or line-range reads, caller/callee context when supported, freshness checks, and recovery guidance when context is stale. Satori does not edit your source code; edits stay in your editor or agent host.

## What You Get

- Find behavior by plain-English intent, not just filenames or exact tokens.
- Give agents a structured route instead of making them assemble context through grep chains.
- Keep search focused on runtime code before pulling in docs or tests.
- Group search around owner symbols; chunks are supporting evidence, not the final unit of navigation.
- Open exact files, line ranges, and symbols instead of dumping broad context.
- Check nearby callers/callees when graph support is available (advisory only — not blast-radius proof).
- Build derived symbol registry and relationship sidecars during completed full indexes.
- See observed `symbolQuality` on ready roots and `manage_index status` before treating outline/graph as rich.
- Treat graph-ready `navigation.inbound="verify"` as explicit caller-confidence state; use the optional `callerSearchTerm` identifier in a separate `must:` lexical search.
- Get clear recovery steps when context is stale, partial, not ready, or multi-runtime owners conflict.
- Install the MCP server and first-party workflow skill with one command.
- Avoid resident MCP startup through `npx`; clients launch an installer-owned Node launcher.

## Packages

| Package | Purpose |
|---|---|
| `@zokizuan/satori-core` | Oxc/Tree-sitter-WASM language analysis, indexing, embeddings, Milvus/Zilliz storage, retrieval, incremental sync |
| `@zokizuan/satori-mcp` | MCP server with the six agent-facing tools and lifecycle gates |
| `@zokizuan/satori-cli` | Installer, doctor command, and shell access to MCP tools |

## Quick Start

Filesystem indexing binds opens to the canonical codebase root with Linux descriptor semantics: required `O_NOFOLLOW`/`O_DIRECTORY` flags, `/proc/self/fd` containment, and post-open identity checks. Indexing fails closed with a capability error on platforms that cannot provide those guarantees; no weaker pathname-only fallback is supported.

Install managed MCP config for every supported local client:

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```

Satori requires Node.js 22.13 or newer. This release uses UTF-8-normalized `language-analysis-v4` and `relationship-v3` evidence; indexes built with `language-analysis-v3` or `relationship-v2` return `requires_reindex` and must be rebuilt once. `sync` does not migrate an incompatible index.

Supported installers: `codex`, `claude`, `opencode`, and `all`.

Choose an index profile during install when the repo should not use the default safe-broad policy:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --profile minimal
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

A non-dry-run install then performs a bounded postflight through that exact launcher. It proves managed client wiring, MCP initialization and installed version, the canonical six-tool surface, runtime-owner registration, and complete child termination. Missing provider or vector configuration is a warning because the proof is static and non-provider-backed. Launcher, protocol, tool, owner, or shutdown failures return a non-zero exit while preserving the installed artifacts and the emitted postflight receipt. The dedicated postflight runtime mode does not recover indexes, start watchers or background sync, call lifecycle tools, search, or create remote state.

Treat `~/.satori/` paths as installer-owned. Do not hand-write `npx @zokizuan/satori-mcp` into resident MCP config unless you are intentionally accepting package-manager startup latency.

For Codex, the installer also writes a marked Satori guidance block to `~/.codex/AGENTS.md` by default. That block positions Satori as semantic-first code exploration: start with `search_codebase` for behavior/ownership context, prefer `recommendedNextAction` when present, then narrow with `file_outline`, `call_graph`, and `read_file` for proof.

Restart every Satori MCP client after changing runtime config. In particular, after changing `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, embedding dimension, `HYBRID_MODE`, vector backend settings, or the Satori runtime version, stop old clients before running `manage_index create`, `reindex`, `sync`, `clear`, or `repair`. Satori records live runtime owners under `~/.satori/runtime/owners.json` and blocks those mutations with `status="blocked"` / `reason="runtime_owner_conflict"` when multiple live Satori runtimes with different fingerprints, package versions, or configs are active. A canonical-root mutation lease separately prevents concurrent writers with otherwise compatible configs; contention returns `reason="mutation_in_progress"`, and `manage_index status` exposes the live lease as `hints.activeMutation` without a wall-clock expiry. `manage_index status` and `list_codebases` show a compact **Runtime owners** line when the registry is readable. `satori-cli doctor` also compares live owner versions and identities with the installed runtime, uses process-start evidence to detect PID reuse when available, inspects lease files read-only, and verifies the managed launcher and configured client entries.

For Codex, `satori-cli install --client codex --install-guidance-hook` also installs a marked `SessionStart` reminder that prints the Satori tool workflow. The hook is guidance-only, suppresses duplicate startup prints for the same working directory, and does not run indexing, search, or provider-backed work.

## First Repo Workflow

1. Run the CLI installer and `doctor`.
2. Restart your MCP client.
3. Index one absolute repository path.
4. Search with plain-English intent, then outline, graph, and open exact symbols (or direct spans) before edits.

```text
manage_index action="create" path="/absolute/path/to/repo"
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
# Exact symbol open (mode required; contractVersion 2; one identity; one context or continuation):
read_file path="/absolute/path/to/repo/src/auth.ts" mode="plain" open_symbol={contractVersion:2,symbolId:"...",context:{preset:"implementation"}}
# Direct span remains an unversioned source read:
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

If any tool returns `requires_reindex`, run the hinted `manage_index action="reindex"` call first, then retry the original tool call. Use `manage_index action="sync"` for ordinary file or ignore-rule convergence.

If `manage_index` returns `reason="runtime_owner_conflict"`, follow the envelope’s listed pids/versions and `hints.nextStep`: leave a single package version/config running, then retry. MCP tools never kill processes or ask interactive cleanup questions.

## Runtime Setup

Satori needs an embedding provider and a Milvus-compatible vector store before indexing. MCP startup, `tools list`, and `doctor` do not require provider credentials; provider-backed tool calls report `MISSING_PROVIDER_CONFIG` when setup is incomplete.

Run `npx -y @zokizuan/satori-cli@latest doctor` after setting env values to check the local setup before indexing. Doctor also prints the installed Satori package set (`satori-cli`, `satori-mcp`, `satori-core`); those packages use independent versions by design. Install postflight proves the installed launcher and MCP protocol path; it does not replace doctor or prove provider connectivity.

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
EMBEDDING_MODEL = "voyage-code-3"
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
EMBEDDING_MODEL=voyage-code-3
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

- `scope="runtime"` so documentation does not dominate first results (tests stay demoted unless test intent is explicit; use `scope="docs"` for docs-only).
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

Current relationship limits are intentional. `CALLS v0` is heuristic/name-based (not a compiler-grade call graph): unique same-file targets can be high confidence; cross-file edges stay low unless `IMPORTS`/`EXPORTS` evidence upgrades them, or an imported module has a unique same-name target (for example class methods without a top-level `EXPORTS` record). Generic names like `push`/`get` stay suppressed without `EXPORTS`. Ambiguous same-name targets are skipped. Empty or short edge lists are not proof of “no callers.” Every graph-ready grouped result carries `navigation.inbound="verify"`; when `callerSearchTerm` is present, use it in a separate `must:<term> <term>` search, tests, and direct references before blast-radius edits. `IMPORTS`/`EXPORTS v0` records only resolvable relative module edges and unambiguous local export declarations; package imports, unresolved paths, ambiguous local exports, and multiline module syntax are skipped.

Language capability is explicit. TypeScript, JavaScript, and Python are the only production-ready `call_graph` languages. Go, Rust, Java, C#, C++, and Scala are `symbol_only`: `file_outline` and `read_file(open_symbol)` use compatible sidecar symbols and current-source validation, while `call_graph` returns `unsupported_language`. Broader catalog/parser support does not imply graph-ready navigation.

Exact navigation is keyed by `symbolInstanceId`. `symbolKey` stays stable-ish across small edits, but it is candidate lookup only and is not exact identity.

Grouped search responses use `formatVersion: 2`. Each result carries one canonical `target` with a repo-relative file, a 1-based inclusive span, and an optional registry-proven concrete `symbolId`; display data, quality, source-only preview evidence, and navigation state are separate facts. Pass a graph-ready `target` directly to `call_graph` with the envelope `codebaseRoot`, and treat its required `navigation.inbound="verify"` as the caller-confidence contract. For reads, resolve `target.file` under `codebaseRoot`. When `target.symbolId` exists, call `read_file` with required `mode` and the one canonical exact open: `open_symbol.contractVersion=2`, exactly one of `symbolId`/`symbolLabel`, and exactly one of `context`/`continuation`. Success is one bounded structured `symbol_context` JSON package in both plain and annotated modes; accepted exact failures use bounded structured errors. Direct `startLine`/`endLine` (or top-level line range) opens remain unversioned source reads and do not expand to a full symbol span. Raw result objects are unchanged.

`call_graph` now uses compatible relationship sidecars as the canonical traversal source for symbol-owned navigation. Completed incremental syncs reuse changed-file symbol output, preserve unchanged registry state, and avoid re-embedding or rewriting unchanged vector chunks. Current source may still be reparsed to recompute deterministic cross-file relationship evidence against the merged registry. If changed-file indexing stops early, recovery fails, or a partial full index hits a limit, Satori clears or withholds navigation state instead of publishing a mixed generation. Public reasons prefer precise values such as `missing_symbol_registry`, `missing_relationship_sidecar`, `incompatible_symbol_registry`, `incompatible_relationship_sidecar`, `stale_symbol_ref`, `navigation_recovery_failed`, and `partial_index_navigation_unavailable`.

## Six MCP Tools

| Tool | Use it for |
|---|---|
| `list_codebases` | See indexed roots and lifecycle buckets; ready roots include compact `symbolQuality=…` and optional Runtime owners summary |
| `manage_index` | JSON-envelope lifecycle: create, reindex, sync, status, clear, repair (clear is destructive; repair only when vector payload + trusted fingerprint proof allow). `status` may include structured `symbolQuality` and Runtime owners |
| `search_codebase` | Runtime-first plain-English discovery with exact operators, compact v2 symbol groups, freshness, warnings, one `recommendedNextAction`, explicit inbound verification, and optional `callerSearchTerm` evidence |
| `file_outline` | Read sidecar symbol outlines and resolve exact symbols without guessing (`ok` / `ambiguous` / `not_found`) |
| `call_graph` | Bounded advisory caller/callee context from a search `symbolRef` when relationship-backed navigation is ready (TS/JS/Python; not sole blast-radius authority) |
| `read_file` | Bounded reads under indexed/searchable roots only (absolute paths; not a general host FS reader): line ranges and annotated plain source, unversioned direct-span opens, or exact `open_symbol` contractVersion 2 context packages |

## What Satori Is Not

- Not an agent framework.
- Not a source-code write server.
- Not a replacement for tests, typecheck, code review, or grep.
- Not a promise that static call graph hints prove runtime or assertion coverage.

Satori gives the agent better evidence. It does not remove engineering judgment.

## Roadmap

Satori is focused on making repo investigation easier for coding agents without requiring heavyweight setup.

Planned work includes:

- **Local-first setup:** keep improving the Ollama-backed local embedding path and evaluate Zvec as an embedded vector-store backend, reducing the need for cloud keys or a separate Milvus/Zilliz setup.
- **Retrieval quality:** improve symbol-owned retrieval, ranking, exact evidence selection, and noisy-result handling.
- **Language support:** expand caller/callee and relationship-backed navigation beyond the currently supported languages.
- **Team workflows:** explore shared indexes, hosted indexing, multi-user freshness state, and managed repo context for engineering teams.
- **Evaluation:** improve deterministic retrieval tests and comparison harnesses for real repositories.

## Repository Layout

```text
packages/core   indexing, retrieval, embeddings, vector store, sync
packages/mcp    MCP server, tool schemas, lifecycle gates, generated tool docs
packages/cli    managed installer, doctor, direct shell tool calls
docs/           current docs map, behavior specs, active plans, dated evidence
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

- `@zokizuan/satori-core@2.0.0`
- `@zokizuan/satori-mcp@6.0.0`
- `@zokizuan/satori-cli@0.5.0` (install examples may use `@latest`)

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

Recommended public release path (tag matches the monorepo version in root `package.json`):

```bash
git tag v0.5.15
git push origin v0.5.15
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

- [Documentation map](./docs/README.md)
- [Architecture](./ARCHITECTURE.md)
- [End-to-end behavior spec](./docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md)
- [Features and use cases](./docs/SATORI_FEATURES_AND_USE_CASES.md)
- [Public launch checklist](./docs/LAUNCH_CHECKLIST.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of conduct](./CODE_OF_CONDUCT.md)
- [MCP package README](./packages/mcp/README.md)

## Open Source

Satori is open source under the MIT License. The public MCP surface is fixed to six tools and does not expose source-code write tools, so users can inspect behavior, self-host the index runtime, and contribute without expanding the agent edit surface.

## License

Satori is released under the [MIT License](./LICENSE).
