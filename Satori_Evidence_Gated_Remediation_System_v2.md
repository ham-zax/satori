# Satori Evidence-Gated Remediation System v2

> Goal: turn agent findings into verified engineering decisions without letting fluent reports become unearned work.

This system replaces a simple “loop through findings” with a stricter operating model:

```text
claim intake
  -> evidence dossier
  -> verification grade
  -> patch readiness
  -> single-scope implementation
  -> proof package
  -> closure decision
```

The key design choice: **investigation can be batched; mutation cannot.**

---

## 1. The invariant

No finding is patched until it has a complete evidence dossier.

No patch is closed until the original failure mode is rerun against the fixed build.

For every finding, preserve this separation:

| Phase | Allowed | Forbidden |
|---|---|---|
| Investigation | source reading, repros, coverage audit, severity classification | code changes |
| Patch | one scoped fix, tests for that fix, contract updates for that fix | opportunistic refactors, next finding |
| Proof | rerun failing case, run targeted tests, check valid behavior still works | “tests pass” without command/output |

---

## 2. Evidence grades

Use these grades instead of vague labels like “looks true.”

| Grade | Name | Meaning | Patch allowed? |
|---|---|---|---|
| E0 | Assertion | Agent claims it. No exact evidence. | No |
| E1 | Source-located | Exact files and lines shown. | No |
| E2 | Runtime-demonstrated | Repro, command, or inspection shows behavior. | Usually no; ask for tests |
| E3 | Test-specified | Existing or proposed tests prove the contract. | Yes, if scope is small |
| E4 | Fixed-proof | Patch + tests + original repro rerun on built artifact. | Close candidate |
| E5 | Regression-guarded | Fix is covered by durable CI/integration path and docs/contracts are aligned. | Closed |

F1 reached E4/E5 shape: source path, repro, tests, patch, and rerun showed no leaked content while valid in-root reads still worked.

---

## 3. Patch readiness levels

Evidence and patch readiness are related but different.

| Level | Meaning |
|---|---|
| P0 | Not patchable. Claim is vague or unproven. |
| P1 | Patchable in principle. Evidence proves the issue, but tests are not designed. |
| P2 | Patch-ready. Evidence is strong and failing tests are named. |
| P3 | Patch in progress. Scope is locked. |
| P4 | Proof-ready. Patch exists; needs final proof. |
| P5 | Closed. Proof package accepted. |

A finding can be serious but still P0. Seriousness does not replace proof.

---

## 4. The finding card

Every finding should be represented as a card with these fields.

```yaml
id:
claim:
risk_class: security | correctness | contract | operability | maintainability | hygiene
moving_resource:
boundary:
current_status:
evidence_grade:
patch_readiness:
owner:
batch:
dependencies:
evidence_required:
  source_locations:
  runtime_path:
  repro_or_inspection:
  existing_tests:
  missing_tests:
  falsifier:
patch_contract:
  allowed_files:
  forbidden_scope:
  behavior_change:
  compatibility_risk:
proof_contract:
  old_bad_behavior:
  valid_behavior:
  tests:
  build_or_runtime_check:
closure_decision:
notes:
```

The most important fields are `moving_resource` and `boundary`.

Examples:

- F1 resource: host filesystem bytes.
- F1 boundary: MCP client request must not become arbitrary host read.
- F4 resource: public agent contract.
- F4 boundary: docs/tool schemas must not instruct agents to use a stale contract.
- F5 resource: deterministic ordering.
- F5 boundary: OS/locale must not change contract-ranked output.

---

## 5. Batch rules

### Evidence batching

Investigate up to five findings at once.

Reason: evidence gathering is mostly read-only and benefits from comparison.

### Patch WIP limit

Patch exactly one finding at a time.

Reason: code mutation creates regression risk. One patch should have one proof story.

### Reopen WIP limit

Only one reopened finding at a time.

Reason: reopen means the mental model was wrong. Stop expanding until the failed assumption is understood.

---

## 6. Severity and priority score

Score only after evidence is at least E2.

```text
priority = impact + boundary_risk + contract_risk + regression_risk - patch_size_penalty
```

Use 0–3 for each positive dimension.

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Impact | cosmetic | dev friction | user/operator confusion | security/correctness breach |
| Boundary risk | none | internal module | public API/tool | trust/security boundary |
| Contract risk | none | internal docs | public docs | agent behavior contract |
| Regression risk | isolated | some coupling | broad lifecycle | cross-package/runtime |
| Patch size penalty | tiny | small | medium | broad/refactor |

Patch the highest score only if it is P2 or higher.

If a high-score finding is P0/P1, ask for missing proof first.

---

## 7. Closure types

A finding can close in four legitimate ways.

| Closure | Meaning |
|---|---|
| fixed_proven | Code changed and proof package passed. |
| false_proven | Evidence contradicted the claim. |
| accepted_risk | Behavior is intentional; contract/docs explicitly say so. |
| parked | Verified but deferred with reason, owner, and revisit trigger. |

Avoid “closed because discussed.”

---

## 8. Anti-gaming rules for agents

Reject these outputs:

| Agent move | Response |
|---|---|
| “Likely” / “probably” without line ranges | Ask for evidence or downgrade. |
| Source lines but no runtime path | Ask what execution path makes those lines matter. |
| Runtime repro but no tests | Ask for failing tests before patch. |
| Patch includes unrelated cleanup | Split or reject scope. |
| “All tests pass” without command output | Ask for command and relevant excerpts. |
| Final proof omits original repro | Not closed. |
| Fix changes public behavior but no docs | Proof incomplete. |
| Finding is maintainability-only but patch is broad | Convert to incremental seam extraction. |

---

## 9. Standard prompts

### 9.1 Batch investigation prompt

```text
Investigate this batch only: [IDs].

Do not patch anything.

For each finding, produce a finding card with:

- verdict: verified / partially_verified / unverified / false
- evidence grade: E0–E3
- patch readiness: P0–P2
- exact source locations with file paths and line ranges
- runtime/release path showing why the source matters
- repro, inspection command, or falsifier
- existing tests
- missing tests
- compatibility risk
- smallest patch proposal if verified
- recommended priority inside this batch

Use F1 as the evidence standard:
source lines + runtime path + repro/test proof + missing tests.

Do not move outside this batch.
```

### 9.2 Verification-ranking prompt

```text
Do not patch yet.

For this batch, rank only findings with evidence grade E2 or higher.

For each finding below E2, say exactly what proof is missing.

For each patchable finding, score:
- impact: 0–3
- boundary risk: 0–3
- contract risk: 0–3
- regression risk: 0–3
- patch size penalty: 0–3
- total priority score

Recommend one finding to patch first and explain why it is patch-ready.
```

### 9.3 Patch prompt

```text
Implement the smallest safe fix for [ID] only.

Scope lock:
- Do not patch any other finding.
- Do not refactor unrelated code.
- Do not rename public contracts unless required by this finding.
- Add tests that fail before the fix and pass after it.
- Update docs only if the behavior contract changes.

Patch contract:
1. [behavior requirement]
2. [boundary requirement]
3. [test requirement]
4. [compatibility requirement]

After patching, report:
- files changed
- behavior changed
- tests added or updated
- public contract/docs updated
- compatibility break, if any
```

### 9.4 Final proof prompt

```text
Show final proof for [ID].

Required:

1. Exact fix path with file paths and line ranges.
2. Test names added or changed.
3. Test command output with relevant pass lines.
4. Original repro or inspection rerun against the built/runtime artifact.
5. Valid behavior check showing intended behavior still works.
6. Public contract docs updated, if behavior changed.
7. Closure recommendation: fixed_proven / false_proven / accepted_risk / parked.

Do not move to the next finding.
```

---

## 10. Recommended Satori order after F1

F1 is closed first because it was a trust-boundary bug.

Next, do not automatically follow numeric order. Use evidence and risk.

Suggested investigation batches:

```text
Batch A: F4, F2, F5, F6, F11
Batch B: F7, F8, F9, F10, F3
```

Why this order:

- F4 is public contract drift: agents may act on wrong instructions.
- F2 is ownership/release-path drift: installer behavior can fork.
- F5 is determinism: may affect Merkle/search/ranking contracts.
- F6 is trust calibration: call graph evidence must not look stronger than it is.
- F11 may already be partly closed by F1, but other path tools need audit.
- F3 is real but should not become a giant refactor. Treat it as a seam-extraction policy, not an urgent patch.

---

## 11. Special handling by finding type

### Security/trust-boundary findings

Require E4 before closure.

Proof must include old exploit/repro rerun.

### Public contract findings

Require implementation + docs/schema alignment.

Proof must include at least one generated manifest, README/spec, or tool description check.

### Determinism findings

Require a test with adversarial values.

Good adversarial values include case differences, accents, numeric strings, path separators, and same-score ties.

### Maintainability findings

Do not patch broadly.

Instead, require:

1. a concrete seam,
2. an immediate reason to touch that seam,
3. before/after responsibility reduction,
4. tests proving no behavior change.

### Operability findings

Proof must include operator-facing output.

Examples: `doctor`, `status`, `list_codebases`, startup diagnostics, logs.

---

## 12. The one-page operating loop

```text
while findings remain:
    select next read-only batch of <= 5
    request evidence cards
    classify evidence grade and patch readiness
    rank only E2+ findings
    choose one P2+ finding
    request narrow patch
    request final proof
    close / reopen / park
```

The loop is intentionally boring. Boring is good here: it keeps the agent from turning a review into a refactor spiral.

---

## 13. Current F1 reference standard

F1 is the model example for future findings:

- Claim: `read_file` could read arbitrary host files.
- Proof: exact source path, execution order, runnable repro, symlink/`..`/sibling cases, missing tests.
- Patch: canonical realpath containment before content read.
- Tests: outside root, sibling, symlink escape, `..` escape, valid indexed root, annotated no-leak.
- Final proof: rerun built artifact; outside content denied; valid inside content allowed.

Future findings should be weaker or stronger than F1 explicitly, not vaguely.
