# Contributing to @satori-code/core

Read the [main contributing guide](../../CONTRIBUTING.md) first for shared setup and workflow rules.

## Quick Commands

```bash
pnpm build:core
pnpm dev:core
pnpm --filter @satori-code/core typecheck
pnpm --filter @satori-code/core test
```

## Project Structure

- `src/core/` — `Context` (composition root and compatibility façade), indexing pipeline, ignore rules, semantic search
- `src/generation/` — Publication store and full-index generation workflow
- `src/sync/` — incremental synchronization
- `src/embedding/` — embedding providers (Potion, Voyage, OpenAI, Gemini, Ollama)
- `src/vectordb/` — vector stores (LanceDB, Milvus/Zilliz gRPC and REST)
- `src/reranker/` — query-time reranking
- `src/symbols/`, `src/navigation/`, `src/relationships/` — symbol registry, navigation sidecars, and relationship evidence
- `src/language/`, `src/languages/`, `src/language-analysis/`, `src/semantic/` — language catalog, capabilities, parsers, and the CBM semantic engine
- `src/packages/` — package and workspace ownership
- `src/config/`, `src/policy/` — index profiles and repository policy

New domain behavior belongs in a dedicated owner under these directories, not in `Context`.

## Guidelines

- Use TypeScript strict mode.
- Follow existing code style.
- Reject unsupported persisted formats with a typed error; never migrate them.
