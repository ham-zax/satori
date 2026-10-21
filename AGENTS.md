# AGENTS.md

I’m Hamza. You’re my coding agent.

Build systems that are simple, predictable, maintainable, and easy to prove correct. Move quickly, but do not guess: find the behavior’s true owner, make the smallest complete change, prove the requested outcome, and stop.

Your global instructions (`~/.claude/CLAUDE.md` for Claude Code, `~/.codex/AGENTS.md` for Codex) own tools, context budget, delegation, and skill selection. This file owns the Satori-specific rules and wins where the two overlap. An applicable skill's protocol wins over this file, except "Working with me".

## Working with me

* **Answer the question asked.** Questions, explanations, reviews, audits, and diagnoses are read-only. Answer briefly from what you already know. Look something up only when you cannot answer without it, and leave side topics I did not raise.
* **Results before new work.** Report the finished run and deliver what is already owed before starting anything new.
* **Start from the workflow skill** your global instructions name, and use its fast path for small changes.
* **I dictate by voice.** Read for intent, state your reading of an unclear phrase in one line, and continue with what is clear.

## Scope

* A request authorizes only the edits and focused verification its outcome needs, in as many small, verified batches as that takes. It excludes a new outcome, a later phase, cleanup, redesign, refactoring, hardening, dependency upgrades, optimization, and adjacent fixes.
* For performance or robustness requests, the measured bottleneck or demonstrated failure defines the scope, wherever it lives.
* Anything outside scope requires `concrete risk | evidence it applies | current decision it changes`. If a part is missing, omit it. Report adjacent defects, warnings, and security findings separately instead of fixing them.
* Ask a blocking question, one at a time, only when the answer changes architecture, public behavior, data safety, authorization, irreversible state, meaningful cost, or the responsible owner. Otherwise take the smallest reversible, convention-consistent assumption and state it when it affects the result.
* Do not invent requirements, APIs, schemas, parameters, aliases, compatibility guarantees, or output shapes. Repository code, tests, configuration, and documentation are the primary evidence; use external sources for upstream or version-specific behavior the repository cannot establish. Surface instruction conflicts that would change the outcome.
* Ask before adding a dependency, external service, build requirement, persistent component, generator, or compatibility layer.
* Create a plan, report, status, or handoff file in the repository only when I ask or a skill requires it. Such files go in `docs/improvements/`, with a row in its `README.md`.

## Ownership

* Fix the responsible boundary, not a downstream symptom. Start from the owning code, one caller, the contract, and the nearest focused test.
* Every behavior and mutable state collection has one authoritative owner. Do not duplicate policy, validation, configuration, state, or business logic across domains.
* `Context` is the composition root and compatibility façade: it constructs services, wires dependencies, exposes established APIs, and delegates. It gains no new domain logic or mutable state, and it is not a cross-domain coordinator. Cross-domain workflows need an explicit coordinator with a named contract.
* New indexing, search, generation-authority, publication, retention, lease, repair, or navigation behavior belongs to a dedicated domain owner that depends on narrow ports or domain types, not on `Context`. Migrate existing dependencies only when the outcome requires it.
* Before adding behavior or state to an owner, identify `invariant | lifecycle | authoritative writer | persistence boundary | callers | why this owner is correct`. If the change would give an owner a second major domain, use the correct owner, do the smallest in-scope extraction, or report a blocker.
* File size and complexity are warning signals. Obey enforced budgets, make a bounded extraction decision when a change crosses one, and never split a file only to satisfy a number.

## Defects

* Establish `visible failure → demonstrated mismatch → violated invariant → responsible owner → falsifiable repair`.
* Hold one leading hypothesis at a time. When evidence contradicts the mechanism, return to the smallest reproduction. After two failed repairs on the same mechanism, reset and re-establish the mismatch, invariant, and owner.
* Every repair or iteration loop has `claim | disproving check | stopping condition`.
* Before expanding into an unrequested subsystem, state the hypothesis, expected evidence, and stopping condition, and investigate one bounded branch.
* Stop investigating when more evidence would not change the conclusion, owner, or next action.

## Changes

* Every changed file implements a stated requirement, lies on the demonstrated causal path, provides necessary regression evidence, or synchronizes an affected contract. Stop improving once the requested outcome works.
* Use established project patterns, libraries, and tools. Add no abstractions, extension points, or edge-case handling for hypothetical needs.
* Validate untrusted input where it enters the system. Stable inputs give stable outputs, ordering, diagnostics, and generated artifacts.
* Remove code the change makes obsolete unless an established contract requires compatibility.
* Before changing public behavior, identify first-party consumers and update only those the change invalidates. Keep affected tests, schemas, documentation, and generated artifacts in sync.
* Comments explain intent, ownership, invariants, or surprising constraints.

## Verification

* The default is focused checks, not the full suites: the smallest deterministic checks that together can disprove the requested outcome. To run one test file, use that package's `test:raw` flags with the file path in place of the glob. `pnpm run check` runs lint, typecheck, and the version and scope checks.
* Run broader checks only when I ask, repository policy requires them, the changed boundary invalidates them, or the change touches a hot path (search, indexing, admission, sync, publication). Caution, difficulty, or wanting extra confidence is not a reason.
* Add a test only when all three exist: `changed behavior or mechanism | realistic regression caused by this change | missing existing coverage`.
* Preserve the test oracle. Never weaken assertions, rewrite fixtures, delete cases, suppress failures, or change expected output to make the implementation pass.
* Reuse a passing result while its inputs are unchanged. After a repair, rerun the failed check and only what the repair invalidated.
* Once the focused checks pass, that state is final. Confirm scope with `git diff --stat`. Start a review only on evidence of a specific defect, when I ask, or when the active skill requires it.

### Changes that claim unchanged behavior

Optimizations, refactors, fast paths, caches, and concurrency changes promise the same observable results. Existing tests are evidence only where they exercise the changed paths.

* Make equivalence a test: list the inputs the new code branches on, build a small fixture for each, and assert that new and old produce the same published output.
* A fast path returns "unsure" and falls back to the slow path unless it is provably correct. Never re-implement a library or compiler rule and let the copy give definite answers.
* Code that starts background work must not return or throw while that work is in flight unless ownership is explicitly handed off. Check every `return` and `throw` path.
* Write failure-path tests before the fix, with deterministic fault injection rather than sleeps. Assert the real invariant (cleanup completed, nothing published) and confirm the test fails on the broken code.
* One change at a time: equivalence test, then measurement, then commit.

## Performance and robustness

Satori must be fast on every request and correct under concurrent writers, crashes, and partial failure.

* Profile before optimizing (CPU profile, phase timings, or argument-size logging on a realistic repository), and rank the remaining costs after each change.
* Work that is constant per session, per publication, or per unchanged file is not repeated per request. Cache it behind a witness that proves the input is unchanged (stat signature, content hash, or the identity of a frozen value), and fall back to the uncached path when the witness is missing or uncertain.
* Consolidate a redundant check only when a held invariant already guarantees it, and name that invariant in a comment at the remaining check.
* Architecture changes are in scope when the profile points there, including another owner, process, or worker and all cores. Ownership rules still decide where the code lives.
* Every cache, fast path, or consolidated check gets a differential test against the old path and a mutation check: break the witness or key, confirm the test fails, restore.
* Robustness means bounded batch, list, and filter sizes; cancellation and timeouts that release leases and stop background work; no partial publication on failure; deterministic ordering for equal scores.
* Report before and after medians of at least three runs on the same input, with peak memory, machine load, and the command used.

## Repository safety

* Check repository status before editing. Staged, unstaged, and untracked work is mine; never discard it.
* Amend, rebase, merge, stash, reset, clean, or change branches only when explicitly asked.
* Run no broad formatter, generator, codemod, or fix-all command that may modify unrelated files.
* Delete no user data, indexes, databases, environments, or irreplaceable generated output without explicit authorization.
* Start a long-running command once and wait for it rather than polling. Restart an active command only after confirmed failure or timeout. Leave no background processes, temporary files, or generated state behind.
* When malformed input or ambiguous state makes a safe result impossible, report a blocker instead of inventing behavior.

## Reporting

* Lead with the result or blocker. Cite files, symbols, commands, and tests. Keep observations, assumptions, and findings distinct, and state uncertainty.
* Reviews: `finding → evidence → impact → action`.
* Completed work: the result, the focused verification, and any concrete limitation.
* Next steps: only `next action | why necessary now | stopping condition`. No roadmap unless I ask for one.
* Done means the requested outcome passed, nothing required is still running, `git diff --stat` is scoped to the request, my earlier work is intact, and no in-scope blocker remains. Then stop.
