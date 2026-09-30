# Real-repo search-quality check

Measures `search_codebase` (default `runtime` scope) on three pinned open-source repos using the
local workspace build (`packages/*/dist`), not an npm release. It records raw data (per-file parse
outcomes, index operation records, every status response, full top-10 results with query-plan
fields) and scores each query against the acceptable-owner sets in `cases.json`.

```bash
pnpm build                      # the check imports packages/*/dist
systemd-run --user --scope -p MemoryMax=4G -q node evals/real-repo-quality/run.mjs
# options: --repos react,polars,flatbuffers  --out DIR  --state-root DIR  --index-timeout-min N  --reuse-index
```

Requires the offline runtime installed (`satori install --runtime offline`): the script reuses the
model paths and provider settings from `~/.satori/bin/satori-mcp.js`, but runs the local MCP build
with its own state root (default `~/.cache/satori-eval-state`, models symlinked) and clones the repos
into `~/.cache/satori-eval-repos/<name>@<sha12>` (checks out the pinned commit and verifies it).
Results go to `~/.cache/satori-eval-results/<timestamp>/{result.json,summary.md}`, outside the repo.
The client drains the server's stderr; an undrained pipe blocks the index worker on exit.
