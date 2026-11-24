# CBM Upstream Sync, Language Expansion, Pipeline Improvements & Dart Span Fix Plan

Date: 2026-11-25 (Revised after peer review)
Status: Revised (ready for gated execution, Slice 0 + Slice 1A starting in isolated worktree)
Repo: `/home/hamza/repo/satori` (base `dd27885c`)
Upstream reference: `/home/hamza/repo/codebase-memory-mcp` (target pin `9a4da7a314833d8d965b74612e1f25fef5371861`)

## Context & Current Pins

| Vendored surface | Current Satori pin | Upstream `origin/main` | Gap |
|---|---|---|---|
| `third_party/cbm-semantic/` (7 language resolvers + common core) | `11b662f9` (2026-09-27) | `9a4da7a3` (2026-11-23) | ~2,485 commits (`34 files, +11,795 / -1,524` in `internal/cbm/lsp/` + `src/semantic/`) |
| `third_party/cbm-extractor/` (140 language definition extractors) | `1111d9a9` (2026-11-19) | `9a4da7a3` (2026-11-23) | 8 merged PRs + deferred local Dart #4 comment-before-body span fix |

**Execution & qualification rules (incorporating peer review):**
1. **Qualify semantic and extractor slices independently; run heavy WASM builds sequentially.** Never mix behavior-preserving optimizations with intentional output changes in the same qualification gate.
2. **Consolidate user-facing reindex triggers:** Both `extractorVersion` and `relationshipVersion` affect Publication compatibility (`packages/core/src/core/context.ts:1026`). Keep per-slice provenance in manifests/`UPSTREAM.md` during development, and consolidate any user-facing version bumps into one qualified release.
3. **Combined C++ definition-to-call check:** Before shipping updated extractor + semantic bundles together, run a combined C++ definition-to-call binding check (including GoogleTest bodies from `#3048`).
4. **Fixture first:** Every accuracy/bug fix starts with a minimal failing fixture test before touching C or TS code.
5. **Preserve Satori local patches:** Every sync carries forward all documented patches in `third_party/cbm-semantic/UPSTREAM.md` and `scripts/cbm-extractor-sync.mjs`.

---

## Slice 0: Prerequisite — Fast-Forward Local CBM Checkout & Audit `1111d9a9..9a4da7a3`

* **Action:** Fast-forward `/home/hamza/repo/codebase-memory-mcp` from `1111d9a9` to `9a4da7a3` (verify clean working tree).
* **File-level closure audit:** Check which commits in `1111d9a9..9a4da7a3` actually touch Satori's vendored extractor closure (`extract_defs.c`, `lang_specs.c`, `callable_sig.c`, `helpers.c`, `grammars/`) vs. CBM-only pipeline files (e.g., `#2996` `requirements.txt` BOM handling lives in CBM's pipeline, not the extractor closure, and is excluded unless file-level evidence shows otherwise).
* **Stopping condition:** Local CBM at `9a4da7a3` and exact per-slice file list confirmed.

---

## Slice 1A: Behavior-Preserving $O(N^2) \to O(N)$ Semantic Indexing (Qualified Alone)

* **Goal:** Eliminate quadratic type-registry and import-list scans in `third_party/cbm-semantic` (`835c806d`, `8b8e5496`) with **zero change to published outputs**.
* **Scope:**
  * Port `internal/cbm/lsp/lsp_name_rows.h`, `lsp_node_iter.h`, `lsp_work.h`, and the opt-in registry tail index in `common/type_registry.{c,h}` plus the smaller per-definition identity index (`8b8e5496`).
  * Wire all **7** vendored semantic resolvers that share `type_registry.{c,h}`: Go, Java, C#, C/C++, Rust, **Kotlin**, and **PHP**.
  * Preserve OOM fallback to linear scan at every indexed lookup site.
  * Update `scripts/semantic-engine-build-config.mjs` if new headers/units are added; keep `PINNED_UPSTREAM_COMMIT` / provenance accurate per slice.
* **Qualification gate (must pass before Slice 1B starts):**
  1. **Published-output equivalence:** Identical *published* definitions, calls, and proof authority across all 7 languages (Go, Java, C#, C/C++, Rust, Kotlin, PHP) on existing WASM test suites and real-repo harnesses (`trufflehog`, `guava`, `Newtonsoft.Json`, `rust-analyzer`, CBM C set).
  2. **Adversarial fixtures:** Duplicate-name definitions/imports and deterministic allocation-failure fallback (confirming indexed route and linear-scan fallback return identical results).
  3. **3-run median timing & peak WASM memory** before vs. after on real repos.

---

## Slice 1B: Semantic Resolver Accuracy & Crash/Truncation Fixes (`11b662f9` → `9a4da7a3`)

Runs only after Slice 1A passes its zero-diff qualification gate. Carry forward every local patch in `third_party/cbm-semantic/UPSTREAM.md` (`go_lsp_add_import` OOM check, Kotlin sole-definer removal, PHP global/static precision rules, C include-guard unwrap, Rust `#[cfg(test)]` gate filtering, per-file arena + 32 MiB retained-tree budget):

| Language | Upstream commits | Key behavior | Failing fixture required first |
|---|---|---|---|
| **Go** | `18d5f14e`, `dc81846a`, `dfa84677`, `bdc27776`, `d2d4f028`, `4b03f7af`, `6e784c38`, `4a78fe6a` | Cross-file embedded struct promotion (`o.Hello()` via embedded `base.Base`), cross-file package-level `var`/`const` typing (`pkg.Default.Get()`), closure params, cross-file type aliases, block-scoped shadowing, per-file `init()` caller names, suppress bare-`init` false bindings | Embedded promotion, package-level value receiver, bare `init := func() {}; init()` non-binding |
| **Java** | `80810097`, `679d1e1a`, `6c52e826` | `lsp_external` proven-external receiver suppression (no short-name guess to unrelated project methods), skip generated record accessors on fallback | JDK/external receiver calling method sharing a local project name → 0 false edges |
| **C#** | `f649a27c`, `c0a8ed8b`, `dad89184`, `21c253ff` | Arena-grown `using`-directive walk stack (fixes silent drop past 256 pending entries), nested-type qualifier resolution (`new Command.Result(...)`), global-namespace spec order | >256 namespace blocks before `using static` + nested `A.B` type qualifier |
| **C/C++** | `8efb059f`, `fb690ae9` (`#3048`) | Mask CRLF line splices (`cbm_c_mask_crlf_splices`) in cross-file pass; consistent GoogleTest body caller naming | `\<CR><LF>` string splice before cross-file call + GoogleTest body caller |
| **PHP & Rust** | `09dc36d2`, `0843106f`, `ad435fd0` | Mask PHP inline HTML (`?> ... <?php`) in cross-file pass; resolve Rust `use` paths inside the importing crate | PHP template call after `?>` + Rust multi-crate `use` |

* **Verification:** Rebuild `satori-semantic-engine` WASM, run `packages/core/src/semantic/wasm/*.test.ts` and `packages/core/src/relationships/*.test.ts`.

---

## Slice 2: Independently Gated Language Depth (Ruby + Python)

### 2A. Ruby Semantic Resolver (`e9f87efe`..`435baf6b`) — Independently Gated
* **Pre-promotion qualification required before changing `packages/core/src/languages/capabilities.ts:207`:**
  * Vendor `ruby_lsp.{c,h}`, `ruby_stdlib_data.c`, and `tree-sitter-ruby` into `third_party/cbm-semantic/`.
  * Set explicit WASM binary-size and peak-memory budgets and measure on a real Ruby repository.
  * Prove fixture coverage: self dispatch, `include`/`prepend`/`extend` MRO, singleton methods, ivar typing (`@x = Const.new`), `super`, block-`self` rebinding suppression, and fail-closed unresolved ancestry.
  * Promote Ruby from symbol-only to call-graph capable only if size, memory, and precision gates pass.

### 2B. Python Precision Rules (`packages/core/src/relationships/python-resolution.ts`)
* **Prove missing edge first:** Reuse existing `pythonMethodTargetsForRuntimeTypes(..., '__init__', ...)` (`python-resolution.ts:1405`); write a failing fixture proving which published `CALLS` edge is missing for `ClassName(...)` → `__init__` (vs. `Class` when no user `__init__` exists), and failing fixtures for `global`-bound names (`148dd052`) and conflicting/aliased `@overload` declarations (`28f20234`, `accfcf6f`).
* **Verification:** Focused Core Python resolution tests + `packages/mcp/src/core/python-call-fallback.test.ts`.

---

## Slice 3: Pipeline & MCP Ergonomics (Each Gated by Reproduction)

### 3A. C/C++ Incremental Header-Includer Invalidation (`beba7f8c`, `0fe36012`)
* **Prove the gap first:** `buildRelationshipDeltaWork` (`packages/core/src/relationships/builder.ts:473`) already expands `affectedFiles` via `changedPreviousTargetInstanceIds`, `dependencyKeys`, `changedTargetNames`, and `moduleBindings`. Write a failing incremental-sync reproduction proving an includer escapes those paths across:
  1. Direct and **transitive** `#include` chains,
  2. **Header deletion**,
  3. **Newly resolvable** `#include` (header added after initial index).
* **Repair in the existing delta owner:** Extend `builder.ts` / `index-generation-workflow.ts:2088` rather than duplicating delta logic.
* **Equivalence oracle:** Compare **canonical symbol and relationship payloads** (not raw Publication JSON, which carries distinct IDs and timestamps) between incremental sync and a cold full index.
* **Schema & fallback rule:** If persisted include metadata is required, define how older Publications without that field fall back cleanly before deciding on any schema version bump.

### 3B. `trace_path` Diagnostics (`a540bffb`, `ab8f68a1`) — Independently Gated
* **Contract:** Preserve `packages/core/src/navigation/trace-path.ts:71` resolved shortest-path behavior unchanged.
* **Additive diagnostics only:** Expose `recursionState` / self-call omission metadata and optional `possibleOverrides` diagnostic candidates on dispatching edges without altering shortest-path selection, determinism, or byte budgets.

---

## Slice 4: Batched `cbm-extractor` Rebuild + Deferred Dart #4 Span Fix

Batch all extractor changes into **one** sequential Emscripten rebuild and **one** Hugging Face extended-pack refresh:

1. **Dart #4 comment-before-body span fix in `scripts/cbm-extractor-sync.mjs:122` (the patch generator):**
   * Update `satori_dart_def_end_node` in `scripts/cbm-extractor-sync.mjs` (not only the generated `extract_defs.c`) to walk past both `comment` and `documentation_comment` named siblings before checking `function_body`, stopping at any non-comment sibling so a declaration boundary (e.g., an abstract/external method signature followed by a comment and another declaration) never swallows the next declaration's body.
   * **Regression fixtures:** Dart function + class method with `// comment` (`comment`), `/// doc` (`documentation_comment`), `/* block */`, AND an abstract/external declaration followed by a comment + concrete method (declaration-boundary check).
2. **Upstream `cbm-extractor` sync (`1111d9a9` → `9a4da7a3`):**
   * Apply only changes proven relevant to Satori's vendored extractor closure in Slice 0 (e.g., `#2979` ObjectScript v1.11.0 grammar/extraction, `#3048` C++ GoogleTest body naming if extractor-side; exclude `#2996` `requirements.txt` BOM pipeline code).
3. **Single rebuild & release verification gate:**
   * Regenerate vendored files via `node scripts/cbm-extractor-sync.mjs` and `node scripts/sync-cbm-language-map.mjs`.
   * Run `node scripts/build-cbm-extractors.mjs` (atomic GNU `mv --exchange` swap).
   * Run `node scripts/sync-cbm-language-map.mjs --check`, `node scripts/cbm-extractor-sync.mjs --check`, `node scripts/build-cbm-extractors.mjs --check`, and `pnpm run cbm-extractor:verify`.
   * **Extended pack release gate:** Because `scripts/verify-cbm-extractors.mjs:32` permits missing extended modules locally, if any extended WASM hash changes, publish the new pack revision to Hugging Face, pin `CBM_EXTENDED_REVISION` in `packages/cli/src/cbm-extractor-store.ts:13`, and verify a clean CLI install against the new manifest.
   * Run the combined **C++ definition-to-call binding check** across the updated extractor + semantic engine before shipping.

---

## Explicitly Out of Scope (Skip from CBM)

* `ts_lsp.c` (Satori uses TypeScript 7 compiler API `@typescript/typescript`, strictly more accurate).
* CBM Lens (`graph-ui/`) and local browser LLM.
* `test_impact*.c` (~35 C files) and PDF/Terraform/K8s infra graph extractors.
* `#2996` (`requirements.txt` BOM handling in CBM's dependency-manifest pipeline — outside Satori's extractor closure).
