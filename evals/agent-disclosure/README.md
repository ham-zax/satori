# Phase 3 disclosure mechanical pilot

This harness compares the current grouped initial response with one smaller
`disclosureLimit` while keeping the query, caller limit, retrieval, ranking,
reranking, grouping, runtime, source authority, and publication receipt fixed.

It calls the production `search_codebase` and `continue_search` tools. It does
not implement search, grouping, paging, or retry semantics. The runtime guard
disables watcher/background ownership, replaces freshness synchronization with
a no-sync published-index decision, blocks reindex and LanceDB mutation entry
points, and records provider/storage operations without their inputs or output
data.

The output is an unsealed mechanical-pilot artifact. It can prove that the
harness reconstructs the same ranked grouped result set, that smaller initial
disclosure reduces serialized bytes, and that deferred evidence remains
reachable through deterministic continuation. It is not agent-answer evidence,
does not select a production default, and must not be reused as held-out
qualification authority.

Each output directory includes the exact external pilot task alongside the
result and operation trace so `OUTPUT-CHECKSUMS.sha256` is self-verifying after
the evidence directory is moved or archived.
