# Satori Documentation

Satori is a **local-first code-intelligence layer for developers and coding agents**. It lets an agent ask a repository question in natural language, find the relevant implementation through semantic + lexical evidence, and continue into exact source, symbols, references, structure, and conservative relationships. These docs are organized so you can first learn that workflow, then inspect architecture and operations when you need them.

## Start here

1. [`../README.md`](../README.md) — what Satori is, why you would use it, install, first repository, features, runtime choices, and measured evidence.
2. [`PRODUCT_GUIDE.md`](PRODUCT_GUIDE.md) — the guided product manual: mental model, example questions, repository-learning workflows, bug investigation, refactor planning, freshness, automatic maintenance, privacy, and FAQ.
3. [`../satori-landing/docs/index.html`](../satori-landing/docs/index.html) — public operational docs for setup, tools, lifecycle/status, troubleshooting, and runtime boundaries.

A useful mental model is:

```text
Repository -> Intelligence Database -> Ask -> Locate Owner -> Trace -> Read Exact Source
```

A **Publication** is Satori's immutable snapshot of everything it knows about one coherent repository generation.

## Learn the system

- [`PRODUCT_GUIDE.md`](PRODUCT_GUIDE.md) — best place to understand what Satori knows and how to use that intelligence in real coding workflows.
- [`architecture/LANGUAGE_INTELLIGENCE.md`](architecture/LANGUAGE_INTELLIGENCE.md) — current language-analysis backends, symbol/navigation capability boundaries, extension model, and qualified relationship semantics.
- [`../satori-landing/architecture.html`](../satori-landing/architecture.html) — public architecture overview for the repository-intelligence layers, Publications, local retrieval, freshness, mutation lifecycle, and shared runtime.

## Operate and ship it

- [`../satori-landing/docs/index.html`](../satori-landing/docs/index.html) — installation, repository profiles, MCP workflows, 11-tool reference, lifecycle states, debugging, and troubleshooting.
- [`../packages/mcp/README.md`](../packages/mcp/README.md) — package-focused MCP runtime documentation.
- [`RELEASING.md`](RELEASING.md) — release graph, qualification, npm authentication, publication, and registry verification.

## Current product contract

Satori's public MCP surface is exactly 11 tools:

`manage_index`, `search_codebase`, `architecture_overview`, `continue_search`, `call_graph`, `trace_path`, `find_references`, `detect_changes`, `file_outline`, `read_file`, and `list_codebases`.

The current product is organized around immutable Publications. A Publication binds semantic/lexical search evidence, symbol ownership, structural navigation, supported relationship evidence, source freshness, and repository policy into one generation. Readers bind to one Publication for a request; replacement work is prepared separately and activated only when it is complete enough to become current authority.

TypeScript, JavaScript, Python, Go, Java, C#, C++, Rust, and Scala expose production symbol navigation plus the current qualified `CALLS v0` slice. Relationship navigation is deliberately conservative and does not imply complete dynamic-dispatch or whole-program blast-radius proof.

Fresh managed local installs use Potion embeddings, BM25, LateOn reranking, and LanceDB on the qualified Linux x64 / WSL2 path. Ordinary source changes converge through sync. Rebuild-safe incompatibilities on the managed offline path can start or join background reindex maintenance automatically; explicit reindex remains the operator recovery override when automatic maintenance is unavailable, unsafe, or suppressed after failure.

## Historical engineering records

This repository also keeps detailed plans, research, reviews, and remediation evidence. They explain *why* Satori evolved, but they are not automatically current product instructions.

Treat these as historical unless a current document explicitly names one as authoritative:

- `plans/` — implementation plans and migration designs;
- `research/` — investigations, measurements, and external-source analysis captured at a point in time;
- `remediation/` — issue-specific remediation and qualification records;
- `superpowers/plans/` and `superpowers/specs/` — dated engineering design/execution artifacts;
- `superpowers/agent-plans/` — multi-agent coordination artifacts;
- `architecture/ownership-boundary-audit.md` — explicitly dated pre-clean-break architecture audit.

When a historical document conflicts with the current README, Product Guide, current source, current public docs, or current release tooling, prefer the current product surface.
