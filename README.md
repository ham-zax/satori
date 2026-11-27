<p align="center">
  <a href="https://satori.hamza.my.id"><img src="satori-landing/logo.svg" alt="Satori" width="88" height="88" /></a>
</p>

<h1 align="center">Satori</h1>

<p align="center">
  <strong>Local code search and navigation for coding agents.</strong><br />
  Ask where a behavior lives. Get the owning symbol, its relationships, and the exact source.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@satori-code/cli"><img src="https://img.shields.io/npm/v/@satori-code/cli?label=npm" alt="npm version" /></a>
  <a href="https://github.com/ham-zax/satori/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ham-zax/satori/ci.yml?branch=master&label=CI" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0 license" /></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/BENCHMARKS.md">Benchmarks</a> ·
  <a href="https://satori.hamza.my.id">Website</a>
</p>

<a id="start"></a>

## Install

**Requirements.** Node.js 22.22 or newer on Linux x64 or ARM64 with glibc, including WSL2. The default install downloads its models once, then runs offline with no model API key.

```bash
npx -y @satori-code/cli@latest install
npx -y @satori-code/cli@latest doctor
```

The installer detects **Codex, Claude Code, OpenCode, Cursor, VS Code, Windsurf, and Pi**. For Antigravity, use `install --client agy`. Restart your client after installation. See the [client setup reference](docs/REFERENCE.md#client-setup) for other MCP clients.

## Ask your first question

Open your coding agent in a Git repository and ask:

> Use Satori to find where authentication tokens are refreshed. Show me the owning function, its source, and one caller.

Small offline workspaces index in the background at startup. Larger eligible workspaces begin indexing on the first Satori query. To index the current Git repository during installation, add `--index`. [Indexing behavior and limits](docs/REFERENCE.md#index-lifecycle)

## What you can do

| Task | Example |
| --- | --- |
| Find unfamiliar behavior | “Where does the background worker decide to retry?” |
| Inspect an implementation | “Show the owning symbol and the code that validates that setting.” |
| Trace a change | “Which indexed callers reach this function, and what should I verify before changing it?” |
| Review a diff | “Map the changed lines to their symbols and identify likely affected callers.” |

Satori combines semantic search, BM25, and exact matches, then reranks candidates locally by default. Its MCP tools give agents bounded source reads, file outlines, and call navigation where language support is available. Graph edges are leads to verify in source and tests. [Language support](docs/REFERENCE.md#language-support)

Satori reads repository source and keeps its index local by default. Compatible local MCP sessions can share the same runtime and index. [Runtime and data handling](docs/REFERENCE.md#runtime-choices)

<a id="for-ai-agents"></a>

For agent setup and first-tool guidance, see [using Satori with an agent](docs/PRODUCT_GUIDE.md#ask-an-agent-to-use-satori).

## Benchmarks

Browse the [benchmarks](docs/BENCHMARKS.md) for measured agent discovery, retrieval quality, and indexing and navigation latency. Each comparison links to its setup and limitations.

## Documentation

- [Product guide](docs/PRODUCT_GUIDE.md) for finding owners, verifying call paths, and deciding when to use native tools.
- [Reference](docs/REFERENCE.md) for client setup, configuration, CLI and MCP commands, and troubleshooting.
- [Contributing](CONTRIBUTING.md), [local MCP development](docs/LOCAL_DEV_MCP.md), and [security reporting](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE). [Commercial licensing](COMMERCIAL-LICENSING.md) is available.
