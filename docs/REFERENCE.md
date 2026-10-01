# Satori Reference

The complete product and operations reference. For the short introduction, see the [README](../README.md).

**Ask your codebase in natural language, then verify the answer in real source.**

Satori is a **local-first code-intelligence layer** for coding agents. Ask where behavior lives in plain English, even when you do not know the filename or symbol yet. Satori combines semantic meaning with BM25 and exact lexical evidence, maps results back to owning symbols, and lets the agent continue into file structure, conservative relationship evidence, exact source spans, and freshness-aware navigation through MCP.

On the qualified Linux x64 / WSL2 path, the default managed runtime keeps that retrieval stack local with Potion embeddings + BM25 + LateOn reranking + LanceDB. No model API key is required for the offline path after installation. The installer configures Codex, Claude Code, and OpenCode, plus Antigravity (`agy`) on request.

```text
Repository
   |
   v
semantic + lexical evidence
   + symbols + structure
   + supported relationships
   + source freshness
   |
   v
Ask -> locate owner -> trace -> read exact source
```

Satori's MCP tool surface does **not** expose source-code write commands. It manages its own index/runtime state and supported client configuration; your coding agent or editor owns source changes.

## 30-second example

You open an unfamiliar repository and ask:

```text
Where is refresh-token rotation implemented, what owns it,
and what exact code should I inspect before changing it?
```

Instead of repeatedly guessing filenames and dumping large files, an agent can use Satori to:

1. search by intent and exact evidence;
2. resolve relevant matches to owning symbols;
3. inspect the structure of the owning file;
4. follow supported callers/callees when useful;
5. read the exact symbol or bounded source span;
6. see whether that evidence is current, stale, or under maintenance.

That evidence funnel is the product.

## What can you ask Satori?

```text
Where is authentication refresh handled?

What owns index publication?

Find the code responsible for automatic reindexing.

Where does this user-facing error originate?

Which code handles this configuration setting?

Show me the structure of this file without dumping the whole file.

What directly calls this symbol?

What code should I inspect before changing this subsystem?
```

You do not need to know the correct filename or identifier before you start.

## What Satori knows about a repository

A Satori Publication is an immutable snapshot of everything Satori knows about one coherent repository generation. That knowledge includes:

| Intelligence layer | What it gives the agent |
|---|---|
| Semantic embeddings | Find behavior by meaning when identifiers are unknown |
| BM25 + exact evidence | Preserve symbols, paths, config keys, errors, and literal clues |
| Symbol ownership | Map matching evidence back to functions, methods, classes, and supported owners |
| Parser-derived structure | File outlines and exact source spans without reading whole files first |
| Relationship evidence | Conservative callers, callees, imports, and exports where supported |
| Source checkpoints | Know whether indexed evidence still matches the repository |
| Index policy | Know what files/extensions/ignore rules belong to the Publication |
| Publication generations | Keep search, navigation, relationships, and freshness on one coherent state |

## Why developers use it

- **Learn unfamiliar codebases.** Ask where behavior lives before learning the repository tree by hand.
- **Investigate bugs.** Move from a symptom or error string to the owning implementation and related evidence.
- **Plan refactors.** Inspect the owner, nearby structure, exact source, and supported relationships before the first change.
- **Reduce context waste.** Prefer symbol-sized evidence and bounded source over broad repository/file dumps.
- **Help smaller/local models.** Spend scarce context on the code that matters rather than on discovery.
- **Give multiple agents one local intelligence runtime.** Compatible local sessions can share the managed runtime and repository intelligence.
- **Keep repository intelligence current.** Ordinary edits converge through sync; managed offline rebuild-safe incompatibilities can reindex automatically instead of making the user babysit the index.

## Features

### Hybrid repository search

Semantic retrieval finds concepts; BM25 and exact evidence keep literal code facts precise. Owner-oriented grouping reduces duplicate chunk noise.

### Structure, navigation, and exact source

TypeScript, JavaScript, Python, Go, Java, C#, C++, Rust, and Scala have production symbol navigation plus the current qualified `CALLS v0` slice. `file_outline` exposes structure; `read_file` opens an exact indexed symbol or bounded source range.

### Conservative relationship navigation

Satori prefers missing evidence over invented certainty. Call-graph results are navigation leads, not compiler-grade whole-program blast-radius proof.

### Freshness and self-maintenance

Satori tracks repository source checkpoints, prepares replacement Publications atomically, and distinguishes fresh, changed, unverified, indexing, and rebuild-required states. On the managed offline path, rebuild-safe incompatibilities can automatically start or join one background reindex. Connected/remote and failed/unsafe recovery remains explicit.

### Local-first runtime

The default Linux x64 / WSL2 path runs Potion embeddings, BM25, LateOn reranking, and LanceDB locally. Connected Voyage and Milvus/Zilliz remain optional advanced configurations.

### Shared managed runtime

Compatible Codex, Claude Code, OpenCode, and subagent sessions can attach to one private local Satori host instead of starting one heavy provider/index stack per session.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/architecture/satori-architecture.dark.png">
  <img alt="Satori architecture: agent queries flow through MCP tools into candidate search (Potion vectors + BM25), reciprocal rank fusion, LateOn reranking, and owner-symbol grouping over one pinned LanceDB index version; background workers scan changed files, build the next index, and publish it atomically." src="./docs/architecture/satori-architecture.light.png">
</picture>

- **Search path (read-only):** dense and BM25 candidates merge through reciprocal rank fusion, LateOn rescores a bounded top set, and matching chunks resolve to their owning symbols.
- **Index version:** one complete snapshot of vectors, symbols, and call edges. Each request stays pinned to one version; a new version goes live only when complete.
- **Background indexing:** supervised workers hash only changed files and build the next version off the request path.

Interactive diagram: [`docs/architecture/satori-architecture.html`](./architecture/satori-architecture.html) (source: [`satori.architecture.json`](./architecture/satori.architecture.json), rendered with Archify).

## Documentation

- [`docs/PRODUCT_GUIDE.md`](./PRODUCT_GUIDE.md) — how to think about Satori and use it for repository learning, debugging, refactors, local models, and multi-agent work.
- [`satori-landing/docs/index.html`](../satori-landing/docs/index.html) — complete operational setup, tool, lifecycle, and troubleshooting reference.
- [`satori-landing/architecture.html`](../satori-landing/architecture.html) — Publication, retrieval, navigation, freshness, and runtime architecture.
- [`docs/architecture/LANGUAGE_INTELLIGENCE.md`](./architecture/LANGUAGE_INTELLIGENCE.md) — language backends and relationship capability boundaries.
- [`docs/RELEASING.md`](./RELEASING.md) — release qualification and publication workflow.
- [`docs/improvements/`](./improvements/README.md) — evaluated but deferred proposals.
- [`docs/evidence/`](./evidence/) — raw benchmark results, the CBM language-parity run that gates symbol-only languages, and the security findings registry checked by `pnpm findings:check`.

## Install

Requirements: Node.js 22.13+, Linux x64 (native Linux or WSL2), and at least
2 GiB of available runtime capacity for the qualified native deployment
envelope. The capacity figure is an allowance, not measured steady
consumption.
The recommended first run needs no global install:

```bash
npx -y @satori-code/cli@latest install
npx -y @satori-code/cli@latest doctor
```

For a persistent `satori` command, install the lightweight CLI globally and use
the same flow without the `npx` prefix:

```bash
npm install -g @satori-code/cli@latest
satori install
satori doctor
```

`install` auto-detects supported Codex, Claude Code, and OpenCode clients from
their documented local markers or CLI executables. `--client auto` is the
explicit equivalent. Antigravity (`agy`) is opt-in: use `--client agy`, or
`--client all` to configure every supported client.
If no supported client is detected, Satori stops before runtime installation and
shows explicit client commands. `satori uninstall` defaults to all supported
clients; use `--client auto` to limit cleanup to currently detected clients.

Run `satori` without arguments at any time for human-readable help.
Use `satori -v` to print the installed CLI, MCP runtime, and Core versions.

Agents receive Satori guidance in two native ways, with nothing injected per
tool call:

- the Satori MCP server sends short tool guidance once per session through the
  MCP `instructions` field, which Codex, Claude Code, and OpenCode load natively;
- one canonical `satori` skill is installed at `~/.agents/skills/satori`. Codex
  and OpenCode load it directly; Claude Code gets a link to it at
  `~/.claude/skills/satori`.

Install adds nothing to `AGENTS.md` or hook files, and it never removes or
overwrites files it did not write: a real directory at a skill-link path is
refused with instructions to remove it yourself. `satori uninstall` removes the shared skill only when it targets
all clients (the default).

Restart your coding agent and tell it:

```text
Index /absolute/path/to/repo with Satori, then find where auth refresh is handled.
```

That is the complete local path. Satori installs a stable launcher under `~/.satori/`; your agent does not download the server again on every startup.

On Linux x64 and WSL2, the default offline Potion + LanceDB runtime uses LateOn
D128 as its query-time reranker and is shared
behind that launcher. Multiple compatible Codex, Claude Code, OpenCode, or
subagent sessions attach as independent MCP sessions to one private local host,
shared provider/LanceDB state, and one Potion worker. The host uses a user-only
Unix-domain socket, idles out after clients disconnect, and is not used for
connected Voyage/Milvus or explicit Ollama runtimes.

To stop every verified Satori MCP runtime under the active state root:

```bash
satori terminate
```

The command shuts down registered servers and their provider workers without
removing client configuration, indexes, or installed packages.

Upgrade the installed CLI, MCP runtime, and its compatible Core dependency:

```bash
satori upgrade
```

If you do not keep the
CLI installed globally, run the same release flow through the latest CLI:

```bash
npx -y @satori-code/cli@latest upgrade
```

Satori reports each potentially slow phase as it works:

```text
Checking latest Satori release...
Installing MCP <version> and Core <version>...
Verifying candidate runtime...
Activating verified runtime...
```

The CLI is updated first. Satori then stages and verifies the exact MCP/Core runtime before switching the stable launcher. If runtime verification fails, the updated CLI remains installed and the managed launcher is left unchanged; correct the reported problem and run `satori upgrade` again. Restart running coding agents after a successful runtime upgrade. The command does not rewrite client configuration, indexes, hooks, or repository profiles.

An upgrade follows one coordinated release closure declared by the latest CLI package. It does not independently combine the newest CLI, MCP, and Core versions. This keeps every activated runtime on an exact, tested MCP/Core pairing.

For other no-install commands, replace `satori` with `npx -y @satori-code/cli@latest`.

## First five minutes

### 1. Create the repository intelligence database

The first index is explicit: Satori will not silently decide to ingest an arbitrary workspace. Tell your coding agent:

```text
Index /absolute/path/to/repo with Satori.
```

Full creation runs in the background. Once the Publication is ready, the repository has a durable intelligence layer the agent can query.

### 2. Ask for behavior, not filenames

```text
Use Satori to find where auth refresh is handled,
identify the owner, and show me the exact implementation to inspect first.
```

### 3. Follow the evidence funnel

```text
search_codebase
    -> owner-oriented result
    -> architecture_overview when repository-wide context is useful
    -> file_outline / call_graph when useful
    -> read_file for exact proof
    -> continue_search only if the frozen result has more useful evidence
```

You normally do not need to orchestrate these tools manually. They are the 11 MCP primitives your coding agent uses to interrogate the repository intelligence layer.

## How Satori changes the workflow

| Without a repository intelligence layer | With Satori |
|---|---|
| Guess filenames and repeat broad searches | Ask where behavior lives in plain English |
| Read large files to reconstruct ownership | Open an exact symbol or bounded source span |
| Lose literals in semantic-only search | Combine semantic, BM25, path, symbol, and exact evidence |
| Rebuild a mental map in every session | Reuse persistent Publication-backed repository intelligence |
| Work from an index that may have drifted | Carry explicit source freshness and maintenance state |
| Assemble relationships from scattered reads | Follow conservative owner-oriented navigation evidence |

## Where it earns its keep

### Unfamiliar codebases

Use Satori as the first map. Ask what owns a behavior, inspect the file structure, then open the implementation rather than browsing the tree at random.

### Bug investigation

Start from a symptom, error string, or behavior description and move toward the owning source. Use supported relationships as leads, not as a substitute for compiler/test/runtime proof.

### Refactor and feature planning

Find the owner and exact source before proposing a change. Inspect nearby symbols and qualified call evidence when they materially affect scope.

### Smaller and local models

Use a strict retrieval funnel—search, owner, outline, exact span—so limited context is spent on implementation rather than repository discovery.

### Multi-agent work

Compatible local sessions can share the managed runtime and current repository intelligence while keeping their MCP sessions independent.

## The index maintains itself where it safely can

Satori distinguishes ordinary source drift from states that need a full rebuild:

- **ordinary edits:** incremental sync prepares a replacement Publication;
- **compatible completed Publication + sync running:** reads can continue from the proven generation with freshness metadata;
- **managed offline rebuild-safe incompatibility:** Satori automatically starts or joins one background reindex and returns deterministic `not_ready` / `indexing` state for retry;
- **connected/remote, unsafe, or failed automatic recovery:** explicit `manage_index reindex` remains the operator override;
- **clear:** always explicit.

This keeps routine local reindex maintenance out of the user's way without hiding cases where a rebuild can have operational or provider-cost consequences.

<details>
<summary><strong>Benchmark: Satori versus codebase-memory-mcp</strong></summary>

## Measured on Satori

Measured with the repository's own benchmark script; raw results are committed.

### Satori versus codebase-memory-mcp

Five pinned repositories, two sequential runs each, measured with `scripts/bench-vs-cbm.mjs` against codebase-memory-mcp 0.11.0 on the same machine (Satori `52b59d76`, offline Potion + LanceDB + LateOn). Ranges are the two runs; 20 unique called functions per repository.

| Repository | Index (Satori / CBM) | Symbol lookup p50 | Callers p50 | One-file edit (Satori sync / CBM reindex) |
|---|---:|---:|---:|---:|
| satori (TypeScript) | 76–77 s / 20 s | 39–50 / 31 ms | 46–61 / 21 ms | 20–27 s / 13 s |
| trufflehog (Go) | 67–71 s / 9–10 s | 59–65 / 19 ms | 64–69 / 16 ms | 15–16 s / 23–27 s |
| ripgrep (Rust) | 9.3–9.4 s / 2.7–4.6 s | 14–16 / 13 ms | 141–147 / 12 ms | 2.2 s / 2.1–2.6 s |
| kotlinpoet (Kotlin) | 7.8–8.1 s / 2.6–2.7 s | 18–19 / 13 ms | 181–183 / 12 ms | 2.6–3.1 s / 2.2 s |
| fastapi-template (Python + TS) | 6.5 s / 2.1–2.2 s | 16 / 12 ms | 206–207 / 12 ms | 3.8–4.0 s / 2.0 s |

Satori found a same-name definition in the defining file for 80–100% of lookups, and its file outlines covered 76–100% of CBM's definitions in 30 sampled files per repository. Satori indexes slower because it also builds embeddings, a vector index, and publication proofs; CBM builds a graph only. Satori's peak RSS during indexing was 1.2–3.1 GB (whole process tree) versus 0.1–2.2 GB for CBM's shared daemon. Satori's index timings agreed within 10% across runs; CBM's shared-daemon timings and Satori's edit sync on two repositories did not, so treat those as indicative. Raw results: [`docs/evidence/benchmarks/2026-09-28-final.json`](./evidence/benchmarks/2026-09-28-final.json).

</details>

## Runtime Choices

| Runtime | Retrieval | Storage | Requirement |
|---|---|---|---|
| Offline | Potion Code 16M v2 + BM25 | LanceDB | Linux x64; no model API key |
| Connected | Voyage Code 3 + BM25 | LanceDB | `VOYAGEAI_API_KEY` |
| Ollama | selected Ollama model + BM25 | LanceDB | local loopback Ollama |
| Connected Milvus | Voyage Code 3 + BM25 | Milvus or Zilliz Cloud | `VOYAGEAI_API_KEY`, `MILVUS_ADDRESS` (plus `MILVUS_TOKEN` for Zilliz) |

Connected install:

```bash
satori install --client all --runtime voyage
satori doctor
```

`satori doctor` prints an applied-runtime table for Codex, Claude Code, and
OpenCode. Each row shows whether that client is configured, its effective
profile, embedding provider/model/dimension, reranker, vector store, and whether
the values come from the managed launcher or client config. Credentials and
local artifact paths are never included in the table. This also works when the
managed launcher temporarily points at a local repository build; doctor keeps
the outside-managed-store warning while reporting the profile the launcher
actually applies.

For Milvus or Zilliz Cloud, add `--vector-store milvus` to a Voyage install; the launcher then sets `VECTOR_STORE_PROVIDER=Milvus`, which the runtime requires (`MILVUS_ADDRESS` alone does not select Milvus). For Ollama embeddings, select an explicit model:

```bash
satori install --client all --runtime offline --ollama-model nomic-embed-text
```

Changing the embedding provider, model, dimensions, vector backend, or persisted projection changes index compatibility and requires a reindex. Satori never silently converts or deletes the previous backend's publication.

### Test the repository runtime locally

From a Satori checkout, the development installer builds the local Core, MCP,
and CLI packages, preflights the MCP runtime, updates the selected clients, and
points the stable launcher at this checkout. It does not install or replace the
globally published CLI.

```bash
pnpm dev:install-local-mcp -- --client opencode --runtime offline --reranker lateon
```

That exact command selects OpenCode, local Potion embeddings, LanceDB, and the
LateOn reranker. Restart OpenCode after changing the launcher.

| Development option | Supported values and constraints |
|---|---|
| `--client` | `opencode` (default), `codex`, `claude`, or `all` |
| `--runtime` | `offline` or `voyage`; when omitted, preserve the managed selection, or use offline for a new launcher |
| `--reranker` | `lateon` or `none`; offline only |
| `--ollama-model` | Selects an Ollama model instead of Potion; offline only |
| `--vector-store` | `lancedb` or `milvus`; offline requires LanceDB and Milvus requires Voyage |
| `--no-build` | Reuse the existing local build output |
| `--home`, `--node` | Override the managed home or Node executable for isolated testing |

Useful local combinations:

```bash
# Offline Potion + LanceDB + LateOn
pnpm dev:install-local-mcp -- --client opencode --runtime offline --reranker lateon

# Offline Potion + LanceDB without neural reranking
pnpm dev:install-local-mcp -- --client opencode --runtime offline --reranker none

# Offline Ollama + LanceDB
pnpm dev:install-local-mcp -- --client opencode --runtime offline --ollama-model nomic-embed-text --reranker none

# Connected Voyage + LanceDB or Milvus
pnpm dev:install-local-mcp -- --client opencode --runtime voyage --vector-store lancedb
pnpm dev:install-local-mcp -- --client opencode --runtime voyage --vector-store milvus
```

To stop testing the checkout and restore OpenCode to the current published
runtime, run the published installer again. The explicit form below also
restores the same offline Potion + LateOn selection used in the first example:

```bash
npx -y @satori-code/cli@latest install --client opencode --runtime offline --reranker lateon
npx -y @satori-code/cli@latest doctor
```

If the latest CLI is already installed globally, the equivalent first command
is `satori install --client opencode --runtime offline --reranker lateon`.
Restart OpenCode after restoring the published runtime.

## MCP Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Manage the repository-intelligence Publication: create the first index, synchronize source changes, inspect readiness, cancel a live supervised create/reindex/sync operation by exact operation ID, recover with reindex, or clear index state. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance; explicit reindex remains the operator recovery override. |
| `search_codebase` | Search the repository-intelligence Publication with semantic, lexical, and exact evidence and return owner-oriented results. Start here for behavior, ownership, configuration, or path discovery. |
| `architecture_overview` | Summarize bounded Publication architecture evidence as logical areas, cross-area boundaries, and hotspots. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. |
| `file_outline` | List the indexed symbols and spans in one file. Use it to choose an exact owner before reading implementation. |
| `call_graph` | Inspect advisory callers, callees, imports, and exports when supported. Verify inbound leads before blast-radius changes. |
| `trace_path` | Find one bounded shortest path between exact published symbols over selected persisted relationships, with scope and truncation evidence. |
| `find_references` | Scan validated published source for ranking-independent exact textual occurrences of one canonical symbol, with exact spans and coverage evidence. |
| `detect_changes` | Map a Git diff to current indexed symbol seeds and bounded transitive callers for change orientation. |
| `read_file` | Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods. |
| `list_codebases` | List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one. |

Public paths are absolute. `read_file` is restricted to tracked searchable roots; it is not a general host-filesystem reader.

## Recommended Agent Workflow

```text
1. search_codebase for behavior or ownership
2. use architecture_overview when you need repository-wide areas, boundaries, or hotspots
3. follow recommendedNextAction when returned
4. use file_outline to inspect one file's owners
5. use call_graph or trace_path for bounded relationship context
6. use find_references when you need ranking-independent exact textual occurrences
7. use read_file for exact proof
8. use continue_search only when the frozen result has more useful evidence
```

When a tracked Publication becomes incompatible with a managed offline runtime, Satori automatically starts or joins one background reindex and returns `not_ready`/`indexing` so the caller can retry without asking the user to repair the index. Full create/reindex candidate construction runs in a supervised child process group with no-progress and cancellation handling, so a compiler/parser crash is contained to that mutation and a previous completed Publication remains current until a replacement is activated. Automatic maintenance retries transient external/worker failures with bounded exponential backoff; deterministic configuration/incompatibility failures, resource limits, and cancellation remain suppressed until relevant state changes or a successful manual create/reindex supersedes them. Use `sync` for ordinary source changes when refreshed indexed evidence is needed. Search and navigation do not wait for a same-root sync: when a compatible completed Publication exists, they continue from that pinned generation with stale/unverified provenance and pending-sync metadata. Create/reindex operations that do not expose a readable generation still return `not_ready` with the active operation so drivers can retry deterministically. Optional semantic-provider failure does not have to discard a searchable Publication: persisted provider coverage marks the affected call graph `degraded` or `unavailable` instead of claiming complete relationship coverage. For grouped pagination, `limit` bounds the frozen result set across every page and `disclosureLimit` controls only the initial page: `limit=20, disclosureLimit=6` returns up to six initially and freezes up to twenty. Search continuation `"complete"` means complete for that caller-bounded frozen set, never for the full available pool; `omittedBeyondLimitGroupCount` reports groups excluded by `limit`. Treat inbound call-graph results as leads to verify, not compiler-grade blast-radius proof.

## Index Profiles

Install with `--profile default|minimal|all-text` to write repository policy to `satori.toml`:

```toml
[index]
profile = "minimal"
```

| Profile | Includes |
|---|---|
| `default` | Every file type in the [language catalog](#language-support), plus documentation, config, scripts, infrastructure files, queries, and known extensionless files. CSV, patches, SVG, gettext catalogs, and `.env` files are left to `all-text`. |
| `minimal` | Source (including every navigation language's extensions) and documentation text. |
| `all-text` | `default` plus additional bounded UTF-8 text files. |

Every profile honors `.satoriignore`, `.gitignore`, and the hard denylist for secrets, dependencies, generated output, lockfiles, binaries, logs, databases, bundles, source maps, and snapshots. Git ignore files (`.git/info/exclude`, the root `.gitignore`, then nested `.gitignore` files, parent before child) apply first, and `.satoriignore` is applied last so its rules, including `!` re-includes, override them. The hard denylist cannot be re-included by any `!` rule, and it matches directory names such as `build`, `out`, `target`, `tmp`, and `logs` at any depth. Profiles control what is indexed; `search_codebase` still defaults to implementation-first `scope="runtime"`.

## Configuration

The installer owns the launcher and non-secret runtime identity. Provider credentials remain in the MCP client's environment.

Common variables:

```text
SATORI_RUNTIME_PROFILE
VECTOR_STORE_PROVIDER
LANCEDB_PATH
EMBEDDING_PROVIDER
EMBEDDING_MODEL
EMBEDDING_OUTPUT_DIMENSION
VOYAGEAI_API_KEY
SATORI_RERANKER_PROVIDER
SATORI_LATEON_MODEL_PATH
SATORI_LATEON_PROFILE
SATORI_LATEON_ACTIVATION_POLICY
MILVUS_ADDRESS
MILVUS_TOKEN
```

Run `doctor` after changing runtime configuration. Restart every Satori MCP client before mutating an index under a new provider, model, backend, dimension, or package version; incompatible live runtime owners are blocked instead of racing one publication. Mutation ownership is scoped to the backend authority root: each LanceDB state root carries its own owner registry, and Milvus runtimes are keyed by endpoint, so isolated state roots do not block one another.

## How Publication Works

Satori stores each index generation as one immutable Publication. A complete Publication owns the vector collection, navigation, selection policy and format identity, source checkpoint, and persisted semantic-provider coverage for that generation. Readers pin one Publication for the lifetime of a request; activation makes a replacement Publication current, while failed candidate work leaves the active Publication unchanged. Full-index candidates also have durable receipts before vector collection creation. If a process dies mid-build, the next same-root create/reindex can prove and reclaim an unreferenced orphan candidate instead of leaking an unmapped collection.

Incremental synchronization scans for source changes, embeds changed chunks only, updates navigation and relationship evidence, and activates the complete replacement Publication. Ordinary source divergence converges through `sync`. Search admission is bounded before pathological source files can exhaust the worker: individual searchable sources are capped at 8 MiB and aggregate searchable source bytes at 512 MiB per full Publication; the aggregate limit produces a truthful partial `limit_reached` Publication. TypeScript compiler-backed semantics have separate 4 MiB per-source and 64 MiB per-project budgets, so semantic over-budget cases leave search available while call-graph coverage becomes unavailable. Managed offline runtimes automatically rebuild a tracked Publication when the current format/runtime identity or runtime policy requires a full reindex; corrupt or unsupported authority still fails closed for explicit operator recovery. Satori does not expose a force-unlock or salvage retired authority formats into the current Publication model.

## Offline Local Reranking

Offline install defaults to reranking eligible candidates with the Apache-2.0
`lightonai/LateOn-Code-edge` FP32 ONNX checkpoint under the managed v6 D128
profile. Its rerank document projection is projection-v5, including bounded,
source-validated textual references distinct from proven callers. The profile pins the
model, artifacts, projection, candidate depth, and sequential CPU execution
semantics without encoding machine-speed assumptions such as queue wait,
scoring latency, or a fixed CPU thread count. Model weights are not bundled in
each versioned MCP runtime. The CLI downloads the roughly 72 MB pinned closure
once into `~/.satori/models/`, verifies every artifact, and reuses it across
upgrades.

The default Potion embedding model (`minishlab/potion-code-16M-v2`, about
32 MB) is acquired the same way; the runtime package ships only its native
helper. Model downloads show progress, resume after an interruption, retry
transient failures, and replace a corrupt cached copy automatically. Set
`HF_ENDPOINT` to use a Hugging Face mirror. `satori uninstall --purge` removes
the model cache together with the runtime and indexes. A managed LateOn install bound to an older profile is refused with a
reinstall instruction; it is not migrated. Disable neural reranking explicitly with:

```bash
satori install --runtime offline --reranker none
```

`--reranker none` is the explicit opt-out: it keeps the selected embedding
provider plus baseline ordering (exact + BM25 + single vector). With Ollama
embeddings that is the Ollama model plus baseline ordering, not "Potion +
BM25". The runtime also falls back to that baseline automatically on any LateOn
failure; automatic failure fallback and explicit opt-out are different
concepts.

Direct MCP runtimes can select the same reranker with:

```text
SATORI_RERANKER_PROVIDER=lateon
SATORI_LATEON_MODEL_PATH=/absolute/path/to/LateOn-Code-edge
```

The current managed profile is:

```text
SATORI_LATEON_PROFILE=lateon_offline_quality_projection_v6_d128_v1
SATORI_LATEON_ACTIVATION_POLICY=lateon_context_v6_d128_owner_default_v1
```

Any other LateOn profile ID is rejected and cannot execute; reinstall the
managed runtime to bind v5. One local
LateOn worker serves overlapping searches through a FIFO queue instead of
falling back merely because another search is already reranking. Cancellation,
a genuine worker/output failure, or the hard safety ceiling restores the
frozen baseline retrieval order for that request.

Projection-v4 rerank context sends the exact question once plus a
positive-only answer-type line (the implementation focus never names
competing artifact classes), and each projected document is a bounded answer
packet: factual `candidate_role` derived from path classification plus trusted
structural context (direct callers, callees, and supporting tests resolved to
exact instance identities in the same sealed navigation generation; sorted and
capped; never a preference value). The reranker's published order remains
final: Satori applies no ranking weights, score multipliers, or global
test/documentation penalties. When only some candidates project, Satori
reranks the projectable ones, keeps the failed candidate in its retrieval
slot, and reports `RERANKER_INPUT_DEGRADED`; when none project, it skips the
provider, preserves retrieval order, and reports `RERANKER_SKIPPED_INPUT`
instead of `RERANKER_FAILED`.

The runtime verifies the pinned revision's artifact digests before use, performs
ONNX inference in a killable child process, and preserves the complete
deterministic baseline when model loading, scoring, validation, or the request
deadline fails. Projection profiles freeze model, projection, depth, thread,
and batching behavior. A terminal rerank
execution reports qualified diagnostics — attempts, retries, timeouts, the
effective deadline, observed wall time, and deadline lateness — alongside the
frozen retrieval order. The resulting effective profile remains part of the
shared-runtime and frozen-result identity.

LateOn is query-time ranking evidence only. It does not control candidate
eligibility, source freshness, publication authority, or baseline search
availability.

Grouped search results carry no `score`; the returned sequence is the final
relevance order. Request `includeResultIndex` when an explicit authoritative
rank is needed.

## Language Support

Search and bounded reads work across the indexed text and language catalog. Rich symbol navigation depends on parser evidence. TypeScript, JavaScript, Python, Go, Java, C#, C++, Rust, and Scala expose production `CALLS v0` when the current Publication has compatible relationship navigation. Resolved test-reference navigation remains limited to the languages whose test-reference capability is separately qualified, including TypeScript, JavaScript, Python, and Go. Python and Go additionally expose on-demand `file_outline(detail="analysis")` structural metrics for exact functions and methods. TypeScript, JavaScript, and Scala use Satori's syntax/name-based advisory resolver; Scala v1 admits only direct non-member calls with a unique indexed target, while member/dynamic dispatch remains outside the claim. The CBM-backed languages use conservative direct-call slices: Go excludes receiver/type, embedded/interface dispatch, callbacks/callable aliases, and unknown strategies; Java and C# admit exact static bindings only within the same detected build root (Maven/Gradle or `.csproj`), falling back to the same source directory when no manifest establishes broader authority, and exclude receiver dispatch; C++ currently admits exact same-translation-unit direct calls and rejects unproved cross-translation-unit or conditional-preprocessor cases; Rust requires Cargo package ownership and rejects receiver dispatch plus unmodeled `cfg`-dependent sources. Inspect `manage_index status` instead of assuming every indexed language is graph-ready.

Python inbound relationships are qualified for bounded static patterns,
including absolute-import constructor receivers and direct service or callback
value-origin flow. Reflection, arbitrary factories, collections,
monkeypatching, unbounded aliases, and ambiguous environments remain outside
that model. Individual edges may be exact under the supported model, but the
inbound result set remains non-exhaustive and absence still requires
deterministic verification.

Structural definition coverage is intentionally language-specific:

| Analyzer | Proven definition coverage |
|---|---|
| TypeScript / JavaScript | Classes, functions, methods, interfaces, types, enums, module variables, plus TypeScript namespaces and declaration-only signatures |
| Python | Classes, functions, methods, and direct module bindings |
| Go | Functions, methods, structs, interfaces, and named types |
| Rust | Modules, traits, structs, enums, functions, methods, type aliases, unions, and macros |
| Java | Classes, interfaces, enums, constructors, and methods |
| C# | Namespaces, classes, interfaces, structs, enums, constructors, and methods |
| C++ | Namespaces, classes, structs, enums, unions, typedefs/types, and callable declarations or definitions |
| Scala | Packages, classes, traits, objects, enums, types, functions, methods, and named package-level vals, vars, or givens |

Kotlin and PHP take their symbols from the CBM definition extractors below and add conservative `calls_v0` call graphs from CBM's semantic resolvers: exact package, import, and companion calls in Kotlin; `use`, namespace, global, and explicit `Class::method()` calls in PHP. Receiver dispatch abstains in both.

Eighty-eight more languages are **symbol-only**, including Swift, Ruby, Dart, Elixir, Erlang, Haskell, Lua, Perl, R, Zig, Julia, OCaml, F#, Clojure, Groovy, Solidity, Crystal, Odin, Hare, Verilog/VHDL, Bash/Fish/PowerShell, and build files (CMake, Makefile, Bazel/Starlark, justfile). Their definitions, owners, `file_outline`, and exact symbol search come from codebase-memory-mcp's own definition extractor, compiled per language to WebAssembly; they have no call graph. A language is promoted only after Satori reproduces the definitions of the codebase-memory-mcp binary (recall and precision ≥ 0.95 on CBM's per-grammar fixtures plus pinned public repositories; see [`docs/evidence/language-parity/`](./evidence/language-parity/)). Names and spans follow CBM, so overloads and multi-clause functions are listed once per clause, and some definitions span only their value (R `f <- function() …`).

Twenty-nine of the 89 extractors (Kotlin and PHP among them) ship inside the npm package. The other sixty are an extended pack (about 100 MB) that `satori install` downloads from [`zokizuan/satori-cbm-extractors`](https://huggingface.co/zokizuan/satori-cbm-extractors) at a pinned revision and verifies file by file, eight files at a time (resume, retry, and `HF_ENDPOINT` mirrors work as for the embedding model). If that download fails, installation still succeeds with a warning, and those languages stay searchable but report `structural_evidence_unavailable` until a later install fetches the pack.

Every other language in the catalog is search-only: its files are indexed for semantic search and bounded reads, with no symbols, outline, or call graph. The catalog follows codebase-memory-mcp's extension and filename table (about 140 languages in all; search-only ones include Vue, Svelte, HTML, CSS, SQL, and XML). Scripts with an unrecognized or missing extension are routed by their shebang (`python`, `node`, `bash`/`sh`, `zsh`, `ruby`, `perl`, `php`, `lua`), and `.m` files are classified as Objective-C, Magma, or MATLAB by content. Other files outside the catalog are skipped under the `default` and `minimal` profiles; `all-text` indexes any bounded UTF-8 file as plain text. `manage_index status` reports each indexed language's effective capabilities.

`.c` and `.h` files currently use the C++ parser for a proven common-C subset; Satori does not claim a native C parser or independent C type system. `CALLS v0` for that routed subset is limited to exact same-translation-unit direct bindings that survive the C++ semantic gate.

## Privacy and Limits

- Offline Potion embedding, LanceDB storage, search, and runtime telemetry make no network requests after installation.
- Connected providers receive the projected embedding or reranking input required for their service.
- Satori does not edit repository source.
- Local diagnostics exclude source, queries, paths, symbols, and repository identifiers and are never uploaded by Satori.
- Native Windows and macOS are not supported in this release. On Windows, run Satori inside WSL2.
- The relationship graph is conservative navigation evidence, not a full static-analysis proof.

## Breaking changes (next major)

This release removes support for every earlier on-disk format, config shape, CLI flag, environment variable, and install artifact. There is no migration and nothing is deleted for you: old state is refused with a message naming the single fix.

After upgrading, do both of these:

1. **Reinstall** the managed runtime: `satori upgrade` (or `npx -y @satori-code/cli@latest upgrade` without a global CLI), then `satori install ...` again for your client. Restart every MCP client afterward. Managed LateOn installs must be reinstalled with `satori install --runtime offline --reranker lateon`, or with `--reranker none` to disable LateOn.
2. **Reindex** every repository with `manage_index` `action="reindex"`. An index written by an older release is reported as `requires_reindex`; the old generation is left on disk and never parsed, migrated, or deleted.

Removed, and what you will see:

| Removed | What happens now |
|---|---|
| Publication v1, `package_ownership_v1`, `symbol_index_v3`, `relationship_v4` readers | The index is reported `requires_reindex`; `manage_index reindex` rebuilds it. Core rejects with `Unsupported Publication version at '<path>'; reindex is required.` or `Unsupported Publication package ownership schema version; reindex is required.` |
| Persisted call evidence without `CallSite.kind` | `CallSite.kind` is now required in persisted call evidence; reindex to regenerate it. |
| `.ts` source fallback for workers and server entry | `Satori runtime file '<path>' is missing; reinstall is required.` |
| Shared-runtime attach protocol v1 (`launcherNonce`) | `Attach handshake protocol version is unsupported; reinstall is required.` Reinstall the launcher. |
| `~/.context` state-directory migration | Old `~/.context` state is ignored and left in place. Reindex. |
| Language capability import/export facade and aliases | One canonical capability set only. |
| `satori update` alias | Not a command. Use `satori upgrade`. |
| Legacy install cleanup (retired skill, instruction, and guidance-hook companions; old Codex hooks, env templates, AGENTS.md blocks, pre-marker skill copies; silent deletion of retired runtime env vars) | Nothing is stripped or deleted. A real directory at a skill-link path is refused: `Refusing to replace <path>: it is not managed by Satori. Remove it manually and rerun install.` |
| LateOn historical profile and activation-policy IDs, and `satori upgrade` migration of them | CLI: `Existing managed LateOn installation uses unsupported profile <profile>. Reinstall with \`satori install --runtime offline --reranker lateon\`, or \`satori install --runtime offline --reranker none\` to disable LateOn.` MCP: `Invalid SATORI_LATEON_PROFILE '<id>'. Expected <current id>; reinstall is required.` and the same for `SATORI_LATEON_ACTIVATION_POLICY`. Existing LateOn installs must be reinstalled (the rerank request contract and runtime profile pin were regenerated). |
| `SATORI_RERANK_APPLICATION_MODE` | `SATORI_RERANK_APPLICATION_MODE has been removed; unset it.` |
| `OLLAMA_MODEL` | `OLLAMA_MODEL has been removed; set EMBEDDING_MODEL instead and unset OLLAMA_MODEL.` |
| `MILVUS_ADDRESS` alone selecting Milvus | MCP: `MILVUS_ADDRESS no longer selects Milvus; set VECTOR_STORE_PROVIDER=Milvus explicitly.` CLI install: `MILVUS_ADDRESS no longer selects Milvus; pass --vector-store milvus or set VECTOR_STORE_PROVIDER=Milvus.` Voyage and Zilliz/Milvus remain fully supported. |
| Grouped `search_codebase` result `score` field | Removed. Response order and `resultIndex.rank` are the ranking. |
| `read_file` `open_symbol` without `contractVersion` | `contractVersion` is required whenever an exact-symbol marker is present. |
| Index fingerprints without version fields (`legacy` sentinel) | Fingerprints must carry their version fields; reindex to regenerate them. |
| Retired v1/v3 rerank request-contract evidence | Removed. |
| `satori-cli` bin alias | Use `satori`, or `npx -y @satori-code/cli@latest`. |
| `VectorDatabase` optional `lexicalMatchModes` / `defaultLexicalMatchMode`; Milvus `collection_names` fallback | Custom `VectorDatabase` implementations must provide both lexical fields. |

## Packages

| Package | Purpose |
|---|---|
| [`@satori-code/cli`](../packages/cli) | Installer, doctor, and command-line access to MCP tools. |
| [`@satori-code/mcp`](../packages/mcp) | The MCP server and 11 public tools. |
| [`@satori-code/core`](../packages/core) | Indexing, analysis, embeddings, storage, and retrieval. |

## Development

```bash
pnpm install
pnpm build
pnpm run check
```

Focused package tests:

```bash
pnpm --filter @satori-code/core test
pnpm --filter @satori-code/mcp test
pnpm --filter @satori-code/cli test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for repository conventions, [docs/RELEASING.md](./RELEASING.md) for coordinated package releases, [SECURITY.md](../SECURITY.md) for private vulnerability reporting, and [THIRD_PARTY.md](../THIRD_PARTY.md) for attribution.

## License

Copyright (c) 2026 Hamza (@ham-zax)

Satori is open-source software available under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](../LICENSE).

Alternative commercial licensing terms are available separately from the copyright holder for organizations that require different licensing terms. See [COMMERCIAL-LICENSING.md](../COMMERCIAL-LICENSING.md).
