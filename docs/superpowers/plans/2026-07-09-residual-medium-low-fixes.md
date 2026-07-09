# Residual Medium/Low Navigation & Search Fixes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the medium- and lower-impact agent confusion paths (wrong open_symbol attribution, untrustworthy docs scope, warning spam, weak inbound discovery, splitter noise, ordering/hygiene, mega-symbol walls, installer polish) without expanding the six-tool public surface.

**Architecture:** Keep adapters → application → domain ownership. Prefer pure helpers co-located with the existing owner; extract only when two call sites share the same priority/collapse rule. Prefer reason codes / structured warning objects / fallback promotion over new tools or new list buckets. HI-1/HI-2/HI-3 (provider readiness, installer empty env, near-tie ranking) are **already implemented and committed** — do not re-open them here except where L12 is explicitly residual polish beyond HI-1.

**Tech Stack:** TypeScript monorepo (`packages/mcp`, `packages/core`, `packages/cli`), Node `node:test`, `pnpm`, existing MCP JSON envelopes.

---

## Plan revision (2026-07-09 review)

| Finding | Resolution in this plan |
|---------|-------------------------|
| **B2** preview-open via `openSymbol`/`span` conflicts with exact `open_symbol` contract (`read_file` overwrites request range with resolved span) | **Keep** `span` / `symbolSpan` / `nextActions.openSymbol` exact (full symbol). For oversized symbols, `recommendedNextAction` prefers a plain `read_file` **preview range** first. Assert `callGraphHint.symbolRef.span` remains full symbol span. |
| **C1** `must:${label} path:${…}` is malformed (whitespace tokenization; unsafe path values) | Reuse `extractIdentifierFromSymbolLabel` → `must:<id> <id>` (same as `buildExactSymbolFallbackQuery`). Include `path:` only for sanitized repo-relative file/glob. Test labels with spaces/parentheses. |
| **Wave A too broad** vs “do not mix waves” | Split into **independent ship slices**: A1 (M4) alone; A2 (M6) alone; A3 (L10) alone unless collapse rule is proven shared with M6; A4 (L9) separate bounded contract-ordering cleanup. |

No blocker on A1, B1, D1, or E1 direction.

---

## Constraints (do not violate)

| Rule | Implication |
|------|-------------|
| Six tools only | No `referenceSearch` tool. Promote existing `search_codebase` / `navigationFallback` / `nextActions`. |
| Determinism | Warning collapse samples must be sorted with `compareContractStrings` (or local code-unit compare already used nearby). |
| Fail closed | `open_symbol` still must not guess on ambiguity; exact resolve stays exact. |
| Exact open contract | Exact `open_symbol` always opens the **resolved symbol span**. Do not smuggle `previewSpan` into `open_symbol` args expecting truncated content — `read_file` overwrites request range with the resolved span (`packages/mcp/src/tools/read_file.ts` exact path). |
| Group span integrity | Do not replace primary group `span` / `symbolSpan` with preview just to shrink opens — that leaks into `callGraphHint`, `nextActions.openSymbol`, and legacy group span (`search-group-results.ts`). |
| `symbolQuality` contract | Remains **observed registry richness**, not parser-cause diagnosis. Parser-fallback rate is a **separate** status field if added. |
| Public contract changes | Same patch updates tests + schema `describe` + `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` (and AGENTS if agent-facing). |
| No speculative modules | Failing tests first; extract helper only if duplication of priority/collapse rules is real. |
| Do not mix ship slices | Each **ship slice** is independently shippable, testable, and reviewable. A “wave” is only an ordering hint. |
| Commits | Only when user explicitly asks. |

---

## Research Summary (grounded owners)

| ID | Defect | Owner (edit here first) | Evidence in tree |
|----|--------|-------------------------|------------------|
| **M4** | `open_symbol` annotated path re-outlines the window and surfaces overlapping sibling symbols; content can include shared overlap lines | `packages/mcp/src/tools/read_file.ts` (exact open + annotated branch ~447–628); outline builder `packages/mcp/src/core/registry-file-outline.ts` | Exact open already sets `startLine/endLine` from `resolvedSymbol.span`; annotated mode then calls `handleFileOutline({ start_line, end_line })` without restricting to resolved `symbolId` |
| **M5** | `scope=docs` includes **tests** by policy | `packages/mcp/src/core/search-ranking-policy.ts` `shouldIncludeCategoryInScope` (docs branch returns `docs \|\| tests`); schema text in `search_codebase.ts:152`; tests in `handlers.scope.test.ts` / `search.eval.test.ts` | Explicit contract today: docs returns docs **and** tests |
| **M6** | Call graph dumps every `Duplicate symbolKey '…' has N candidates` from registry | `packages/core/src/symbols/registry.ts:593–596` emits per-key strings; `packages/mcp/src/core/relationship-backed-call-graph.ts:352–358` spreads `input.registry.warnings` into response | Per-key warnings are intentional at build; **collapse at call_graph presentation boundary** |
| **M7** | Inbound often notes-only (suppressed low confidence); discovery cost high | `relationship-backed-call-graph.ts` already builds `suppressed_edge` notes + Python caller fallback; **no** top-level search promotion on call_graph envelope | Promote executable `search_codebase` using **identifier extraction**, not raw labels (see `extractIdentifierFromSymbolLabel` / `buildExactSymbolFallbackQuery` in `search-response-helpers.ts`) |
| **M8** | AST splitter catch → stderr flood + silent text-symbol fallback | `packages/core/src/splitter/ast-splitter.ts:83–109` (`parser.setLanguage` / `parse` catch); quality gauge `packages/core/src/symbols/symbol-quality.ts` deliberately non-parser | Fix Invalid argument if reproducible; aggregate fallback metrics separately from `symbolQuality` |
| **L9** | Residual `localeCompare` on contract sorts | e.g. `search-response-helpers.ts:33`, `relationship-backed-call-graph.ts:358`, `registry-file-outline.ts` | Bounded **contract-ordering** cleanup only; not a full ranking/grouping sweep in the same slice |
| **L10** | `OUTLINE_SYMBOL_REGISTRY_WARNINGS:N` opaque string | `navigation-handlers.ts:469–470` | Structured warning or drop when non-blocking; share helper with M6 **only** if formats match |
| **L11** | Mega-class groups dominate; recommended action opens a wall of code | HI-3 near-tie sort in `search-group-ordering.ts`; group build keeps full `symbolSpan` as primary `span` (`search-group-results.ts:294–302`); exact `open_symbol` always expands to full resolved span | **Do not** point `openSymbol` at `previewSpan`. Prefer plain `read_file` preview in `recommendedNextAction` when oversized |
| **L12** | Managed Claude empty env looked healthy | Largely fixed by **HI-1** (`buildPreservedManagedEnv`, doctor blank trim). Residual: install-time degraded signal if still desired | Only if post-HI-1 gap remains after re-test |

**Dependency note:** M4 does not depend on M5–M8. M6 collapse is independent of M7 promotion. M5 is a deliberate public scope contract change (tests + docs). M8 root-cause may need a repro fixture; do not block A1 on it.

---

## Recommended execution order (ordering only — ship separately)

```text
Slice A1  M4  open_symbol exact outline / sibling drop          [ship alone]
Slice A2  M6  call_graph duplicate-key warning collapse         [ship alone]
Slice A3  L10 outline registry warning structure                [ship alone;
                                                                share helper with A2 only if
                                                                string formats truly match]
Slice A4  L9  bounded contract-ordering localeCompare cleanup   [ship alone + monkeypatch test]

Slice B1  M5  docs scope excludes tests
Slice B2  L11 oversized: recommendedNextAction → plain preview read
              (keep span/symbolSpan/openSymbol exact)

Slice C1  M7  notes-only inbound → search_codebase must:<identifier>

Slice D1  M8  AST Invalid argument + bounded logging [+ optional splitterStats]

Slice E1  L12 installer residual (only if needed after HI-1)
```

Rationale: M4 is highest agent-harm and must not mix with warning-presentation churn. M6/L10/L9 are independent review units. M5 is a scope contract flip. L11 must not fight exact open. M7 needs correct must: construction. M8/D are core/indexing. L12 is conditional.

---

## Slice A1: M4 — Strict open_symbol content + exact outline under open

**Ship alone.** Do not bundle warning or localeCompare work.

**Files:**
- Modify: `packages/mcp/src/tools/read_file.ts`
- Modify (only if window filter belongs in outline builder): `packages/mcp/src/core/registry-file-outline.ts`
- Test: `packages/mcp/src/tools/read_file.test.ts`
- Doc (if annotated envelope fields change): `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

**Invariants:**
1. Exact `open_symbol` content is always `lines[resolved.startLine-1 .. resolved.endLine]` and never widened by request span, outline window, or sibling symbols. (`read_file` already overwrites request range with resolved span after exact outline — keep that.)
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
2. Build annotated outline from the already-resolved exact symbol only (reuse fields from the exact outline response already in hand).
3. Keep content slice from that same resolved span.

Avoid a new shared “classifier module.” A small local helper is fine:

```ts
function outlineFromResolvedOpenSymbol(resolved: ExactSymbol): { symbols: unknown[] } {
  return { symbols: [resolved] };
}
```

- [ ] **Step 3: Prove**

```bash
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test src/tools/read_file.test.ts
```

- [ ] **Step 4: Spec note** — exact open returns only the resolved symbol in annotated outline; content is the resolved span.

---

## Slice A2: M6 — Collapse registry duplicate-key warnings on call_graph

**Ship alone.**

**Files:**
- Modify: `packages/mcp/src/core/relationship-backed-call-graph.ts` (presentation boundary ~352–358)
- Optionally pure helper co-located in the same file **only if** A3 will not share it yet
- Test: `packages/mcp/src/core/handlers.call_graph.test.ts` and/or `call-graph.test.ts`
- Do **not** change `buildSymbolRegistry` warning generation unless a second consumer also needs collapse

**Contract:**
- Default response: at most one collapsed line, e.g.  
  `DUPLICATE_SYMBOL_KEY:42 sample=foo,bar,baz`  
  (count + up to 3 sample keys, sorted deterministically).
- Full per-key list only if an existing debug path already exists; **do not invent** a call_graph debug param for this slice.
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
  samples.sort(compareContractStrings);
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
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.call_graph.test.ts src/core/call-graph.test.ts
```

---

## Slice A3: L10 — Structured outline registry warnings

**Ship alone.** Share a helper with A2 **only after** proving both sites collapse the same string format; otherwise duplicate a few lines.

**Files:**
- Modify: `packages/mcp/src/core/navigation-handlers.ts` (~469–470)
- Modify envelope types only if outline warnings become objects
- Test: outline / navigation tests under `packages/mcp/src/core/`

**Preferred (minimal public churn):** keep `warnings: string[]` but make the string actionable:

```text
OUTLINE_SYMBOL_REGISTRY_WARNINGS:118 action=treat_outline_as_degraded_identity sample=...
```

If types already support structured details (search-style), prefer:

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

- [ ] Non-blocking: do not set `blocksUse=true`.
- [ ] If count is 0, omit warning entirely.
- [ ] Prove with outline-focused tests only (do not re-run the entire call_graph suite as a merge requirement for this slice).

---

## Slice A4: L9 — Bounded contract-ordering localeCompare cleanup

**Ship alone.** This is **not** an open-ended ranking/grouping sweep.

**In scope (public MCP ordering paths only):**
- `packages/mcp/src/core/search-response-helpers.ts` (`buildSearchWarningDetails` sort)
- `packages/mcp/src/core/relationship-backed-call-graph.ts` (warning sort) — only if not already fixed as a drive-by in A2; prefer fix here if A2 deliberately left compare alone
- `packages/mcp/src/core/registry-file-outline.ts` (warning sort)

**Explicitly out of this slice:**
- `search-ranking-policy.ts`, `search-grouping.ts`, `search-owner-resolution.ts` (park; open a separate hygiene ticket if MCP payload order is proven locale-sensitive)
- Full core `context.ts` / language registry localeCompare

- [ ] Replace in-scope sorts with `compareContractStrings` from `@zokizuan/satori-core` (or the local code-unit compare used in `search-group-ordering.ts`).
- [ ] **Required proof:** monkeypatch `String.prototype.localeCompare` (pattern in `packages/core/src/sync/merkle.test.ts`) for at least one warning-sort path and assert stable order.

```bash
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/search-response-helpers.test.ts  # or nearest existing test file extended
```

---

## Slice B1: M5 — Docs scope excludes tests

**Decision (locked):** Change public policy so `scope=docs` is **docs-only** (markdown/spec-ish paths classified as `docs`). Tests remain in `runtime` and `mixed`.

**Why not a new bucket:** This is a scope filter, not readiness. No new scope enum value.

**Files:**
- Modify: `packages/mcp/src/core/search-ranking-policy.ts` — `shouldIncludeCategoryInScope`
- Modify: `packages/mcp/src/tools/search_codebase.ts` schema `.describe(...)` for `scope`
- Modify tests:
  - `packages/mcp/src/core/handlers.scope.test.ts` (`docs scope only returns docs and tests` → docs only)
  - `packages/mcp/src/core/search.eval.test.ts` (`docs scope includes docs and tests only`)
- Doc: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`, `AGENTS.md` if it states docs+tests

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

## Slice B2: L11 — Oversized symbols: recommend plain preview read (not preview open_symbol)

**Depends on:** HI-3 near-tie method preference (already committed). This task is the remaining “open wall of code” issue.

### Why the old approach is wrong

1. Exact `open_symbol` **always** clamps content to the **resolved symbol span** (`read_file.ts` exact resolve overwrites any requested `start_line`/`end_line`). Putting `previewSpan` into `open_symbol` args is a **no-op** for wall-of-code content.
2. Replacing primary group `span` with `previewSpan` leaks into:
   - `callGraphHint` / `symbolRef.span` (`search-group-results.ts` ~313)
   - `nextActions.openSymbol` (~324–331)
   - legacy group `span` field (~347)
   That corrupts graph identity and exact navigation.

### Locked policy

| Field | Oversized symbol behavior |
|-------|---------------------------|
| `symbolSpan` | Full resolved symbol (unchanged) |
| `span` (legacy primary) | Full symbol span (unchanged) |
| `previewSpan` | Hit/preview window (unchanged) |
| `nextActions.openSymbol` | Still exact full-symbol open (when ready) |
| `callGraphHint.symbolRef.span` | **Full** symbol span (must not shrink) |
| `recommendedNextAction` | Prefer plain `read_file` with `previewSpan` line range **before** exact open when `symbolSpan` line count ≥ threshold |

Threshold: recommend **200** lines, constant e.g. `OVERSIZED_SYMBOL_LINE_THRESHOLD`.

Optional non-blocking warning / capability note: `SEARCH_OVERSIZED_SYMBOL_PREVIEW_READ` (name must not claim “preview open_symbol”).

**Files:**
- Modify: helpers that build `recommendedNextAction` / top action selection (e.g. `search-response-helpers.ts`, `search-response-envelopes.ts`, and/or `search-group-results.ts` — **only** the recommended-action path, not primary `span` assignment)
- Test: grouped search tests asserting recommended action shape + `callGraphHint.symbolRef.span` integrity

**Do not:**
- Set `nextActions.openSymbol` start/end from `previewSpan`
- Overwrite primary `span` or `symbolSpan` with preview
- Drop method/function groups (HI-3 already prefers them on near-tie)

- [ ] **Failing tests**

```ts
test("oversized symbol recommends plain read_file preview before exact open", async () => {
  // group with symbolSpan 1–2000, previewSpan 100–140
  // assert recommendedNextAction.tool === "read_file"
  // assert args use start_line/end_line from previewSpan
  // assert args do NOT use open_symbol for the default recommendation
  // assert nextActions.openSymbol (if present) still uses full symbol span
  // assert callGraphHint.symbolRef.span === full symbolSpan
});

test("clear higher score still ranks first even for mega-class", async () => {
  // HI-3 regression remains green
});
```

- [ ] Implement only `recommendedNextAction` / top-action selection branching on oversized line count.
- [ ] Prove with scoped search/group tests (not full MCP suite required for green light of this slice).

---

## Slice C1: M7 — Promote search when inbound is notes-only

**Decision (locked):** No new MCP tool. No new graph edge confidence inventing “fake edges.”

**Files:**
- Modify: call_graph response assembly (`relationship-backed-call-graph.ts` and/or handler that serializes call_graph envelope)
- Reuse: `extractIdentifierFromSymbolLabel` from `packages/mcp/src/core/search-response-helpers.ts` (same pattern as `buildExactSymbolFallbackQuery`)
- Types: optional `hints.nextSteps` / existing hints shape on supported call_graph responses
- Test: `handlers.call_graph.test.ts`

### Behavior

When `direction` is `callers` or `both`, and:
- inbound **edges** count is 0, and
- there exists ≥1 `notes` entry with `type === "suppressed_edge"` targeting the resolved symbol (or inbound-suppressed set non-empty),

attach an executable fallback.

### Query construction (locked — do not invent raw labels)

Operator parsing tokenizes on whitespace (`search-query-planning.ts`). A raw label like `method buildOperatorSummary(operators: ParsedSearchOperators)` becomes `must:method` plus loose semantic tokens — too broad and non-deterministic.

**Required pattern** (mirrors existing search fallback):

```ts
import { extractIdentifierFromSymbolLabel } from "./search-response-helpers.js";

function buildInboundNotesOnlySearchQuery(input: {
  symbolLabel?: string;
  symbolId?: string;
  file?: string; // repo-relative only
}): { query: string; pathFilterIncluded: boolean } {
  const identifier =
    extractIdentifierFromSymbolLabel(input.symbolLabel)
    || extractIdentifierFromSymbolLabel(input.symbolId);
  // Prefer must:<id> <id> so lexical must: and semantic term agree.
  const base = identifier ? `must:${identifier} ${identifier}` : undefined;
  if (!base) {
    // Fail closed on fallback quality: omit search next step rather than emit garbage must:.
    return { query: "", pathFilterIncluded: false };
  }

  const file = input.file?.trim() ?? "";
  const isSafeRepoRelativePath =
    file.length > 0
    && !file.startsWith("/")
    && !file.includes("://")
    && !file.includes("..")
    && !/\s/.test(file);

  if (isSafeRepoRelativePath) {
    return { query: `${base} path:${file}`, pathFilterIncluded: true };
  }
  return { query: base, pathFilterIncluded: false };
}
```

Then:

```ts
hints: {
  nextSteps: [
    {
      tool: "search_codebase",
      args: {
        path: "<absolute codebase root>", // manage/search path contract: absolute root
        query: constructedQuery,          // must:<identifier> <identifier> [path:rel/file]
        scope: "runtime",
        resultMode: "grouped",
      },
      reason:
        "Inbound graph edges were suppressed as low-confidence; use deterministic must: search to find call sites.",
    },
  ],
}
```

**Path rules:**
- Tool `path` arg = absolute codebase root (existing contract).
- Query `path:` operator = **only** sanitized repo-relative file/glob — never absolute root, never prose “caller hint.”
- If identifier cannot be extracted, **omit** the search next step (fail closed on quality) rather than emit `must:method` noise.

**Do not:**
- Promote low-confidence edges into `edges` without an explicit confidence flag.
- Add “name + file import” as pretended CALLS edges in this residual patch.
- Concatenate raw `symbolLabel` into `must:`.

- [ ] Test: notes-only inbound → hints present with `search_codebase` and `must:<identifier>` where identifier has no spaces.
- [ ] Test: label `method buildOperatorSummary(operators: ParsedSearchOperators)` → query contains `must:buildOperatorSummary` and `buildOperatorSummary`, **not** `must:method` as the only must token with trailing paren soup.
- [ ] Test: unsafe/missing file → no `path:` operator in query.
- [ ] Test: real inbound edges present → no spammy forced search hint (or only optional secondary).

---

## Slice D1: M8 — Fix / contain Invalid argument + expose fallback rate **separately**

**Files:**
- Modify: `packages/core/src/splitter/ast-splitter.ts`
- Test: `packages/core/src/splitter/ast-splitter.test.ts`
- Optional status surface: manage_index status envelope builders in mcp — **new field name not `symbolQuality.*cause`**

**Phase D1a — Correctness / noise (required):**
1. Reproduce `Invalid argument` with a minimal TS fixture. Common causes: wrong language grammar, empty/null code, concurrent reuse of a single Parser without reset, or unsupported node API.
2. Hardening candidates (pick smallest that stops the flood):
   - Ensure `setLanguage` + `parse` run on a per-call safe parser state.
   - Guard empty code / oversized buffers with explicit fallback without throwing.
   - Rate-limit identical stderr lines (e.g. log once per language+error class per process, then count).
3. Prefer structured logger over emoji `console.warn` spam for production paths if a logger port already exists; otherwise rate-limited `console.warn` is acceptable.

**Phase D1b — Observability (optional same slice or follow-on):**
- Track counters during index: `astOk`, `textSymbolFallback`, `recursiveFallback`.
- Expose on `manage_index status` as e.g. `splitterStats: { textSymbolFallbackRate, recursiveFallbackRate, basis: "last_index_run" }` — **not** inside `symbolQuality.status`.
- `symbolQuality` remains registry-observed richness only (AGENTS contract).

- [ ] Unit test: splitter does not throw on previously failing fixture; returns chunks.
- [ ] Unit test: repeated failures do not emit unbounded unique log volume (if rate-limit added).
- [ ] If status field added: type + status test + spec sentence.

---

## Slice E1: L12 — Only if HI-1 gap remains

**Prerequisite:** Re-run install → Claude config → doctor after HI-1 is in use.

**Already covered by HI-1:**
- Omit empty Claude env keys (`buildPreservedManagedEnv`)
- Doctor trims/blanks env

**Only implement if residual product gap:**
- Install result message explicitly says credentials required / managed entry incomplete when voyage/milvus absent
- Or list_codebases already shows provider_incomplete (HI-2) — prefer that over new install-only UX

**Do not** invent a fourth readiness narrative.

---

## Docs & contract checklist (per ship slice)

| Slice | Docs/tests to update |
|-------|----------------------|
| A1 | `read_file` tests; behavior spec open_symbol annotated outline note |
| A2 | call_graph tests; optional warning-shape note in behavior spec |
| A3 | outline/navigation tests |
| A4 | contract sort monkeypatch test |
| B1 | `search_codebase` schema describe; scope tests; eval tests; AGENTS/spec scope matrix |
| B2 | search recommended-action tests; behavior spec “oversized → plain preview read first” |
| C1 | call_graph hints; behavior spec “inbound notes → must: identifier search” |
| D1 | splitter tests; optional status field types + spec |
| E1 | install/doctor tests only if code changes |

---

## Explicit non-goals (parked)

| Item | Why parked |
|------|------------|
| New `referenceSearch` tool | Violates fixed six-tool surface |
| New list_codebases bucket for provider | HI-2 uses reason codes; already preferred |
| Raising low-confidence CALLS edges into edges by default | F6 blast-radius risk |
| Putting previewSpan into open_symbol to shrink content | Exact open overwrites range; no-op / contract fight |
| Replacing primary group span with previewSpan | Leaks into callGraphHint and openSymbol |
| Raw `must:${symbolLabel}` fallbacks | Whitespace tokenization breaks labels |
| Full localeCompare purge of ranking/grouping/core | Separate hygiene; A4 is bounded only |
| AST language expansion / new extractors | Separate capability plan |
| F3/FLC design | Out of residual board |

---

## Proof gates (smallest per ship slice)

```bash
# A1
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test src/tools/read_file.test.ts

# A2
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.call_graph.test.ts src/core/call-graph.test.ts

# A3
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/registry-file-outline.test.ts  # or navigation/outline tests that exist

# A4
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  # extend nearest helper test with localeCompare monkeypatch

# B1
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.scope.test.ts \
  src/core/search.eval.test.ts \
  src/tools/search_codebase.test.ts

# B2
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/search-group-ordering.test.ts \
  # + recommendedNextAction oversized coverage in group/response tests

# C1
pnpm --filter @zokizuan/satori-mcp exec node --import tsx --test \
  src/core/handlers.call_graph.test.ts

# D1
pnpm --filter @zokizuan/satori-core exec node --import tsx --test \
  src/splitter/ast-splitter.test.ts

# Before any multi-slice release cut
pnpm run check
pnpm --filter @zokizuan/satori-mcp test
```

---

## Risk register

| Risk | Mitigation |
|------|------------|
| M4 content still shows overlap lines | Document as source-truth; fix attribution via outline-only sibling drop |
| M5 breaks agents that used docs scope for tests | Spec + schema describe; tests live under runtime |
| M6 collapse hides useful keys | Keep count + 3 samples |
| M7 malformed must: from labels | Use `extractIdentifierFromSymbolLabel`; test spaced/paren labels; omit fallback if no identifier |
| M7 unsafe path: | Only sanitized repo-relative paths; absolute root stays in tool `path` arg |
| L11 wall-of-code via open_symbol | Recommend plain preview read; never smuggle preview into exact open or primary span |
| L11 callGraphHint corruption | Assert `symbolRef.span` stays full symbolSpan |
| M8 status field confuses with symbolQuality | Separate `splitterStats`; never overload symbolQuality |
| Wave bundling | Ship A1/A2/A3/A4 as separate commits/PRs |
| Scope creep into new tools/buckets | Reject in review; plan non-goals |

---

## Suggested ship slices (semantic commits when asked)

1. `fix(mcp): clamp open_symbol outline to exact resolved symbol` — **A1**
2. `fix(mcp): collapse call_graph duplicate symbolKey warnings` — **A2**
3. `fix(mcp): structure outline registry warning counts` — **A3**
4. `fix(mcp): use compareContractStrings for contract warning sorts` — **A4**
5. `fix(mcp): make docs scope docs-only (exclude tests)` — **B1**
6. `fix(mcp): recommend plain preview read for oversized symbols` — **B2**
7. `fix(mcp): promote must: identifier search when inbound call_graph is notes-only` — **C1**
8. `fix(core): harden AST splitter fallback logging [+ optional status stats]` — **D1**

---

## Self-review (spec coverage)

| Requirement | Task |
|-------------|------|
| 4 open_symbol neighboring text | A1 |
| 5 docs scope tests | B1 |
| 6 call_graph warning spam | A2 |
| 7 inbound notes-only | C1 (identifier-safe must:) |
| 8 AST splitter noise / quality | D1 |
| 9 localeCompare residual | A4 (bounded) |
| 10 opaque outline warnings | A3 |
| 11 mega-symbols | B2 (preview **read**, not preview open_symbol) + HI-3 |
| 12 installer managed empty env | E1 conditional; HI-1 primary |

### Review findings closed in plan

| Review item | Closed by |
|-------------|-----------|
| B2 vs exact open_symbol conflict | B2 rewritten: recommended plain read only |
| C1 malformed must:/path: | C1 uses extractIdentifier + safe path: rules |
| Wave A too broad | Split into A1–A4 independent ship slices |

No new shared classifier module required up front. No new list bucket. No new public tool.
