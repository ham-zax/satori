# Satori CLI v1.1: Shell CLI With MCP as SSOT (Hardened stdio)

## Summary
Add a new `satori-cli` binary inside `@zokizuan/satori-mcp` that can be used by any agent via shell, without an MCP adapter.

The CLI spawns the existing MCP server as a child process over stdio and uses the MCP SDK Node client pattern:
`Client + StdioClientTransport + tools/list + tools/call`.

Tool contracts remain owned by MCP; CLI reflects tool changes dynamically via `tools/list`.

Hard requirement: no stdio corruption. Child stdout is protocol-only.

## Implementation Status (Current Patch)
- [x] Bootstrap/server split with ESM-safe dynamic import after stdio patching.
- [x] `SATORI_RUN_MODE=cli` startup gating (`verifyCloudState`, watcher mode, background sync not started).
- [x] `satori-cli` command surface (`tools list`, `tool call`, wrapper mode, `--args-json`, `--args-file`, `--args-json @-`).
- [x] Envelope-aware exit mapping (`isError=true` and `status!="ok"` both exit `1`).
- [x] `manage_index create|reindex` wait/poll behavior to avoid premature child shutdown.
- [x] Fake-server integration tests (well-behaved, corrupted stdout, non-ok envelope, manage wait).
- [x] Stdout-safety unit tests (`console` patch + cli stdout guard).
- [ ] Real-server cli-mode smoke in CI (enable only after lazy startup guarantee for external providers is fully enforced).

## Scope
- Add `satori-cli` bin.
- Refactor MCP server entry to a bootstrap + shared server factory.
- Add explicit `SATORI_RUN_MODE=cli` minimal mode.
- Add schema-subset wrapper flags with deterministic behavior and guaranteed fallback to `--args-json` / `--args-file`.
- Add CI-safe tests (fake MCP server + one real-server smoke in cli mode that requires no external services only after lazy-startup guarantee is enforced).

## Non-goals
- No reimplementation of tool logic outside MCP.
- No new MCP tools (surface remains exactly 6).
- No full JSON Schema engine for CLI flags.

## Public Interface Changes

### New binary
- `satori-cli` published as part of `@zokizuan/satori-mcp`.

### Commands
Reserved subcommands: `tools`, `tool`, `help`, `version`.
Anything else is treated as a tool name.

- `satori-cli tools list`
- `satori-cli tool call <toolName> --args-json '<json>'`
- `satori-cli tool call <toolName> --args-file <path>`
- `satori-cli tool call <toolName> --args-json @-` (read JSON from stdin)
- `satori-cli <toolName> [schema-driven flags...]` (schema subset; otherwise instruct `--args-json` / `--args-file`)

`help` and `version` must preserve the stdout JSON-only invariant:
- stdout emits JSON payloads
- human-readable text (if any) goes to stderr only

### Global flags
- `--startup-timeout-ms <n>` default `180000`
- `--call-timeout-ms <n>` default `600000`
- `--format json|text` default `json` (`text` summary prints to stderr only)
- `--debug` (stderr diagnostics)

### Output contract
- `stdout`: JSON only (either `tools/list` result or `tools/call` result)
- `stderr`: logs, human summaries, server stderr passthrough

### Exit codes
- `0` success
- `1` tool-level error (`CallTool` response `isError === true`)
- `2` CLI usage error (bad JSON, missing args in wrapper mode, unknown flags)
- `3` startup/transport/call timeout or protocol failure

Exit code `1` also applies to structured non-ok tool envelopes (`status !== "ok"`) even when MCP `isError === false`.

### Stable stderr error tokens
- `E_SCHEMA_UNSUPPORTED`
- `E_PROTOCOL_FAILURE`
- `E_STARTUP_TIMEOUT`
- `E_CALL_TIMEOUT`
- `E_TOOL_ERROR`

## Packaging / Build (Must Match Current Repo)
Update `packages/mcp/package.json`:

- Add bin entry: `"satori-cli": "dist/cli/index.js"` while keeping `"satori": "dist/index.js"`.
- Update `fix:bin-perms` to chmod both `dist/index.js` and `dist/cli/index.js` to `0o755`.
- Keep existing `files` config (`dist/**/*.js` already included).

Ensure build emits CLI:
- Update `packages/mcp/tsconfig.json` so `src/cli/**/*` and `src/server/**/*` are included, producing `dist/cli/index.js`.

Ensure executables:
- Shebang must be first line in both TS entrypoints:
  - `packages/mcp/src/index.ts`: `#!/usr/bin/env node`
  - `packages/mcp/src/cli/index.ts`: `#!/usr/bin/env node`
- Confirm `tsc` preserves shebang in emitted JS and chmod script covers both bins.

## Server Refactor (Stdout Safety + Shared Factory)

### Core rule
Patch before any imports that can log (ESM safe).

Because ESM executes imported modules before importer module body, `src/index.ts` must be a bootstrap with no project static imports and dynamic import after patching.

### Files
- `packages/mcp/src/index.ts`
- `packages/mcp/src/server/start-server.ts`
- `packages/mcp/src/server/stdio-safety.ts`

### `packages/mcp/src/index.ts` bootstrap contract
- No static imports from project code.
- Restrict bootstrap static imports to Node built-ins only.
- Read `SATORI_RUN_MODE` (default `mcp`).
- Capture protocol stdout capability before patch:
  - capture `originalStdoutWrite = process.stdout.write.bind(process.stdout)`
  - construct `protocolStdout` as a transport-compatible `Writable` wrapper whose `_write(...)` forwards to `originalStdoutWrite`
  - do not pass raw `write/once` captures directly into server start contract
- Install stdio safety patch:
  - Patch `console.log/info/warn/error/debug` to `process.stderr.write`.
  - In `SATORI_RUN_MODE=cli`, patch `process.stdout.write` to block accidental non-protocol writes.
  - In `SATORI_RUN_MODE=cli`, patch `process.stdout.end` and `process.stdout.writev` (when present) to prevent bypass.
  - In `SATORI_RUN_MODE=cli`, patch `process.stdout._write` and `process.stdout._writev` (when present) to prevent bypass.
  - Default guard behavior is `drop` (not redirect), with deterministic stderr markers.
  - Optional override: `SATORI_CLI_STDOUT_GUARD=redirect|drop` (default `drop`).
  - For binary/non-text blocked stdout chunks, emit deterministic stderr marker instead of raw binary spill.
- Dynamic-import `./server/start-server.js` after patch.
- Call `startMcpServerFromEnv({ runMode, protocolStdout })`.

### Protocol stdout preservation contract
- Do not validate/parse JSON-RPC in guard code.
- Preserve protocol writes by passing `protocolStdout: Writable` into `StdioServerTransport`.
- In `cli` mode, `StdioServerTransport` must write through `protocolStdout`, never through patched global `process.stdout`.
- Separation strategy is routing-based: non-transport stdout writes are redirected away from fd=1, transport writes use dedicated wrapper to fd=1.
- In normal `mcp` mode, do not patch `process.stdout.write`.

### `packages/mcp/src/server/start-server.ts`
- Export `startMcpServerFromEnv(options)`:
  - `runMode: "mcp" | "cli"`
  - `protocolStdout: NodeJS.WritableStream` for cli mode transport wiring
  - optional test hooks/deps for deterministic startup assertions
- Build current server components (config, embedding, context, snapshot, sync, handlers).
- Connect transport:
  - `new StdioServerTransport(process.stdin, protocolStdoutLike)` for `cli` mode
  - `new StdioServerTransport()` for normal mode
- In `cli` mode, missing `protocolStdout` is a deterministic startup failure (`E_PROTOCOL_FAILURE`, exit `3`).
- Minimal-mode invariants in `runMode=cli`:
  - Do not start `syncManager.startBackgroundSync()`
  - Do not start watcher mode
  - Do not run long startup reconciliation (`verifyCloudState()`)
  - Do not start other startup loops/timers
  - Keep on-demand tool execution behavior unchanged

### `packages/mcp/src/server/stdio-safety.ts`
- Export `installConsoleToStderrPatch()`:
  - patches `console.log/info/warn/error/debug`
  - no protocol framing logic
- Export `installCliStdoutRedirect()`:
  - used only in `SATORI_RUN_MODE=cli`
  - redirects/drops accidental stdout writes

## CLI Implementation (No Custom Framing)

### Files
- `packages/mcp/src/cli/index.ts`
- `packages/mcp/src/cli/resolve-server-entry.ts`
- `packages/mcp/src/cli/client.ts`
- `packages/mcp/src/cli/args.ts`
- `packages/mcp/src/cli/format.ts`

### Transport
- Use MCP SDK:
  - `Client` from `@modelcontextprotocol/sdk/client/index.js`
  - `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`
- Spawn server via transport:
  - `command = process.execPath`
  - `args = [resolvedDistIndexJsPath]`
  - `env = { ...process.env, SATORI_RUN_MODE: "cli" }`
  - `stderr: "pipe"` and forward bytes to parent stderr without parsing
- Do not use `MCP_ENABLE_WATCHER` for CLI behavior decisions; `SATORI_RUN_MODE` is the SSOT.

### Path resolution (cwd-independent)
- `resolve-server-entry.ts` uses `import.meta.url` to map `dist/cli/index.js` to sibling `dist/index.js`.

### Tool reflection flow
- Call `client.listTools()` once per invocation and cache in-memory.
- Wrapper mode parses using normalized schema from `tools/list` (`inputSchema` or equivalent normalized field).
- If schema is missing/non-object/unsupported, wrapper mode is disabled with deterministic error `E_SCHEMA_UNSUPPORTED` and fallback guidance.
- Execute with `client.callTool({ name, arguments })`.

### Tool result interpretation (indexing-lock aligned)
After `callTool`:
1. If `result.isError === true`, treat as tool error (`E_TOOL_ERROR`, exit `1`).
2. Else parse `content[0].text` as JSON when possible.
3. If parsed payload includes `status` and `status !== "ok"`, treat as tool error (`E_TOOL_ERROR`, exit `1`), and surface `status` + `reason` + `hints.status` on stderr summary when available.
4. If payload is not a structured envelope, treat as success unless transport/protocol errors occurred.

This preserves MCP-as-SSOT while keeping CLI automation-safe for indexing-lock envelopes:
- `status: "not_ready"` with `reason: "indexing"`
- `status: "requires_reindex"` with `reason: "requires_reindex"`
- `status: "not_indexed"` with `reason: "not_indexed"`

### Timeouts
- Apply `--startup-timeout-ms` around `client.connect(transport)`.
- Apply `--call-timeout-ms` around each `listTools` / `callTool`.
- On timeout or protocol failure:
  - best-effort `transport.close()`
  - exit code `3`
- Ensure timers are `unref()` to avoid hanging tests.

### Long-running manage actions (ephemeral-safe)
For `manage_index` with `action=create|reindex`:
1. Do not terminate immediately after first call response.
2. Poll `manage_index { action: "status", path }` on the same child process at deterministic interval.
3. Exit polling when terminal envelope/state is reached (`ok/indexed`, `indexfailed`, or `requires_reindex`).
4. Respect timeout budget (`--call-timeout-ms` or explicit wait timeout if introduced).
5. Only then close transport/process.

This prevents CLI from killing in-flight indexing before marker-based completion.

## Wrapper Flag Parsing (Schema Subset + Deterministic Fallback)
Supported subset:
- `type: string|number|integer|boolean`
- enum of primitives
- arrays of primitives (repeat flags; preserve insertion order)
- objects only via `--<key>-json '{...}'`

Unsupported schema features force fallback:
- `oneOf`, `anyOf`, `allOf`
- `$ref`
- `patternProperties`
- nested object expansion
- complex array item schemas

Determinism rules:
- Accept both `--start_line` and `--start-line` for same property.
- If both appear, last occurrence wins.
- Arrays preserve insertion order, never sorted.
- Required fields are enforced only in wrapper-flag mode.
- `--args-json` / `--args-file` / `--args-json @-` bypass wrapper enforcement.
- If raw-args mode is selected, tool-arg flags are rejected with exit `2`.
- Emit stable schema fallback error:
  - `E_SCHEMA_UNSUPPORTED: <tool>.<property> ... use --args-json/--args-file`

## Testing Strategy (CI-safe)

### Unit tests
- CLI arg parsing and exit code mapping.
- Wrapper subset parsing and fallback messages.
- Deterministic precedence and array ordering.
- `--args-json @-` stdin parsing behavior.
- stdout JSON-only enforcement in output layer.
- Envelope interpretation tests: `isError:false` + `status:not_ready|requires_reindex|not_indexed` must exit `1`.

### Fake MCP integration tests (primary regression guard)
Case A: well-behaved fake server (success path)
- Fake server supports `tools/list` and `tools/call` and writes only protocol messages to stdout.
- Fake server emits stderr noise:
  - `console.log/info/warn/error/debug`
  - `process.stderr.write("noise\\n")`
- Assert:
  - CLI stdout remains valid JSON
  - stderr noise does not fail command unless tool returns `isError: true`
  - tool assertions validate expected tool names as subset presence, not exact-count equality

Case B: intentionally corrupted fake server (failure path)
- Fake server emits non-protocol stdout noise before/around protocol messages.
- Assert deterministic failure:
  - exit code `3`
  - stderr contains `E_PROTOCOL_FAILURE`
  - stdout is empty or deterministic error JSON, but never mixed human output

Case D: indexing-lock envelope behavior
- Fake server returns `isError:false` with structured envelope payloads:
  - `status:not_ready, reason:indexing`
  - `status:requires_reindex, reason:requires_reindex`
  - `status:not_indexed, reason:not_indexed`
- Assert CLI exits `1` and emits `E_TOOL_ERROR`.

Case E: manage_index create/reindex wait behavior
- Fake server simulates `manage_index create` then status transitions over polls.
- Assert CLI keeps process alive until terminal state or timeout and does not exit immediately after first create call.

Case C: server-side stdout protection unit test
- Unit-test `installCliStdoutRedirect()` directly.
- Assert accidental `process.stdout.write(...)` in cli mode is rerouted/dropped with deterministic stderr marker behavior.

### Minimal-mode enforcement tests
- Unit tests around `startMcpServerFromEnv` with injectible hooks/deps/spies assert cli mode does not start:
  - watcher mode
  - background sync
  - startup reconciliation (`verifyCloudState`)

### Real server cli-mode smoke
- Run `satori-cli tools list` against real server with:
  - `SATORI_RUN_MODE=cli`
  - `EMBEDDING_PROVIDER=Ollama`
  - `MILVUS_ADDRESS=localhost:19530`
- CI policy:
  - CI-enabled only after startup is guaranteed lazy and does not require external services
  - prerequisite proof test: `startMcpServerFromEnv(runMode=cli)` does not initialize embedding/vector backends during startup path
  - until that guarantee exists, keep this as non-CI/local smoke and rely in CI on:
    - fake-server integration tests
    - stdio-safety unit tests
    - packaging smoke tests

### Dist packaging smoke
- `pnpm --filter @zokizuan/satori-mcp build`
- Verify:
  - `packages/mcp/dist/index.js` exists
  - `packages/mcp/dist/cli/index.js` exists
  - first line of both starts with shebang `#!`
- Run:
  - `node packages/mcp/dist/cli/index.js version`
  - `node packages/mcp/dist/cli/index.js help`

## Docs
- Update `packages/mcp/README.md` to document:
  - `satori-cli` usage and output contract
  - `SATORI_RUN_MODE=cli` semantics (no startup loops/watchers; on-demand only)
  - wrapper parsing subset + fallback behavior
- Optional: add note in `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` that CLI is a client of the same six tools and adds no new MCP surface.

## Explicit Risk Call-out
- ESM import order risk: stdio safety patch must run before importing any project modules that can log. `src/index.ts` must remain bootstrap-only with dynamic import after patch.

## TDD Execution Order (Required)

### E1. Bootstrap safety first
1. Write failing tests for stdout/stderr discipline and cli-mode startup gating.
2. Refactor `src/index.ts` and extract `start-server` to pass tests.
3. Confirm default `mcp` mode behavior is unchanged.

### E2. Minimal CLI happy path
1. Write failing tests for `tools list` and `tool call` using fake server.
2. Implement transport + routing + JSON output.
3. Add timeout handling, exit-code assertions, stable stderr error tokens, and envelope-aware non-ok detection.

### E2.1. Indexing-lock integration behavior
1. Write failing tests for `status != ok` envelope exit mapping.
2. Write failing tests for `manage_index create|reindex` wait/poll behavior.
3. Implement polling on same child process and timeout-safe termination.

### E3. Wrapper subset parser
1. Write failing tests for supported schema parsing.
2. Implement deterministic parser and required-field rules.
3. Add failing tests for unsupported schema features; implement stable fallback error.

### E4. Packaging safety
1. Write failing packaging smoke checks (bin exists, shebang, exec perms).
2. Update package config/scripts and pass checks.

### E5. Real-server smoke gate
1. Add cli-mode smoke for real server `tools list`.
2. Mark CI/local behavior per lazy-startup guarantee.

## Validation Checklist (Run Before Merge)
- [ ] `pnpm --filter @zokizuan/satori-mcp test`
- [ ] `pnpm --filter @zokizuan/satori-mcp build`
- [ ] `node packages/mcp/dist/cli/index.js --help`
- [ ] `node packages/mcp/dist/index.js --help`
- [ ] Validate stdout JSON integrity under stderr/stdout noise attempts
- [ ] Validate non-cli MCP startup behavior remains unchanged
