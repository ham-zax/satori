# @zokizuan/satori-cli

Installer, diagnostics, and command-line access for [Satori](https://github.com/ham-zax/satori).

The CLI installs one managed MCP runtime, writes a stable launcher under `~/.satori/`, configures Codex, Claude Code, OpenCode, or all three, and verifies the installed protocol path. The default qualified offline install gives those agents natural-language repository search using local Potion embeddings, BM25, LateOn reranking, and LanceDB without requiring a model API key after installation.

## Quick Start

Offline on Linux x64 or Windows through WSL2, no global install required:

```bash
npx -y @zokizuan/satori-cli@latest install
npx -y @zokizuan/satori-cli@latest doctor
```

For a persistent `satori` command:

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

The package installs the `satori` command. Run `satori` without arguments for
human-readable help.

For the default offline Potion + LanceDB runtime on Linux x64/WSL2, LateOn D32
reranks the bounded query-time candidate set. D32 is operationally qualified but
not held-out qualified; it became the managed offline default through an
explicit owner activation decision scoped to Linux x64/WSL2 managed offline
installations. The installer downloads its pinned Apache-2.0 model closure once
into `~/.satori/models/`, verifies every artifact, and reuses it across MCP
upgrades. `--reranker none` is the explicit opt-out: it keeps the selected
embedding provider plus baseline ordering (exact + BM25 + single vector) - with
Ollama embeddings that is the Ollama model plus baseline ordering, not "Potion +
BM25". The runtime also falls back to that baseline automatically on any LateOn
failure; automatic failure fallback and explicit opt-out are different
concepts. Compatible
clients attach through one private local host instead of each starting a full
MCP runtime. Each client still has its own MCP session and continuations. The
shared host idles out after disconnect and is not used for Voyage, Milvus, or
explicit Ollama runtimes.

Connected Voyage runtime:

```bash
satori install --client all --runtime voyage
satori doctor
```

Restart the MCP client after installation.

Use `satori upgrade` to update the globally installed CLI, then stage and activate that release's exact MCP and Core versions. `satori update` is an exact alias. Without a global CLI, use `npx -y @zokizuan/satori-cli@latest upgrade`. The CLI update happens first. If MCP/Core verification fails, the updated CLI remains installed and the managed launcher is left unchanged; correct the reported problem and run the command again. Client configuration, indexes, hooks, and repository profiles are not rewritten.

The command reports progress before each potentially slow phase:

```text
Checking latest Satori release...
Installing MCP <version> and Core <version>...
Verifying candidate runtime...
Activating verified runtime...
```

The latest CLI manifest is the release authority: it names one exact MCP/Core closure. Upgrade never mixes independently selected `latest` versions, so an MCP or Core release becomes available through `satori upgrade` only after a compatible CLI release points to it.

For a no-install invocation, replace `satori` with `npx -y @zokizuan/satori-cli@latest`.

The offline package carries a checksum-pinned 36.0 MiB Potion model/helper
closure. The default LateOn reranker adds one shared download of about 72 MB,
not one copy per MCP runtime version. A representative Satori publication
indexed 10,830 chunks in 34.46 seconds on CPU, with 154.543 ms warm-search p95
after publication.

The qualified native deployment contract requires at least 2 GiB of available
runtime capacity. This is a deployment allowance, not measured steady
consumption: earlier integration evidence observed a 1,447.21 MiB incremental
publication peak. A later six-publication run established bounded retained
capacity, not a proven plateau or multi-day guarantee.

## Commands

```text
install [--client auto|all|codex|claude|opencode]
        [--runtime offline|voyage] # defaults to offline Potion + LateOn D32
        [--vector-store lancedb|milvus]
        [--ollama-model <model>]
        [--reranker lateon|none]
        [--profile default|minimal|all-text]
        [--dry-run]
        [--install-guidance-hook]

doctor [--verbose] [--json]
version # aliases: -v, --version
upgrade # alias: update
terminate
uninstall [--client auto|all|codex|claude|opencode] [--dry-run] # defaults to all supported clients
tools list
tool call <toolName> --args-json '<json>'
tool call <toolName> --args-file <path>
<toolName> [schema-driven flags]
```

Codex receives one managed Satori block in `~/.codex/AGENTS.md` by default.
The block recommends Satori for semantic ownership and freshness-aware
discovery, and the usual/native workflow for known paths, exact literals, and
small local edits. `--install-guidance-hook` additionally writes one opt-in
`SessionStart` reminder to `~/.codex/hooks.json`; it preserves unrelated hook
entries and may require Codex's one-time hook trust review.

Global flags must precede the command token:

```text
--startup-timeout-ms <n>
--call-timeout-ms <n>
--format json|text
--debug
```

`doctor` prints a concise human summary by default, including an
applied-runtime table for Codex, Claude Code, and OpenCode. The table reports
configuration status, effective profile, embedding provider/model/dimension,
reranker, vector store, and configuration source without exposing credentials
or local artifact paths. A launcher that targets a local repository build keeps
its outside-managed-store warning, but the table still reports the profile that
launcher actually applies. Use `doctor --verbose` for paths, individual
successful checks, package sources, and local diagnostics. Use `doctor --json`
or the compatible global form `--format json doctor` for the complete
machine-readable result, including `runtimeConfigurations`.

`install`, `upgrade`, and `uninstall` also print concise human summaries by default. Put `--format json` before the command for a structured receipt without interactive progress text, or use `--debug` to expose MCP startup details during install verification.

`satori -v`, `satori --version`, and `satori version` print the installed CLI,
MCP runtime, and Core versions. Put `--format json` first for structured output.

`satori terminate` gracefully stops every verified Satori runtime owner and
shared host under the active state root. Provider workers close through the
normal server lifecycle. The command does not uninstall clients or delete
indexes. Put `--format json` first for a structured termination receipt.

## Runtime Ownership

The installer persists non-secret runtime identity in its managed launcher. Provider keys and Milvus credentials remain client-owned environment values. Reinstall preserves compatible managed selections and rejects conflicting explicit provider or backend configuration instead of silently overriding it.

Use `satori.toml` only for repository index policy:

```toml
[index]
profile = "minimal"
```

Do not place provider keys, model names, or backend credentials in `satori.toml`.

Supported runtime paths include bundled Potion + LanceDB, Voyage + LanceDB, explicit loopback Ollama + LanceDB, and connected Voyage + Milvus/Zilliz. Native Windows and macOS are not supported in this release; Windows users should install inside WSL2.

## Development

```bash
pnpm --filter @zokizuan/satori-cli build
pnpm --filter @zokizuan/satori-cli test
pnpm run release:smoke:cli
```

Node.js 22.13 or newer is required.

## License

Copyright (c) 2026 Hamza (@ham-zax)

Satori is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](./LICENSE).

Alternative commercial licensing terms are available separately from the copyright holder.

