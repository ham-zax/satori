# @zokizuan/satori-core

The indexing and retrieval engine behind [Satori](https://github.com/ham-zax/satori).

Most coding-agent installations should use `@zokizuan/satori-cli` and `@zokizuan/satori-mcp`. Install Core directly when embedding Satori's lower-level analysis, indexing, storage, or retrieval APIs in another Node.js application.

## What Core Owns

- repository discovery, ignore policy, source observation, and incremental synchronization;
- Oxc and Tree-sitter-WASM language analysis;
- structural chunks, symbols, navigation, and conservative relationship evidence;
- Potion, VoyageAI, OpenAI, Gemini, and Ollama embeddings;
- dense and BM25 hybrid retrieval;
- LanceDB and Milvus/Zilliz storage adapters; and
- atomic publication identity, compatibility, checkpoint, and receipt state.

Files remain the source of truth. Navigation and graph data are derived source evidence; vectors are model-specific derived state. Provider, model, dimensions, inference contract, projection, and schema participate in persisted compatibility.

## Retrieval and Storage

Core supports Potion, VoyageAI, OpenAI, Gemini, and Ollama embeddings; LanceDB and Milvus/Zilliz storage; and dense + BM25 hybrid retrieval. The managed offline distribution uses Potion Code 16M v2 with 256-dimensional vectors, while the connected reference path uses Voyage Code 3.

The persistence model separates source-derived lexical/navigation state from model-specific vectors. That boundary preserves a complete exact + BM25 + single-vector baseline if a future optional local reranker or multi-vector sidecar is missing, stale, corrupt, or over deadline. No such offline reranker is shipped today.

## Install

```bash
npm install @zokizuan/satori-core
```

Node.js 22.13 or newer is required. Provider and storage requirements depend on the adapters selected by the host application.

## Repository Policy

Core reads the same repository-local `satori.toml` used by the MCP distribution:

```toml
[index]
profile = "minimal"
```

The file controls index breadth only. Credentials, provider models, dimensions, and backend endpoints belong in runtime configuration.

## Development

```bash
pnpm --filter @zokizuan/satori-core build
pnpm --filter @zokizuan/satori-core typecheck
pnpm --filter @zokizuan/satori-core test
```

Satori is MIT licensed.
