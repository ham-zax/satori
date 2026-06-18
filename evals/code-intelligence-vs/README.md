# Code Intelligence VS Harness

This eval compares Satori and codebase-memory-mcp on the same repository tasks.
It is intentionally adapter-based: each provider keeps its own MCP tool surface,
and the harness normalizes outputs into files, symbols, warnings, latency, and
anchor-based scores.

## Run

Build Satori first if `packages/mcp/dist/index.js` is stale or missing:

```bash
pnpm run build:mcp
```

Run the default suite against both providers:

```bash
pnpm run vs:code-intelligence -- \
  --cmm-command /home/hamza/.local/bin/codebase-memory-mcp \
  --out /tmp/satori-vs-both.json
```

Run only one provider:

```bash
pnpm run vs:code-intelligence -- --provider satori
pnpm run vs:code-intelligence -- \
  --provider codebase-memory \
  --cmm-command /home/hamza/.local/bin/codebase-memory-mcp
```

Use JSON-array command specs when a server command needs arguments:

```bash
pnpm run vs:code-intelligence -- \
  --satori-command '["node","packages/mcp/dist/index.js"]' \
  --cmm-command '["node","/path/to/codebase-memory-mcp/server.js"]'
```

## Scoring

Each task defines expected file, symbol, and text anchors in `tasks.json`.
The harness reports raw score, pass count, unsupported count, and a per-task
leader. Unsupported or not-ready responses can still show anchor overlap for
debugging, but they cannot pass a task.

This is not an LLM answer-quality benchmark. It measures deterministic code
intelligence retrieval/navigation behavior:

- `search`: find relevant implementation symbols and files.
- `outline`: expose symbols for a known file.
- `callgraph`: traverse or approximate relationships around a function.
- `architecture`: summarize package/module structure.

## Fairness Notes

Satori search tasks need provider/vector configuration. If Satori returns
`missing_provider_config`, the run is an environment failure, not evidence that
Satori lost the retrieval task.

Satori exact navigation also depends on compatible JSON sidecars. If it returns
`requires_reindex`, run `manage_index(action="reindex")` for the target repo
before using the result as a leaderboard.
