# @satori-code/mcp

The Model Context Protocol server behind [Satori](https://github.com/ham-zax/satori). It exposes local code search, bounded source reads, repository structure, and relationships supported by the index.

## Install through the CLI

```bash
npx -y @satori-code/cli@latest install
npx -y @satori-code/cli@latest doctor
```

The installer configures supported clients to run a stable launcher. It sets up the default offline Potion, BM25, LateOn, and LanceDB stack on qualified Linux x64 and ARM64 with glibc, including WSL2. See the [client setup reference](https://github.com/ham-zax/satori/blob/master/docs/REFERENCE.md#client-setup) for client selectors and manual registration.

For a standalone deployment, inspect the runtime options with `npx -y @satori-code/mcp@latest --help`. Use an installed runtime entry or the stable managed launcher as the resident stdio command. Package resolution through `npx` can exceed client startup timeouts.

## Use the tools

Ask `search_codebase` where a behavior lives, then follow its `recommendedNextAction` to read the source. Use the exact published symbol when requesting relationships. Repository and source paths are absolute.

For a direct `read_file` symbol request, pass the published `symbolId` under `open_symbol` with `contractVersion: 2`. When a result supplies `codebaseRoot`, preserve that root across exact reads and continuations to disambiguate overlapping indexes.

For grouped search, `limit` controls the whole frozen ranking and `disclosureLimit` controls the initial page. Pass the continuation handle and exact `nextOffset` as `expectedOffset` to `continue_search`.

Eligible Git workspaces automatically index within the runtime’s byte and file budgets. A ready Publication groups search, source checkpoints, symbols, and relationships for one repository generation. While a replacement is pending, tools may return evidence from the compatible prior generation with freshness warnings. See the [index lifecycle](https://github.com/ham-zax/satori/blob/master/docs/REFERENCE.md#index-lifecycle) for readiness and recovery.

<!-- TOOLS_START -->

## Tools

| Tool | Purpose |
|---|---|
| `manage_index` | Manage the repository-intelligence Publication: create the first index, synchronize source changes, inspect readiness, cancel a live supervised sync, recover with reindex, or clear index state. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance; explicit reindex remains the operator recovery override. |
| `search_codebase` | Search the repository-intelligence Publication with semantic, lexical, and exact evidence and return owner-oriented results. `limit` bounds the frozen result set across all pages; `disclosureLimit` controls only the initial grouped page. |
| `architecture_overview` | Summarize bounded Publication architecture evidence as existing logical areas plus factual package architecture from the same persisted ownership snapshot: scoped package identities/counts, cross-package CALLS/IMPORTS boundaries, package fan-in/fan-out, and owned-package cycles. Optional subtree/exclusions and runtime/all scope filter evidence before both projections. |
| `continue_search` | Reveal more of one frozen result set without rerunning retrieval. Use it when the initial disclosure is relevant but incomplete. A grouped envelope without continuation reports pagination.continuation="complete" for the caller-bounded frozen set only; omittedBeyondLimitGroupCount reports groups excluded by the caller limit. |
| `call_graph` | Inspect admitted CALLS plus persisted semantic reference evidence. Edited files retain published IDs and spans with stale-source warnings. The default evidenceSummary separates returned CALLS/inbound caller owners from resolved exact target references, reference-only owners, ownerless exact references, ambiguous/unresolved target evidence, and observational sourceReferences; detailed evidence remains pageable. |
| `trace_path` | Find one shortest directed path between exact published symbol IDs over selected persisted CALLS, IMPORTS, EXPORTS, or TESTS edges. The requested path confines nodes and evidence; depth, node, and edge budgets report truncation. |
| `find_references` | Find ranking-independent exact textual occurrences of one canonical symbol across validated published source, with exact spans, owning symbols when available, deterministic path scope, and Publication-hash-bound complete/partial coverage. Edited files are scanned from current bytes and labeled current_source_text. Textual matches are observational only. |
| `detect_changes` | Map a Git diff to hash-matched indexed seeds and bounded inbound CALLS. Edited files use published spans only when the base bytes match the publication. Each seed declares its span basis. Mixed bases add IMPACT_MIXED_SYMBOL_SPANS. Graph-derived callers are labeled direct/transitive with causal paths, explicit proof-backed vs heuristic evidence class, and area aggregation; uncertain semantic references stay separate, and completeness reasons disclose traversal and evidence limits. |
| `file_outline` | List indexed symbols and spans in one file. Edited files retain published coordinates with stale-source warnings, and a symbol whose current declaration was proven against the current bytes also reports its current span. Exact Python functions and methods can request on-demand structural analysis; relationship_coverage exposes per-file observed ResolutionClaim construct calibration. |
| `read_file` | Read a bounded source span or one exact indexed symbol. Large ranges are compacted so agent UIs receive structure instead of implementation floods. |
| `list_codebases` | List known indexed repositories, readiness, and runtime-owner state. Use it to discover existing publications before creating another one. |
| `run_script` | Run JavaScript and return selected results. Combine Satori repository reads with explicitly allowlisted downstream MCP tools in the same script, or run plain computation. |

<!-- TOOLS_END -->

## Runtime boundaries

- Source reads are scoped to authorized searchable roots. Use native tools to edit code.
- Call-graph evidence is bounded by language and source coverage. Confirm important inbound relationships with exact occurrences, source reads, or tests.
- A failed index mutation leaves the previous completed Publication in place. Cancel supervised create, reindex, and sync operations by their exact operation ID.
- Provider, model, dimensions, and vector storage participate in index compatibility. Incompatible live runtimes cannot mutate the same index.
- Offline managed sessions can share a private local host. Connected runtimes use per-client servers.
- Voyage reranking is explicit and sends queries and projected code excerpts to Voyage AI. Offline LateOn runs on the local CPU. When a reranker fails, search returns retrieval order with a diagnostic.

See the [runtime reference](https://github.com/ham-zax/satori/blob/master/docs/REFERENCE.md#runtime-choices) for provider settings and the [local development guide](https://github.com/ham-zax/satori/blob/master/docs/LOCAL_DEV_MCP.md) for testing an unreleased MCP server.

## Development

```bash
pnpm --filter @satori-code/mcp build
pnpm --filter @satori-code/mcp test
```

## License

[AGPL-3.0-only](LICENSE). [Commercial licensing](https://github.com/ham-zax/satori/blob/master/COMMERCIAL-LICENSING.md) is available.
