---
name: satori-evidence-bounded-repair
description: Use in Satori for recurrent or high-consequence defects involving index or state integrity, incremental updates or recovery, repository/path/revision identity, concurrency, deterministic result ordering, MCP or public contracts, or a requested outcome that remains false despite focused green tests. Also use for explicit root-cause or release judgments. Do not use for clear local low-risk fixes, ordinary features or refactors, or broad reviews.
---

# Satori Evidence-Bounded Repair

Apply the repository `AGENTS.md`. Narrow the repair; do not grant authority for
broader cleanup, subagents, new dependencies, release work, or unrequested
artifacts.

## Freeze the repair contract

Record compact working notes, not a new file:

- **Outcome:** What must become observably true?
- **Witness:** What smallest real invocation or readback could disprove success?
- **Must preserve:** Which behavior, state, identity, ordering, or contract
  cannot change?
- **Exclusions:** Which known adjacent concerns are outside this repair?

Treat exclusions as provisional only when reproduced causal evidence reopens
one through the expansion permit. Similarity does not.

If the user requested diagnosis or review only, establish and report the cause
without implementing a repair.

## Find the first wrong boundary

For an indexing or retrieval defect, inspect the shortest applicable path:

```text
repository, revision, workspace, and path identity
-> discovery, filtering, parsing, chunks, and projections
-> embedding role and artifact identity
-> storage, publication, incremental update, and recovery authority
-> candidate retrieval, fusion, reranking, grouping, and stable ordering
-> MCP schema, serialization, and user-visible response
```

Do not audit every stage. Stop at the first demonstrated boundary where a
correct value becomes incorrect, then verify the nearest authoritative
readback.

At each inspected boundary record:

```text
expected | observed | evidence | responsible owner
```

Treat indexes, caches, summaries, reports, and knowledge graphs as derived
evidence unless a contract explicitly makes one authoritative.

Never clear or rebuild a user's existing index merely to simplify diagnosis.
Use a disposable fixture, isolated temporary index, or non-destructive
readback.

## Establish one falsifiable explanation

Express the leading explanation as:

```text
visible failure
-> first wrong boundary
-> violated invariant
-> responsible owner
-> falsifiable repair
```

Do not label a plausible explanation as root cause.

Test an alternative explanation only when evidence supports it and it would
materially change the responsible owner or repair. Otherwise let acceptance
falsify the leading explanation.

After two failed repairs for the same mechanism, stop patching and re-establish
the witness, first wrong boundary, and hypothesis.

## Gate expansion

Before inspecting another subsystem, owner, public contract, or unrequested
behavior, state:

```text
hypothesis | expected evidence | direct relevance | stopping condition
```

The permit authorizes one bounded read or check. It does not authorize editing
that area.

Expand implementation only when the check shows that:

- Evidence continues along the same causal chain.
- The additional owner violates frozen acceptance.
- The current change caused the new failure.
- The exact defect mechanism occurs in a directly shared writer, reader,
  identity, state, or contract path.

Similar names, nearby code, technical debt, unrelated failing tests,
speculative hardening, and possible future requirements are insufficient.

If one representative check does not reproduce the mechanism, stop the branch
and report only a concrete, evidenced follow-up.

## Repair the responsible owner

Change the owner responsible for the violated invariant at the smallest
complete boundary.

Classify every file changed by this repair as exactly one of:

- Causal repair.
- Nearest regression proof.
- Required contract synchronization.
- Generated output required by one of the above.

Remove changes introduced by this repair that have no such role. When generated
output is affected, change its authoritative source first and regenerate only
the required outputs.

Do not add speculative abstractions, compatibility layers, feature flags,
monitoring, workflows, dependencies, or cleanup.

## Climb the acceptance ladder only as needed

Run each applicable baseline level in order:

1. Prove the original observable witness now passes.
2. Run the nearest deterministic regression test.
3. Prove the affected must-preserve behavior remains true.
4. Add risk-specific evidence only for a boundary changed by the repair.

Risk-specific evidence may include:

- **Incremental state:** The relevant cold-versus-incremental transition,
  deletion, rename, retry, or restart/readback.
- **Identity:** The actual workspace, revision, normalized path, case, or root
  distinction involved in the defect.
- **Concurrency:** One mechanism-specific interleaving, lease loss, ordering,
  or deduplication case.
- **MCP/public contract:** A real invocation with its schema, ordering, result,
  and applicable error behavior.
- **Determinism:** Repeat the same stable input and compare the promised
  user-visible result.

Do not run every risk-specific item. Run a broader package or repository gate
only when the changed boundary invalidates it, repository policy requires it,
or release readiness was explicitly requested.

## Stop and report

Stop when the witness and frozen acceptance pass, the causal chain closes at
the responsible owner, must-preserve conditions remain true, required generated
or contract synchronization is complete, and no demonstrated in-scope blocker
remains.

Report concisely:

```text
outcome -> responsible owner -> verification -> result
```

Keep separate when applicable:

- **Repair:** Whether the demonstrated mechanism was fixed.
- **Product outcome:** Whether all requested observable behavior passed.
- **Release:** Whether applicable existing release gates passed.

A higher-level blocker does not erase accepted lower-level evidence unless it
actually disproves that evidence.

Report adjacent findings only when they have concrete evidence and impact. Do
not implement them without authorization.
