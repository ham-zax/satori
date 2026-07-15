# Tests, fixtures, and proofs

Apply when changing public-contract, lifecycle, authority, race, golden, or
integration tests and their fixtures.

## Do not soften the proof

- Derive the expected outcome from the production contract before adapting the
  fixture.
- When the contract selects one outcome, assert exactly that outcome. Do not
  accept success-or-error branches, arrays of incompatible codes, or partial
  assertions merely to make the fixture pass.
- Multiple outcomes are valid only when the public contract exposes that
  capability/platform branch and the fixture states which branch it selects.
- Before changing an established assertion, trace the reachable runtime path
  and explain which production invariant changed.

## Build complete, typed fixtures

- Trace the exact production path and model every field it reads. Do not rely
  on omitted fields, permissive defaults, or unrelated real state.
- For prepared navigation/source lifecycles, model the path-scoped root,
  generation and receipt identities, completion proof, mutation lease,
  authority observations, watcher/prepared-read observation, and final
  revalidation used by that path.
- Keep snapshot and root helpers path-scoped. A helper such as
  `getCodebaseInfo: () => info` must not make arbitrary nested paths look like
  tracked roots.
- Use exported Core/MCP types, `satisfies`, and real receipt/build helpers.
  Use `as unknown as` only at a narrow private test seam, with its arguments and
  result typed from the authoritative production contract.
- Exercise the public boundary unless the test explicitly owns an internal
  unit. Do not bypass parsing and then claim public behavior is proven.

## Falsify the boundary

For each applicable public control, cover the strongest relevant alternatives:

- valid authority and the expected happy path;
- blank, mixed, unknown, minimum, maximum, and just-outside input values;
- missing, stale, mismatched, and genuinely unavailable identity;
- state change during the final asynchronous authority/source boundary;
- colliding internal output fields and final serialized-byte pressure;
- malformed, cross-domain, or out-of-span continuation evidence.

Prefer one focused falsification test per invariant over broad smoke coverage.

## Validate in dependency order

- During iteration, run the smallest owning test.
- A production contract edit invalidates focused proofs, the affected package
  gate, and any required integration or generated-artifact checks.
- A fixture-only edit invalidates its owning suite, not unrelated green gates.
- After a failure, fix the production defect or fixture model; never broaden the
  accepted outcomes. Rerun the failed gate and only invalidated downstream
  gates.
- Before handoff, inspect the complete diff and report exact commands, results,
  unrun gates, and residual risk. Do not claim green while a known relevant
  failure remains unresolved or unreproduced after the fix.
- Freeze expected truth before measurement. Never change the answer key after
  observing a result.
