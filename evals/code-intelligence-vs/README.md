# Code Intelligence VS Harness

This eval compares Satori and codebase-memory-mcp on the same repository tasks.
It is intentionally adapter-based: each provider keeps its own MCP tool surface,
and the harness normalizes outputs into files, symbols, warnings, latency, and
anchor-based scores.

The S1 normalization experiment is separate from this five-task benchmark.
It replays metadata, file-symbol supplementation, and definition fusion using
a frozen diagnostic capture. It does not measure final grouped acceptance.
See the [experiment plan](../../docs/improvements/s1-owner-discovery-plan-2026-10-23.md)
and [measured results](../../docs/improvements/s1-normalization-experiment-2026-10-23.md)
for scope and the reproduction command. The tested normalization variants
do not fix S1. The fixture preserves persisted and source-derived candidates.
The script checks the baseline fusion order before evaluating any variant.

The separate [declaration-evidence experiment](../../docs/improvements/s1-declaration-evidence-experiment-2026-10-23.md)
compares total-evidence and name-priority ordering with the same per-file cap.
It uses the captured S1 pool and oracle-assisted React/FlatBuffers file probes.
Name priority admits S1 only with trial normalization and removes an accepted
React owner from supplementation. The rule is rejected as an unconditional
replacement. These positions are not grouped search ranks or benchmark scores.

The [graph evidence experiment](../../docs/improvements/s1-graph-evidence-experiment-2026-10-23.md)
checks the real Satori call path through task-owned production sidecars.
Both proof-backed edges survive read-back across 692 extracted TypeScript files.
Three non-TypeScript files also enter the registry to preserve the replay window.
With admission fixed, handler-only graph labels improve LateOn rank from 58 to
52, while fusion remains at 16. The parent reproduces complete scores and
ordering. Neither artifact read-back nor controlled admission establishes grouped
search acceptance.

## Run

Build Satori first if `packages/mcp/dist/index.js` is stale or missing:

```bash
pnpm run build:mcp
```

Run the default suite against both providers:

```bash
pnpm run vs:code-intelligence -- \
  --cmm-command /path/to/codebase-memory-mcp \
  --out /tmp/satori-vs-both.json
```

Run only one provider:

```bash
pnpm run vs:code-intelligence -- --provider satori
pnpm run vs:code-intelligence -- \
  --provider codebase-memory \
  --cmm-command /path/to/codebase-memory-mcp
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
debugging, but they cannot pass a task. Treat that raw score as diagnostic
overlap only: an unsupported callgraph task did not complete traversal, so its
anchor score is not a measure of graph capability and must not rank providers.

This is not an LLM answer-quality benchmark. It measures deterministic code
intelligence retrieval/navigation behavior:

- `search`: find relevant implementation symbols and files.
- `outline`: expose symbols for a known file.
- `callgraph`: traverse or approximate relationships around a function.
- `architecture`: summarize package/module structure.

## Satori Callgraph Contract

The grouped search output is format version 3. The envelope carries
`codebaseRoot`; each result carries `target.file`, optional `target.symbolId`,
and `navigation.graph`. The harness selects the first result where
`navigation.graph === "ready"` and both target fields are nonempty, then calls
`call_graph` with that exact target as `symbolRef` and `codebaseRoot` as `path`.
The retired `callGraphHint` and `nextActions` fields are not part of this
contract.

Agents can discover this mapping from the MCP tool schemas and descriptions,
the `navigation` data returned by grouped search, and the shipped workflow at
`packages/cli/assets/skills/satori/SKILL.md`.

## Fairness Notes

Satori search tasks need provider/vector configuration. If Satori returns
`missing_provider_config`, the run is an environment failure, not evidence that
Satori lost the retrieval task.

Satori exact navigation also depends on compatible JSON sidecars. If it returns
`requires_reindex`, run `manage_index(action="reindex")` for the target repo
before using the result as a leaderboard.

For a steady-state benchmark, inspect `manage_index(action="status")` and wait
until `sourceFreshness.state` is `verified`. Report runs during index lag
separately.

codebase-memory-mcp schemas vary by server version. An inspected local server
advertises `project` and `query`, plus `name_pattern` and `semantic_query`; the
current chat connector advertises `project_name` and `name_pattern`. Inspect
the selected server's `tools/list` schema. The harness does not convert
natural-language task queries into regular expressions or assume one universal
contract.
