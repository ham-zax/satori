# Public contract changes

Apply when changing externally consumed schemas, tool inputs or outputs,
serialized envelopes, errors, migrations, or generated contract artifacts.

## Review before repair

- For each review finding, establish the expected contract, reachable runtime
  path, observed mismatch, and impact before editing.
- Classify it as a production correctness/reproducibility gap, a test/fixture
  gap, a documentation/generator gap, or not a defect.
- Change runtime implementation only for a verified production gap. Do not add
  compatibility behavior or alter authority semantics to satisfy an unproven
  review claim.

## Establish authority first

- Read the owning boundary schema and serializer, one production caller, the
  frozen plan or fixture, and the focused contract test before editing.
- Record the accepted variants, required and forbidden fields, success and
  error shapes, global and effective limits, compatibility decision, and
  first-party consumers.
- If code, frozen artifacts, and documentation disagree, establish which owner
  is authoritative before changing behavior. Do not choose the easiest version.
- Treat generated docs, handoffs, and review summaries as retrieval aids, not
  contract authority.

## Close the input boundary

- Use strict, disjoint schemas. Reject unknown fields, mixed variants, and
  violations of exactly-one requirements at the boundary.
- Trim caller-controlled identifiers, labels, fingerprints, cursors, and kinds
  before applying nonblank and length limits.
- Derive numeric floors from mandatory serialized envelopes and ceilings from
  canonical constants. Prove every accepted variant leaves room for its public
  wrapper and required payload; reject impossible budgets before runtime work.
- Keep global and request-effective limits distinct. A field named
  `hardResponseLimitBytes` reports the one global hard limit; use a separately
  named field for a caller-selected or clamped effective limit.
- Classify expected caller and resource errors before the catch-all. Never let
  caller validation or budget failure become an authority failure.

## Close the output boundary

- Project every public field explicitly. Never spread a composer, handler, or
  other internal object into public JSON.
- Keep the schema, TypeScript type, serializer, and byte accounting on the same
  field list. Test that colliding and unknown internal fields cannot escape.
- Enforce the response cap against the final serialized UTF-8 bytes, including
  the public wrapper.
- Keep accepted exact-symbol errors on the bounded `symbol_context` prefix.
  Ordinary reads retain their own errors; do not merge the two classifications.
- Under the frozen exact-open contract, unprovable prepared/root authority is
  `NAVIGATION_UNAVAILABLE`; ordinary outside-root reads use
  `outside_indexed_root`.

## Preserve continuation meaning

- Bind continuation fingerprints, cursors, direction, ranges, and policy to
  the evidence domain that issued them.
- Reject malformed, stale, tampered, or out-of-symbol ranges. Do not clamp or
  normalize a submitted continuation into different content.
- Keep direct spans on the frozen unversioned `startLine`/`endLine` shape.
  Do not add snake-case aliases or a second compatibility branch.

## Migrate and generate last

- Do not add compatibility behavior unless the frozen contract explicitly
  requires it. Version control is the archive.
- Enumerate and migrate production callers, tests, fixtures, scripts, agent
  instructions, hand-written docs, generators, and published artifacts.
- Claim "unchanged" only after comparing old and new accepted field names and
  behavior side by side.
- Fix union and discriminator rendering in the generator before regeneration.
  Regenerate only after runtime code and focused proofs are stable, then run the
  corresponding generated-artifact check.
