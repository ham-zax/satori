# Satori Bridge Reliability Hardening Plan (CLI-Only)

## Summary

Stabilize `examples/pi-extension/satori-bridge` so it does not silently fail when `satori-cli` hits stdio/protocol issues.

This plan keeps the bridge **CLI-only** and fixes reliability in two layers:

1. Fix MCP stdout guard behavior so protocol bytes are not blocked in normal guard modes.
2. Add bridge-side, **safe** auto-recovery retry with `SATORI_CLI_STDOUT_GUARD=off` only for protocol/transport failures.

## Goals

- Bridge works without requiring users to manually set `SATORI_CLI_STDOUT_GUARD=off`.
- No silent failures in `/satori-mcp` health check or tool execution.
- No unsafe retries for side-effecting calls.
- Full compatibility with indexing-lock non-ok envelopes.

## Non-Goals

- No direct MCP fallback path in the bridge.
- No MCP tool surface expansion (must stay at six tools).
- No changes to indexing-lock response semantics.

## Root Cause

`installCliStdoutRedirect` currently patches low-level stdout internals (`_write`/`_writev`) in addition to top-level methods. This can intercept bytes used by MCP stdio framing, causing:

- `[STDOUT_BLOCKED_BINARY ...]`
- transport timeout / `E_PROTOCOL_FAILURE`
- bridge command failure (`Operation aborted`, timeout, parse errors)

## Public Interface / Config Changes

### MCP Runtime

- Keep `SATORI_CLI_STDOUT_GUARD=drop|redirect|off`.
- In CLI mode, if guard is `off`, emit one stable stderr line once per server process:
  - `[STDOUT_GUARD_DISABLED] SATORI_CLI_STDOUT_GUARD=off`

### Bridge

Add recovery policy controls:

- Env: `SATORI_CLI_GUARD_RECOVERY=auto|never` (default `auto`)
- Config: `"guardRecovery": "auto" | "never"` (default `auto`)

Add deterministic details metadata on bridge results:

- `attemptCount: number`
- `guardRecoveryAttempted: boolean`
- `guardRecoverySucceeded: boolean`
- `effectiveGuardMode: "drop" | "redirect" | "off"`

## Implementation

### 1) MCP stdout guard fix (mandatory root fix)

Files:

- `packages/mcp/src/server/stdio-safety.ts`
- `packages/mcp/src/index.ts`
- (verify wiring) `packages/mcp/src/server/start-server.ts`

Changes:

- In `installCliStdoutRedirect`, patch only `write`, `writev`, `end`.
- Remove patching for `_write` and `_writev`.
- Keep console patch to stderr unchanged.
- Keep protocol transport using dedicated `protocolStdout` (captured before patch).
- Keep default guard mode unchanged (`drop`).
- Emit warning when `off` is active (once per process boot).

### 2) Bridge safe auto-recovery retry (CLI-only)

File:

- `examples/pi-extension/satori-bridge/index.ts`

Changes:

- Add a unified execution wrapper used by both:
  - `listToolsThroughCli`
  - `callToolThroughCli`
- Attempt strategy:
  - Attempt 1: configured/default guard mode.
  - Attempt 2: force `SATORI_CLI_STDOUT_GUARD=off` only when retry-eligible.
- Retry eligibility (strict and deterministic):
  - Retry-eligible only for protocol/transport failures:
    - exit code `3`, or
    - no parseable JSON tool response + retryable signatures (`E_PROTOCOL_FAILURE`, `STDOUT_BLOCKED_*`, empty stdout, JSON parse failure).
  - Retry-forbidden when stdout produced a parseable tool response:
    - `isError: true`
    - parseable `content` array CallTool shape
    - parseable structured envelope in `content[0].text` with `status` (including non-ok statuses such as `not_ready`, `requires_reindex`, `not_indexed`).
  - Retry-forbidden for exit code `2`.
  - Retry-forbidden for indexing lock/freshness responses (for example `status:"not_ready", reason:"indexing"` and `freshnessDecision.mode:"skipped_indexing"`).
- Side-effect safety denylist:
  - Never auto-retry `manage_index` calls by default (create/reindex/sync/status/clear).
  - Exception allowed only if attempt 1 failed before handshake/request dispatch is confirmed (startup/connect stage failure only).
- Add sticky mode:
  - If forced-`off` retry succeeds once, reuse `effectiveGuardMode=off` for remaining bridge process lifetime.
- If both attempts fail, return one deterministic combined error.

### 3) `/satori-mcp` command hardening

File:

- `examples/pi-extension/satori-bridge/index.ts`

Changes:

- Reuse the same retry wrapper as tool calls.
- Keep UI command non-blocking.
- Ensure deterministic error notification and no uncaught exception path.
- Include guard/recovery status in debug details.

### 4) Docs/config alignment

Files:

- `examples/pi-extension/satori-bridge/README.md`
- `examples/pi-extension/satori-bridge/config.example.json`
- `examples/pi-extension/satori-bridge/skills/satori-mcp/SKILL.md` (if guard guidance exists)

Changes:

- Remove wording that manual `off` is broadly recommended by default.
- Document:
  - default guard is `drop`
  - auto-recovery to `off` is protocol-failure-only
  - tool-level non-ok envelopes do not trigger retry

## Tests (must add/adjust in same patch)

### A) MCP stdio guard tests

- Ensure `_write`/`_writev` are not patched.
- Ensure `write`/`writev`/`end` are patched as expected.
- Ensure `off` mode warning is emitted once.

### B) MCP protocol smoke

- Start server in `SATORI_RUN_MODE=cli` with default guard (real server path).
- Connect client and run `tools/list`.
- Assert success (no protocol timeout/corruption).
- This is mandatory. If full lazy startup is not yet available in CI, keep an equivalent local smoke gate and add CI once lazy startup is proven.

### C) Bridge retry behavior tests

- Protocol failure on attempt 1, success on attempt 2 with `off`.
- Both attempts fail -> deterministic combined error.
- Valid non-ok envelope (`status:"not_ready", reason:"indexing"`) does not retry.
- Valid `isError:true` does not retry.
- Parseable CallTool JSON response shape does not retry, even when non-ok.
- Exit code `2` does not retry.
- `manage_index` does not auto-retry except startup/connect-stage failure.
- Sticky `effectiveGuardMode=off` is reused after successful recovery.
- `/satori-mcp` failure path always reports deterministic connection failure.

## TDD Order (required)

1. MCP guard patch + stdio-safety unit tests.
2. MCP real-server CLI-mode `tools/list` smoke.
3. Bridge classifier tests (retryable vs non-retryable matrix).
4. Bridge retry wrapper implementation + sticky mode tests.
5. Side-effect denylist tests (`manage_index` no retry).
6. `/satori-mcp` non-blocking and deterministic failure reporting tests.
7. Docs/config sync.

## Acceptance Criteria

- `satori-cli tools list` succeeds under default guard in patched runtime.
- Bridge health check works without manual guard override.
- Bridge recovers automatically from protocol-corruption signatures.
- No duplicate side effects from retries.
- Indexing-lock envelopes are treated as tool-level outcomes, not transport failures.

## Assumptions

- Bridge transport remains CLI-only.
- Recovery default is `auto`.
- `off` remains an escape hatch, not the default.
- Existing six-tool MCP contract is unchanged.
