# Search-quality evaluation

The behavioral retrieval benchmark for `search_codebase`: each case asks a
behavioral question and checks that the owning implementation appears within a
top-k budget.

```bash
pnpm eval:search-quality
```

Cases and fixtures live in `fixtures/search-quality/`; the harness is
`search-quality-evaluation.ts` and runs against the production search path.

This benchmark measures retrieval only. Semantic relationship qualification
(`evals/semantic-relationship-qualification/`) is separate, and passing one does
not substitute for the other.
