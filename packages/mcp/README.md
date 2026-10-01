# @satori-code/mcp

The MCP runtime behind [Satori](https://github.com/ham-zax/satori), a local-first code-intelligence layer for coding agents.

Agents can ask a repository question in natural language and move from hybrid semantic + lexical search to owning symbols, exact source, structural context, references, relationship navigation, architecture evidence, change orientation, and freshness-aware index state. The live MCP registry exposes 11 tools, including bounded `trace_path` and ranking-independent `find_references`.

Most users should install Satori through `@satori-code/cli`. The installer writes a stable local launcher, configures supported MCP clients, and selects the managed runtime. This package is the server/runtime surface, not a separate end-user product and not a client-configuration manager.

## Install

```bash
npx -y @satori-code/cli@latest install
npx -y @satori-code/cli@latest doctor
```

`install` auto-detects Codex, Claude Code, and OpenCode; Antigravity (`agy`) is
opt-in, and `--client all` configures every supported client. A persistent `satori` command is optional:
`npm install -g @satori-code/cli@latest`.

The qualified default offline path supports Linux x64, including Windows through WSL2, and uses local Potion embeddings, BM25, LateOn reranking, and LanceDB without a model API key after installation. Explicit local Ollama and connected Voyage configurations are also available. See the [main README](https://github.com/ham-zax/satori#install) for runtime choices.

When installed through the CLI, compatible offline Potion + LanceDB clients
share one private local host, provider/LanceDB state, and one Potion worker. Each
client remains an independent MCP session. Direct `npx @satori-code/mcp`
execution is still isolated and does not join the managed host.

Direct package execution is intended for inspection and custom harnesses:

```bash
npx -y @satori-code/mcp@latest --help
```

Do not use `npx` as the resident MCP command when the CLI installer supports your client; package resolution can exceed normal MCP startup timeouts.

## Workflow

The product flow is intentionally narrower than the tool list:

```text
ask by intent
  -> search_codebase
  -> identify the owner
  -> file_outline / call_graph when useful
  -> read_file for exact proof
  -> continue_search only when the frozen result contains more useful evidence
```

A first repository still needs an explicit create:

```text
manage_index action="create" path="/absolute/path/to/repo"
```

Then a typical evidence path is:

```text
search_codebase path="/absolute/path/to/repo" query="where is auth refresh handled"
file_outline path="/absolute/path/to/repo" file="src/auth.ts"
call_graph path="/absolute/path/to/repo" symbolRef={...} direction="both"
read_file path="/absolute/path/to/repo/src/auth.ts" start_line=1 end_line=160
```

Public paths are absolute. Search is freshness-aware; exact reads are limited to indexed searchable roots. Follow `recommendedNextAction` when returned.

Exact-symbol recommendations include `codebaseRoot` to identify the originating
Publication when indexed roots overlap. Preserve it in the `read_file` request.
Successful symbol-context responses also return `codebaseRoot`; reuse that root,
the absolute file path, and the symbol ID when requesting a continuation. An
explicit root is authorized and never replaced by another overlapping root.

For a concrete symbol result, the recommended read uses bounded implementation
context for implementation searches, call context for reference searches, and
definition context for exact lookups. Large symbols still recommend the matched
source span first. Continuation pages preserve the same recommendation policy.

On managed offline runtimes, a tracked rebuild-safe incompatibility automatically starts or joins one background reindex and returns deterministic `not_ready` / `indexing` state for retry. Explicit reindex remains the operator recovery override for connected/remote runtimes, unsafe states, or a failed automatic attempt. `clear` remains explicit.

To opt into first-time workspace indexing on managed offline runtimes, set
`SATORI_AUTO_INDEX_WORKSPACE=true` in the MCP server environment. After the
client finishes its MCP handshake, Satori indexes the authorized session roots
(`SATORI_SESSION_ROOTS_JSON`, or the launcher's working directory) one at a time.
Existing publications are preserved. Indexing uses the repository's existing
index policy and the normal background operation limits; inspect progress with
`manage_index status`. Workspace creates and compatibility reindexes are
single-flight. Transient provider/network/worker failures may retry in the same
runtime after bounded exponential backoff, while deterministic configuration or
compatibility failures, resource limits, and cancellation stay suppressed until
relevant state changes or a successful manual create/reindex supersedes them.
The option defaults to off and has no effect on connected runtimes. File-change
observation remains controlled by `MCP_ENABLE_WATCHER`.

Semantic relationship analysis is resource-bounded independently from search.
WASM-backed languages skip sources over 1 MiB rather than duplicating them into
linear memory. TypeScript compiler-backed analysis defaults to 4 MiB per source
and 64 MiB across the compiler project. Skipped or failed provider work remains
searchable but is persisted as `degraded` / `unavailable` provider coverage, so
`manage_index status` capability evidence cannot report a healthy call graph
when the owning provider did not cover the required source set. Search itself
has separate admission limits: 8 MiB per searchable source and 512 MiB of
aggregate searchable source bytes per full Publication; the aggregate limit
publishes `limit_reached` partial search state rather than running until heap
exhaustion. Broad workspace roots (filesystem root, home directory, state root)
stay rejected unless `SATORI_ALLOW_BROAD_ROOTS=true` explicitly opts in.

<!-- TOOLS_START -->

## Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Manage the repository-intelligence Publication: create the first index, synchronize source changes, inspect readiness, cancel a live supervised sync, recover with reindex, or clear index state. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance; explicit reindex remains the operator recovery override. |
| `search_codebase` | Search the repository-intelligence Publication with semantic, lexical, and exact evidence and return owner-oriented results. `limit` bounds the frozen result set across all pages; `disclosureLimit` controls only the initial grouped page. |
| `architecture_overview` | Summarize bounded Publication architecture evidence as existing logical areas plus factual package architecture from the same persisted ownership snapshot: scoped package identities/counts, cross-package CALLS/IMPORTS boundaries, package fan-in/fan-out, and owned-package cycles. Optional subtree/exclusions and runtime/all scope filter evidence before both projections. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. A grouped envelope without continuation reports pagination.continuation="complete" for the caller-bounded frozen set only; omittedBeyondLimitGroupCount reports groups excluded by the caller limit. |
| `call_graph` | Inspect admitted CALLS plus persisted semantic reference evidence. The default evidenceSummary separates returned CALLS/inbound caller owners from resolved exact target references, reference-only owners, ownerless exact references, ambiguous/unresolved target evidence, and observational sourceReferences; detailed evidence remains pageable. |
| `trace_path` | Find one shortest directed path between exact published symbol IDs over selected persisted CALLS, IMPORTS, EXPORTS, or TESTS edges. The requested path confines nodes and evidence; depth, node, and edge budgets report truncation. |
| `find_references` | Find ranking-independent exact textual occurrences of one canonical symbol across validated published source, with exact spans, owning symbols when available, deterministic path scope, and Publication-hash-bound complete/partial coverage. Textual matches are observational only. |
| `detect_changes` | Map a Git diff to current indexed symbol seeds and bounded inbound CALLS. Graph-derived callers are labeled direct/transitive with causal paths, explicit proof-backed vs heuristic evidence class, and area aggregation; uncertain semantic references stay separate, and completeness reasons disclose traversal and evidence limits. |
| `file_outline` | List indexed symbols and spans in one file. Exact Python functions and methods can request on-demand structural analysis; relationship_coverage exposes per-file observed ResolutionClaim construct calibration. |
| `read_file` | Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods. |
| `list_codebases` | List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one. |

<!-- TOOLS_END -->

`read_file` accepts `open_symbol: {"contractVersion":2,"symbolId":"…"}` with an absolute file `path`;
mode defaults to `plain` and context to `definition`. Preserve `codebaseRoot`
from search recommendations when publications overlap.

Grouped search exposes the oldest contributing `indexedAt` and `stalenessBucket`.
Age is not proof that source changed. Exact registry hits expose `registryBuiltAt`
separately. Outline and graph freshness also include current-source hash checks;
per-file index dates are `null` because the symbol registry does not retain them. Call edges expose `strategy` (`rule` or
`heuristic`), existing confidence scores, and `args` source expressions when
available. These expressions are not evaluated values or complete data flow.

`detect_changes` compares `baseRef` (default `HEAD`) to the tracked working tree
and returns changed files, symbol seeds, and transitive callers up to depth 3.
It includes staged and unstaged tracked edits, excludes untracked files, and
reports missing/stale files, deleted-symbol limitations, and truncation. It uses
current publications across bounded navigation calls, not one atomic snapshot;
its results are advisory and do not establish complete impact coverage.

## Runtime Boundaries

- The server does not edit repository source.
- `read_file` is not a general host-filesystem reader.
- Inbound call-graph evidence is advisory and should be verified before blast-radius edits.
- Python inbound relationships cover bounded static constructor-receiver and
  direct service/callback value-origin patterns. Dynamic or ambiguous flows
  remain partial, so an absent inbound edge is not proof that no caller exists.
- `manage_index` has no force-unlock or repair path. Full create/reindex and explicit `sync` use supervised executors; `cancel` targets only the exact live supervised create/reindex/sync operation ID, and the writer lease is retained until executor quiescence is proven. A failed reindex preserves the previous completed Publication. Use `reindex` when current Publication authority is missing, corrupt, partial, or incompatible.
- Full-index candidate ownership is durably recorded before vector collection creation. A later same-root create/reindex can reclaim an older unreferenced candidate collection, while any collection referenced by a Publication generation remains protected.
- Provider, model, dimensions, projection, and vector backend are persisted compatibility identities; changing them requires a reindex.
- Multiple incompatible live Satori runtimes are blocked from mutating the same publication. Mutation ownership is scoped to the backend authority root: each LanceDB state root has its own owner registry, and Milvus runtimes are keyed by endpoint.
- Rerank context v4 sends the exact question once plus a positive-only answer
  type line, and each projected document is a bounded answer packet carrying a
  factual `candidate_role` plus trusted structural context (direct callers,
  callees, supporting tests — exact instance identities, sorted and capped).
  The reranker's published order is final; there are no ranking weights, score
  multipliers, or global test/documentation penalties. Partial projection
  reranks the projectable candidates and reports `RERANKER_INPUT_DEGRADED`;
  zero projectable candidates skip the provider with `RERANKER_SKIPPED_INPUT`
  (never `RERANKER_FAILED`); terminal provider failures report
  `RERANKER_FAILED` with qualified deadline and lateness diagnostics while the
  frozen retrieval order is published.
- Under `debugMode=full`, candidate survival records per-document rerank input
  provenance — UTF-8 bytes, SHA-256, candidate role, and projection identities —
  never source text.
- Managed offline Potion + LanceDB clients on Linux x64/WSL2 share one private
  local host. Connected providers, Milvus, and explicit Ollama runtimes keep
  the direct per-client lifecycle.
- LateOn projection-v4 D32 is the semantic reranking contract whenever LateOn
  is selected. Managed offline installs bind
  `lateon_offline_quality_projection_v6_d128_v1` automatically. The v6 profile
  pins the model, artifacts, projection, candidate depth, and sequential CPU
  execution semantics, but does not encode machine-speed assumptions such as
  queue wait, scoring latency, or a fixed CPU thread count. One local worker
  serves overlapping searches through a FIFO queue; each request is reranked
  unless it is cancelled, the worker genuinely fails, or the hard safety
  ceiling is exceeded. Direct runtimes enable LateOn when
  `SATORI_RERANKER_PROVIDER=lateon` and an absolute `SATORI_LATEON_MODEL_PATH`
  are configured. Any other LateOn profile ID is rejected and cannot execute;
  reinstall the managed runtime to bind v5.
  `SATORI_RERANKER_PROVIDER=none` is the explicit opt-out: with Ollama embeddings
  it means the selected embedding provider plus baseline ordering, not
  "Potion + BM25". Automatic failure fallback and explicit opt-out are different
  concepts.

## Development

```bash
pnpm --filter @satori-code/mcp build
pnpm --filter @satori-code/mcp test
pnpm --filter @satori-code/mcp docs:check
```

Node.js 22.13 or newer is required.

## License

Copyright (c) 2026 Hamza (@ham-zax)

Satori is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](./LICENSE).

Alternative commercial licensing terms are available separately from the copyright holder.
