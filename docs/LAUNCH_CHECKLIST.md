# Satori Public Launch Checklist

Use this before publishing packages, updating the website, or launching on Product Hunt.

## Product Positioning

### One-liner
Satori gives MCP coding agents deterministic repo search, exact symbol reads, caller/callee context, and stale-index recovery before they edit.

### Product Hunt tagline
Repo retrieval for MCP coding agents.

### Short description
Satori is a read-only MCP server and installer that helps AI coding agents investigate real codebases before editing: semantic code search, exact symbol navigation, call graph context, bounded file reads, and explicit index lifecycle guidance.

### Who it is for
- Developers using Codex, Claude Code, OpenCode, or MCP-compatible agent workflows.
- Teams with repos too large or active to paste into a chat window.
- Agent users who want visible evidence before accepting edits.

### What to avoid claiming
- Do not claim Satori writes code or replaces tests.
- Do not claim static call graph references prove runtime or assertion coverage.
- Do not claim provider free tiers are guaranteed; provider allowances can change.

## Product Hunt Assets

- Product name: `Satori`
- Website URL: `https://hamza.my.id/satori/`
- GitHub URL: `https://github.com/ham-zax/satori`
- Tagline: `Repo retrieval for MCP coding agents.`
- Thumbnail/social image: `satori-landing/og-image.svg`
- Demo flow to show:
  1. Run `npx -y @zokizuan/satori-cli@0.4.2 install --client all`
  2. Run `npx -y @zokizuan/satori-cli@0.4.2 doctor`
  3. Index one repo with `manage_index action="create"`
  4. Search with `search_codebase`
  5. Open exact context with `file_outline`, `call_graph`, and `read_file`

## Maker Comment Draft

I built Satori because coding agents often start editing before they have enough repo evidence. Satori gives them a read-only MCP surface for searching code by intent, opening exact symbols, following caller/callee context, and detecting stale or unsafe index state.

The public setup path is installer-first: `satori-cli install --client all` writes managed config for supported clients and avoids resident `npx` startup latency. The MCP surface stays intentionally small: six tools, deterministic status, and no source-code write operations.

I would especially like feedback on install UX across MCP clients and whether the search -> outline -> graph -> read workflow matches how you actually want agents to investigate large repos.

## Pre-Launch Checks

- `pnpm install --frozen-lockfile`
- `pnpm run check`
- `pnpm --filter @zokizuan/satori-core test`
- `pnpm --filter @zokizuan/satori-core test:integration`
- `pnpm --filter @zokizuan/satori-mcp test`
- `pnpm --filter @zokizuan/satori-cli test`
- `pnpm run release:smoke:mcp`
- `pnpm run release:smoke:cli`
- `pnpm audit --prod --audit-level high`
- `pnpm audit --audit-level high`
- `pnpm -C packages/mcp docs:check`
- `pnpm -C packages/mcp manifest:check`
- `git diff --check`
- Smoke `satori-cli install --client all` in a temp home and confirm generated client config exposes runtime env names:
  - Codex: `env_vars` plus optional `[mcp_servers.satori.env]` template in `~/.codex/config.toml`
  - Claude Code: `mcpServers.satori.env` in `~/.claude.json`
  - OpenCode: `mcp.satori.environment` in `~/.config/opencode/opencode.json`

## Website Checks

- Landing page title and description mention MCP coding agents and repo retrieval.
- `/docs/` explains install, provider setup, first index, lifecycle states, warnings, and troubleshooting.
- `/architecture.html` explains installer-owned startup and the six-tool MCP boundary.
- `robots.txt`, `sitemap.xml`, Open Graph, Twitter card, and structured data are present.
- Product Hunt URL, GitHub URL, and install commands match current package versions.

## Launch-Day Runbook

1. Publish packages through the GitHub tag workflow when possible:
   ```bash
   git tag v0.5.1
   git push origin v0.5.1
   ```
2. Verify npm registry state:
   ```bash
   pnpm run release:verify
   ```
3. Deploy `satori-landing/` to the public site.
4. Open the public landing page and check:
   - install command is visible in the first viewport,
   - docs and architecture links work,
   - social metadata renders in a link preview debugger,
   - `robots.txt` and `sitemap.xml` are reachable.
5. Submit Product Hunt with the positioning above.
6. Monitor the first hour for:
   - npm install failures,
   - MCP startup issues,
   - docs confusion around provider setup,
   - Product Hunt comments asking for unsupported clients.

## Rollback

- Package release issue: deprecate the broken package version on npm and publish a patch.
- Website issue: redeploy the previous static site artifact or revert the docs commit.
- Product Hunt copy issue: update the description/comment in place and answer with corrected setup steps.
