# Documentation map

Use this page to find the current source of truth. Redundant root-level plans
are removed once their behavior is covered by code, tests, and current product
documentation. Dated implementation and experiment plans remain when their
sequence, rationale, or measurements are useful historical evidence.

## Product and architecture

- [Architecture](../ARCHITECTURE.md) — canonical package boundaries, runtime
  flows, state, and authority model.
- [End-to-end behavior spec](SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md) —
  authoritative public behavior and evidence-backed contracts.
- [Workflows](SATORI_FEATURES_AND_USE_CASES.md) — user-facing setup and common
  operations.
- [Repository map](SATORI_REPOSITORY_MAP.md) — implementation ownership and
  navigation guide.
- [Repository learning roadmap](SATORI_REPO_LEARNING_ROADMAP.md) — extended
  onboarding material.
- [Launch checklist](LAUNCH_CHECKLIST.md) — publication positioning and release
  preparation.

## Active plans

Long-lived implementation plans live in [`plans/`](plans/). A file remains
there only while it contains unresolved or explicitly deferred work.

- [Index-state stability](plans/INDEX_STATE_STABILITY_PLAN.md)
- [Language capability and extractor harness](plans/LANGUAGE_CAPABILITY_MATRIX_AND_SYMBOL_EXTRACTOR_HARNESS_PLAN.md)
- [Operational trust](plans/OPERATIONAL_TRUST_PRODUCT_PLAN.md)
- [Relationship-backed navigation and SQLite](plans/RELATIONSHIP_BACKED_NAVIGATION_AND_SQLITE_STORE_PLAN.md)
- [CLI implementation](plans/SATORI_CLI_IMPLEMENTATION_PLAN.md)
- [Symbol-owned retrieval](plans/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md)

Dated follow-on plans remain under [`release/`](release/) when their date and
measurement context are part of the contract. In particular, bounded symbol
context, indexing throughput, offline runtime, and search-quality work should
not be collapsed into generic roadmap claims.

## Evidence and historical records

- [`release/`](release/) contains dated benchmarks, investigations, accepted
  measurements, and release checkpoints.
- [`release/artifacts/`](release/artifacts/) contains machine-readable search
  quality results.
- [`remediation/`](remediation/) contains evidence-gated review and remediation
  records. These are retained as proof, not as current implementation plans.
- [`design/plans/`](design/plans/) contains dated implementation plans
  retained for execution history; their unchecked boxes are not current roadmap
  authority.
- [`design/specs/`](design/specs/) contains design rationale that is
  still useful after implementation.

Evaluation protocols and their authority artifacts live beside their harnesses
under [`../evals/`](../evals/), not in product documentation.
