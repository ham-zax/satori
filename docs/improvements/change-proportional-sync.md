# Change-proportional edit sync

Status: deferred. Recorded 2026-09-28.

## Question

Why does syncing a one-line edit take seconds, and how could its cost scale
with the size of the change instead of the size of the repository?

## Findings

Work for the changed file itself (chunking, embedding, symbol extraction) is
well under a second. The rest scales with the repository. On trufflehog
(3,295 Go files) a one-comment edit sync took ~20 s:

| Step | Time | Cause |
|---|---:|---|
| Fresh sync worker process | ~1.2 s | Each sync runs in an isolated, killable process group; nothing stays warm |
| Full-tree change scan | ~2 s | Stats every observed file |
| Reload previous registry and relationships | ~2.5 s | The fresh process has no navigation cache |
| Whole-language semantic analysis | ~4 s | See [incremental semantic analysis](incremental-semantic-analysis.md) |
| Stage navigation sidecars | ~1.9 s | Rewrites or links every shard |
| Pre-activation rescan | ~1.7 s | Proves the source did not change while the candidate was prepared |

Small repositories sync in 2–4 s only because each step is small.

## Proposal

1. Long-lived sync worker per root that keeps navigation state warm between
   syncs, while keeping cancellation and crash containment (today the
   supervisor cancels by killing the worker's process group; see
   `packages/mcp/src/server/mutation-worker-supervisor.ts`).
2. Use the file watcher's change set instead of full-tree scans, with a
   cheaper freshness proof (changed paths plus a watcher sequence), falling
   back to the full scan when the watcher overflowed or restarted.
3. Incremental semantic analysis (separate proposal).
4. Publication that only writes the changed files' navigation data.

Items 1 and 2 change deliberate guarantees (process isolation, source
freshness proof) and need their own design review.

## When to do it

When edit-to-searchable latency on medium or large repositories becomes the
main complaint. Target: sub-second sync for a one-file edit, regardless of
repository size.
