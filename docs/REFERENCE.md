# Satori reference

For the first install and example question, see the [README](../README.md#install). For ways to use the tools together, see the [product guide](PRODUCT_GUIDE.md).

## Client setup

The managed offline runtime supports Node.js 22.22 or newer on Linux x64 and ARM64 with glibc, including WSL2. The qualified configuration assumes at least 2 GiB of available runtime capacity. On Windows, run the installer in WSL2 so it configures the Linux clients.

```bash
npx -y @satori-code/cli@latest install
npx -y @satori-code/cli@latest doctor
```

Use `install --client <name>` to configure a specific client. These are the default paths inside the user’s home directory.

| Client | Selector | Configuration |
| --- | --- | --- |
| Codex | `codex` | `~/.codex/config.toml` |
| Claude Code | `claude` | `~/.claude.json` |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` |
| Cursor | `cursor` | `~/.cursor/mcp.json` |
| VS Code | `vscode` | `~/.config/Code/User/mcp.json` on Linux |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| Pi | `pi` | `~/.pi/agent/mcp.json` |
| Antigravity | `agy` | `~/.gemini/config/mcp_config.json` |

The default `auto` selector configures detected clients and leaves Antigravity opt-in. Use `--client agy` to select it explicitly, or `--client all` to write every supported client configuration. Use `install --dry-run` to preview changes. Restart clients after installing or changing their configuration.

For another stdio MCP client, register a server named `satori` with the path to your Node executable as the command and the absolute path to `~/.satori/bin/satori-mcp.js` as its only argument. If you have no detected client, install the shared runtime with an explicit supported selector first. The stable launcher keeps client configuration independent of the installed MCP version.

The installer puts the shared `satori` skill at `~/.agents/skills/satori/SKILL.md`. Claude Code and Antigravity receive links in their own skill directories. Use `--no-skill` to skip a new skill installation. An existing Satori-managed skill can still be refreshed.

### Optional Codex SessionStart hook

The Claude Code install writes and registers the read-only `~/.satori/bin/satori-hook.js` shim. If that file is present, Codex can reuse it. Add the following entry to the `hooks.SessionStart` array in `~/.codex/hooks.json`. Keep any existing entries and replace both paths with absolute paths from your installation.

```json
{
  "matcher": "startup|resume|clear|compact",
  "hooks": [
    {
      "type": "command",
      "command": "\"/absolute/path/to/node\" \"/home/you/.satori/bin/satori-hook.js\"",
      "timeout": 5
    }
  ]
}
```

Review and trust the handler with `/hooks` in the Codex CLI. The hook reads index state from disk and adds guidance to the session. The MCP runtime handles background indexing. For a Codex-only install without the shim, the shared skill and repository `AGENTS.md` can guide tool selection. [Codex hooks reference](https://learn.chatgpt.com/docs/hooks)

## Index lifecycle

Satori stores search, symbols, relationships, and source checkpoints in an immutable index generation called a **Publication**. A completed replacement becomes current atomically. While a compatible Publication remains readable, searches can use it with freshness warnings while a sync is pending.

Automatic indexing applies to eligible Git workspace source under the following budgets. A 50,000-file cap also applies.

| Runtime | At MCP session startup | On first eligible Satori tool call |
| --- | --- | --- |
| Offline | Up to 20 MiB | Up to 150 MiB |
| Connected | Deferred | Up to 8 MiB |

Use `install --index` from a Git repository to index it during setup or `--no-index` to skip that installer step. Wait for background work when a tool reports `not_ready` with `indexing.mode="auto_indexing"`. Use native reads in the meantime, then retry the original tool. For a repository above the automatic limits, decide whether to explicitly create an index based on its size and provider cost.

| `manage_index` action | When to use it |
| --- | --- |
| `status` | Inspect readiness, freshness, and active operation progress. Use `detail="capabilities"` for language coverage. A status check can start or join eligible automatic maintenance. |
| `create` | Explicitly create the first index when automatic indexing cannot cover the repository. |
| `sync` | Refresh indexed evidence after source or ignore-rule changes. |
| `reindex` | Rebuild after an incompatible runtime or policy change when automatic recovery is unavailable, or recover an index after a diagnosed failure. |
| `cancel` | Stop a supervised create, sync, or reindex by its exact operation ID. |
| `clear` | Remove that repository’s tracked index when deletion is intended. |

Managed offline runtimes can automatically rebuild eligible tracked indexes after a version or policy change. Check readiness before starting another job for the same root. Source freshness and recorded index age are separate. If a response warns about pending changes, verify exact code or call sites against the working tree before relying on stale indexed evidence.

## Index profiles

Place a regular `satori.toml` file at the repository root or use `install --profile <name>` from that repository.

```toml
[index]
profile = "minimal"
```

| Profile | Coverage |
| --- | --- |
| `default` | Catalogued languages, documentation, configuration, scripts, and recognized extensionless files. |
| `minimal` | Source and documentation, including files for all navigation languages. |
| `all-text` | Default coverage plus additional bounded UTF-8 text. |

Git exclusions apply first. Satori applies `.satoriignore` last, so it can override Git rules. A hard denylist protects files such as recognized secrets, dependencies, binaries, and generated output. A negation rule cannot re-include those paths. Overridable defaults cover additional paths such as vendored code and tool caches. Search defaults to `scope="runtime"` regardless of index profile. Use `scope="docs"` for documentation and `scope="mixed"` for both.

Individual searchable files are capped at 8 MiB. Structural analysis has separate limits and can be partial even when text search covers the file.

## Runtime choices

| Runtime | Embedding and storage | Requirements |
| --- | --- | --- |
| Offline, default | Potion Code 16M v2 and LanceDB, with local LateOn reranking | Qualified Linux environment. Models are downloaded during setup. |
| Connected | Voyage Code 3 and local LanceDB | `VOYAGEAI_API_KEY`. |
| Connected with remote storage | Voyage Code 3 and Milvus or Zilliz Cloud | `VOYAGEAI_API_KEY`, `MILVUS_ADDRESS`, and `MILVUS_TOKEN` where required. |

Use `install --runtime voyage` to select connected embeddings. Add `--vector-store milvus` for Milvus or Zilliz Cloud.

Changing the embedding provider, model, dimension, or vector backend can make existing indexes incompatible. Restart clients after an upgrade or runtime change so they connect with the same runtime before attempting index mutations.

Offline embeddings, reranking, and storage run locally after setup. Connected providers receive the source-derived inputs needed for embedding or reranking. Remote storage is an explicit option. Satori’s diagnostics stay local.

### Configuration

For a managed install, use the CLI to select the runtime and reranker. The installer records non-secret settings in the launcher. Set provider credentials in the MCP client’s environment. Run `satori doctor --verbose` to see the effective configuration and its sources.

For a standalone MCP process, set runtime options in its environment.

| Settings | Environment variables |
| --- | --- |
| Runtime and embeddings | `SATORI_RUNTIME_PROFILE`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_OUTPUT_DIMENSION`, `VOYAGEAI_API_KEY` |
| Vector storage | `VECTOR_STORE_PROVIDER`, `LANCEDB_PATH`, `MILVUS_ADDRESS`, `MILVUS_TOKEN` |
| Reranking | `SATORI_RERANKER_PROVIDER`, `VOYAGEAI_RERANKER_MODEL`, `SATORI_LATEON_MODEL_PATH`, `SATORI_LATEON_PROFILE`, `SATORI_LATEON_ACTIVATION_POLICY` |

### Choosing a reranker

| Option | When to use it |
| --- | --- |
| `lateon` | The offline default. Runs locally and reranks a bounded set of search candidates. |
| `voyage` | An explicit network option for either runtime. It sends queries and projected code excerpts to Voyage AI and requires `VOYAGEAI_API_KEY`. Its default model is `rerank-3-lite`. |
| `none` | Omit reranking and keep the exact, lexical, and embedding-based retrieval order. |

Use `satori reranker status` to inspect the active selection and `satori reranker use lateon|voyage|none` to change it. To choose another Voyage model, use `satori reranker use voyage --model <name>`. The CLI tests the Voyage key and model before switching unless you pass `--no-verify`. See [reranking benchmarks](BENCHMARKS.md#reranking) for measured differences.

The installer verifies and caches the pinned model files under `~/.satori/models/`. Interrupted downloads can resume. Set `HF_ENDPOINT` when you need a Hugging Face mirror. If the installer reports an unsupported older LateOn profile, reinstall with `install --runtime offline --reranker lateon`.

## CLI commands

Without the global command, replace `satori` with `npx -y @satori-code/cli@latest`. To put `satori` on your PATH, install it with `npm install -g @satori-code/cli@latest`.

| Command | Purpose |
| --- | --- |
| `satori install` | Configure clients and install the managed runtime. |
| `satori -v` | Print installed CLI, MCP, and Core versions. |
| `satori doctor --verbose` | Show launcher, runtime, and client configuration checks. Use `--json` for automation. |
| `satori upgrade` | Stage and verify a matched MCP and Core release before switching the managed launcher. |
| `satori terminate` | Stop verified Satori runtime processes while retaining client configuration and data. |
| `satori gc --dry-run` | Preview reclaimable storage. Omit `--dry-run` to apply cleanup. |
| `satori uninstall` | Remove installer-managed client configuration. |
| `satori uninstall --purge` | Also stop runtimes and delete stored models and indexes. |
| `satori tools list` | Inspect the active runtime’s tool names and schemas. |
| `satori tool call <tool> --args-json '<json>'` | Call an MCP tool directly. Use `--args-file` to supply arguments from a file. |

`satori upgrade` preserves client settings and index locations. Restart the client to pick up the activated release. Use `satori <command> --help` to see supported arguments and flags.

By default `gc` can evict idle worktree indexes and enforce an index storage budget. To restrict cleanup to retired or orphaned data, use:

```bash
satori gc --dry-run --worktree-days 0 --max-size 0
```

Review the preview before applying it. Active runtime owners can prevent Publication cleanup. Disconnect clients when safe so GC can acquire exclusive ownership.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `search_codebase` | Find behavior, configuration, and owning symbols using semantic, lexical, and exact evidence. |
| `read_file` | Read an exact symbol or a bounded source range inside an authorized searchable root. |
| `file_outline` | Inspect indexed symbols and spans in a file. |
| `architecture_overview` | Explore repository areas, boundaries, and hotspots. |
| `call_graph` | Inspect supported callers and callees for a concrete symbol. |
| `trace_path` | Find one bounded relationship path between published symbols. |
| `find_references` | Locate exact textual occurrences of a canonical symbol independently of ranking. |
| `detect_changes` | Map a Git diff to changed symbols and bounded caller evidence. |
| `continue_search` | Reveal another page of a frozen search ranking. |
| `list_codebases` | List known repositories and index readiness. |
| `manage_index` | Inspect and manage index generations and supervised operations. |

Give tools absolute paths. Follow `recommendedNextAction` from a search response and preserve the supplied `codebaseRoot` when opening exact symbols. For a direct exact-symbol `read_file` request, use `open_symbol` with `contractVersion: 2` and the published `symbolId`. Search results may point to a matched span inside a larger symbol.

In grouped search, `limit` bounds the frozen result set and `disclosureLimit` bounds the first page. Continue with the returned handle and exact next offset. A completed continuation covers that frozen set. It can still omit results beyond the limit.

## Language support

Search and bounded reads work across indexed source and text. Structural navigation depends on the file’s language and the evidence in the current Publication.

| Coverage | Examples |
| --- | --- |
| Symbols and supported call navigation | TypeScript, JavaScript, Python, Go, Java, C#, C++, Rust, Scala, Kotlin, PHP. |
| Symbols and file outlines | Swift, Ruby, Dart, Elixir, Haskell, Lua, PowerShell, and other languages covered by the definition extractors. |
| Search and bounded reads | Vue, Svelte, HTML, CSS, SQL, XML, and other indexed text outside the structural analyzers. |

C files route through a supported subset of the C++ analyzer. Language support is specific to constructions and parser coverage. Call evidence can be partial or unavailable for dynamic dispatch, ambiguous matches, and parse-error regions. Use `manage_index` capabilities for effective coverage and the [language architecture](architecture/LANGUAGE_INTELLIGENCE.md) for supported proof boundaries.

Some symbol analyzers use a separately downloaded language pack. If installation warns that the pack could not be fetched, affected languages remain searchable. Rerun `install` to retry the pack.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| The client cannot see Satori | Run `doctor --verbose`, confirm the intended client config, and restart the client. Use an explicit `--client` if auto-detection missed it. |
| Install reports an unmanaged `satori` entry | Review the existing entry and rename or remove it before reinstalling if you intend to replace it. |
| The tool reports `not_ready` | Check the operation and retry guidance in the response. Wait for the active job while using native reads. |
| The tool reports pending changes | Verify source directly. Sync when you need updated search or graph evidence. |
| The tool reports `requires_reindex` | Identify the incompatible or missing index state. Let an eligible automatic rebuild finish or use an explicit reindex once the cause and scope are known. |
| The runtime reports incompatible live owners | Stop or reconnect older clients before retrying an index mutation with the intended runtime. |
| Voyage rejects a reranker or model | Verify the key and model name. Failed validation leaves the previous selection in place. |

For a checkout build, see [local MCP development](LOCAL_DEV_MCP.md). For contributing and release qualification, see the [documentation index](README.md).
