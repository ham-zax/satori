# Residual Medium/Low Navigation & Search Fixes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the medium- and lower-impact agent confusion paths (wrong open_symbol attribution, untrustworthy docs scope, warning spam, weak inbound discovery, splitter noise, ordering/hygiene, mega-symbol walls, installer polish) without expanding the six-tool public surface.

**Architecture:** Keep adapters → application → domain ownership. Prefer pure helpers co-located with the existing owner; extract only when two call sites share the same priority/collapse rule. Prefer reason codes / structured warning objects / fallback promotion over new tools or new list buckets. HI-1/HI-2/HI-3 (provider readiness, installer empty env, near-tie ranking) are **already implemented and staged** — do not re-open them here except where L12 is explicitly residual polish beyond HI-1.

**Tech Stack:** TypeScript monorepo (`packages/mcp`, `packages/core`, `packages/cli`), Node `node:test`, `pnpm`, existing MCP JSON envelopes.

---

## Constraints (do not violate)

| Rule | Implication |
|------|-------------|
| Six tools only | No `referenceSearch` tool. Promote existing `search_codebase` / `navigationFallback` / `nextActions`. |
| Determinism | Warning collapse samples must be sorted with `compareContractStrings` (or local code-unit compare already used nearby). |
| Fail closed | `open_symbol` still must not guess on ambiguity; exact resolve stays exact. |
| `symbolQuality` contract | Remains **observed registry richness**, not parser-cause diagnosis. Parser-fallback rate is a **separate** status field if added. |
| Public contract changes | Same patch updates tests + schema `describe` + `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` (and AGENTS if agent-facing). |
| No speculative modules | Failing tests first; extract helper only if duplication of priority/collapse rules is real. |
| Do not mix waves | Each wave is independently shippable and testable. |
| Commits | Only when user explicitly asks. |

---

## Research Summary (grounded owners)

| ID | Defect | Owner (edit here first) | Evidence in tree |
|----|--------|-------------------------|------------------|
| **M4** | `open_symbol` annotated path re-outlines the window and surfaces overlapping sibling symbols; content can include shared overlap lines | `packages/mcp/src/tools/read_file.ts` (exact open + annotated branch ~447–628); outline builder `packages/mcp/src/core/registry-file-outline.ts` | Exact open already sets `startLine/endLine` from `resolvedSymbol.span`; annotated mode then calls `handleFileOutline({ start_line, end_line })` without restricting to resolved `symbolId` |
| **M5** | `scope=docs` includes **tests** by policy | `packages/mcp/src/core/search-ranking-policy.ts` `shouldIncludeCategoryInScope` (docs branch returns `docs \|\| tests`); schema text in `search_codebase.ts:152`; tests in `handlers.scope.test.ts` / `search.eval.test.ts` | Explicit contract today: docs returns docs **and** tests |
| **M6** | Call graph dumps every `Duplicate symbolKey '…' has N candidates` from registry | `packages/core/src/symbols/registry.ts:593–596` emits per-key strings; `packages/mcp/src/core/relationship-backed-call-graph.ts:352–358` spreads `input.registry.warnings` into response | Per-key warnings are intentional at build; **collapse at call_graph presentation boundary** |
| **M7** | Inbound often notes-only (suppressed low confidence); discovery cost high | `relationship-backed-call-graph.ts` already builds `suppressed_edge` notes + Python caller fallback; **no** top-level `nextActions` / search promotion on call_graph envelope | Do **not** invent a tool; promote `search_codebase` must:/path args when inbound is notes-only |
| **M8** | AST splitter catch → stderr flood + silent text-symbol fallback | `packages/core/src/splitter/ast-splitter.ts:83–109` (`parser.setLanguage` / `parse` catch); quality gauge `packages/core/src/symbols/symbol-quality.ts` deliberately non-parser | Fix Invalid argument if reproducible; aggregate fallback metrics separately from `symbolQuality` |
| **L9** | Residual `localeCompare` on contract sorts | e.g. `search-response-helpers.ts:33`, `relationship-backed-call-graph.ts:358`, `registry-file-outline.ts`, ranking/grouping helpers | Route **public ordering** through `compareContractStrings` / local code-unit compare |
| **L10** | `OUTLINE_SYMBOL_REGISTRY_WARNINGS:N` opaque string | `navigation-handlers.ts:469–470` | Structured warning or drop when non-blocking |
| **L11** | Mega-class groups dominate; open wall-of-code | HI-3 near-tie sort already in `search-group-ordering.ts`; group build uses full `symbolSpan` as primary `span` in `search-group-results.ts:294–302` | Prefer `previewSpan` for default open when symbol is oversized; keep `symbolSpan` explicit |
| **L12** | Managed Claude empty env looked healthy | Largely fixed by **HI-1** (`buildPreservedManagedEnv`, doctor blank trim). Residual: install-time degraded signal if still desired | Only if post-HI-1 gap remains after re-test |

**Dependency note:** M4 does not depend on M5–M8. M6 collapse is independent of M7 promotion. M5 is a deliberate public scope contract change (tests + docs). M8 root-cause may need a repro fixture; do not block Wave A on it.

---

## Recommended execution order

```text
Wave A  Agent correctness / payload hygiene (ship first)
        M4 open_symbol clamp + sibling drop
        M6 call_graph warning collapse
        L10 outline warning structure
        L9 residual localeCompare (only paths touched by A, then sweep)

Wave B  Search contract truthfulness
        M5 docs scope excludes tests
        L11 mega-symbol default open uses previewSpan

Wave C  Inbound discovery without new tools
        M7 promote search fallback when inbound notes-only

Wave D  Indexing quality observability
        M8 AST Invalid argument + bounded logging + optional splitterFallback stats

Wave E  Installer residual (only if needed)
        L12 post-HI-1 doctor/install degraded mark
```

Rationale: M4 mis-attribution is the highest agent-harm bug. M6/L10 make warnings usable again. M5 is intentional contract change and should not be mixed with open_symbol. M7 needs envelope design but no new tool. M8 is deeper/core and can ship independently. L12 is mostly superseded by staged HI-1.

---

## Wave A — Agent correctness & warning hygiene

### Task A1: M4 — Strict open_symbol content + exact outline under open

**Files:**
- Modify: `packages/mcp/src/tools/read_file.ts`
- Modify (only if window filter belongs in outline builder): `packages/mcp/src/core/registry-file-outline.ts`
- Test: `packages/mcp/src/tools/read_file.test.ts`
- Doc (if annotated envelope fields change): `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

**Invariants:**
1. Exact `open_symbol` content is always `lines[resolved.startLine-1 .. resolved.endLine]` and never widened by request span, outline window, or sibling symbols.
2. When `symbolId` (or exact label) resolved successfully, annotated `outline.symbols` contains **only** that resolved symbol (drop siblings, including overlapping neighbors).
3. Overlapping sibling bodies that share line ranges with the resolved span may still appear as **text inside content** if they share those lines in the file — that is source truth. Attribution comes from outline/metadata, not from inventing non-contiguous content.
4. Ambiguous / not_found behavior unchanged (fail closed).

- [ ] **Step 1: Write failing tests**

```ts
// read_file.test.ts — sketch
test("open_symbol annotated outline drops overlapping sibling symbols", async () => {
  // Fixture file with two overlapping registry spans:
  // normalizeMarkerFingerprint 50–60, decideInterruptedIndexingRecovery 52–107
  // open decideInterruptedIndexingRecovery by symbolId
  // Assert:
  // - content starts at line 52 text, ends at line 107 text
  // - payload.outline.symbols length === 1
  // - payload.outline.symbols[0].symbolId === requested id
  // - no sibling label in outline
});

test("open_symbol plain content uses resolved span only even if request span is wider", async () => {
  // open_symbol with symbolId + start_line/end_line that overshoots resolved span
  // assert content line count === resolvedEnd - resolvedStart + 1
});
```

- [ ] **Step 2: Minimal implementation**

Preferred (smallest blast radius): in `read_file.ts` annotated branch when `input.open_symbol` already resolved an exact symbol:

1. Do **not** re-query outline for a window that reintroduces siblings.
2. Build annotated outline from the already-resolved exact symbol only (reuse fields from the exact outline response already in hand ~493–531).
3. Keep content slice from that same resolved span.

If exact path currently discards the full exact outline payload before annotated build, thread `resolvedSymbol` through instead of a second windowed `handleFileOutline`.

Avoid a new shared “classifier module.” A 10-line local helper is fine:

```ts
function outlineFromResolvedOpenSymbol(resolved: ExactSymbol): { symbols: unknown[] } {
  return { symbols: [resolved] };
}
```

- [ ] **Step 3: Prove**

```bash
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test src/tools/read_file.test.ts
```

- [ ] **Step 4: Spec note** — one sentence under `read_file` / `open_symbol`: exact open returns only the resolved symbol in annotated outline; content is the resolved span.

---

### Task A2: M6 — Collapse registry duplicate-key warnings on call_graph

**Files:**
- Modify: `packages/mcp/src/core/relationship-backed-call-graph.ts` (presentation boundary ~352–358)
- Optionally pure helper co-located: same file or tiny `call-graph-warnings.ts` **only if** tests want pure export
- Test: `packages/mcp/src/core/handlers.call_graph.test.ts` and/or `call-graph.test.ts`
- Do **not** change `buildSymbolRegistry` warning generation unless a second consumer also needs collapse (outline is L10)

**Contract:**
- Default response: at most one collapsed line, e.g.  
  `DUPLICATE_SYMBOL_KEY:42 sample=foo,bar,baz`  
  (count + up to 3 sample keys, sorted deterministically).
- Full per-key list only when call_graph/debug path already exists; if no debug flag on call_graph today, **do not invent a param** — keep detail out of default payload (notes already carry suppressed edges).
- Keep existing count-style warnings: `RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:N`, dynamic fallback counts.
- Suppressed edges stay as structured `notes` (already good).

- [ ] **Step 1: Failing test**

```ts
// Feed registry with many duplicate symbolKey warnings into relationship-backed path
// assert warnings.filter(w => w.includes("Duplicate symbolKey")).length === 0
// assert one warning matches /^DUPLICATE_SYMBOL_KEY:\d+/
// assert sample keys stable across two calls
```

- [ ] **Step 2: Implement collapse before sort**

```ts
function collapseRegistryDuplicateKeyWarnings(warnings: string[]): string[] {
  const dupKeyRe = /^Duplicate symbolKey '([^']+)' has (\d+) candidates$/;
  const samples: string[] = [];
  let dupCount = 0;
  const rest: string[] = [];
  for (const w of warnings) {
    const m = dupKeyRe.exec(w);
    if (m) {
      dupCount += 1;
      samples.push(m[1]);
      continue;
    }
    rest.push(w);
  }
  samples.sort(compareContractStrings); // or existing local compare
  if (dupCount > 0) {
    const sample = samples.slice(0, 3).join(",");
    rest.push(`DUPLICATE_SYMBOL_KEY:${dupCount}${sample ? ` sample=${sample}` : ""}`);
  }
  return rest;
}
```

Apply to `input.registry.warnings` (and only those), then merge with neighbor warnings.

- [ ] **Step 3: Prove**

```bash
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test src/core/handlers.call_graph.test.ts src/core/call-graph.test.ts
```

---

### Task A3: L10 — Structured outline registry warnings

**Files:**
- Modify: `packages/mcp/src/core/navigation-handlers.ts` (~469–470)
- Modify envelope types if outline warnings become objects: `packages/mcp/src/core/search-types.ts` or outline types in navigation types
- Test: outline / navigation tests under `packages/mcp/src/core/`
- Prefer **backward-compatible** shape: keep `warnings: string[]` but make the string structured **or** add parallel `warningDetails` only if search already has that pattern (`buildSearchWarningDetails`)

**Preferred (minimal public churn):** mirror search’s structured details if outline envelope already allows `warnings` as strings:

```text
OUTLINE_SYMBOL_REGISTRY_WARNINGS:118 action=treat_outline_as_degraded_identity sample=...
```

Better if types allow:

```ts
{
  code: "OUTLINE_SYMBOL_REGISTRY_WARNINGS",
  count: 118,
  severity: "caution",
  blocksUse: false,
  action: "Prefer symbolId exact opens; reindex if identity looks wrong.",
  sample?: string[]  // top 3 keys if available
}
```

- [ ] Use the **same collapse helper idea as A2** only if both sites share identical string formats — otherwise duplicate 15 lines rather than force a premature shared module.
- [ ] Non-blocking: do not set `blocksUse=true`.
- [ ] If count is 0, omit warning entirely.

---

### Task A4: L9 — localeCompare sweep on paths touched + known hot contract sorts

**Files (priority list from exploration):**
- `packages/mcp/src/core/search-response-helpers.ts` (`buildSearchWarningDetails` sort)
- `packages/mcp/src/core/relationship-backed-call-graph.ts` (warning sort)
- `packages/mcp/src/core/registry-file-outline.ts`
- Optional same wave if cheap: `search-ranking-policy.ts`, `search-grouping.ts`, `search-owner-resolution.ts` **only if** those sorts affect MCP response order

**Out of scope for this residual plan:** full core `context.ts` / language registry localeCompare (unless a public MCP payload is proven non-deterministic). Track separately if needed.

- [ ] Replace with `compareContractStrings` from `@zokizuan/satori-core` (or local code-unit compare already used in `search-group-ordering.ts`).
- [ ] Add or extend a small test that monkeypatches `String.prototype.localeCompare` (pattern exists in `packages/core/src/sync/merkle.test.ts`) for at least warning sort stability.

---

## Wave B — Search contract truthfulness

### Task B1: M5 — Docs scope excludes tests

**Decision (locked):** Change public policy so `scope=docs` is **docs-only** (markdown/spec-ish paths classified as `docs`). Tests remain in `runtime` and `mixed`.

**Why not a new bucket:** Existing Failed/Requires Reindex analogy does not apply; this is a scope filter, not readiness. Changing inclusion is enough; no new scope enum value.

**Files:**
- Modify: `packages/mcp/src/core/search-ranking-policy.ts` — `shouldIncludeCategoryInScope`
- Modify: `packages/mcp/src/tools/search_codebase.ts` schema `.describe(...)` for `scope`
- Modify tests:
  - `packages/mcp/src/core/handlers.scope.test.ts` (`docs scope only returns docs and tests` → docs only)
  - `packages/mcp/src/core/search.eval.test.ts` (`docs scope includes docs and tests only`)
  - any AGENTS / behavior spec mentions
- Doc: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`, `AGENTS.md` tool runtime if it states docs+tests

**Implementation:**

```ts
if (scope === "docs") {
  return category === "docs";
}
```

**Classification note:** `isTestPath` already wins over `isDocPath` in `classifyPathCategory` (tests before docs). `*.test.ts` never becomes `docs`. After the change, docs scope simply drops the tests category.

- [ ] Failing tests first that assert `src/foo.test.ts` **absent** and `docs/*.md` **present**.
- [ ] Prefer markdown/spec ranking only if residual noise remains among docs-classified `.ts` helpers under `docs/`; do **not** invent a new path category in the same patch unless tests prove docs-scope still polluted by non-doc code under `docs/`.

**Prove:**

```bash
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.scope.test.ts \
  src/core/search.eval.test.ts \
  src/tools/search_codebase.test.ts
```

---

### Task B2: L11 — Mega-symbol default open uses previewSpan

**Depends on:** HI-3 near-tie method preference (already staged). This task is the remaining “open wall of code” issue.

**Files:**
- Modify: `packages/mcp/src/core/search-group-results.ts` (`buildSearchNextActions` / primary `span` choice ~294–341)
- Possibly: helpers that build `recommendedNextAction` / `openSymbol` args
- Test: grouped search tests in `handlers.scope.test.ts` or dedicated group-results test

**Policy:**
- Keep `symbolSpan` and `previewSpan` both present (already).
- If `symbolSpan` line count ≥ threshold (recommend **200** lines, constant named e.g. `OVERSIZED_SYMBOL_LINE_THRESHOLD`), then:
  - `span` used for default `nextActions.openSymbol` / primary open hint = `previewSpan`
  - optionally set a non-blocking warning or capability note: `SEARCH_OVERSIZED_SYMBOL_PREVIEW_OPEN`
- Do **not** drop method/function groups; HI-3 already prefers them on near-tie.

- [ ] Failing test: class with 2000-line symbolSpan + small previewSpan → openSymbol start/end match previewSpan.
- [ ] Clear score winner still ranks first even if mega-class (HI-3 regression must stay green).

---

## Wave C — Inbound discovery without new tools

### Task C1: M7 — Promote search when inbound is notes-only

**Decision (locked):** No new MCP tool. No new graph edge confidence inventing “fake edges.”

**Files:**
- Modify: call_graph response assembly (`relationship-backed-call-graph.ts` and/or handler that serializes call_graph envelope)
- Types: `packages/mcp/src/core/call-graph.ts` `CallGraphResponseSupported` — optional `nextActions` / `recommendedNextAction` **only if** envelope already allows hints; otherwise put under existing `hints` if present on unsupported/supported shapes
- Test: `handlers.call_graph.test.ts`

**Behavior:**
When `direction` is `callers` or `both`, and:
- inbound **edges** count is 0, and
- there exists ≥1 `notes` entry with `type === "suppressed_edge"` targeting the resolved symbol (or inbound-suppressed set non-empty),

then attach an executable fallback, e.g.:

```ts
hints: {
  nextSteps: [
    {
      tool: "search_codebase",
      args: {
        path: "<absolute root>",
        query: `must:${label} path:${callerHintOrRepo}`,
        scope: "runtime",
        resultMode: "grouped",
      },
      reason: "Inbound graph edges were suppressed as low-confidence; use deterministic must: search to find call sites.",
    },
  ],
}
```

Use the same next-step shape already used for reindex/root discovery elsewhere so agents can execute without parsing prose.

**Do not:**
- Promote low-confidence edges into `edges` without a separate confidence flag (would reintroduce false blast-radius).
- Add “name + file import” as pretended CALLS edges. If a bounded heuristic mode is later desired, it must be explicitly labeled `kind: "import"` / `confidence: heuristic` and is a **follow-on design**, not this residual patch.

- [ ] Test: notes-only inbound → hints present with `search_codebase` + `must:`.
- [ ] Test: real inbound edges present → no spammy forced search hint (or only optional secondary).

---

## Wave D — AST splitter quality

### Task D1: M8 — Fix / contain Invalid argument + expose fallback rate **separately**

**Files:**
- Modify: `packages/core/src/splitter/ast-splitter.ts`
- Test: `packages/core/src/splitter/ast-splitter.test.ts`
- Optional status surface: manage_index status envelope builders in mcp (`manage-maintenance-handlers.ts`) — **new field name not `symbolQuality.*cause`**

**Phase D1a — Correctness / noise (required):**
1. Reproduce `Invalid argument` with a minimal TS fixture (tool call logs suggested large TS during smoke). Common causes: wrong language grammar, empty/null code, concurrent reuse of a single Parser without reset, or unsupported node API.
2. Hardening candidates (pick smallest that stops the flood):
   - Ensure `setLanguage` + `parse` run on a per-call safe parser state.
   - Guard empty code / oversized buffers with explicit fallback without throwing.
   - Rate-limit identical stderr lines (e.g. log once per language+error class per process, then count).
3. Prefer structured logger over emoji `console.warn` spam for production paths if a logger port already exists; otherwise rate-limited `console.warn` is acceptable.

**Phase D1b — Observability (optional same wave or follow-on):**
- Track counters during index: `astOk`, `textSymbolFallback`, `recursiveFallback`.
- Expose on `manage_index status` as e.g. `splitterStats: { textSymbolFallbackRate, recursiveFallbackRate, basis: "last_index_run" }` — **not** inside `symbolQuality.status`.
- `symbolQuality` remains registry-observed richness only (AGENTS contract).

- [ ] Unit test: splitter does not throw on previously failing fixture; returns chunks.
- [ ] Unit test: repeated failures do not emit unbounded unique log volume (if rate-limit added).
- [ ] If status field added: type + doctor/status test + spec sentence.

---

## Wave E — Installer residual (conditional)

### Task E1: L12 — Only if HI-1 gap remains

**Prerequisite:** Re-run install → Claude config → doctor after HI-1 is committed/used.

**Already covered by staged HI-1:**
- Omit empty Claude env keys (`buildPreservedManagedEnv`)
- Doctor trims/blanks env

**Only implement if residual product gap:**
- Install result message explicitly says credentials required / managed entry incomplete when voyage/milvus absent
- Or list_codebases already shows provider_incomplete (HI-2) — prefer that over new install-only UX

**Do not** invent a fourth readiness narrative.

---

## Docs & contract checklist (per wave)

| Wave | Docs/tests to update |
|------|----------------------|
| A | `read_file` tests; call_graph tests; outline tests; behavior spec open_symbol + warnings note |
| B | `search_codebase` schema describe; scope tests; eval tests; AGENTS scope line if present; behavior spec scope matrix |
| C | call_graph envelope hints; behavior spec “inbound notes → search” |
| D | splitter tests; optional status field in manage_index types + spec |
| E | install/doctor tests only if code changes |

---

## Explicit non-goals (parked)

| Item | Why parked |
|------|------------|
| New `referenceSearch` tool | Violates fixed six-tool surface |
| New list_codebases bucket for provider | HI-2 uses reason codes; already preferred |
| Raising low-confidence CALLS edges into edges by default | F6 blast-radius risk |
| Full localeCompare purge of all core | Large hygiene; only contract-ordering paths here |
| AST language expansion / new extractors | Separate capability plan |
| F3/FLC design | Out of residual board |

---

## Proof gates (pick smallest per wave)

```bash
# Wave A
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/tools/read_file.test.ts \
  src/core/handlers.call_graph.test.ts \
  src/core/call-graph.test.ts

# Wave B
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.scope.test.ts \
  src/core/search.eval.test.ts \
  src/core/search-group-ordering.test.ts

# Wave C
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.call_graph.test.ts

# Wave D
pnpm --filter @zokizuan/satori-core exec node --import tsx --test \
  src/splitter/ast-splitter.test.ts

# Before any release cut of a wave
pnpm run check
pnpm --filter @zokizuan/satori-mcp test
```

---

## Risk register

| Risk | Mitigation |
|------|------------|
| M4 content still shows overlap lines | Document as source-truth; fix attribution via outline-only sibling drop |
| M5 breaks agents that used docs scope for tests | Spec + schema describe; tests live under runtime |
| M6 collapse hides useful keys | Keep count + 3 samples; full list remains in registry build logs if needed |
| M7 agents ignore hints | Reuse executable nextSteps shape agents already follow for reindex |
| M8 status field confuses with symbolQuality | Separate `splitterStats`; never overload symbolQuality |
| Scope creep into new tools/buckets | Reject in review; plan non-goals |

---

## Suggested ship slices (semantic commits when asked)

1. `fix(mcp): clamp open_symbol outline to exact resolved symbol`
2. `fix(mcp): collapse call_graph duplicate symbolKey warnings`
3. `fix(mcp): structure outline registry warning counts`
4. `fix(mcp): use compareContractStrings for contract warning sorts`
5. `fix(mcp): make docs scope docs-only (exclude tests)`
6. `fix(mcp): open oversized symbols via previewSpan by default`
7. `fix(mcp): promote search_codebase when inbound call_graph is notes-only`
8. `fix(core): harden AST splitter fallback logging [+ optional status stats]`

---

## Self-review (spec coverage)

| Requirement | Task |
|-------------|------|
| 4 open_symbol neighboring text | A1 |
| 5 docs scope tests | B1 |
| 6 call_graph warning spam | A2 |
| 7 inbound notes-only | C1 |
| 8 AST splitter noise / quality | D1 |
| 9 localeCompare residual | A4 |
| 10 opaque outline warnings | A3 |
| 11 mega-symbols | B2 (+ HI-3 done) |
| 12 installer managed empty env | E1 conditional; HI-1 primary |

No new shared classifier module required up front. No new list bucket. No new public tool.
