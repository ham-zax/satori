# @zokizuan/satori-core

Core indexing and retrieval engine used by Satori.

Use this package when you want the lower-level engine directly. Most agent workflows should install `@zokizuan/satori-cli` (installer) and `@zokizuan/satori-mcp` (six MCP tools) instead of calling core APIs from agents.

## What It Owns

- File discovery and ignore filtering (`.satoriignore`, `.gitignore`, hard denylist).
- One normalized language-analysis boundary for symbols, structural chunks, module bindings, and call evidence. Oxc analyzes JavaScript/JSX/TypeScript/TSX/DTS; Tree-sitter WASM analyzes Python, Go, Rust, Java, C#, C++, and Scala; unsupported or structurally degraded input falls back to bounded fixed-size text chunks without authoritative symbols.
- OpenAI, VoyageAI, Gemini, and Ollama embeddings.
- LanceDB and Milvus/Zilliz vector persistence and search.
- Dense/BM25 hybrid retrieval and optional reranking.
- Incremental sync with stat-first, hash-on-change file tracking.
- Repo-local `satori.toml` index profiles: `default`, `minimal`, and `all-text` (index policy only — not provider credentials).
- Derived symbol registry and relationship sidecars for symbol-owned navigation.

Files remain the source of truth. The symbol registry is a deterministic navigation view for a compatible indexed snapshot; grouped search can use owner symbols while chunks remain supporting evidence. Exact navigation uses `symbolInstanceId`, while `symbolKey` stays stable-ish candidate lookup only. Relationship sidecars store conservative `CALLS v0` plus TypeScript/JavaScript `IMPORTS`/`EXPORTS v0` edges that back symbol-owned `call_graph` traversal. `CALLS v0` is heuristic/name-based: unique same-file targets can be high confidence; cross-file edges stay low unless IMPORTS/EXPORTS evidence upgrades them, or an imported module has a unique same-name target. They are navigation hints, not proof of runtime call coverage.

Language-analyzer configuration is immutable after construction: set `chunkSize`, `chunkOverlap`, and a custom `languageAnalyzer` through constructor options. `LanguageAnalysisResult` reports `complete`, `recovered`, or `unsupported`; degraded results carry a typed reason (`syntax_error`, `parser_unavailable`, `analysis_failure`, or `unsupported_language`) and never expose raw parser errors. Source spans use UTF-8 byte offsets and UTF-16 code-unit columns.

This is an intentional exported Core 2.0 API change: the mutable analyzer setters and `Context.updateLanguageAnalyzer` are removed. The six MCP tools and their schemas are unchanged.

Core 2.0 embedding implementations also use immutable `embedQuery`,
`embedDocuments`, and `getIdentity` methods. A custom embedding must return its
stable provider, model, dimension, optional artifact digest, and normalization
identity; `Context` rejects an incomplete or inconsistent identity before it
opens or publishes persisted index authority. Custom vector adapters receive
Core-built projections and separately typed control records rather than
constructing either inside storage.

Parser, symbol-extractor, and relationship-builder identities are durable index fingerprints. The UTF-8-normalized contracts are `language-analysis-v4+<parser identity>` and `relationship-v3+utf8-normalized-analysis`. Indexes carrying `language-analysis-v3` and/or `relationship-v2` are incompatible and require `manage_index reindex`; incremental `sync` cannot migrate their symbol or relationship evidence.

Completed full indexes write canonical JSON navigation sidecars and then import an additive `navigation.sqlite` cache. JSON remains the canonical navigation source; SQLite is optional for parity checks or explicit experimental reads.

Incremental sync now reuses changed-file symbol output, preserves unchanged registry state, and avoids re-embedding or rewriting unchanged vector chunks. It may reparse unchanged source to recompute deterministic cross-file relationship evidence against the merged registry. If changed-file indexing stops early, core clears navigation state instead of publishing a mixed generation.

Repo config is intentionally small:

```toml
[index]
profile = "minimal"
```

`satori.toml` is index policy only. Provider credentials, model names, backend
selection, and Milvus/Zilliz endpoints belong in runtime configuration, not in
repo config.

Profiles:

- `default`: source, docs/text, config, scripts, infra/query files, and known extensionless files.
- `minimal`: source plus docs/text only.
- `all-text`: default plus unknown UTF-8 text files under the configured size cap.

## Install

```bash
npm install @zokizuan/satori-core
```

Node.js 22.13 or newer is required. Runtime provider requirements depend on the
embedding/vector-store implementation you choose. The MCP distribution defaults
to VoyageAI plus embedded LanceDB; direct Core users can explicitly wire
LanceDB, Milvus SDK, or Milvus REST/Zilliz adapters.

Filesystem indexing binds traversal and file opens to the canonical codebase root via realpath containment and post-open descriptor identity checks (with `/proc/self/fd` preferred on Linux). Paths that resolve outside the root are refused.

## Minimal Use with optional Milvus

```ts
import { Context, OpenAIEmbedding, MilvusVectorDatabase } from '@zokizuan/satori-core';

const embedding = new OpenAIEmbedding({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small'
});

const context = new Context({
  embedding,
  vectorDatabase: new MilvusVectorDatabase({
    address: process.env.MILVUS_ADDRESS,
    token: process.env.MILVUS_TOKEN,
    vectorDimension: embedding.getDimension()
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
