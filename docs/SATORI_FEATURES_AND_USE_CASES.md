# Satori Workflows

Satori helps coding agents find behavioral owners, navigate exact source, and detect when index evidence is stale. It is a read-only evidence layer, not a source editor and not a replacement for exact native lookup after a file is known.

This guide covers common tasks. The authoritative tool contracts and edge-case behavior remain in [SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md](./SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md).

## Public Surface

Satori exposes exactly six MCP tools:

| Tool | Use |
| --- | --- |
| `list_codebases` | List known roots and readiness. |
| `manage_index` | Create, reindex, sync, inspect, clear, or repair an index. |
| `search_codebase` | Find behavioral owners with freshness-aware search. |
| `file_outline` | Resolve deterministic file symbols and spans. |
| `call_graph` | Inspect bounded heuristic caller/callee context. |
| `read_file` | Read tracked files or one exactly resolved symbol. |

Filesystem `path` inputs are always absolute, but their targets differ by tool. `manage_index` and `file_outline` use a codebase root; `search_codebase` and `call_graph` accept an indexed root or subdirectory; `read_file` uses the absolute file path. Nested `file` and `symbolRef.file` values are repository-relative to the resolved root. `list_codebases` has no path input. Satori never writes source files.

## 1. Install

Use the installer rather than copying runtime paths into MCP client configuration:

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```

Supported clients are `codex`, `claude`, and `opencode`. The installer:

- installs a managed MCP runtime under `~/.satori/`;
- writes a stable launcher;
- updates supported client configuration;
- verifies the launcher, MCP handshake, canonical tool list, runtime-owner registration, and shutdown;
- checks provider configuration without indexing or searching.

Restart configured MCP clients after installation or after changing provider settings. A postflight warning about incomplete provider configuration means the launcher is installed but indexing is not ready.

### Provider Setup

Indexing needs an embedding provider and vector backend. A common local embedding setup is:

```bash
export EMBEDDING_PROVIDER=Ollama
export EMBEDDING_MODEL=nomic-embed-text
export OLLAMA_HOST=http://127.0.0.1:11434
export MILVUS_ADDRESS=localhost:19530
```

Run `satori-cli doctor` after changing environment variables, then restart every resident Satori MCP client so all processes use one runtime identity.

## 2. Create The First Index

Check state before starting expensive work:

```json
{"action":"status","path":"/absolute/path/to/repository"}
```

If the root is not indexed and provider configuration is complete, explicitly start creation:

```json
{"action":"create","path":"/absolute/path/to/repository"}
```

`create` is a kickoff operation. Its response includes a durable operation receipt. Use `manage_index status` later to inspect the same operation, phase, durable transition, and terminal result.

Do not repeatedly call `create` while indexing. A per-root mutation lease allows many readers but only one create, reindex, sync, repair, or clear operation at a time.

### Index Policy

Optional repository policy lives in `satori.toml`:

```toml
[index]
profile = "default"
```

Available profiles are `default`, `minimal`, and `all-text`. `.satoriignore` excludes repository content. Hard-denied secrets, binaries, generated artifacts, lockfiles, and similar unsafe inputs remain excluded regardless of profile.

## 3. Navigate Code

Use semantic discovery first, then exact navigation for proof.

### Find The Owner

Start with behavior rather than guessed identifiers:

```json
{
  "path":"/absolute/path/to/repository",
  "query":"where interrupted indexing is recovered"
}
```

Narrow with deterministic prefix operators when needed:

```text
lang:typescript path:packages/mcp/src must:lease interrupted indexing recovery
```

Supported operators are `lang:`, `path:`, `-path:`, `must:`, and `exclude:`. Inspect:

- `warnings` and each warning action;
- the envelope `recommendedNextAction`;
- each grouped result's canonical `target`, `quality`, and `navigation.graph` state.

Warnings are degraded evidence unless `blocksUse=true`.

### Lock The Exact Symbol

Once a candidate file is known, use `file_outline` to resolve the exact symbol and current span. Exact mode returns `ok`, `ambiguous`, `not_found`, or `not_ready`; it does not guess. Treat `not_ready` as unverified current source: synchronize when appropriate, then use a bounded direct read if verification remains unavailable.

```json
{
  "path":"/absolute/path/to/repository",
  "file":"packages/mcp/src/server/start-server.ts",
  "symbol":"verifyCloudState"
}
```

For grouped `formatVersion: 2` results, build reads from the envelope `codebaseRoot` plus `target.file`. When `target.symbolId` is present, call `read_file` with required `mode` and the one canonical exact open: `open_symbol.contractVersion=2`, exactly one of `symbolId`/`symbolLabel`, and exactly one of `context`/`continuation`. Success is one bounded structured `symbol_context` JSON package in both plain and annotated modes; accepted exact failures use bounded structured errors. When no symbol identity is present, use an unversioned direct span (`open_symbol.startLine/endLine` or top-level line range). Do not rebuild spans from prose, and do not treat exact open as a full unversioned symbol-span dump.

### Inspect Relationships

When a grouped result has `navigation.graph="ready"`, pass its `target` directly to `call_graph` with the envelope `codebaseRoot`. That state carries `navigation.inbound="verify"` because CALLS v0 is name-based and heuristic. Treat it as context, then confirm inbound impact with scoped text search, tests, or direct references. If `callerSearchTerm` is present, a separate `must:<term> <term>` search is the compact verification path.

### Read The Proof

Use `read_file` with the canonical exact `open_symbol` request for one unambiguous symbol context package, or an unversioned bounded line window when symbol evidence is unavailable. Reads are restricted to tracked searchable roots and deny `..` or symlink escapes.

After ownership and the exact path are known, `rg` and bounded native reads are appropriate for fast literal confirmation. Satori is strongest at behavioral discovery, freshness decisions, and evidence-aware navigation.

## 4. Recover An Index

Start with `manage_index status`. Use its proof and mechanically recommended next action.

| Observed state | Action |
| --- | --- |
| Ordinary tracked-file changes | Run `sync`, or let search-on-read freshness reconcile them. |
| `.satoriignore` or compatible profile changes | Run `sync` for immediate convergence. |
| `requires_reindex` or `hints.reindex` | Stop normal navigation and request explicit approval for `reindex`. |
| Trusted remote payload and fingerprint exist, but local readiness proof is missing | Run `repair`. |
| Provider configuration is incomplete | Set the missing environment variables and restart clients before interpreting index proof. |
| Another live mutation owns the root | Wait for it or stop the extra runtime identified in the response; do not bypass the lease. |
| No related remote collection exists | Run `create` with explicit approval. |

### Sync

`sync` updates ordinary file changes. It is not a substitute when compatibility evidence requires a full rebuild.

### Repair

`repair` rebuilds local readiness only when vector payload, fingerprint, completion marker, and snapshot evidence satisfy the repair contract. A refusal identifies which proof failed and directs the next valid action. It does not guess or silently create a new index.

### Reindex

`reindex` is expensive: it rebuilds provider-backed chunks. Run it only after an explicit `requires_reindex` result and user approval.

### Clear

`clear` deletes index state and is destructive. Use it only when the user explicitly asks to remove the index.

## 5. Diagnose

Run:

```bash
satori-cli doctor
```

Doctor is read-only. It checks:

- installed CLI, MCP, and core package versions;
- Node support and npm package visibility;
- embedding and vector configuration;
- managed launcher identity;
- Codex, Claude, and OpenCode wiring;
- live runtime owners and identity conflicts;
- active, abandoned, or malformed mutation leases;
- aggregated local CLI diagnostics.

Follow `nextSteps` in order. After changing configuration, restart MCP clients before retrying provider-backed work.

### Privacy-Safe Local Diagnostics

Direct tool calls made through `satori-cli` append a bounded local log under installer-owned `~/.satori/` state. `doctor` returns a deterministic aggregate as `localDiagnostics`.

The local schema records only:

- tool category;
- call duration;
- outcome and returned search-result count;
- validated warning codes;
- fallback use;
- lifecycle action and repair success.

The result count applies only to `search_codebase`; outline symbols, graph nodes or edges, listed roots, and read bytes are intentionally not combined into that metric. The log does not store source, query text, paths, symbol names, or repository identifiers. It is capped at 1,000 validated events and published through a bounded interprocess lock plus same-directory atomic replacement with user-only file permissions. Symlinked log paths are refused. Recording is best-effort and cannot change tool behavior; malformed records are skipped during reads, extra fields are ignored, and both are removed when the log is next compacted.

There is no upload mechanism. Any future upload requires explicit consent, a versioned schema, documented retention, and a preview of the exact payload.

Local diagnostics measure runtime behavior, not whether a result was useful or an edit was correct. Use the labeled useful-context evaluation harness for product-quality claims.

## Agent Workflow: Understand An Unfamiliar Feature

1. Search for the behavior in plain English.
2. Compare the top owners and inspect freshness warnings.
3. Open the leading file outline and resolve the exact symbol.
4. Inspect supported outbound relationships, or use the canonical target's read mapping when graph navigation is unavailable.
5. Read the exact symbol and only the immediately necessary collaborators.
6. Stop when the owner, invariant, and state transition are supported by current source.

Do not begin with a broad repository dump. Do not infer ownership from filename similarity alone.

## Agent Workflow: Assess Blast Radius

1. Resolve the exact changed symbol with `file_outline`.
2. Use `call_graph` for bounded inbound and outbound hints when supported.
3. Confirm inbound references with scoped exact search or `rg`.
4. Read contract tests and direct callers.
5. Separate proven callers from heuristic name matches.
6. Stop when every public contract and direct mutation path has a proof or an explicit unknown.

Call-graph output is never sole authority for edit scope.

## Agent Workflow: Debug A Failure

1. Search the exact error token with `must:` when available.
2. Search the behavior that emits or handles the failure.
3. Resolve and read the emitting symbol.
4. Trace its inputs, state transition, and recovery path.
5. Check status and freshness before trusting persisted spans.
6. Reproduce with the smallest deterministic test.
7. Stop when observed behavior, expected behavior, reachable path, mismatch, and impact are all demonstrated.

If search reports `requires_reindex`, stop navigation and report the failed proof rather than substituting `sync`.

## Agent Workflow: Verify Another Agent's Edit

1. Inspect the actual diff and preserve unrelated worktree changes.
2. Search for the changed behavior and its owner.
3. Resolve current source spans for edited symbols.
4. Confirm callers with graph hints plus direct references.
5. Read changed tests and the nearest contract tests.
6. Run the smallest deterministic proof, then proportional regression gates.
7. Report findings as evidence, impact, and action.
8. Stop when additional exploration would not change the conclusion or next action.

Generated reports, cached indexes, and another agent's summary are retrieval aids, not final authority.

## Maintainer Reference

Keep implementation detail out of this workflow guide. Maintainers should use:

- [SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md](./SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md) for authoritative behavior;
- generated MCP tool documentation for schemas and response contracts;
- package tests for executable proof;
- [Operational trust plan](./plans/OPERATIONAL_TRUST_PRODUCT_PLAN.md) for roadmap state and fixed boundaries.

When public behavior changes, update the authoritative contract, generated reference, and proving tests in the same patch.
