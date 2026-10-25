# Reranker selection plan

Written 2026-10-13 against `master` at `a710008a` plus the uncommitted work
listed under [Baseline](#baseline). Status: plan only; decisions answered 2026-10-13. Nothing in this document
is implemented. Measurements that motivate it are in
[Voyage rerankers and definition fusion](voyage-reranker-and-definition-fusion.md).

A written plan is warranted because the change crosses three packages, opens a
public configuration value, moves a privacy boundary and changes installer
state that survives upgrades.

## Goal

A user can switch the reranker from the CLI, without editing environment
variables by hand:

- **offline**: the local LateOn model (today's default);
- **online**: Voyage, with any model name the user types;
- **none**: no reranking.

The model name is not checked against a list in Satori. Whatever the user
types is sent to the provider. If the provider rejects it, the user sees the
provider's own error.

Other online providers are a documented extension point, not built.

## Requested outcomes and where each is delivered

| Outcome (Hamza, 2026-10-13) | Delivered by |
|---|---|
| No fixed list of accepted model names | Tasks 1, 2 |
| A rejected name does not switch anything; the CLI shows Voyage's message | Task 7 (Task 4 for a name set in the environment) |
| Choose Voyage at install time with a flag | Tasks 5, 6, 7 |
| `rerank-3-lite` is the Voyage model when none is named | Tasks 1, 2, 5 |
| Switch reranker from the CLI: offline, online, none | Tasks 5, 6, 7 |
| After choosing Voyage, pick any of its models | Tasks 5, 6 |
| Other providers kept as a placeholder | Task 5 (one table), Task 8 (docs) |
| Fusion is not touched | [Out of scope](#out-of-scope) |

## Decisions

These change public behaviour or a privacy boundary. Hamza answered all four on
2026-10-13. Each answer is recorded under its question, and the tasks are
written for those answers.

**D1. May the offline runtime call Voyage for reranking?**
Today it may not: `SATORI_RERANKER_PROVIDER=voyage` is rejected under the
offline runtime's local-only network policy (`packages/mcp/src/config.ts:524`,
`packages/cli/src/runtime-config.ts:233`,
`packages/cli/src/runtime-selection.ts:76`, `packages/cli/src/args.ts:391`).
The measured gain (MRR 0.5557 to 0.7798) was produced with exactly that
combination: local Potion embeddings, local LanceDB, Voyage reranking.
That measurement is dated 2026-10-13: it precedes the `5f96827c` rubric change and `0a2aa66c`,
and it uses Voyage's native document. At `fb125738` the same comparison reads 0.5664 to 0.8810,
because Voyage now receives the canonical projection.

- *Recommended:* allow it, only when the user explicitly selects Voyage. It is
  never inferred from the presence of an API key. Embeddings and the vector
  store stay local-only. `status` and `doctor` state that the query and code
  excerpts are sent to Voyage.
- *Alternative:* Voyage reranking only in the connected runtime
  (`--runtime voyage`). Then Tasks 3 and the offline half of Task 6 are dropped,
  and the measured configuration is not available to users.

*Answer:* allowed, by explicit selection. The install command takes the choice
as a flag (`--reranker voyage`), and the documentation may recommend it for
better ranking.

**D2. What happens at search time when the provider rejects the request?**
Today every search silently falls back to retrieval order with the generic
warning "The reranker failed, so results use retrieval ranking only."

- *Recommended:* keep returning results, and put the provider's status and
  message, with the configured model name, in that warning (Task 4). In
  addition `satori reranker use voyage` makes one small test call and refuses
  to switch if the provider rejects it (Task 7), so a wrong name fails at the
  moment it is typed.
- *Alternative:* fail the search outright on a permanent provider error. This
  breaks the documented rule that reranker failure falls back to baseline
  ordering (`docs/REFERENCE.md`, "Offline Local Reranking").

*Answer:* when Voyage rejects the name, nothing is switched and the CLI tells
the user what Voyage said. Searches are not failed.

Voyage has no endpoint that lists its models. Checked 2026-10-13:
`GET /v1/models`, `/v1/rerank/models` and `/v1/models/rerank` return 404, and
the API reference index lists no such endpoint. So Satori keeps no list and
fetches none. The rejection itself carries the current list:

```text
HTTP 400
{"detail":"Model rerank-no-such-model is not supported. Supported models are
['rerank-lite-1', 'rerank-2-lite', 'rerank-2', 'rerank-3', 'rerank-3-lite',
'rerank-2.5', 'rerank-2.5-lite']."}
```

The CLI prints that message unchanged, so the user always sees Voyage's own
current list without Satori maintaining one.

Task 4 is kept for a name set directly in the environment, which never passes
through the CLI check. That is an assumption about the answer; Task 4 can be
dropped without affecting the other tasks.

**D3. Default Voyage model when none is named.**
*Recommended:* keep `rerank-2.5` (today's default) until Task 9 has measured the
shipped path. Changing the default is then a one-line change with evidence.

*Answer:* `rerank-3-lite`, wherever Voyage reranking is used and no model is
named. Today three places disagree (`rerank-2.5-lite` in the core class,
`rerank-2.5` twice in MCP); Tasks 1 and 2 reduce them to one constant.

**D4. Command wording.**
*Recommended:*

```text
satori reranker use lateon
satori reranker use voyage [--model <name>]
satori reranker use none
satori reranker status
satori install --reranker lateon|voyage|none [--reranker-model <name>]
```

`offline` is accepted as another spelling of `lateon`. `enable` and `disable`
keep working as `use lateon` and `use none`.

*Answer:* agreed.

## Architecture

Reranker choice already has one owner per package. The plan keeps those owners
and removes the duplicated lists inside them.

- **Core** (`packages/core/src/reranker/voyageai-reranker.ts`) owns the Voyage
  HTTP call and its failure classification. It stops constraining the model
  name.
- **MCP config** (`packages/mcp/src/config.ts`) owns parsing
  `SATORI_RERANKER_PROVIDER` and `VOYAGEAI_RERANKER_MODEL` and the rule for
  which provider is legal under which network policy.
  `packages/mcp/src/server/provider-runtime.ts` constructs the reranker and
  needs no logic change.
- **MCP search** (`packages/mcp/src/core/search-rerank-execution.ts`) owns what
  a failed rerank reports.
- **CLI** owns the installed launcher's environment. A new
  `packages/cli/src/reranker-providers.ts` becomes the single table of
  providers. It replaces four separate hard-coded lists:
  `runtime-config.ts:30`, `doctor.ts:158`, `args.ts:377` and
  `runtime-selection.ts:76`.

The CLI and MCP packages are published separately and the CLI does not depend
on MCP, so each keeps its own provider list. Task 8 documents that adding a
provider touches both.

No new environment variable is introduced. `VOYAGEAI_RERANKER_MODEL` already
exists and is already part of the shared runtime identity
(`packages/mcp/src/server/shared-runtime-identity.ts:170`), so changing the
model already separates runtime owners correctly.

## Tech stack

TypeScript, pnpm workspace, `node:test` through `tsx`. No new dependency. The
CLI test call in Task 7 uses Node's built-in `fetch`.

## Baseline

- Branch `master`, `a710008a`.
- Uncommitted, to be kept as is: core fusion credit fix (three files), the
  model-keyed definition-fusion switch and `rerank-3` / `rerank-3-lite`
  acceptance (five files). See the results document, "Changes in the working
  tree". Whether these are committed before execution starts is Hamza's call;
  the executor must not commit, stage or revert them.
- Green baseline to confirm before Task 1:

```bash
cd /home/hamza/repo/satori
pnpm --filter @satori-code/core build
pnpm --filter @satori-code/core exec node --import tsx --test src/reranker/voyageai-reranker.test.ts
pnpm --filter @satori-code/mcp exec node --import tsx --import ./src/test-state-root.ts --test \
  src/core/search-execution.native-order.test.ts src/core/search-definition-discovery.test.ts \
  src/server/runtime-bootstrap.test.ts src/server/shared-runtime-identity.test.ts
pnpm --filter @satori-code/cli exec node --import tsx --test \
  src/args.test.ts src/runtime-config.test.ts src/install-preflight.test.ts src/doctor.test.ts
```

Known and unrelated: the full core suite exits 1 because six
`src/generation/` files exceed the per-file time budget. Do not fix it here.

## Compatibility boundary

Kept:

- `SATORI_RERANKER_PROVIDER` values `lateon`, `voyage`, `none`.
- `satori reranker enable|disable|status [--purge]` and
  `satori install --reranker lateon|none`.
- LateOn stays the default for a new offline install. Voyage is never selected
  by default in the offline runtime.
- Reranker failure still returns results in retrieval order.
- The exported type name `VoyageRerankerModel` (now an alias of `string`).

Changed:

- An unknown `VOYAGEAI_RERANKER_MODEL` used to be replaced silently by
  `rerank-2.5`. It is now sent as typed.
- `VOYAGEAI_RERANKER_MODEL` unset used to mean `rerank-2.5`. It now means
  `rerank-3-lite` (D3). This reaches existing connected-runtime users who have
  a Voyage key and never set a model: their reranker changes, and definition
  fusion is skipped for it. That combination (Voyage embeddings, Milvus,
  `rerank-3-lite`) has not been measured.
- The offline runtime accepts an explicit Voyage reranker (D1).
- `VOYAGEAI_RERANKER_MODEL` becomes launcher-owned, like
  `SATORI_RERANKER_PROVIDER`. A value set only in a client's own config is
  overridden by the launcher after the next install or `reranker use`.

The API key is never written to the launcher. `VOYAGEAI_API_KEY` stays a
pass-through from the client's environment.

## TDD route

Mode `auto`, decision `strict`. Reason: behaviour change on a public
configuration value, a network-permission rule, and installer state shared by a
producer (CLI) and a consumer (MCP). Authority: this auto decision and the
repository rule to write failure-path tests before the fix. Each task writes
its test first, sees it fail for the stated reason, then makes the change.
Tests use fake `fetch` and temporary home directories; none calls Voyage.

## Tasks

Run in order. One task per worker turn. After each task run only the command
listed for it; do not run the full suites until Task 8.

### Task 1. Core accepts any Voyage model name

Files: `packages/core/src/reranker/voyageai-reranker.ts`,
`packages/core/src/reranker/index.ts`,
`packages/core/src/reranker/voyageai-reranker.test.ts`.

- `export type VoyageRerankerModel = string;` Config, field, `getModel` and
  `setModel` follow from it.
- Export `DEFAULT_VOYAGE_RERANKER_MODEL = 'rerank-3-lite'` from the reranker
  file and from `reranker/index.ts`. The class default (line 122, today
  `rerank-2.5-lite`) uses it. An existing test that asserts the old class
  default changes its expected value to the constant; say so in the report.
- `getSupportedModels()` returns `Record<string, …>` and is described as known
  limits for documented models, not a list of what is accepted. It has no
  consumer outside its own file.
- Tests first: (a) a model name absent from that table reaches the request body
  unchanged; (b) an HTTP 400 with a body yields `RerankerRequestError` with
  kind `permanent_http`, status 400, one attempt, and a message containing the
  body text.

Verify: `pnpm --filter @satori-code/core exec node --import tsx --test src/reranker/voyageai-reranker.test.ts`, then `pnpm --filter @satori-code/core build`.

### Task 2. MCP config passes the model name through

Files: `packages/mcp/src/config.ts` (lines 157 and 567–574),
`packages/mcp/src/server/provider-runtime.ts` (line 569), nearest test
`packages/mcp/src/server/runtime-bootstrap.test.ts`.

- `rankerModel?: string`.
- `VOYAGEAI_RERANKER_MODEL`: trimmed; non-empty is used as typed; unset or
  empty is core's `DEFAULT_VOYAGE_RERANKER_MODEL`. Delete the allowlist.
- `provider-runtime.ts:569`: the `|| 'rerank-2.5'` fallback uses the same
  constant.
- Check for other restatements of the old default and update only those:
  `rg -n "rerank-2\.5" packages/mcp/scripts evals/search-quality`.
- Tests first: `rerank-9-test` survives into `config.rankerModel`; unset gives
  `rerank-3-lite`; whitespace-only gives `rerank-3-lite`.

Verify: that test file, then `pnpm --filter @satori-code/mcp build` (confirms
`provider-runtime.ts:107` still type-checks). If generated docs change, the
diff must be limited to the default model name:
`git diff --stat packages/mcp docs`.

### Task 3. Explicit Voyage reranking under the offline runtime (needs D1)

Files: `packages/mcp/src/config.ts` (lines 524–531),
`packages/mcp/src/core/capabilities.ts` (lines 54–59), their tests
(`runtime-bootstrap.test.ts`, `capabilities.test.ts`).

- Replace the local-only rejection with: provider `voyage` requires
  `VOYAGEAI_API_KEY`; if missing, throw
  `SATORI_RERANKER_PROVIDER=voyage requires VOYAGEAI_API_KEY.`
- Inference is unchanged: under local-only, Voyage is selected only by an
  explicit `SATORI_RERANKER_PROVIDER=voyage`. `resolveRerankerProvider`
  already behaves this way; add a test that pins it.
- `hasReranker` for Voyage becomes "key present". Add a comment naming the
  invariant it relies on: under local-only the provider can only be `voyage`
  when explicitly configured, which config enforces.
- Tests first: offline profile + explicit voyage + key builds a config with
  provider `voyage`; offline profile + key and no explicit provider stays
  `none` or `lateon`; explicit voyage without key throws the message above.

Do not touch `packages/core/src/config/execution-profile.ts`. Embedding and
vector-store endpoints keep their loopback checks.

Verify: the two test files.

### Task 4. A rejected request says why (needs D2)

Files: `packages/mcp/src/core/search-rerank-execution.ts` (catch at line 434),
`packages/mcp/src/core/search-result-finalization.ts` (lines 212–214 and
397–399), `packages/mcp/src/core/search-types.ts`,
`packages/mcp/src/core/search-response-helpers.ts` (line 177), test
`packages/mcp/src/core/search-execution.native-order.test.ts` or the nearest
existing reranker-failure test (`rg -l RERANKER_FAILED packages/mcp/src -g '*.test.ts'`).

- When the caught error is a `RerankerRequestError` of kind `permanent_http`,
  record its status and message on `searchDiagnostics`, next to
  `rerankerFailureKind`.
- The message is provider text, so bound it: one line, control characters
  removed, at most 300 characters.
- The `RERANKER_FAILED` warning for that kind reads, for example:
  `Voyage rejected the rerank request for model 'rerank-9' (HTTP 400): <provider message>. Results use retrieval ranking only.`
  with action `Check the model name and API key, then run satori reranker use voyage --model <name>.`
  Warnings are strings of the form `CODE - message`
  (`buildSearchWarningDetail`); use that existing form to carry the text.
- All other failure kinds keep today's wording.
- Tests first: a fake reranker that throws
  `new RerankerRequestError('permanent_http', 400, 1, 'Model rerank-9 is not supported')`
  produces a warning containing `rerank-9`, `400` and the provider text, and
  results are still returned; a `timeout` failure keeps the old message.

Verify: that test file plus
`src/core/search-execution.golden.test.ts` (snapshot must not change).

### Task 5. One provider table in the CLI, and argument parsing

Files: new `packages/cli/src/reranker-providers.ts`,
`packages/cli/src/args.ts`, `packages/cli/src/args.test.ts`,
`packages/cli/src/runtime-config.ts`, `packages/cli/src/doctor.ts`.

The table, and the only place a provider is listed in the CLI:

```ts
export const RERANKER_PROVIDERS = {
    lateon: { network: "local" },
    voyage: {
        network: "remote",
        keyEnv: "VOYAGEAI_API_KEY",
        modelEnv: "VOYAGEAI_RERANKER_MODEL",
        // Mirrors DEFAULT_VOYAGE_RERANKER_MODEL in core; the CLI does not depend on core.
        defaultModel: "rerank-3-lite",
    },
    none: { network: "local" },
} as const;
export type InstallReranker = keyof typeof RERANKER_PROVIDERS;
```

- `InstallOfflineReranker` is replaced by `InstallReranker` everywhere.
- `runtime-config.ts:30` and `doctor.ts:158` derive their sets from the table.
- `reranker use <provider> [--model <name>]`. `offline` maps to `lateon`.
  `--model` is rejected for a provider without `modelEnv`. The model value is
  trimmed and must be non-empty; nothing else is checked.
- `enable` and `disable` parse to the same command shape as `use lateon` and
  `use none`.
- `install --reranker lateon|voyage|none` and `--reranker-model <name>`
  (valid only with `--reranker voyage`). `--reranker voyage` is accepted for
  both runtimes; `--reranker lateon` stays offline-only.
- Tests first, in `args.test.ts`: each form above; an arbitrary model name is
  preserved; `--model` with `lateon` is a usage error; an unknown provider is a
  usage error listing the table's keys.

Verify: `pnpm --filter @satori-code/cli exec node --import tsx --test src/args.test.ts src/runtime-config.test.ts src/doctor.test.ts`.

### Task 6. The launcher carries provider and model

Files: `packages/cli/src/install-contracts.ts`,
`packages/cli/src/install-preflight.ts` (lines 586–626),
`packages/cli/src/runtime-selection.ts` (`resolveOfflineReranker`),
`packages/cli/src/runtime-upgrade.ts` (`upgradeRuntimeSelection`),
`packages/cli/src/install.ts` (stale-plan key list at lines 327–336),
`packages/cli/src/runtime-config.ts` (lines 233–239), and their tests.

- Add `VOYAGEAI_RERANKER_MODEL` to `LAUNCHER_OWNED_RUNTIME_ENV_VARS` and to the
  stale-plan key list.
- Launcher environment for Voyage, in both runtimes:
  `SATORI_RERANKER_PROVIDER=voyage` and `VOYAGEAI_RERANKER_MODEL=<name>`.
  LateOn and `none` write no `VOYAGEAI_RERANKER_MODEL`.
- Selection order stays: explicit flag, then environment, then the existing
  launcher, then platform default. Voyage is reachable through the first three
  only. Selecting it without `VOYAGEAI_API_KEY` in the environment is a usage
  error that names the variable.
- An upgrade keeps the launcher's provider and model.
- `runtime-config.ts`: the offline + Voyage error becomes an `ok` check that
  says reranking is online, plus an error when the key is missing.
- Tests first: the built environment for each provider in each runtime; an
  upgrade over a Voyage launcher keeps `rerank-3-lite`; the launcher file
  contains no API key; switching from Voyage to LateOn removes
  `VOYAGEAI_RERANKER_MODEL`.

Verify: `pnpm --filter @satori-code/cli exec node --import tsx --test src/install-preflight.test.ts src/runtime-config.test.ts src/install.test.ts`.

### Task 7. `reranker use`, `status`, `doctor`

Files: `packages/cli/src/runtime-reranker.ts`,
`packages/cli/src/install-contracts.ts` (`ManagedRerankerResult`),
`packages/cli/src/doctor.ts`, `packages/cli/src/doctor-format.ts`,
`packages/cli/src/index.ts` (help text at lines 327–331 and 371–379, dispatch
at 708), `packages/cli/src/command-help.ts`,
`packages/cli/src/install-preflight.ts`, new
`packages/cli/src/runtime-reranker.test.ts`, existing `doctor-format.test.ts`,
`command-help.test.ts`, `index.test.ts`, `install-preflight.test.ts`.

- `launcherReranker` returns the launcher's provider for both runtimes.
  `ManagedRerankerResult` gains `model: string | null` and
  `network: "local" | "remote"`.
- `use` reuses the existing activation path
  (`upgradeRuntimeSelection` then `activateManagedRuntimeSelection`).
  "Unchanged" compares provider and model.
- Before activating Voyage, make one rerank call (one short query, one short
  document, the chosen model) with an injectable `fetch`. A non-2xx answer
  stops the switch with a `CliError` that quotes the provider's status and
  message. A network failure stops it too, with the transport error. The
  launcher is left as it was. `--no-verify` skips the call.
- The provider's message is printed unchanged. For an unknown name it already
  lists the names Voyage accepts (see D2), so the CLI adds no list of its own.
- `install --reranker voyage` runs the same check during preflight and stops
  before anything is written.
- `status` and `doctor` print provider, model, and for a remote provider one
  line: `Online: search queries and code excerpts are sent to Voyage.`
- `--purge` keeps its rule: refused while the launcher uses LateOn.
- Tests first: a 400 from the fake `fetch` leaves the launcher byte-identical
  and the error contains the provider text; a 200 writes provider and model;
  `use voyage --model rerank-3` twice reports `unchanged` the second time;
  `use voyage` with no model writes `rerank-3-lite`; an install whose check is
  rejected writes nothing; `status` output for each provider.

Verify: `pnpm --filter @satori-code/cli exec node --import tsx --test src/runtime-reranker.test.ts src/doctor-format.test.ts src/command-help.test.ts src/index.test.ts src/install-preflight.test.ts`.

### Task 8. Documentation and full checks

Files: `docs/REFERENCE.md` (environment list near line 490; the "Offline Local
Reranking" section), `packages/mcp/README.md` (lines 181–184),
`docs/improvements/README.md` (status of this plan).

- A "Choosing a reranker" section: the commands from D4, the statement that
  any model name is passed to the provider, the privacy and billing note for
  online reranking, and that definition fusion is skipped only for Voyage
  `rerank-3` and `rerank-3-lite`; any other name, including future ones, keeps
  the standard rule.
- "Adding a provider" in the same section, as the placeholder for future
  providers: one entry in `packages/cli/src/reranker-providers.ts`, one value
  in the MCP provider list in `config.ts`, one case in `createReranker`
  (`packages/mcp/src/server/provider-runtime.ts:647`), one `Reranker`
  implementation in core. No provider is added now.
- The root `README.md` recommendation is Hamza's to write; do not edit it.

Verify, one at a time, each under
`systemd-run --user --scope -q -p MemoryMax=6G`:
`pnpm run lint`, `pnpm run typecheck`, `pnpm --filter @satori-code/mcp test`,
`pnpm --filter @satori-code/cli test`. Core: the reranker test file only (the
full core suite's time-budget failure is pre-existing).

### Task 9. Measure the shipped Voyage path (paid; needs a go-ahead)

Not a code task. It answers the open limit in the results document: the
reported Voyage figures came from a test hook that sent LateOn-format documents.

- On a copy of the saved index state (never the original), run the 28-question
  eval with the launcher switched to Voyage `rerank-3-lite` (the default),
  then `rerank-3`, then `rerank-2.5`. `evals/real-repo-quality/session.mjs` reads the installed
  launcher's environment, so `satori reranker use voyage --model <name>` on the
  development install is the switch. Restore LateOn afterwards.
- Cost: about 680,000 billed tokens per model.
- Report hit@1, hit@5, hit@10 and MRR next to the hook figures.
- Stop condition: if `rerank-3-lite` is within 0.04 MRR of 0.7738, and
  `rerank-3` is within one question of 20 at rank 1 and within 0.04 MRR of
  0.7798, record the result and stop. Otherwise report the gap; a gap on
  `rerank-3-lite` also reopens D3. The likely cause is the plainer document built by
  `buildNativeProviderRerankDocument`
  (`packages/mcp/src/core/search-rerank-execution.ts:167`); sending the
  LateOn projection to Voyage instead is a ranking change and a separate
  decision.

## Verification at the user-visible seam

After Task 7, on the development install:

```bash
satori reranker status                       # LateOn, local
satori reranker use voyage                   # no model named: rerank-3-lite
satori reranker use voyage --model rerank-3  # test call succeeds, launcher updated
satori reranker status                       # Voyage rerank-3, online notice
satori reranker use voyage --model no-such   # refused, provider's message shown, launcher unchanged
satori reranker use offline                  # LateOn again
```

and one search after restarting the client, whose debug output names the
Voyage provider and model.

## Risks

- **Privacy.** With D1 an "offline" install can send code excerpts to a third
  party. Mitigation: explicit selection only, stated in `status`, `doctor` and
  the reference.
- **Silent fallback.** A key that expires later degrades every search. Task 4
  makes the warning specific; it does not stop the search.
- **Fusion rule keyed on model names.** A future Voyage model that judges as
  well as `rerank-3` will keep the standard fusion rule and lose some of its
  gain until the rule is revisited. Accepted for now.
- **Default model changes before the shipped path is measured.** The
  `rerank-3-lite` figure (MRR 0.7738) came through the test hook on offline
  retrieval. Task 9 measures the shipped offline path. The connected runtime
  is not measured by this plan.
- **Installer state.** Task 6 changes which variables the launcher owns. The
  upgrade and switch-back tests in Task 6 are the guard.

## Out of scope

- Definition fusion: its rule, its weights and the model-keyed switch. To be
  revisited in a separate session.
- Other online rerank providers, a larger local LateOn model and local
  cross-encoders.
- Changing the default reranker. LateOn stays the default for a new offline
  install.
- Routing Voyage through the LateOn document projection.
- The retrieval misses `r1`, `p3`, `f5` and the low rank of `r2`.
- The pre-existing core per-file time-budget failure.

## Execution handoff

Route: one reusable worker, tasks in order, one task per turn. The tasks share
types down the chain core → MCP → CLI, so they are not independent and should
not run in parallel.

- Tasks 1, 2, 5 and 8 are mechanical: a small model at high effort is enough.
- Tasks 3, 4, 6 and 7 change a permission rule, a response contract and
  installer state: use the stronger model, and have each reviewed before the
  next starts.
- Each turn's deliverable is the task's test file passing with the listed
  command. The worker reports the command output and `git diff --stat`.
- The worker must not commit, stage, push, run formatters across the
  repository, edit fusion code, or touch the root `README.md`.
- Stop and report when a listed line number no longer matches, when a test
  outside the listed files fails, or when a task needs a file not named in it.

User confirmation required: yes, for the paid Voyage calls in Task 9 only.
D1 to D4 are answered.
