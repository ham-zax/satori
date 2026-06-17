# @zokizuan/satori-core

Core indexing and retrieval engine used by Satori.

Use this package when you want the lower-level engine directly. Most agent workflows should install `@zokizuan/satori-mcp` or `@zokizuan/satori-cli` instead.

## What It Owns

- File discovery and ignore filtering.
- AST-aware chunking with an in-package recursive fallback splitter. The legacy `LangChainCodeSplitter` class name remains for API compatibility, but `langchain` is no longer a runtime dependency.
- OpenAI, VoyageAI, Gemini, and Ollama embeddings.
- Milvus/Zilliz vector persistence and search.
- Dense/BM25 hybrid retrieval and optional reranking.
- Incremental sync with stat-first, hash-on-change file tracking.
- Repo-local `satori.toml` index profiles: `default`, `minimal`, and `all-text`.
- Derived symbol registry and relationship sidecars for symbol-owned navigation.

Files remain the source of truth. The symbol registry is a deterministic navigation view for a compatible indexed snapshot; grouped search can use owner symbols while chunks remain supporting evidence. Exact navigation uses `symbolInstanceId`, while `symbolKey` stays stable-ish candidate lookup only. Relationship sidecars store conservative `CALLS v0` plus TypeScript/JavaScript `IMPORTS`/`EXPORTS v0` edges that now back symbol-owned `call_graph` traversal.

Completed full indexes write canonical JSON navigation sidecars and then import an additive `navigation.sqlite` cache. JSON remains the canonical navigation source; SQLite is optional for parity checks or explicit experimental reads.

Incremental sync now reuses changed-file symbol output, preserves unchanged registry state, and recomputes relationships against the merged registry without re-splitting unchanged files. If changed-file indexing stops early, core clears navigation state instead of publishing a mixed generation.

Repo config is intentionally small:

```toml
[index]
profile = "minimal"
```

`satori.toml` is index policy only. Provider credentials, model names, and Milvus/Zilliz endpoints belong in runtime configuration, not in repo config.

Profiles:

- `default`: source, docs/text, config, scripts, infra/query files, and known extensionless files.
- `minimal`: source plus docs/text only.
- `all-text`: default plus unknown UTF-8 text files under the configured size cap.

## Install

```bash
npm install @zokizuan/satori-core
```

Runtime requirements depend on the embedding/vector-store implementation you choose. The MCP distribution defaults to embeddings plus a Milvus-compatible backend; direct users can wire the same components explicitly.

## Minimal Use

```ts
import { Context, OpenAIEmbedding, MilvusVectorDatabase } from '@zokizuan/satori-core';

const context = new Context({
  embedding: new OpenAIEmbedding({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'text-embedding-3-small'
  }),
  vectorDatabase: new MilvusVectorDatabase({
    address: process.env.MILVUS_ADDRESS,
    token: process.env.MILVUS_TOKEN
  })
});

await context.indexCodebase('/absolute/path/to/repo');

const results = await context.semanticSearch({
  codebasePath: '/absolute/path/to/repo',
  query: 'authentication refresh flow',
  topK: 5,
  retrievalMode: 'hybrid',
  scorePolicy: { kind: 'topk_only' }
});
```

## Development

```bash
pnpm --filter @zokizuan/satori-core build
pnpm --filter @zokizuan/satori-core typecheck
pnpm --filter @zokizuan/satori-core test:integration
```
