# Satori — Pitch Deck

## Repo Context for AI Coding Agents

---

## Slide 1: Title

**Satori**

*Deterministic code retrieval that gives AI agents investigation superpowers before every edit.*

---

## Slide 2: Problem — AI Agents Edit from Incomplete Context

Agents grep nearby files, guess the right function, edit from partial context, and leave you to discover what they missed.

| Failure Mode | Impact | Source |
|---|---|---|
| **Wrong file** | Nearby text isn't the same as the right implementation. Agents edit the obvious file, not the correct one. | `satori-landing/index.html:1083-1089` |
| **Missed callers** | A change looks small until three other functions depend on it. Without caller context, breakage is invisible. | `satori-landing/index.html:1091-1096`; `AGENTS.md:45` |
| **Stale context** | Active repos move while agents work. Old indexes produce hallucinated edits from outdated code. Satori's `freshnessDecision` envelope and `requires_reindex` gate make this explicit. | `satori-landing/index.html:1098-1103`; `CHANGELOG.md:374,379,874` |
| **Opaque decisions** | Results point to real files, symbols, and warning states, but agents don't surface *why* they chose a path. Satori's structured envelopes (status / hints / warnings / canonical targets) make agent reasoning inspectable. | `satori-landing/index.html:1106-1110`; `AGENTS.md:53-59` |

---

## Slide 3: Solution — Repo-Aware, Read-Only Code Investigation

Satori indexes a repository, keeps the index fresh, and gives agents a small deterministic MCP surface for finding, navigating, and reading code without flooding the context window.

| Capability | Description |
|---|---|
| **By Intent, Not Filename** | Ask "where is auth refresh handled?" instead of guessing file paths |
| **Exact Spans, Not Dumps** | Open exact symbols and line ranges instead of flooding with broad context |
| **Deterministic Navigation Path** | `search_codebase` → `file_outline` → `call_graph` (when supported) → `read_file(open_symbol)` |
| **Read-Only Boundary** | No MCP write tools. Agents search and navigate; edits stay in your editor |

**Evidence:** `AGENTS.md:36-48` (fixed tool surface, no-knob policy), `AGENTS.md:51` (navigation path), `AGENTS.md:48` (no write tools), `README.md:9,226-229`

---

## Slide 4: Product — Six-Tool MCP Surface

A fixed, stable MCP tool surface agents can reliably learn — no knob sprawl, no hidden behavior.

| Tool | Contract |
|---|---|
| **search_codebase** | Semantic + BM25 hybrid search. Runtime-first defaults. Operators parsed from query prefix: `lang:`, `path:`, `-path:`, `must:`, `exclude:`. Grouped by symbol or file. |
| **file_outline** | Sidecar-backed symbol extraction per file. Exact mode returns `ok`, `ambiguous`, or `not_found` without guessing. |
| **call_graph** | Bounded caller/callee traversal from `symbolRef`. TS/JS/Python production-ready. Go/Rust/Java/C#/C++/Scala return `unsupported_language` with a navigation fallback. |
| **read_file** | Plain text or annotated mode. 1-based line ranges, safe truncation, deterministic `open_symbol` resolution. |
| **manage_index** | `create` / `reindex` / `sync` / `status` / `clear`. `clear` is destructive and requires explicit user request. Fingerprint gates block mismatched access. |
| **list_codebases** | Plain-text readiness buckets: Ready, Indexing, Requires Reindex, Failed. Deterministic sort. |

**Evidence:** `AGENTS.md:38-46` (tool contracts), `packages/mcp/src/tools/registry.ts:16-23` (tool list), `list_codebases.ts:113-147` (bucket names)

---

## Slide 5: Product Evidence — How Each Capability Works

### Semantic Search
- Dense vectors + BM25 hybrid with Reciprocal Rank Fusion (RRF)
- AST-aware chunking via tree-sitter across **9 languages** (TS, JS, Python, Java, **C++ only**, Go, Rust, C#, Scala)
- Optional VoyageAI neural reranking
- Scope filtering: `runtime` (default) / `docs` / `mixed`
- Changed-files ranking boost (`rankingMode=auto_changed_first`)
- **Cap-1 caveat:** `.c` is routed to the C++ parser; no dedicated C AST
- **Cap-2 caveat:** `importExportCapability` is `NONE` for all native languages — cross-file import/export tracking is **not** a production capability today

### Exact Reads & Symbol Navigation
- `file_outline` with `resolveMode=outline|exact`
- `read_file` with 1-based inclusive line ranges, safe truncation
- `open_symbol` parameter resolves exactly without guessing spans
- Symbol registry sidecars (`symbolKey` for stable lookup, `symbolInstanceId` for exact identity)

### Caller/Callee Context
- Conservative `CALLS v0` edges, name-based heuristic
- Bounded depth (1-3) and edge count. Deterministic sorting.
- Production: TypeScript, JavaScript, Python only
- `symbol_only`: Go, Rust (file_outline works; call_graph returns `unsupported_language`)
- AST-split only, no graph: Java, C++, C#, Scala

### Freshness Gates
- **5-field runtime fingerprint:** `embeddingProvider`, `embeddingModel`, `embeddingDimension`, `vectorStoreProvider`, `schemaVersion`
- Any mismatch → `requires_reindex` (blocks search, prevents corrupt retrieval)
- Sync-on-read for `search_codebase` (only)
- Merkle-based incremental sync (stat-first, hash-on-change)
- Completion proof markers in vector backend (`kind=satori_index_completion_v2`)
- **State machine (5 states):** `not_found` (response vocab) → `indexing` → `indexed` / `indexfailed` → `sync_completed` → `requires_reindex`

**Evidence:** `ARCHITECTURE.md:259-303` (state machine + fingerprint), `packages/mcp/src/core/snapshot.ts`, `packages/mcp/src/core/sync.ts:480-494` (3-min loop), `packages/core/src/sync/synchronizer.ts:350-369` (stat-first)

---

## Slide 6: Market — Developers & Teams Using AI Coding Agents

For indie devs and engineering teams using Claude Code, Codex, OpenCode, or Cursor-style agent workflows where the repo is too large to paste into chat.

| Persona (from landing page, in source order) | Need |
|---|---|
| **You want faster shipping** | Keep the agent moving, but make investigation part of the workflow before it touches important files |
| **Your repo is not a demo** | Mixed docs, tests, generated files, stale indexes, renamed paths are normal. Satori treats these as first-class states |
| **You need visible evidence** | Results point to real files, symbols, line spans, and exact next tool calls |
| **You want read-only repo context** | Satori exposes no write tools. Edits stay in host editor |
| **You work inside packages** | Search from a subdirectory inside an indexed repo. Root identity and navigation paths stay consistent |
| **You want a practical trial path** | MIT/open source. Zilliz and VoyageAI free allowances suitable for trial |

**Evidence:** `satori-landing/index.html:1183-1235` (persona cards, original order)

---

## Slide 7: Current Status — Production-Ready Open Source

| Metric | Value | Source |
|---|---|---|
| License | MIT | `LICENSE` |
| NPM Packages | 3 | `package.json` |
| Latest Core | v1.6.4 | `packages/core/package.json:3` |
| Latest MCP | v4.11.8 | `packages/mcp/package.json:3` |
| Latest CLI | v0.4.6 | `packages/cli/package.json:3` |
| MCP Tools | 6 fixed | `AGENTS.md:36-46` |
| Client Integrations | 3 (Codex, Claude, OpenCode) | `README.md:41` |
| Embedding Providers | 4 (VoyageAI, OpenAI, Gemini, Ollama) | `packages/core/src/embedding/` |
| Vector Store | Milvus / Zilliz (gRPC + REST) | `packages/core/src/vectordb/` |
| Transport | stdio only | `packages/mcp/src/server/start-server.ts:2,288-289` |

### Package Breakdown

| Package | Purpose |
|---|---|
| `@zokizuan/satori-core` v1.6.4 | Indexing, AST chunking, embeddings, Milvus/Zilliz storage, incremental Merkle sync |
| `@zokizuan/satori-mcp` v4.11.8 | MCP server with 6 tools, Zod schemas, snapshot v3 state machine, fingerprint gates, search telemetry |
| `@zokizuan/satori-cli` v0.4.6 | Installer for Codex/Claude/OpenCode. `bin: satori-cli`. Managed config ownership. `doctor` command. Schema-backed wrapper flags |

### Installer-First Setup
```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```
- Writes managed client config (TOML for Codex, JSON for Claude, JSONC for OpenCode)
- Copies first-party `satori` workflow skill (plus `satori-search`, `satori-navigation`, `satori-indexing` companions)
- Launcher at `~/.satori/bin/satori-mcp.js` — no `npx` on resident MCP startup
- Repo-local `satori.toml` for index profile selection (`default`, `minimal`, `all-text`)
- Server manifest at `server.json` for installer/catalog consumption

**Evidence:** `README.md:24-30` (packages), `server.json` (install manifest), `packages/cli/src/install.ts`, `packages/mcp/assets/skills/` (skill inventory)

---

## Slide 8: Architecture — How It Works

```
MCP Client (Codex, Claude, OpenCode)
       │
       │ JSON-RPC over stdio
       ▼
┌──────────────────────────────────────────────────┐
│  @zokizuan/satori-mcp                            │
│                                                   │
│  ToolRegistry (6 tools) → Zod → JSON Schema       │
│  SnapshotManager v3 (fingerprint gate)            │
│  SyncManager (3-min loop + chokidar watchers)     │
│  CapabilityResolver (fast | standard | slow)      │
│  VoyageAI Reranker (optional, capability-gated)   │
│  Search Telemetry (stderr, structured)            │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│  @zokizuan/satori-core                           │
│                                                   │
│  ContextOrchestrator (indexCodebase, semanticSearch)│
│  AST Splitter (tree-sitter: 9 languages)          │
│  Embedding (OpenAI | VoyageAI | Gemini | Ollama)  │
│  VectorDatabase (Milvus gRPC | Milvus REST)       │
│  FileSynchronizer (Merkle DAG)                    │
└──────────────────────┬───────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   Milvus / Zilliz            ~/.satori/
   (dense + hybrid            (snapshots, merkle,
    collections)               sidecars, runtime/owners)
```

### Boundary discipline
- MCP package owns control flow, state, and lifecycle gates
- Core package owns indexing and retrieval computation (MCP-agnostic)
- CLI package owns installation, uninstallation, and shell tool invocation
- Adapters stay behind ports: `Embedding` and `VectorDatabase` interfaces

**Evidence:** `ARCHITECTURE.md:7-61` (system diagram), `packages/mcp/src/index.ts`, `packages/core/src/core/context.ts`

---

## Slide 9: Operational Robustness — What the Codebase Actually Handles

Satori's production-readiness is not just feature surface — it is in how the system handles failure modes. Each of the following is implemented, tested, and surfaced in tool responses.

| Capability | Behavior |
|---|---|
| **Fingerprint mismatch** | Provider/model/dimension/schema drift → `requires_reindex` envelope with `hints.reindex` args |
| **Stale local snapshot** | `stale_local` proof outcome; does not pretend ready |
| **Indeterminate remote state** | Milvus timeout, probe failure, drop timeout → local state preserved (no half-clear) |
| **Verified remote delete** | `dropCollection` + `hasCollection` re-probe with retry; aborts local mutation if not verified |
| **Clear tombstones** | Collection-scoped persistence of intentional clear; survives reload |
| **Multi-runtime conflict** | Different fingerprint/config Satori runtimes → `status="blocked"`, `reason="runtime_owner_conflict"` |
| **Snapshot lock hardening** | Bounded wait, stale-PID detection, no CPU-spin, `.corrupt-<pid>-...json` preserved on parse error |
| **Per-codebase indexing lock** | Other roots not blocked when one is indexing |
| **Sync-on-read** | `search_codebase` runs `ensureFreshness` before returning results |
| **Ignore-rule reconciliation** | `.satoriignore`/`.gitignore`/`satori.toml` signature change → reindex-by-diff (not full rebuild) |
| **Reindex preflight** | Ignore-only changes route to `sync` (not reindex); `allowUnnecessaryReindex` override exists |
| **Search fault injection** | Deterministic test paths for primary/expanded/both pass failures; degraded but usable with warnings |
| **Staleness buckets** | Grouped results: `Fresh` (≤30m), `Aging` (≤24h), `Stale` (>24h) |
| **Noise mitigation hints** | Top-N dominated by tests/fixtures/coverage → `hints.noiseMitigation` with suggested patterns |
| **Noisy-result recovery** | Apply suggested `.satoriignore`, run `sync` — not full reindex |
| **Read-side path-scoped live evidence** | Exact `path:` searches supplement with bounded live reads when vector chunks are stale |
| **Partial-scan preservation** | Unreadable dirs do not trigger mass false deletion in sync |
| **Snapshot merge precedence** | `indexing` > `indexfailed|requires_reindex` > `indexed|sync_completed`; stale high-progress doesn't override fresh |
| **Metadata setter guardrails** | `status`/`indexingPercentage`/`indexedFiles` cannot be mutated via cosmetic setters |
| **Completion proof + clear tombstones** | Distinct sources of truth: remote marker + clear intent + local ready |

**Evidence:** `CHANGELOG.md:114,375-380,431,679,852-867,874`, `ARCHITECTURE.md:185-198,1512-1906`, `docs/SATORI_FEATURES_AND_USE_CASES.md:1512-1920`

---

## Slide 10: Comparison Eval Harness — Determinism, Not Marketing

Satori ships a real comparison harness, with measured scope and acknowledged limitations.

### What it is
- `scripts/code-intelligence-vs.mjs` (680 lines) + `evals/code-intelligence-vs/tasks.json` (5 tasks)
- Run via `pnpm run vs:code-intelligence`
- Compares Satori vs `codebase-memory-mcp` (the only other MCP wired in)
- 4 task kinds: `search`, `outline`, `callgraph`, `architecture`
- Reports per-provider raw score, pass count, unsupported count, per-task leader (`leader` / `tie` / `no result`)

### What it is not
- **Not** an LLM answer-quality benchmark — measures deterministic retrieval/navigation behavior only
- **Not** a public leaderboard — no results.json, no win/loss tables in repo
- **Not** run in CI — invoked manually; the `summarize()` function has unit tests against synthetic tie data only
- **Not** multi-tool — only Satori and codebase-memory-mcp

### Distinct from internal determinism suite
- `packages/mcp/src/core/search.eval.test.ts` (196 lines) is the **internal** eval: scope filtering invariants, ranking determinism, grouped/raw output shape
- This is **not** the comparison harness — it tests Satori against its own past behavior, not against other tools

### Attributed upstream
Satori explicitly acknowledges MIT-licensed inspiration from `codebase-memory-mcp` in `THIRD_PARTY.md`. The harness is the project's response to that lineage: ship a deterministic comparison rather than claim sole invention.

**Evidence:** `evals/code-intelligence-vs/README.md`, `scripts/code-intelligence-vs.mjs:16` (`PROVIDERS = ["satori", "codebase-memory"]`), `THIRD_PARTY.md:3-11`

---

## Slide 11: Azure Opportunity

Satori's architecture maps cleanly onto Azure services. Today it runs on Milvus/Zilliz + VoyageAI/OpenAI/Ollama. Azure integration is an additive adapter layer — no core rewrites needed.

### Existing seams that reduce Azure integration cost

| Azure Service | Satori Mapping | Status |
|---|---|---|
| **Azure OpenAI** | `text-embedding-3-small`/`large` already supported via the existing OpenAI provider. **`OPENAI_BASE_URL` is the existing custom-endpoint seam** — Azure-specific base URL is config, not code. Only Azure-specific auth (token + deployment routing) is missing. | Provider exists; auth + deployment routing wiring needed |
| **Azure AI Search** | Replace Milvus vector store. Collection → Index, Marker doc → metadata field. Same dense+BM25+RRF model preserves semantics. | Adapter needed (no Azure code today) |
| **Azure Container Apps** | Host MCP server as a long-running container. Today Satori uses **stdio transport only**; HTTP transport would need to be added. Per-customer container isolation is a deployment model, not a code change. | Transport extension + ops work |
| **Azure Blob Storage** | Store Merkle DAGs, symbol registries, and relationship sidecars. Shared state across team members' sessions. Today these live under `~/.satori/`. | Storage abstraction needed |
| **Evaluation Pipelines** | Run `pnpm run vs:code-intelligence` at scale; wire to Azure DevOps or GitHub Actions. Compare Satori + codebase-memory across repos; regression detection on index changes. | Eval harness exists; pipeline infra needed |
| **CI integration** | Index-on-push triggers. Search freshness tied to commit SHAs. | CI integration layer, no Azure DevOps code today |

### What exists vs what's needed

| Component | Already Built | Azure Work |
|---|---|---|
| Embedding provider interface | OpenAI, VoyageAI, Gemini, Ollama | AzureOpenAI auth + deployment routing |
| Vector store interface | Milvus gRPC, Milvus REST | AzureAISearch adapter |
| State storage | Local `~/.satori/` | Azure Blob adapter |
| Eval suite | `vs:code-intelligence` (comparison) + `search.eval.test.ts` (internal determinism) | CI pipeline integration |
| MCP transport | stdio | HTTP transport + Container Apps hosting |

**Evidence:** `packages/core/src/embedding/openai-embedding.ts:7,21` (baseURL seam), `packages/mcp/src/config.ts:262` (env var), `packages/core/src/vectordb/` (adapter pattern), `scripts/code-intelligence-vs.mjs`

---

## Slide 12: Roadmap

### Done (Production)
- Six-tool MCP surface with deterministic envelopes — `AGENTS.md:36-46`
- Fingerprint gates and completion proof — `ARCHITECTURE.md:259-312`
- Incremental Merkle sync with ignore reconciliation — `ARCHITECTURE.md:185-198`
- CLI installer for Codex, Claude, OpenCode — `packages/cli/src/install.ts`
- Symbol registry sidecars for completed full indexes — `README.md:194-211`
- First-party skills: `satori`, `satori-search`, `satori-navigation`, `satori-indexing` — `packages/mcp/assets/skills/`
- Comparison eval harness (Satori vs codebase-memory-mcp) — `evals/code-intelligence-vs/`
- Snapshot v3 lock/merge hardening — `CHANGELOG.md:431,679`
- PI extension bridge example — `examples/pi-extension/satori-bridge/`
- Server manifest for installer catalogs — `server.json`

### In Progress (plan docs exist, checkboxes mostly open)
- **Symbol-owned retrieval** — `docs/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md`. Chunk-first → symbol-first grouping. Owner metadata on indexed chunks. SQLite parity-gated navigation backend.
- **Bridge reliability hardening** — `docs/SATORI_BRIDGE_RELIABILITY_HARDENING_PLAN.md`
- **Search query intent redesign** — `docs/superpowers/specs/2026-03-16-satori-search-query-intent-design.md`
- **Indexing lock hardening** — `docs/INDEXING_LOCK_HARDENING_PLAN.md`
- **Snapshot manager hardening** — `docs/SNAPSHOT_MANAGER_HARDENING_PLAN.md`
- **Search-side ignore guidance hardening** — `docs/SEARCH_SIDE_IGNORE_GUIDANCE_HARDENING_PLAN.md`

### Planned (design-finalized, not yet built)
- **SQLite navigation backend** (opt-in, parity-gated) — `docs/RELATIONSHIP_BACKED_NAVIGATION_AND_SQLITE_STORE_PLAN.md`. Explicitly **not** the default.
- **Expanded language support** — Call graph for Go, Rust (from `symbol_only`). `docs/LANGUAGE_CAPABILITY_MATRIX_AND_SYMBOL_EXTRACTOR_HARNESS_PLAN.md`. Not yet started.
- **Codebase-memory import-export adoption** — Documented in `docs/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md`. Move from heuristic `CALLS v0` to receiver-aware edges.

### Speculative (no plan doc; engagement subjects)
- **Hosted team workflows** — Shared indexes, per-user freshness tracking. Per-repo `.satoriignore` is the only scoping today.
- **Enterprise repo intelligence** — Multi-repo cross-index search, impact analysis across repos.
- **Azure adapters** — Azure AI Search, Azure OpenAI, Azure Blob, HTTP transport. Depends on Slide 11 prioritization.
- **Pricing model** — Self-hosted with enterprise features vs managed SaaS vs hybrid. No code today.

**Evidence:** `docs/superpowers/plans/`, `docs/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md`, `docs/RELATIONSHIP_BACKED_NAVIGATION_AND_SQLITE_STORE_PLAN.md`, `docs/INDEXING_LOCK_HARDENING_PLAN.md`, `docs/SNAPSHOT_MANAGER_HARDENING_PLAN.md`, `docs/SEARCH_SIDE_IGNORE_GUIDANCE_HARDENING_PLAN.md`, `docs/SATORI_BRIDGE_RELIABILITY_HARDENING_PLAN.md`

---

## Slide 13: Traction & Differentiation

### vs. Generic Semantic Search
Generic indexes go stale silently. Satori has fingerprint gates, completion proof, Merkle sync, and explicit state transitions so agents get `requires_reindex` instead of corrupt results. `AGENTS.md:54` makes this an invariant: do not substitute `sync` for `reindex` on fingerprint mismatch.

### vs. Graph-Only Tools
Pure graph tools need exact symbol names to start. Satori starts with natural-language semantic discovery, then narrows to symbols and call graphs. `search_codebase` → `file_outline` → `call_graph` → `read_file(open_symbol)`. When graph is unavailable, the compact grouped target still provides deterministic symbol or span reads.

### vs. Other Code-Intelligence MCPs
Satori ships a deterministic comparison harness (`pnpm run vs:code-intelligence`) that runs Satori and `codebase-memory-mcp` on the same 5-task suite. Satori also acknowledges MIT-licensed upstream inspiration in `THIRD_PARTY.md` rather than claiming sole invention.

### Key Differentiators

| Principle | Behavior | Where |
|---|---|---|
| **Determinism over cleverness** | Stable sorting, warning codes, predictable output shapes | `AGENTS.md:77-88` |
| **Exact evidence, not summaries** | Results carry file paths, symbols, line spans, next tool calls | `AGENTS.md:36-46` |
| **Lifecycle honesty** | No silent degradation. `requires_reindex`, `not_found`, `unsupported_language` | `CHANGELOG.md:431,679,852-867` |
| **Read-only MCP boundary** | No source-file write tools exposed through MCP | `AGENTS.md:48`; `README.md:226-229` |
| **Installer-first** | No `npx` on resident startup. Managed config. Launcher-owned paths | `AGENTS.md:32`; `README.md:72-74` |
| **Capability-honest** | Graph doesn't lie. TS/JS/Python are production graph languages. Others return fallback | `AGENTS.md:46`; `README.md:207` |
| **Fails closed on ambiguity** | `file_outline exact` returns `ambiguous` instead of guessing; `open_symbol` does not fabricate spans | `AGENTS.md:46` |
| **No silent swallows** | Graceful degradation emits `warnings[]` with `action`; structured envelopes with `status`/`reason`/`hints` | `AGENTS.md:59` |
| **Idempotent operations** | Retries and duplicate calls do not corrupt lifecycle state | `AGENTS.md:79-88` (general principles) |
| **Small MCP surface** | Six tools only. New tools require spec + tests + docs + skill impact review | `AGENTS.md:48`; `docs/SATORI_REPO_LEARNING_ROADMAP.md:1047-1057` |

**Evidence:** `AGENTS.md:36-88`, `docs/SATORI_FEATURES_AND_USE_CASES.md:1921-2028`, `THIRD_PARTY.md`

---

## Slide 14: Next Steps

### Satori is MIT-licensed, production-tested across Codex/Claude/OpenCode, and architecturally ready for Azure integration and team workflows.

| Action | Link |
|---|---|
| **GitHub** | [github.com/ham-zax/satori](https://github.com/ham-zax/satori) |
| **Landing Page** | [satori.hamza.my.id](https://satori.hamza.my.id/) |
| **Install** | `npx -y @zokizuan/satori-cli@latest install --client all` |
| **Eval harness** | `pnpm run vs:code-intelligence` |
| **Package** | [npm: @zokizuan/satori-cli](https://www.npmjs.com/package/@zokizuan/satori-cli) |

### Key Questions for Stakeholders

1. **Azure integration priority** — Which Azure service mapping should ship first? Azure OpenAI variant (lowest cost, reuses `OPENAI_BASE_URL` seam) is the fastest path. Azure AI Search adapter is the highest-value unlock.
2. **Team workflows MVP scope** — Shared indexes, per-user freshness tracking, shared `.satoriignore`? Note: Satori today has only per-repo `.satoriignore`; team-level scoping is new surface.
3. **Enterprise pricing model** — Self-hosted with enterprise features? Managed SaaS on Azure? Hybrid?
4. **Eval partnership** — Interest in running the deterministic eval suite against internal repos to benchmark retrieval quality?

---

## Appendix A: Verification Notes

This pitch deck was fact-checked against the codebase by three independent subagents on 2026-07-06.

| Claim | Verification Source |
|---|---|
| 6 MCP tools | `packages/mcp/src/tools/registry.ts:16-23` |
| Tool contracts | `AGENTS.md:38-46` |
| Navigation path | `AGENTS.md:51` |
| Search operators | `AGENTS.md:57`; `packages/mcp/src/core/search-query-planning.ts:10` |
| State machine (5 states) | `packages/mcp/src/config.ts:84-125` |
| Package versions | `packages/*/package.json` (core 1.6.4, mcp 4.11.8, cli 0.4.6) |
| Fingerprint fields | `packages/mcp/src/config.ts:9-15`; `snapshot.ts:78-87` |
| Language capability tiers | `packages/core/src/languages/capabilities.ts:18-118,265-364` |
| AST language count (9) | `packages/core/src/splitter/ast-splitter.ts:12-20,124-134` |
| Embedding providers (4) | `packages/core/src/embedding/`; `config.ts:3` |
| Vector stores | `packages/core/src/vectordb/`; `config.ts:4` |
| Transport = stdio | `packages/mcp/src/server/start-server.ts:2,288-289` |
| Sync interval (3 min) | `packages/mcp/src/core/sync.ts:480-494` |
| Stat-first, hash-on-change | `packages/core/src/sync/synchronizer.ts:350-369` |
| Eval suite (internal) | `packages/mcp/src/core/search.eval.test.ts` (196 lines) |
| Comparison harness | `scripts/code-intelligence-vs.mjs:16`; `evals/code-intelligence-vs/` |
| Codebase-memory attribution | `THIRD_PARTY.md:3-11` |
| Skills inventory | `packages/mcp/assets/skills/`, `packages/cli/assets/skills/` |
| Server manifest | `server.json` |
| Capability profiles | `packages/mcp/src/core/capabilities.ts:4,25-50` |
| Lifecycle honesty envelopes | `CHANGELOG.md:114,374,431,679,852-867` |

## Appendix B: What This Deck Does Not Claim (for honesty)

| Item | Status |
|---|---|
| **No Streamable HTTP transport** | Satori uses stdio today. HTTP is Slide 11 future work. |
| **No hosted SaaS today** | All deployments are self-hosted per developer. |
| **No multi-repo search** | Each root is its own index. |
| **No team `.satoriignore`** | `.satoriignore` is per-repo only. |
| **No call_graph for symbol-only languages** | Go/Rust/Java/C#/C++/Scala return `unsupported_language` with navigation fallback. |
| **No cross-file import/export tracking** | `importExportCapability` is `NONE` for all native languages today. |
| **No published benchmark numbers** | Harness exists; no leaderboard, no win-rate, no per-task scores in repo. |
| **No CI gating of behavioral regressions** | `pnpm test`, `pnpm lint`, and the comparison harness are **not** in CI. Lint is commented out in `.github/workflows/ci.yml:79-80`. |
| **No `.c` dedicated AST** | C is routed to the C++ parser. |
| **No release tags since v4.2.0** | Latest tag is 9 minor versions behind `mcp@4.11.8`. Release process may publish without tagging. |
| **No production-tested claim at CI level** | "Tested" means installer support + integration + smoke. Unit tests and eval suite do not run on PR. |
| **No `~/.satori/.satoriignore` global ignore** | Runtime reads only repo-root control files, despite one ARCHITECTURE.md mention. |
| **No audit trail feature** | Satori surfaces evidence in tool responses, but does not log agent reasoning or edit paths. |

## Appendix C: Internal Doc Contradictions Worth Knowing

- `ARCHITECTURE.md:133` lists `~/.satori/.satoriignore` as a 5th ignore layer; `docs/SATORI_FEATURES_AND_USE_CASES.md:541-542` and runtime code (`context.ts:2007`, `sync.ts:74`) say only repo-root files are loaded. The runtime is authoritative; ARCHITECTURE.md is wrong.
- The deck's "honest" version above reflects runtime, not the architecture doc.
