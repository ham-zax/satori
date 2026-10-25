# TypeScript 7.1 content mappers: findings and revised proof plan

## Migration update, 25 October 2026

The repository migration targets `typescript@7.1.0-beta` for runtime analysis and builds.
Every first-party manifest uses `7.1.0-beta`, including the standalone
`experiments/napi-search-projections` package. That experiment's toolchain still brings
`typescript@6.0.3` transitively through `@napi-rs/cli`; no Satori code uses it.
The analyzer uses the native synchronous API, snapshots and compiler-owned reference diagnostics.
`disableSourceOfProjectReferenceRedirect: true` preserves built-declaration authority and TS6305
for missing outputs. The compiler computes declaration output paths through `getDeclarationEmit`.
The session owner disposes snapshots and closes its native process. CommonJS code uses Node's
`require(ESM)` support, within the existing Node >=22.13 requirement.

Oxlint replaces ESLint and typescript-eslint, removing the lint dependency on TypeScript 6.
Supported recommended rules retain their severities. Duplicate parameters and legacy octal
literals remain compiler/parser errors. Native lint requires explicit presence checks before
unsafe optional-chain assertions in affected tests. The expected test outputs remain unchanged.

External mapper execution stays disabled. The mapper trust decision and framework rollout remain
open. The historical investigation below describes the pre-migration repository. Validation and
the independent review are recorded in the root `TASKS.md` ledger.

Status: historical local investigation, not implemented. This is a local record from 24 October
2026. The correction adds no upstream claims and performs no new registry or API research. Read-only
evidence comes from three delegated investigations plus one paid Jev audit slice. No dependency
installed, no compiler migrated, no index rebuilt, no production file changed. No Satori RAM saving
is claimed.

## Question and corrected premise

The originating request asked whether TypeScript 7.1 can improve Satori "and lower RAM usage by some percentage". The RAM premise does not hold and must not be planned against.

The announcement's memory table (15.8% to 49.6% lower RSS across five projects) measures **`tsc`'s own process** on those checkouts. Satori does not run `tsc` over analyzed repositories. It runs `ts.createLanguageService` inside worker threads on TypeScript 6.0.3 (`packages/core/src/semantic/typescript-configured-project.ts:391`), and uses the `typescript7` alias to 7.0.2 only for build and typecheck (`package.json:72`, invoked at `packages/core/package.json:39` and `:44`; the runtime dependency remains 6.0.3 at `packages/core/package.json:62`). Nothing in 7.1 changes that path, so its memory figures do not transfer. Content mappers additionally add **processes**: a mapper is spawned, and the Vue mapper is itself a `typescript/sync` client that starts its own TypeScript server. Adopting mappers increases memory unless a mapper replaces work we already do.

## Finding 1: the 7.x API removes Satori's analyzer

- `typescript@7.1.0-beta` exports (``.`, `./fs`, `./sync`, `./async`, `./ast`, `./proto`, `./path`, `./vscode`) come from `lib/version.cjs` plus 22 per-platform native packages. `typescript@6.0.3` publishes the whole TypeScript JS API with no exports map.
- `ts.createLanguageService`, `ts.createDocumentRegistry`, `ts.LanguageService`, `ts.createProgram`, `ts.createSourceFile` and `ts.sys` exist in **6.x only**. The call sites that would have to be rewritten are `typescript-configured-project.ts:391`, `:266`, `:312`, `:320` and `typescript-compiler-provider.ts:161`, `:185`, `:1268`.
- `ts.version` is folded into session identity (`typescript-semantic-analyzer.ts:1487-1500`, `ROOT_RESOLUTION_STATE_FORMAT = 1`), so any upgrade invalidates persisted resolution state and forces a re-index. That is a cost of the upgrade, not of mappers.

Consequence for this plan: the old step "resolve through the documented TypeScript 7.1 API" is the expensive part. It is a rewrite of the resolution analyzer onto `typescript/sync`, not a version bump.

## Finding 2: the mapper execution boundary is a trust decision, not a configuration

- A mapper is an arbitrary command taken from the analyzed repository's dependency `package.json` (`typescript.contentMapper.exec`). Validation is "non-empty array of strings" and nothing else (`tsc/internal/tsoptions/contentmappers.go:73-78`).
- It is started with a bare `exec.Command` — no `Env`, no `SysProcAttr`, no uid change, no namespaces, no rlimits, and no per-transform timeout (`tsc/cmd/tsc/sys.go:74-91`). It inherits our environment, filesystem, and network.
- The only opt-in is `runExternalCode`: one process-wide boolean, default `false`, CLI-flag-only (`IsCommandLineOnly`), so a repository can never enable it — a tsconfig entry produces `Option_0_can_only_be_specified_on_command_line`. Without the flag, mappers are dropped at parse time with a config error and no process exists (`tsconfigparsing.go:1392-1397`).
- The single allowlist (mapper package must sit in a `node_modules` under an initial workspace root) returns `true` when `InitialWorkspaceRoots == nil`, which is exactly the state of `tsc --api` sessions — the transport behind `typescript/sync`, `typescript/fs` and `typescript/proto`. For programmatic consumers the allowlist is inert.
- Microsoft states the boundary plainly in `.github/skills/security-report-check/SKILL.md`: `tsc` never executes input code, "**Exception**: if content mappers are enabled", and a mapper running after an explicit flag is not a valid security report.

Consequence: enabling `runExternalCode` while indexing untrusted repositories means running repository-chosen executables as the Satori user, with no timeout and no sandbox. Any adoption needs either a refusal to enable it, or a Satori-owned allowlist plus process isolation that Microsoft does not provide.

## Finding 3: what the coverage would be worth

Today `.vue`, `.svelte`, `.astro` and `.mdx` are inert: `symbolExtractionCapability: NONE` (`capabilities.ts:104`, `:220`, `:234`, `:384-388`) means fixed-size text chunks with no symbols, no calls, and no labels. That is the accuracy this work would buy, and it is a capability gain with no measured search-accuracy evidence yet.

The mapping contract fits our existing conversion: the JS API reports UTF-16 positions, and `Utf8SourceMap.spanFromUtf16` (`language-analysis/source-map.ts`) already converts to the UTF-8 byte spans used at `typescript-compiler-provider.ts:322` and `:1184`. Composition order must be mapper map first, then UTF-8 conversion; the reverse order is silently wrong for multi-byte text.

Mapper inventory on the public registry (my earlier "none published" claim was wrong): `@vue/content-mapper@4.0.0-alpha.0` (also the only one documented around `typescript/sync`), `@astrojs/ts-content-mapper@0.2.0`, `mdx-content-mapper@0.2.0`, `css-modules-content-mapper@0.6.1`. No Svelte mapper is published. Microsoft describes 7.1's editor support as a "baseline editing experience", not a Volar replacement.

## Finding 4: Jev can judge Satori's intent classifier cheaply, and batching breaks it

A slice was run against `evals/real-repo-quality/cases.json` (28 pinned queries, 3 repositories). One `Choice` question with five criteria buckets judged "what kind of answer does this query ask for", compared against the curated query tags and against the shipped classifier (`buildSearchQueryPlan` → `resolveSearchAnswerFocus` in `packages/mcp/dist`).

Cost and latency, measured: **12,420 input tokens (~$0.0005) and 0.64 s** for all 28 questions batched; ~0.37 s per single-question request.

Results:

- Batched (28 questions, one state): Jev agreed with the curated expectation on 18 of 23 tag-tractable queries; the shipped classifier on 19 of 23. At that point the audit looked like a wash.
- Re-running the five disagreements as single-question requests: **5 of 5 then matched**, including the two literal "where are the tests for…" queries that the batch had answered `implementation_owner` at 0.61 and 0.74 confidence. Those now return `tests` at 0.97-1.00.
- Conclusion for this slice: the batch, not Jev's judgment, produced most of the apparent errors.
  In these 28 queries, wrong answers sat at 0.36-0.74 and right answers at 0.79-1.00. This small
  sample does not establish universal calibration. A confidence floor is a cheap prioritization
  filter, not a guarantee.

Classifier issue list produced by the comparison (local classifier returns `neutral` or misses tooling where the curated tag expects a behavior owner):

| Query | Expected intent (judgment) | Shipped classifier |
| --- | --- | --- |
| `r6` where does the eslint plugin check exhaustive deps for hooks | configuration_or_tooling | `implementation` |
| `p3` where does polars cast a column to a different dtype | implementation_owner | `neutral` |
| `p5` where does polars push a filter predicate down in the lazy query optimizer | implementation_owner | `neutral` |
| `f5` where does flatc parse a schema file | implementation_owner | `neutral` |
| `f7` where does flatc resolve a union type when parsing | implementation_owner | `neutral` |

These are hypotheses about the intent classifier, not confirmed defects: the tag mapping itself is a judgment, and `r9` shows it can be arguable. They need a check against real rank outcomes on the pinned repositories before any classifier change.

## Decisions

1. **Recorded: the analyzer moves to the TypeScript 7 API.** Hamza decided on 24 October 2026 that
   Satori will deliberately migrate its TypeScript semantic and resolution analyzer onto the 7.x API
   (`typescript/sync`), accepting that `createLanguageService` is gone, that
   `packages/core/src/semantic/typescript-configured-project.ts` and the provider/session plumbing
   must be rewritten, and that persisted resolution state is invalidated by the `ts.version`
   identity change and requires a re-index. This migration is its own project, is not part of the
   content-mapper proof, and is not started in this document.
2. **Open: trust model.** May Satori ever run mapper code chosen by an untrusted repository? If
   yes, the allowlist, process isolation, and timeouts are ours to build. If no, adoption is
   blocked, or limited to a Satori-owned allowlist of mapper executables we ship and control. This
   is unresolved and is the only remaining blocker for content mappers.
3. Ordering consequence of decision 1: the mapper proof below cannot be run against Satori's
   current analyzer, because the mapper transport is 7.x-only. It becomes the first slice of the
   7.x migration, not a precursor to it.

## Revised proof, when a decision exists

The earlier proof assumed the 7.1 API could be adopted cheaply. It cannot. The smallest evidence that would now justify the cost is:

1. Prove the mapper protocol itself, without enabling `runExternalCode`: spawn one allowlisted mapper, speak `initialize` → `openProject` → `transform` → `closeProject`, and record `{text, mappings}` for one Vue fixture with an accent and an emoji before the call.
2. Compose mapper mappings into `Utf8SourceMap` and show the call resolves to the imported helper's real file and byte span, with the generated scaffold rejected as a source owner.
3. Only then measure whether resolution through a rewritten analyzer changes any pinned rank on
   the local historical checkout at `/home/hamza/repo/webharness` (a local path, not a portable
   requirement), using the existing Publication and the documented budget comparison.
4. Stop at the decision. No framework rollout, no ranking tuning loop, no new benchmark harness.

## Limits of this document

- Nothing here was executed against a mapper; every statement about mapper behaviour comes from reading the Go sources and the specification, not from running one.
- Whether VS Code adds a platform-level content-mapper permission prompt outside the TypeScript extension was not verified.
- The Jev slice measured intent classification only. It says nothing about ranking quality, and no accuracy claim follows from it.
- `/home/hamza/repo/webharness` and any `/tmp/...` path are local historical evidence. They are not versioned, and they may be unavailable after cleanup. This correction performs no new registry or API research.
