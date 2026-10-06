# Contributing

This repository is intentionally narrow. Keep changes focused on:
- `packages/core`: semantic indexing engine
- `packages/mcp`: MCP server runtime
- `packages/cli`: installer, doctor, and shell entrypoints
- `scripts/` and `evals/`: release tooling, benchmarks, and retrieval evaluations
- `docs/` and `satori-landing/`: public documentation and launch collateral

Do not add UI extensions or parallel product surfaces here.

## Setup

```bash
pnpm install
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
pnpm --filter @satori-code/core test
pnpm --filter @satori-code/mcp test
pnpm --filter @satori-code/cli test
pnpm test:scripts
pnpm test:integration
```

To try unreleased changes through a real MCP client (Claude Code, Codex, ...)
without replacing the installed runtime, see
[`docs/LOCAL_DEV_MCP.md`](./docs/LOCAL_DEV_MCP.md).

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

## Releasing

Version reference drift and stale packed artifacts are release errors, enforced
in CI and locally. Before any version bump or coordinates change, read
[RELEASING.md](./docs/RELEASING.md) and run `pnpm run release:check`.

Coordinated version changes use the bump planner; preview before applying:

```bash
pnpm release:bump -- core minor
pnpm release:bump -- core minor --apply
```

Publication happens only through `pnpm run release:all`. Do not hand-publish
MCP or CLI out of order or against a stale Core version.

## License

Satori is licensed under AGPL-3.0-only and is also intended to support separately negotiated commercial licensing by the copyright holder. External code contributions are not being accepted until contributor licensing terms are finalized. Please open an issue before submitting code.
