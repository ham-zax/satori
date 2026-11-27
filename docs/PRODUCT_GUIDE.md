# Using Satori

Satori helps you locate the code behind a behavior and check the source before acting on it. For installation, start with the [README](../README.md#install).

## Find the owner of a behavior

Ask a question that describes what the application does.

> Where does the queue worker decide whether to retry a failed job? Show the code that owns that decision.

Start with `search_codebase`. For a plain-language question, add up to four grounded terms such as `retryPolicy` and `maxAttempts` when you have a reason to expect them in the code. Follow `recommendedNextAction` to open the source behind a promising result. Use `file_outline` when you need to distinguish similar declarations in one file.

Use native reads or exact search when you already know the path, symbol, or error literal. Use `architecture_overview` when you need a repository-wide view of areas and their relationships.

## Trace callers before editing

> Which code paths call this retry decision, and where do they get their attempt count?

From a graph-ready search result, pass its `target` to `call_graph` as `symbolRef`. Use `trace_path` when you already have both published symbol IDs and need one path between them.

Check important call sites in source and tests. The graph covers supported language patterns and can omit dynamic or ambiguous calls. Use `find_references` for ranking-independent textual occurrences, then inspect their context to tell calls from imports or other references.

## Review the impact of a diff

> Which functions does this working-tree change touch? Show the direct callers I should inspect and any relevant tests.

Use `detect_changes` to map changed lines to symbols and identify candidate callers. Read the Git diff and the relevant source before judging the impact. A small or empty call graph still leaves room for callers outside the indexed language or supported patterns.

## Keep the evidence current

Search results describe the indexed snapshot they came from. If Satori warns that changes are pending, read the current working tree before relying on a span or relationship. Use `manage_index` with `action="sync"` when you need updated indexed evidence after edits or ignore-rule changes.

When a tool reports background indexing, continue with native reads and retry after the interval it gives you. Avoid starting another index job for that repository. [Index lifecycle and troubleshooting](REFERENCE.md#index-lifecycle)

## Ask an agent to use Satori

The installer adds the shared `satori` skill by default. To make tool choice explicit for your team, add a short rule to the repository’s agent instructions:

> When you need to locate unfamiliar behavior or its owner, start with Satori’s `search_codebase` and follow `recommendedNextAction`. Use native tools for exact lookups or while the index is unavailable.

Claude Code installations also get a startup hook that reports whether the current repository is indexed. Codex users who have that hook installed can [reuse it in Codex](REFERENCE.md#optional-codex-sessionstart-hook).
