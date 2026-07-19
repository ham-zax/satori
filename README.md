# Satori

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/ham-zax/satori/actions/workflows/ci.yml/badge.svg)](https://github.com/ham-zax/satori/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zokizuan/satori-cli?label=npm)](https://www.npmjs.com/package/@zokizuan/satori-cli)

Local, freshness-aware code retrieval for AI coding agents.

Satori indexes a repository once, combines semantic and lexical search, and gives MCP-compatible agents seven bounded tools for finding owners, tracing nearby relationships, and reading exact source. It does not edit source code.

```text
plain-English question
        |
        v
exact evidence + BM25 + dense retrieval
        |
        v
symbol-owned results
        |
        v
outline, call graph, and bounded source reads
```

## Why Satori

- Find behavior by intent when filenames and exact identifiers are unknown.
- Keep exact paths, symbols, configuration keys, and lexical evidence in the retrieval path.
- Return owner-oriented groups instead of flooding the agent with duplicate chunks.
- Open exact symbols or bounded line ranges instead of dumping entire files.
- Detect source drift and publish complete searchable generations atomically.
- Run fully local retrieval with Potion Code 16M v2 and LanceDB on Linux x64.
- Install one managed MCP runtime for Codex, Claude Code, OpenCode, or all three.

## Measured on Satori

These are repository measurements, not borrowed model-card claims.

### Local Potion + LanceDB

A checksum-sealed run on the Satori repository published 488 files and 10,830 chunks with 256-dimensional Potion vectors:

| Operation | Measured result |
|---|---:|
| First CPU-only publication | 34.46 s |
| Warm search p95 | 154.543 ms |
| Zero-change synchronization p95 | 185.662 ms |
| One-file addition p95 | 789.310 ms |
| One-file body edit p95 | 792.245 ms |
| One-file signature edit p95 | 811.632 ms |
| One-file deletion p95 | 864.802 ms |
| Rename p95 | 880.937 ms |

The bundled native feasibility run measured a 36.0 MiB model/helper closure, 104.3 MiB model-related RSS, and 232.404 ms model load. Its short-text microbenchmark reached 19,282 items/s, but that isolated throughput number is not a full indexing claim.

### Potion versus Voyage

The same frozen 30 positive retrieval tasks were queried against compatible Potion and Voyage hybrid publications. BM25, exact evidence, fusion, grouping, source projection, and request policy were held constant; only the dense model/publication differed.

| Retrieval result | Potion | Voyage |
|---|---:|---:|
| Required owner at rank 1 | 13/30 | 14/30 |
| Required owner in top 5 | 23/30 | 25/30 |
| Required owner in top 15 | 25/30 | 27/30 |
| Observed search latency p50 | 94.64 ms | 1,009.46 ms |
| Observed search latency p95 | 1,251.00 ms | 1,813.34 ms |

Potion is a useful local first stage, not a claim of Voyage parity. The comparison found weaker Java and configuration/runtime retrieval for Potion. The paired latency observations are descriptive rather than a repeated cross-provider performance qualification.

### Less context waste

Satori groups retrieval around owners and exposes bounded source instead of making an agent assemble context from repeated broad reads. In one correct exploratory exact-owner pair, the Satori arm used 10 tool calls and 36,591 model-visible bytes versus 19 calls and 86,401 bytes for native file-by-file exploration. That is 47% fewer calls and 58% fewer visible bytes in that task; it is not presented as a universal token-reduction percentage.

The qualification details and limitations remain available in the [Potion plan](./docs/plans/SATORI_POTION_OFFLINE_EMBEDDING_LEAN_QUALIFICATION_PLAN.md). Context-efficiency numbers will be replaced by the fresh release benchmark before publication.

## Quick Start

Requirements:

- Node.js 22.13 or newer
- Linux x64, including Windows through WSL2
- an MCP-compatible coding agent

Install the local offline runtime:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime offline
npx -y @zokizuan/satori-cli@latest doctor
```

Restart the coding agent, then ask it to index the repository:

```text
manage_index action="create" path="/absolute/path/to/repo"
```

Search it:

```text
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
```

Satori installs a stable launcher under `~/.satori/`. MCP clients do not run the server through `npx` on every startup.

## Runtime Choices

| Runtime | Retrieval | Storage | Requirement |
|---|---|---|---|
| Offline | Potion Code 16M v2 + BM25 | LanceDB | Linux x64; no model API key |
| Connected | Voyage Code 3 + BM25 | LanceDB | `VOYAGEAI_API_KEY` |
| Ollama | selected Ollama model + BM25 | LanceDB | local loopback Ollama |
| Connected Milvus | Voyage Code 3 + BM25 | Milvus or Zilliz | explicit Milvus configuration |

Connected install:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime voyage
npx -y @zokizuan/satori-cli@latest doctor
```

Existing Milvus deployments can select `--vector-store milvus`. Existing Ollama installations can select or retain an explicit model:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime offline --ollama-model nomic-embed-text
```

Changing the embedding provider, model, dimensions, vector backend, or persisted projection changes index compatibility and requires a reindex. Satori never silently converts or deletes the previous backend's publication.

## MCP Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Create, synchronize, inspect, repair, reindex, or clear a repository index. Use status and repair guidance instead of guessing whether an index is ready. |
| `search_codebase` | Run freshness-aware hybrid search and return symbol-owned evidence. Start here for behavior, ownership, configuration, or path discovery. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. |
| `file_outline` | List the indexed symbols and spans in one file. Use it to choose an exact owner before reading implementation. |
| `call_graph` | Inspect advisory callers, callees, imports, and exports when supported. Verify inbound leads before blast-radius changes. |
| `read_file` | Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods. |
| `list_codebases` | List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one. |

Public paths are absolute. `read_file` is restricted to tracked searchable roots; it is not a general host-filesystem reader.

## Recommended Agent Workflow

```text
1. search_codebase for behavior or ownership
2. follow recommendedNextAction when returned
3. use file_outline to inspect one file's owners
4. use call_graph for advisory relationship context
5. use read_file for exact proof
6. use continue_search only when the frozen result has more useful evidence
```

If a tool returns `requires_reindex`, reindex before retrying the original call. Use `sync` for ordinary source changes. Treat inbound call-graph results as leads to verify, not compiler-grade blast-radius proof.

## Index Profiles

Install with `--profile default|minimal|all-text` to write repository policy to `satori.toml`:

```toml
[index]
profile = "minimal"
```

| Profile | Includes |
|---|---|
| `default` | Source, documentation, config, scripts, infrastructure files, queries, and known extensionless text files. |
| `minimal` | Source and documentation text. |
| `all-text` | `default` plus additional bounded UTF-8 text files. |

Every profile honors `.satoriignore`, `.gitignore`, and the hard denylist for secrets, dependencies, generated output, lockfiles, binaries, logs, databases, bundles, source maps, and snapshots. Profiles control what is indexed; `search_codebase` still defaults to implementation-first `scope="runtime"`.

## Configuration

The installer owns the launcher and non-secret runtime identity. Provider credentials remain in the MCP client's environment.

Common variables:

```text
SATORI_RUNTIME_PROFILE
VECTOR_STORE_PROVIDER
LANCEDB_PATH
EMBEDDING_PROVIDER
EMBEDDING_MODEL
EMBEDDING_OUTPUT_DIMENSION
VOYAGEAI_API_KEY
MILVUS_ADDRESS
MILVUS_TOKEN
```

Run `doctor` after changing runtime configuration. Restart every Satori MCP client before mutating an index under a new provider, model, backend, dimension, or package version; incompatible live runtime owners are blocked instead of racing one publication.

## How Publication Works

Satori keeps source-derived navigation separate from model-specific vectors. A completed publication binds vector and lexical state, navigation, relationship evidence, source observation, checkpoint, and receipt to one generation. Readers use the complete previous generation or the complete new generation; failed candidate work does not replace the active publication.

Incremental synchronization scans for changed files, embeds changed chunks only, updates per-file navigation and graph contributions, and activates the complete replacement generation. Missing, corrupt, stale, or incompatible authority fails closed to repair or reindex guidance.

## Future Local Reranking

The current offline product is intentionally simple: exact evidence + BM25 + Potion retrieval, followed by Satori grouping and disclosure. It does not ship a local neural reranker today.

Candidate identity and provenance are kept separate from primary publication authority so a future local second stage can score a complete bounded candidate set and fall back entirely to the existing ordering on failure. Optional LateOn/NextPLAID-style state remains future work; it will never control source freshness or baseline search availability.

## Language Support

Search and bounded reads work across the indexed text and language catalog. Rich symbol navigation depends on parser evidence. TypeScript, JavaScript, and Python currently have the strongest call-graph support; other supported languages may provide symbols without authoritative graph traversal. Inspect `manage_index status` instead of assuming every indexed language is graph-ready.

## Privacy and Limits

- Offline Potion embedding, LanceDB storage, search, and runtime telemetry make no network requests after installation.
- Connected providers receive the projected embedding or reranking input required for their service.
- Satori does not edit repository source.
- Local diagnostics exclude source, queries, paths, symbols, and repository identifiers and are never uploaded by Satori.
- Native Windows and macOS are not supported in this release. On Windows, run Satori inside WSL2.
- The relationship graph is conservative navigation evidence, not a full static-analysis proof.

## Packages

| Package | Purpose |
|---|---|
| [`@zokizuan/satori-cli`](./packages/cli) | Installer, doctor, and command-line access to MCP tools. |
| [`@zokizuan/satori-mcp`](./packages/mcp) | The MCP server and seven public tools. |
| [`@zokizuan/satori-core`](./packages/core) | Indexing, analysis, embeddings, storage, and retrieval. |

## Development

```bash
pnpm install
pnpm build
pnpm run check
```

Focused package tests:

```bash
pnpm --filter @zokizuan/satori-core test
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions, [SECURITY.md](./SECURITY.md) for private vulnerability reporting, and [THIRD_PARTY.md](./THIRD_PARTY.md) for attribution.

## License

MIT
