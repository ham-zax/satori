# Contributing to @zokizuan/satori-core

Read the [main contributing guide](../../CONTRIBUTING.md) first for shared setup and workflow rules.

## Core Package Development

This file covers package-specific expectations for the core indexing engine.

## Development Workflow

### Quick Commands
```bash
# Build core package
pnpm build:core

# Watch mode for development
pnpm dev:core
```

### Making Changes

1. Create a branch for your change.
2. Make edits under `src/`.
3. Follow commit and PR expectations from the [main guide](../../CONTRIBUTING.md).

## Project Structure

- `src/context.ts` - Main Satori context class
- `src/embedding/` - Embedding providers (OpenAI, VoyageAI, Ollama)
- `src/vectordb/` - Vector database implementations (Milvus)
- `src/splitter/` - Code splitting logic
- `src/types.ts` - TypeScript type definitions

## Guidelines

- Use TypeScript strict mode
- Follow existing code style
- Handle errors gracefully

## Support

- General questions: see the [main contributing guide](../../CONTRIBUTING.md)
- Core-specific issues: open an issue with the `core` label
