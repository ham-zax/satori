# Model mirror fallback

Status: deferred. Recorded 2026-09-27.

## Question

Should Satori host its models on GitHub, in the repository or as release
assets, for speed or reliability?

## Findings

- Download speed is not the bottleneck. A real install fetched the 68 MB LateOn
  model in about 20 s; the slow step was the runtime `npm install` (about 35 s).
  Potion is 33 MB and is now cached once in `~/.satori/models`, shared across
  runtime upgrades.
- Hugging Face serves files from a global CDN; GitHub Release assets are also
  CDN-backed, so speed is comparable. Raw repository files are slower and
  rate-limited, and Git LFS has bandwidth quotas.
- Committing models to git is costly: GitHub rejects files over 100 MB and
  warns over 50 MB, and every model version stays in history permanently.
  The Potion files already in the repository remain only as development and
  test fixtures.
- Hugging Face remains the right source of truth: the pinned revision and
  SHA-256 digests come from the model authors' repository, and licensing and
  attribution stay with them (Potion is MIT, LateOn is Apache-2.0; both allow
  redistribution with notices).

## Proposal

Add a fallback mirror for resilience, not speed:

1. On each release, upload the pinned model files as GitHub Release assets,
   named by model and revision, with notices included.
2. Extend the model spec in `packages/cli/src/model-store.ts` with an ordered
   list of sources. Try Hugging Face first, then the GitHub mirror, when the
   failure is `offline`, `stalled`, or HTTP 5xx after retries.
3. Keep verification unchanged: every source must produce the same size and
   SHA-256, so a mirror can never change what is installed.
4. Keep `HF_ENDPOINT` as the user-controlled override for corporate mirrors.

## When to do it

When users report Hugging Face outages, regional blocking, or proxy problems
that `HF_ENDPOINT` does not solve.
