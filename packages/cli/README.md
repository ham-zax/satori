# @zokizuan/satori-cli

Installer, diagnostics, and command-line access for [Satori](https://github.com/ham-zax/satori).

The CLI installs one managed MCP runtime, writes a stable launcher under `~/.satori/`, configures Codex, Claude Code, OpenCode, or all three, and verifies the installed protocol path.

## Quick Start

Offline on Linux x64 or Windows through WSL2:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime offline
npx -y @zokizuan/satori-cli@latest doctor
```

Connected Voyage runtime:

```bash
npx -y @zokizuan/satori-cli@latest install --client all --runtime voyage
npx -y @zokizuan/satori-cli@latest doctor
```

Restart the MCP client after installation.

## Commands

```text
install [--client all|codex|claude|opencode]
        [--runtime voyage|offline]
        [--vector-store lancedb|milvus]
        [--ollama-model <model>]
        [--profile default|minimal|all-text]
        [--dry-run]
        [--install-guidance-hook]

doctor
uninstall [--client all|codex|claude|opencode] [--dry-run]
tools list
tool call <toolName> --args-json '<json>'
tool call <toolName> --args-file <path>
<toolName> [schema-driven flags]
```

Global flags must precede the command token:

```text
--startup-timeout-ms <n>
--call-timeout-ms <n>
--format json|text
--debug
```

## Runtime Ownership

The installer persists non-secret runtime identity in its managed launcher. Provider keys and Milvus credentials remain client-owned environment values. Reinstall preserves compatible managed selections and rejects conflicting explicit provider or backend configuration instead of silently overriding it.

Use `satori.toml` only for repository index policy:

```toml
[index]
profile = "minimal"
```

Do not place provider keys, model names, or backend credentials in `satori.toml`.

## Development

```bash
pnpm --filter @zokizuan/satori-cli build
pnpm --filter @zokizuan/satori-cli test
pnpm run release:smoke:cli
```

Node.js 22.13 or newer is required. Satori is MIT licensed.
