# @zokizuan/satori-mcp

The MCP runtime behind [Satori](https://github.com/ham-zax/satori), the local repository-intelligence database for coding agents.

This package exposes the eight primitives an MCP-compatible agent uses to interrogate that database: freshness-aware hybrid search, symbol ownership, file structure, conservative relationship navigation, diff-based impact, exact source reads, repository discovery, and index lifecycle management.

Most users should install Satori through `@zokizuan/satori-cli`. The installer writes a stable local launcher, configures supported MCP clients, and selects the managed runtime. This package is the server/runtime surface, not a separate end-user product and not a client-configuration manager.

## Install

```bash
npx -y @zokizuan/satori-cli@latest install
npx -y @zokizuan/satori-cli@latest doctor
```

`install` auto-detects supported clients; use `--client all` only when you want
to force configuration of all three. A persistent `satori` command is optional:
`npm install -g @zokizuan/satori-cli@latest`.

The local Potion runtime currently supports Linux x64, including Windows through WSL2. Connected Voyage and explicit local Ollama configurations are also available. See the [main README](https://github.com/ham-zax/satori#install) for runtime choices.

When installed through the CLI, compatible offline Potion + LanceDB clients
share one private local host, provider/LanceDB state, and one Potion worker. Each
client remains an independent MCP session. Direct `npx @zokizuan/satori-mcp`
execution is still isolated and does not join the managed host.

Direct package execution is intended for inspection and custom harnesses:

```bash
npx -y @zokizuan/satori-mcp@latest --help
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
`manage_index status`. Each root is attempted once per runtime. A failed attempt
requires explicit recovery through `manage_index create`; reconnecting does not
start a retry loop. The option defaults to off and has no effect on connected
runtimes. File-change observation remains controlled by `MCP_ENABLE_WATCHER`.

Semantic relationship analysis runs one WASM session per language over that
language's whole file set. Sources over 1 MiB are skipped for relationship
analysis (with a warning and `skippedFiles` in the analyzer result) instead of being
duplicated into WASM linear memory, where multi-megabyte generated files
observe roughly 40x transient blowup and abort the session. Skipped files
remain chunked, embedded, and searchable; only their call-graph edges are
missing. The structured skip report is not yet exposed by `manage_index status`.
The per-file limit does not bound the combined size of a language session.
Broad workspace roots (filesystem root, home directory, state root)
stay rejected unless `SATORI_ALLOW_BROAD_ROOTS=true` explicitly opts in.

## Measured Performance

A checksum-sealed Potion/LanceDB run on Satori published 488 files and 10,830 chunks in 34.46 seconds on CPU. The later representative delta run measured 154.543 ms warm-search p95, 185.662 ms zero-change synchronization p95, and 789–865 ms p95 for one-file add/edit/delete operations.

At revision `4138b1e…`, fresh-process startup measured 645.95 ms p50. The first
`call_graph` after startup measured 7,204.25 ms p50 and 7,530.10 ms p95; calls
measured after two preparation calls were 11.97 ms p50 and 13.57 ms p95, with a
10.97–22.77 ms range. The cold result is `cold_graph_multi_owner`:
checkpoint/completion validation consumed about 3.24 seconds and relationship
loading/validation consumed about 2.59–3.20 seconds. Adjacency construction was
only about 21 ms.

The six-publication memory run at that revision used 120-second settling
periods, peaked at 881.82 MiB RSS, retained three generations, and showed no
monotonic heap, RSS, external-memory, or observable-cache growth. Its result is
`memory_retained_capacity_bounded`, not a proven plateau or multi-day
guarantee. The separate requirement for at least 2 GiB available runtime
capacity is an allowance based on earlier integration evidence that observed a
1,447.21 MiB incremental-publication peak; it is not measured steady
consumption.

The cold and memory characterization was not rerun after current master changed
full-reindex V4 authority publication. These figures remain the retained
release characterization for revision `4138b1e…`, not strict empirical proof
of identical current-master performance.

On 30 frozen positive retrieval tasks, Potion placed the required owner in the top five on 23 tasks versus Voyage on 25. Potion's observed median search latency was 94.64 ms versus 1,009.46 ms for Voyage in that paired run, but the provider latency observations were descriptive and Potion showed weaker Java and configuration/runtime retrieval.

In a fresh two-task OpenCode comparison where both arms answered correctly, Satori used 16 tool calls and returned 76,113 tool-output bytes versus 25 calls and 96,801 bytes for native `grep` / `glob` / `read`. Wall time was 51.65 versus 96.04 seconds; total model tokens were effectively unchanged. This is a small exploratory context-route result, not a universal token-reduction claim.

<!-- TOOLS_START -->

## Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Manage the repository-intelligence Publication: create the first index, synchronize source changes, inspect readiness, cancel a live supervised sync, recover with reindex, or clear index state. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance; explicit reindex remains the operator recovery override. |
| `search_codebase` | Search the repository-intelligence Publication with semantic, lexical, and exact evidence and return owner-oriented results. `limit` bounds the frozen result set across all pages; `disclosureLimit` controls only the initial grouped page. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. A grouped envelope without continuation reports pagination.continuation="complete" for the caller-bounded frozen set only; omittedBeyondLimitGroupCount reports groups excluded by the caller limit. |
| `call_graph` | Inspect advisory callers, callees, imports, and exports when supported. Verify inbound leads before blast-radius changes. |
| `detect_changes` | Map a Git diff to current indexed symbol seeds and bounded transitive callers. Reports incomplete coverage, unavailable source, and truncation; does not sync or reindex. |
| `file_outline` | List indexed symbols and spans in one file. Exact Python functions and methods can request on-demand structural analysis. |
| `read_file` | Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods. |
| `list_codebases` | List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one. |

<!-- TOOLS_END -->

`read_file` accepts `open_symbol: {"symbolId":"…"}` with an absolute file `path`;
mode defaults to `plain` and context to `definition`. Preserve `codebaseRoot`
from search recommendations when publications overlap.

Grouped search exposes the oldest contributing `indexedAt` and `stalenessBucket`.
Age is not proof that source changed. Exact registry hits expose `registryBuiltAt`
separately. Outline and graph freshness also include current-source hash checks;
per-file index dates are `null` because the symbol registry does not retain them. Call edges expose `strategy` (`rule` or
`heuristic`), existing confidence scores, and `args` source expressions when
available. Legacy relationship records can lack arguments; newly analyzed files
retain them. These expressions are not evaluated values or complete data flow.

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
- `manage_index` has no force-unlock or repair path. Explicit `sync` runs as supervised background maintenance while a compatible completed Publication remains readable; `cancel` targets only the exact live sync operation ID. Use `reindex` when current Publication authority is missing, corrupt, partial, or incompatible.
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
  `lateon_offline_quality_projection_v5_d32_v1` automatically. The v5 profile
  pins the model, artifacts, projection, candidate depth, and sequential CPU
  execution semantics, but does not encode machine-speed assumptions such as
  queue wait, scoring latency, or a fixed CPU thread count. One local worker
  serves overlapping searches through a FIFO queue; each request is reranked
  unless it is cancelled, the worker genuinely fails, or the hard safety
  ceiling is exceeded. Direct runtimes enable LateOn when
  `SATORI_RERANKER_PROVIDER=lateon` and an absolute `SATORI_LATEON_MODEL_PATH`
  are configured. Older LateOn profile IDs are recognized only for migration
  guidance and cannot execute; `satori upgrade` migrates managed installations
  to v5.
  `SATORI_RERANKER_PROVIDER=none` is the explicit opt-out: with Ollama embeddings
  it means the selected embedding provider plus baseline ordering, not
  "Potion + BM25". Automatic failure fallback and explicit opt-out are different
  concepts.

## Development

```bash
pnpm --filter @zokizuan/satori-mcp build
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-mcp docs:check
```

Node.js 22.13 or newer is required.

## License

Copyright (c) 2026 Hamza (@ham-zax)

Satori is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](./LICENSE).

Alternative commercial licensing terms are available separately from the copyright holder.
