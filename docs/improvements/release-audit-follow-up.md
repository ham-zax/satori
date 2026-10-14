# Release audit follow-up

Status: plan; item 1 needs a decision before the next publish.

The release-audit fixes are committed in `88e8bab0`..`62ca4ff5`. Release
qualification passes all twelve stages at `62ca4ff5`. This document records what
the fixes left open, the evidence for each item, and a realistic order of work.

## Order of work

| # | Item | Do now? | Why |
|---|---|---|---|
| 1 | Version bump | Yes, before publish | The release graph blocks publication. |
| 2 | `architecture_overview` `path` value | Decide with item 1 | It is a public output change and belongs in the same release note. |
| 3 | `call_graph` collects every source reference | Measure first | No measured cost yet. A design change without a profile breaks the repository rules. |
| 4 | Torn candidate receipt from an older version | Only on a report | Rare, and the current behaviour is safe. |
| 5 | Stray receipt `.tmp` after a crash | No | Harmless: nothing enumerates it. |
| 6 | Lock check-then-unlink window | No | The remaining window needs a second process to replace the lock in microseconds. |

## 1. Version bump

Evidence:

- `pnpm release:check` passes qualification, then the release graph check blocks
  because core 0.7.1, mcp 0.9.1 and cli 0.6.4 are published and the packed files
  differ.
- The unpublished range includes `9297b1db refactor!: remove Ollama embeddings and
  the reranker performance veto`. It removes CLI options and the Ollama provider
  from all three packages.
- `pnpm release:bump minor` (preview) proposes core 0.8.0, mcp 0.9.2, cli 0.6.5.
  The tool bumps only the named package and gives downstream packages a patch for
  the new pin.

Recommendation: a minor bump for each package, because each has a breaking change
(pre-1.0, so minor carries the break):

```bash
pnpm release:bump core minor --apply   # core 0.8.0
pnpm release:bump mcp minor --apply    # mcp 0.10.0 (check the preview first)
pnpm release:bump cli minor --apply    # cli 0.7.0 (check the preview first)
pnpm release:check
```

Run each command once without `--apply` first. The tool refuses a dirty tree.
Stopping condition: `release:check` passes the release graph stage.

## 2. `architecture_overview` `path`

Since `bf44dc9a`, `architecture_overview` filters every projection to the
requested subdirectory, and `path` reports the requested root, not the leased
index root.

Recommendation: keep the new value. The response now describes only the
requested subtree, so a `path` that names the index root would misdescribe it.
Record the change in the release note for item 1. Revert only if a known consumer
reads `path` as the index root; no first-party consumer does.

## 3. `call_graph` source references

Evidence:

- `navigation-handlers.ts` calls `findExactPublishedSourceReferences` with
  `limit: Number.MAX_SAFE_INTEGER`.
- `relationship-backed-call-graph.ts` then drops declarations and references
  whose owner is outside the path scope, and uses the full filtered list for
  `sourceReferenceCount`, the warning count, the first reference, and the
  evidence pages.
- `call-graph-evidence-projection.ts` pages by cursor offset over the
  materialized list, with at most 50 items a page.
- The exact search runs only when inbound coverage is incomplete
  (`shouldInspectInboundSourceReferences`).

A plain cap is wrong: it breaks later pages and the counts, because the filter
runs after the search. That is why the worker's cap was removed.

Plan:

1. Measure. Run `call_graph` inbound on the symbols with the most source
   occurrences in this repository and in one large repository. Record time, peak
   memory and occurrence count, median of three runs.
   Stopping condition: if the worst case is small next to the search budget and
   memory stays bounded, close this item with the figures.
2. Only if step 1 shows a real cost: move the declaration and owner-scope filters
   into the exact search so that its match count equals the filtered count, then
   request `offset + pageSize + 1` references and take the count from
   `matchedOccurrenceCount`. This needs an equivalence test (old and new
   `sourceReferenceCount`, pages and cursors for each filter branch) and a
   mutation check, as `AGENTS.md` requires.

## 4. Torn candidate receipt from an older version

New receipts are published with `linkSync` from a complete temp file, so a crash
cannot tear them. A receipt torn by an older version still makes
`listCandidateReceiptsInPublicationRoot` throw on `JSON.parse`, so indexing for
that root fails closed until a person removes the file.

Recommendation: no automatic delete, because the receipt guards a candidate
collection. If a user reports it, make the error name the file and the safe
action; that is a diagnostic change only.

## 5. Stray receipt `.tmp`

The temp file sits in the publication root and the `finally` block removes it.
It remains only after a process crash between the write and the cleanup.
Candidate enumeration reads only `candidates/`, so the file has no effect beyond
a few kilobytes of disk.

## 6. Lock check-then-unlink window

`removeLockIfUnchanged` compares device and inode before it unlinks. A second
process could still replace the lock between the compare and the unlink. Closing
that window needs an advisory lock (`flock`) on every lock path, which is a new
mechanism for a race the fix already narrowed to microseconds. Revisit only on
evidence of a double owner.
