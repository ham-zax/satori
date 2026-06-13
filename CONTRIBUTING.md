# Contributing

This repository is intentionally narrow. Keep changes focused on:
- `packages/core`: semantic indexing engine
- `packages/mcp`: MCP server runtime
- `packages/cli`: installer, doctor, and shell entrypoints
- `docs/` and `satori-landing/`: public documentation and launch collateral

Do not add UI extensions, eval sidecars, or parallel product surfaces here.

## Setup

```bash
pnpm install
```

## Common Commands

```bash
pnpm run check
pnpm build
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
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
pnpm run check
pnpm build
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
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
- Update docs, generated manifests, and tests in the same PR when behavior or public contracts change.
- Do not expand the public MCP tool surface without an explicit contract update.

## Security

Do not include secrets, provider tokens, private repository code, or sensitive logs in public issues or PRs. See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## License

By contributing, you agree your changes are released under the MIT License.
