# Self-contained distribution

Status: deferred. Recorded 2026-09-27.

## Question

Should Satori install through a `curl | sh` (and PowerShell) script, the way
codebase-memory-mcp does, instead of `npx @satori-code/cli install`?

## What codebase-memory-mcp actually does

- It ships one self-contained native executable per platform (macOS arm64/amd64,
  Linux arm64/amd64, Windows amd64) with SHA-256 checksums on GitHub Releases.
- `install.sh` only downloads and verifies that binary, then runs
  `codebase-memory-mcp install`; all agent integration lives in the binary.
- The same binary is delivered through many channels: the script, npm, PyPI,
  Homebrew, Scoop, winget, AUR, and Chocolatey. Its npm package downloads the
  binary in a `postinstall` script, which newer npm/pnpm script policies block.
  That is one reason the script is its preferred path.

The script works for codebase-memory-mcp because the artifact is a single file
with no language runtime. The script is a consequence of the artifact shape,
not an independent UX win.

## Why Satori does not use a script today

- Satori is a Node program with native Node add-ons (LanceDB, onnxruntime) plus
  the Potion helper. A script would still need Node and npm, and would end up
  running the same `npm install` that `npx` runs.
- npm's install-script blocking does not affect Satori: the managed runtime is
  installed with `npm install --ignore-scripts`, and native binaries come from
  explicit per-platform packages. A fresh install on npm 12.0.2 needed no
  script approval.
- Measured install (Linux x64, cold npm cache): about 60 s first install, about
  8 s repeat, about 3 s uninstall. The dominant cost is the runtime
  `npm install` (about 35 s), not model downloads.

## Proposal

Build one self-contained Satori executable per platform, then make every
channel a thin downloader for it:

1. Produce a single executable per platform with Node's single-executable
   applications (SEA) or an equivalent bundler, embedding the MCP server, Core,
   and CLI.
2. Ship native add-ons (LanceDB, onnxruntime) and the Potion helper as
   per-platform release assets next to the executable, verified by checksum,
   since they cannot be embedded in a SEA blob directly.
3. Attach executables plus `checksums.txt` to GitHub Releases.
4. Add channels, all delivering the same artifact:
   - `install.sh` / `install.ps1`: download, verify, run `satori install`
     (wrap the body in a function so an interrupted pipe never runs a
     partial script).
   - Homebrew tap and Scoop/winget manifests.
   - The existing npm package, changed to resolve the platform binary through
     `optionalDependencies` (no `postinstall`), so script policies never
     block it.
5. Keep models out of the executable; they continue to come from the managed
   model cache (`~/.satori/models`).

## Costs and risks

- Per-platform build matrix (Linux, macOS, Windows × arm64/x64) and native
  module packaging for each.
- Code signing and notarization for macOS and Windows; unsigned binaries hit
  SmartScreen/Gatekeeper prompts.
- Potion currently supports Linux x64 only; other platforms need helper builds
  first or would fall back to Ollama.
- Estimated as a multi-week project.

## When to do it

Worth it when either is true:

- Satori targets users without Node installed.
- Satori supports more platforms than Linux x64 and wants one-command installs
  on each.

Until then, `npx … install` stays the single entry point. The immediate UX
work (visible progress during runtime install, a clear first prompt after
install, and a full uninstall) delivers most of the perceived benefit.

A cheap intermediate step, if wanted: a tiny `install.sh` that checks for a
supported Node version, prints a friendly remediation when it is missing, and
then runs `npx -y @satori-code/cli@latest install`.
