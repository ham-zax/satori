# Delegation and shared-worktree boundaries

Apply only when work is delegated, handed off, or performed in a shared dirty
worktree. `AGENTS.md` remains the global safety and workflow authority.

## Freeze the delegated slice

- Before delegation, name the owned files or subsystem, authoritative inputs,
  allowed behavior changes, prohibited changes, and acceptance commands.
- Keep public schemas, serializers, error mapping, lifecycle behavior, authority
  transitions, and race proofs with the primary owner unless Hamza explicitly
  delegates that exact slice.
- Prefer delegating bounded mechanical work: consumer enumeration,
  hand-written documentation updates, or regeneration after the generator and
  contract are already correct.
- If a mechanical slice requires a production, contract, lifecycle, fixture,
  or generator change, stop and return the blocker. Do not expand ownership or
  weaken a test.

## Protect shared state

- Record staged, unstaged, and untracked state before editing. Preserve existing
  staging and edit only the delegated file set.
- Do not run a formatter, fixer, generator, or cleanup command whose output can
  cross the owned file set.
- If another agent changes an owned input or creates an overlapping diff, stop
  and report the overlap before continuing.

## Handoff with proof

- Return exact files changed, behavior changed, commands and results, unrun
  gates, known failures, generated outputs, and staging/commit state.
- Do not hand back weakened assertions, incomplete mocks, untyped authority
  fixtures, stale generated output, or a known canonical-suite failure.
- The primary owner reviews the complete delegated diff against the frozen
  slice before relying on its reported status.
