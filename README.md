# Satori

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)
[![CI](https://github.com/ham-zax/satori/actions/workflows/ci.yml/badge.svg)](https://github.com/ham-zax/satori/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zokizuan/satori-cli?label=npm)](https://www.npmjs.com/package/@zokizuan/satori-cli)

**Ask your codebase in natural language, then verify the answer in real source.**

Satori is a **local-first code-intelligence layer** for coding agents. Ask where behavior lives in plain English, even when you do not know the filename or symbol yet. Satori combines semantic meaning with BM25 and exact lexical evidence, maps results back to owning symbols, and lets the agent continue into file structure, conservative relationship evidence, exact source spans, and freshness-aware navigation through MCP.

On the qualified Linux x64 / WSL2 path, the default managed runtime keeps that retrieval stack local with Potion embeddings + BM25 + LateOn reranking + LanceDB. No model API key is required for the offline path after installation. Codex, Claude Code, and OpenCode are supported directly by the installer.

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

## Documentation

- [`docs/PRODUCT_GUIDE.md`](./docs/PRODUCT_GUIDE.md) — how to think about Satori and use it for repository learning, debugging, refactors, local models, and multi-agent work.
- [`docs/README.md`](./docs/README.md) — documentation map and current-vs-historical guidance.
- [`satori-landing/docs/index.html`](./satori-landing/docs/index.html) — complete operational setup, tool, lifecycle, and troubleshooting reference.
- [`satori-landing/architecture.html`](./satori-landing/architecture.html) — Publication, retrieval, navigation, freshness, and runtime architecture.
- [`docs/architecture/LANGUAGE_INTELLIGENCE.md`](./docs/architecture/LANGUAGE_INTELLIGENCE.md) — language backends and relationship capability boundaries.
- [`docs/RELEASING.md`](./docs/RELEASING.md) — release qualification and publication workflow.

Dated files under `docs/plans/`, `docs/research/`, `docs/remediation/`, and `docs/superpowers/` are engineering history unless a current document explicitly points to them as an active contract.

## Install

Requirements: Node.js 22.13+, Linux x64 (native Linux or WSL2), and at least
2 GiB of available runtime capacity for the qualified native deployment
envelope. The capacity figure is an allowance, not measured steady
consumption.
The recommended first run needs no global install:

```bash
npx -y @zokizuan/satori-cli@latest install
npx -y @zokizuan/satori-cli@latest doctor
```

For a persistent `satori` command, install the lightweight CLI globally and use
the same flow without the `npx` prefix:

```bash
npm install -g @zokizuan/satori-cli@latest
satori install
satori doctor
```

`install` auto-detects supported Codex, Claude Code, and OpenCode clients from
their documented local markers or CLI executables. `--client auto` is the
explicit equivalent; use `--client all` to force configuration of all three.
If no supported client is detected, Satori stops before runtime installation and
shows explicit client commands. `satori uninstall` defaults to all supported
clients; use `--client auto` to limit cleanup to currently detected clients.

Run `satori` without arguments at any time for human-readable help.
Use `satori -v` to print the installed CLI, MCP runtime, and Core versions.

Codex receives global Satori guidance by default. To also install the optional
Codex session-start reminder:

```bash
satori install --client codex --install-guidance-hook
```

Restart your coding agent and tell it:

```text
Index /absolute/path/to/repo with Satori, then find where auth refresh is handled.
```

That is the complete local path. Satori installs a stable launcher under `~/.satori/`; your agent does not download the server again on every startup.

On Linux x64 and WSL2, the default offline Potion + LanceDB runtime uses LateOn
D32 as its query-time reranker and is shared
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

`satori update` is an exact alias for `satori upgrade`. If you do not keep the
CLI installed globally, run the same release flow through the latest CLI:

```bash
npx -y @zokizuan/satori-cli@latest upgrade
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

For other no-install commands, replace `satori` with `npx -y @zokizuan/satori-cli@latest`.

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
<summary><strong>Measured evidence from the Satori repository</strong></summary>

## Measured on Satori

These are repository measurements, not borrowed model-card claims.

### Local Potion + LanceDB

A checksum-sealed run on the Satori repository published 488 files and 10,830 chunks with 256-dimensional Potion vectors:

| Operation | Measured result |
|---|---:|
| Warm search p95 | 154.543 ms |
| Zero-change synchronization p95 | 185.662 ms |
| One-file addition p95 | 789.310 ms |
| One-file body edit p95 | 792.245 ms |
| One-file signature edit p95 | 811.632 ms |
| One-file deletion p95 | 864.802 ms |
| Rename p95 | 880.937 ms |

The bundled native feasibility run measured a 36.0 MiB model/helper closure, 104.3 MiB model-related RSS, and 232.404 ms model load. Its short-text microbenchmark reached 19,282 items/s, but that isolated throughput number is not a full indexing claim.

### Potion versus Voyage

The same frozen 30 positive retrieval tasks were queried against compatible Potion and Voyage hybrid publications. BM25, exact evidence, fusion, grouping, source projection, and request policy were held constant; only the dense model/publication differed.

| Retrieval result | Potion | Voyage |
|---|---:|---:|
| Required owner at rank 1 | 13/30 | 14/30 |
| Required owner in top 5 | 23/30 | 25/30 |
| Required owner in top 15 | 25/30 | 27/30 |
| Observed search latency p50 | 94.64 ms | 1,009.46 ms |
| Observed search latency p95 | 1,251.00 ms | 1,813.34 ms |

Potion is a useful local first stage, not a claim of Voyage parity. The comparison found weaker Java and configuration/runtime retrieval for Potion. The paired latency observations are descriptive rather than a repeated cross-provider performance qualification.

### Token-efficient retrieval

Satori groups retrieval around owners and exposes bounded source instead of making an agent assemble context from repeated broad reads. The product is designed to cut repository-discovery token waste dramatically by routing exact symbols and compact source windows instead of whole-file dumps.

A fresh two-task OpenCode comparison also reached the correct answers through a shorter evidence route. The detailed exploratory artifact retains the raw tool, context, and token accounting; this public page deliberately does not turn one small run into a universal token-reduction percentage.

The qualification details and limitations remain available in the [Potion plan](./docs/plans/SATORI_POTION_OFFLINE_EMBEDDING_LEAN_QUALIFICATION_PLAN.md).

</details>

## Runtime Choices

| Runtime | Retrieval | Storage | Requirement |
|---|---|---|---|
| Offline | Potion Code 16M v2 + BM25 | LanceDB | Linux x64; no model API key |
| Connected | Voyage Code 3 + BM25 | LanceDB | `VOYAGEAI_API_KEY` |
| Ollama | selected Ollama model + BM25 | LanceDB | local loopback Ollama |
| Connected Milvus | Voyage Code 3 + BM25 | Milvus or Zilliz | explicit Milvus configuration |

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

Existing Milvus deployments can select `--vector-store milvus`. Existing Ollama installations can select or retain an explicit model:

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
npx -y @zokizuan/satori-cli@latest install --client opencode --runtime offline --reranker lateon
npx -y @zokizuan/satori-cli@latest doctor
```

If the latest CLI is already installed globally, the equivalent first command
is `satori install --client opencode --runtime offline --reranker lateon`.
Restart OpenCode after restoring the published runtime.

## MCP Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Manage the repository-intelligence Publication: create the first index, synchronize source changes, inspect readiness, cancel a live supervised sync, recover with reindex, or clear index state. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance; explicit reindex remains the operator recovery override. |
| `search_codebase` | Search the repository-intelligence Publication with semantic, lexical, and exact evidence and return owner-oriented results. Start here for behavior, ownership, configuration, or path discovery. |
| `architecture_overview` | Summarize bounded Publication architecture evidence as logical areas, cross-area boundaries, and hotspots. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. |
| `file_outline` | List the indexed symbols and spans in one file. Use it to choose an exact owner before reading implementation. |
| `call_graph` | Inspect advisory callers, callees, imports, and exports when supported. Verify inbound leads before blast-radius changes. |
| `trace_path` | Find one bounded shortest path between exact published symbols over selected persisted relationships, with scope and truncation evidence. |
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
5. use call_graph for advisory relationship context
6. use read_file for exact proof
7. use continue_search only when the frozen result has more useful evidence
```

When a tracked Publication becomes incompatible with a managed offline runtime, Satori automatically starts or joins one background reindex and returns `not_ready`/`indexing` so the caller can retry without asking the user to repair the index. Explicit `manage_index reindex` remains the recovery override when automatic maintenance is unavailable, suppressed after a failed automatic attempt, or intentionally disabled for connected/remote providers. Use `sync` for ordinary source changes when refreshed indexed evidence is needed. Search and navigation do not wait for a same-root sync: when a compatible completed Publication exists, they continue from that pinned generation with stale/unverified provenance and pending-sync metadata. Create/reindex operations that do not expose a readable generation still return `not_ready` with the active operation so drivers can retry deterministically. For grouped pagination, `limit` bounds the frozen result set across every page and `disclosureLimit` controls only the initial page: `limit=20, disclosureLimit=6` returns up to six initially and freezes up to twenty. Search continuation `"complete"` means complete for that caller-bounded frozen set, never for the full available pool; `omittedBeyondLimitGroupCount` reports groups excluded by `limit`. Treat inbound call-graph results as leads to verify, not compiler-grade blast-radius proof.

## Index Profiles

Install with `--profile default|minimal|all-text` to write repository policy to `satori.toml`:

```toml
[index]
profile = "minimal"
```

| Profile | Includes |
|---|---|
| `default` | Source, documentation, config, scripts, infrastructure files, queries, and known extensionless text files. |
| `minimal` | Source and documentation text. |
| `all-text` | `default` plus additional bounded UTF-8 text files. |

Every profile honors `.satoriignore`, `.gitignore`, and the hard denylist for secrets, dependencies, generated output, lockfiles, binaries, logs, databases, bundles, source maps, and snapshots. Profiles control what is indexed; `search_codebase` still defaults to implementation-first `scope="runtime"`.

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

Satori stores each index generation as one immutable Publication. A complete Publication owns the vector collection, navigation, selection policy and format identity, and source checkpoint for that generation. Readers pin one Publication for the lifetime of a request; activation makes a complete replacement Publication current, while failed candidate work leaves the active Publication unchanged.

Incremental synchronization scans for source changes, embeds changed chunks only, updates navigation and relationship evidence, and activates the complete replacement Publication. Ordinary source divergence converges through `sync`. Managed offline runtimes automatically rebuild a tracked Publication when the current format/runtime identity or runtime policy requires a full reindex; corrupt or unsupported authority still fails closed for explicit operator recovery. Satori does not expose a repair command or salvage retired authority formats into the current Publication model.

## Offline Local Reranking

Offline install defaults to reranking eligible candidates with the Apache-2.0
`lightonai/LateOn-Code-edge` FP32 ONNX checkpoint under the managed v5 D32
profile. Its semantic rerank projection remains projection-v4; v5 pins the
model, artifacts, projection, candidate depth, and sequential CPU execution
semantics without encoding machine-speed assumptions such as queue wait,
scoring latency, or a fixed CPU thread count. Model weights are not bundled in
each versioned MCP runtime. The CLI downloads the roughly 72 MB pinned closure
once into `~/.satori/models/`, verifies every artifact, and reuses it across
upgrades. `satori upgrade` migrates previous managed LateOn combinations to the
v5 default atomically. Disable neural reranking explicitly with:

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
SATORI_LATEON_PROFILE=lateon_offline_quality_projection_v5_d32_v1
SATORI_LATEON_ACTIVATION_POLICY=lateon_context_v5_d32_owner_default_v1
```

Older LateOn profile IDs are recognized only for migration guidance and cannot
execute. `satori upgrade` migrates managed installations to v5. One local
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
and batching behavior. Operators may only reduce their request deadline, queue
wait, reranker-stage deadline, or active/queued capacity using the corresponding
variables listed above; deadlines are never increased. A terminal rerank
execution reports qualified diagnostics — attempts, retries, timeouts, the
effective deadline, observed wall time, and deadline lateness — alongside the
frozen retrieval order. The resulting effective profile remains part of the
shared-runtime and frozen-result identity.

LateOn is query-time ranking evidence only. It does not control candidate
eligibility, source freshness, publication authority, or baseline search
availability.

Search result `score` fields retain bounded retrieval evidence for diagnostics
and compatibility; they are not the final relevance order. Consumers should
preserve the returned sequence, or request `includeResultIndex` when they need
an explicit authoritative rank.

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

`.c` and `.h` files currently use the C++ parser for a proven common-C subset; Satori does not claim a native C parser or independent C type system. `CALLS v0` for that routed subset is limited to exact same-translation-unit direct bindings that survive the C++ semantic gate.

## Privacy and Limits

- Offline Potion embedding, LanceDB storage, search, and runtime telemetry make no network requests after installation.
- Connected providers receive the projected embedding or reranking input required for their service.
- Satori does not edit repository source.
- Local diagnostics exclude source, queries, paths, symbols, and repository identifiers and are never uploaded by Satori.
- Native Windows and macOS are not supported in this release. On Windows, run Satori inside WSL2.
- The relationship graph is conservative navigation evidence, not a full static-analysis proof.
- At revision `4138b1e…`, fresh-process startup measured 645.95 ms p50, after
  which the first `call_graph` measured 7,204.25 ms p50 and 7,530.10 ms p95.
  Calls measured after two preparation calls were 11.97 ms p50 and 13.57 ms
  p95. The cold owners were checkpoint/completion validation and relationship
  loading/validation; adjacency construction was only about 21 ms.
- The six-publication memory experiment at that revision peaked at 881.82 MiB
  RSS and established `memory_retained_capacity_bounded`, not a proven plateau
  or multi-day guarantee. The separate 2 GiB deployment allowance comes from
  earlier integration evidence that observed a 1,447.21 MiB incremental
  publication peak.
- Those cold and memory measurements were not rerun after the current master's
  full-reindex V4 authority-publication change. They are retained release
  characterization, not strict proof of identical current-master performance.

## Packages

| Package | Purpose |
|---|---|
| [`@zokizuan/satori-cli`](./packages/cli) | Installer, doctor, and command-line access to MCP tools. |
| [`@zokizuan/satori-mcp`](./packages/mcp) | The MCP server and nine public tools. |
| [`@zokizuan/satori-core`](./packages/core) | Indexing, analysis, embeddings, storage, and retrieval. |

## Development

```bash
pnpm install
pnpm build
pnpm run check
```

Focused package tests:

```bash
pnpm --filter @zokizuan/satori-core test
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-cli test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions, [docs/RELEASING.md](./docs/RELEASING.md) for coordinated package releases, [SECURITY.md](./SECURITY.md) for private vulnerability reporting, and [THIRD_PARTY.md](./THIRD_PARTY.md) for attribution.

## License

Copyright (c) 2026 Hamza (@ham-zax)

Satori is open-source software available under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](./LICENSE).

Alternative commercial licensing terms are available separately from the copyright holder for organizations that require different licensing terms. See [COMMERCIAL-LICENSING.md](./COMMERCIAL-LICENSING.md).
