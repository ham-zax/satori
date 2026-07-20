# @zokizuan/satori-cli

Installer, diagnostics, and command-line access for [Satori](https://github.com/ham-zax/satori).

The CLI installs one managed MCP runtime, writes a stable launcher under `~/.satori/`, configures Codex, Claude Code, OpenCode, or all three, and verifies the installed protocol path.

## Quick Start

Offline on Linux x64 or Windows through WSL2:

```bash
npx -y @zokizuan/satori-cli@latest install --client all
npx -y @zokizuan/satori-cli@latest doctor
```

Connected Voyage runtime:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime voyage
npx -y @zokizuan/satori-cli@latest doctor
```

Restart the MCP client after installation.

The offline package carries a checksum-pinned 36.0 MiB Potion model/helper closure. A representative Satori publication indexed 10,830 chunks in 34.46 seconds on CPU, with 154.543 ms warm-search p95 after publication.

## Commands

```text
install [--client all|codex|claude|opencode]
        [--runtime offline|voyage] # defaults to offline Potion
        [--vector-store lancedb|milvus]
        [--ollama-model <model>]
        [--profile default|minimal|all-text]
        [--dry-run]
        [--install-guidance-hook]

doctor [--verbose] [--json]
uninstall [--client all|codex|claude|opencode] [--dry-run]
tools list
tool call <toolName> --args-json '<json>'
tool call <toolName> --args-file <path>
<toolName> [schema-driven flags]
```

Codex receives the Satori skill and a conditional AGENTS guidance block by default. `--install-guidance-hook` additionally writes one opt-in `SessionStart` reminder to `~/.codex/hooks.json`; it preserves unrelated hook entries and may require Codex's one-time hook trust review. The reminder presents Satori as an option for semantic or freshness-aware discovery rather than requiring it for every task.

Global flags must precede the command token:

```text
--startup-timeout-ms <n>
--call-timeout-ms <n>
--format json|text
--debug
```

`doctor` prints a concise human summary by default. Use `doctor --verbose` for paths, individual successful checks, package sources, and local diagnostics. Use `doctor --json` or the compatible global form `--format json doctor` for the complete machine-readable result.

`install` and `uninstall` also print concise human summaries by default. Put `--format json` before the command for a structured receipt, or use `--debug` to expose MCP startup details during install verification.

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

Node.js 22.13 or newer is required. Satori is MIT licensed.
