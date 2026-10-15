# Codex config ownership

## Approved outcome

Install and reinstall must recognize this home's Satori launcher after Codex
rewrites its config. Comment positions must never determine ownership or the
extent of a config edit. Preserve unrelated settings and user-owned Satori
options and environment values. Protect custom commands and invalid TOML.
Hamza approved this design and a TOML parser dependency on 2026-10-15.

## Evidence and boundary

`codex mcp add` in a temporary `CODEX_HOME` removed the opening Satori marker
and moved its closing marker after another server. Reinstall then refused the
unchanged launcher wiring. A separate reproduction confirmed that the old
marker replacement deleted an unrelated server between the markers.

The owner is CLI client config handling: `client-config-mutations.ts`,
`client-config-inspection.ts`, and a focused Codex TOML module. Reuse the
existing canonical launcher ownership rule, atomic writes, and stale-file
guards. No runtime/indexing changes, personal config changes, release, or
Git operations are included. Existing marked custom commands remain custom;
comments alone no longer authorize overwriting them.

## Implementation plan

1. Add `toml-eslint-parser` and a shared Codex document reader/editor using
   resolved TOML paths and source ranges. Update only installer-owned wiring;
   preserve user values and unrelated bytes. Retire marker-span replacement
   and remove old marker comments individually when editing a managed entry.
2. Use semantic launcher ownership for install/uninstall and the shared reader
   for diagnostics, presence, environment, and vector-store inspection.
3. Validate selected client config mutations before runtime downloads; discard
   that validation plan, reread after asynchronous preparation, and retain the
   existing apply-time stale-file guard.
4. Add focused regressions for Codex rewrites, displaced markers, valid TOML
   spellings, custom commands, invalid input, preserved options, uninstall,
   idempotence, and concurrent edits. Update existing fixtures invalidated by
   the approved ownership/option-preservation contract without weakening their
   original oracles.

Decision: code-change. Manual marker repair cannot prevent regeneration.
Retirement: delete internal marker authority; keep accepting existing generated
TOML by its actual launcher wiring. No fallback ownership path or new state.
TDD Route: skipped (configured `tdd_mode = "off"`); deterministic regression
checks still cover the demonstrated failure and preservation invariant.

## Verification and stopping condition

Run focused CLI config/install/preflight tests, CLI lint and typecheck, and
repository version/scope checks. A temporary native Codex rewrite followed by
Satori reinstall must succeed; repeat installation must be unchanged. Verify
invalid/custom config rejection before acquisition and apply-time stale-file
rejection. Inspect the final scoped diff and remove experiment state. Stop when
the approved behavior passes; do not publish or edit Hamza's personal config.

## Checkpoint

Implemented and verified. Initial repository status was clean. The marker
authority and text-based Codex readers were retired; no fallback owner or
extra persistent state was added. The shared launcher ownership helper moved
unchanged to `managed-runtime-paths.ts`.

261 focused tests passed across config, install, preflight, postflight,
boundaries, doctor, and reranker tests. CLI lint and typecheck passed (lint
retains three pre-existing `any` warnings in install tests); repository version
and package-scope checks passed. A native `codex mcp add` rewrite in temporary
`CODEX_HOME`, followed by full Satori install, preserved another server and the
user timeout; diagnostics passed and the second install was unchanged.

Independent read-only Luna review found one minor regression in presence
detection: invalid unrelated Codex TOML containing the word `satori` could
block another client's backend selection. Removed Codex's substring fallback
and added regression coverage. Invalid documents supply no usable server
settings; explicitly selected config mutations still reject them strictly.
The reviewer's follow-up confirmed closure, with no blocking or major findings.

The actual affected Codex config was accepted by read-only mutation planning
and remained unchanged. Full planning separately reaches an existing unmanaged
`~/.agents/skills/satori` directory conflict, outside this config repair. No
personal config, skill directory, or release was changed.
