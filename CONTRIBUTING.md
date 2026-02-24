# Contributing

This repository is intentionally narrow. Keep changes focused on:
- `packages/core`: semantic indexing engine
- `packages/mcp`: MCP server runtime

Do not add UI extensions, eval sidecars, or parallel product surfaces here.

## Setup

```bash
pnpm install
```

## Common Commands

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test:integration
```

## Architecture Guardrails

- Keep orchestration logic inside `src/core/` modules.
- Keep provider/config plumbing isolated from business flow.
- Keep indexing, search, and sync logic testable without external services.
- Prefer small focused modules over monolithic handlers.

## Testing

Before opening a PR, run:

```bash
pnpm build
pnpm test:integration
```

Integration tests should continue validating:

1. indexing works end-to-end
2. semantic search returns relevant snippets
3. incremental sync handles add/modify/remove changes correctly

## Pull Requests

- Keep PRs small and scoped.
- Include rationale for architecture-impacting changes.
- Avoid bundling unrelated refactors.

## License

By contributing, you agree your changes are released under the MIT License.
