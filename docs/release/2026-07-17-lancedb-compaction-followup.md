# Follow-up: safe LanceDB compaction outside publication

Date: 2026-07-17

Status: open / not blocking connected LanceDB+Voyage qualification

## Context

Publication finalization must not run LanceDB `optimize()`. Under
`@lancedb/lancedb` 0.31.0 / `lance-encoding-8.0.0`, epoch cleanup:

```ts
await table.optimize({
  cleanupOlderThan: new Date(0),
  deleteUnverified: false,
});
```

failed to decode real multi-file UTF-8 payloads at scale with:

```text
Max offset of … exceeds length of values …
```

That blocked searchable publication. `finalizeCollectionForSearch()` now only
creates the FTS index.

## Scope

- Reproduce against newer LanceDB releases.
- Report the 0.31.0 / lance-encoding-8.0.0 decoder failure upstream.
- Require full search and reopen verification after any maintenance.
- Never block or invalidate an already published generation.
- If compaction is re-enabled, keep it optional, non-authoritative, and out of
  `finalizeCollectionForSearch()`.

## Non-goals

- Fail-soft catch around optimize on the publication path.
- Automatic optimize after every index until a safe combination is proven.

Note: GitHub issues are disabled for this repository, so this note is the
tracked follow-up artifact.
