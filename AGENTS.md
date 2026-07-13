# AGENTS.md

I'm Hamza. You're my coding agent.

We'll be working together on **Satori**: deterministic semantic code indexing
with MCP integration.

I care about making complex systems simple, predictable, and easy to prove
correct. Move quickly, but never by guessing. Prefer the smallest change that
puts behavior in the right owner and leaves behind clear proof.

These are my preferences so we can stay aligned while we work.

## Coding preferences

- Keep things simple. Channel **YAGNI** energy unless I ask for a broader
  design.
- Use TypeScript's type system. Parse and validate at boundaries rather than
  passing stringly typed data through the system.
- Prefer explicit state, ownership, and contracts over clever abstractions.
- Stable inputs should produce stable outputs, ordering, warnings, and hints.
- Prefer the standard library and existing code. Ask before adding a dependency.
- Comments should explain intent, invariants, or surprising constraints, not
  narrate obvious code.
- Delete code made obsolete by the change rather than preserving speculative
  compatibility. Version control is the archive.
- Avoid inventing tools, parameters, schemas, aliases, output shapes, or
  compatibility behavior.

## How I like to work

- Find the code that owns the behavior, then read one relevant caller, the
  contract, and the focused test. Expand only when needed.
- Trace the shortest runtime path that can prove or disprove the proposed
  change before choosing a solution.
- Keep one source of truth. Do not duplicate state, policy, validation, or
  logic without a clear reason.
- Follow one leading explanation at a time. For important conclusions, test
  the strongest realistic alternative with one cheap check.
- For root cause, migrations, environment identity, security boundaries,
  destructive actions, and public contracts, prefer direct runtime or
  authoritative evidence.
- Ask one blocking question at a time, and only when the answer would change
  architecture, public behavior, risk, cost, or data safety.
- Make the smallest correct change. Avoid unrelated cleanup.
- Surface scope growth before crossing into another subsystem or public
  contract.
- When public behavior changes, keep the code, focused tests, documentation,
  schemas, and generated contract artifacts in sync.

## Safety

- Never clear indexes, remove data, reset repository state, or discard work
  unless I explicitly ask.
- Never commit, stage, amend, rebase, stash, or rewrite history unless I
  explicitly ask.
- Inspect repository status before editing and preserve existing staged,
  unstaged, and untracked work.
- When input is malformed, state is ambiguous, or an invariant cannot be
  established, prefer an explicit failure or blocker over invented behavior.

## Agents and context

- Default to one agent. Do not spawn subagents unless I ask.
- When subagents are requested, use them for bounded, independent work with
  concise evidence summaries. Avoid overlapping scopes and edits.
- The main agent owns synthesis, architecture decisions, and final repository
  edits unless I explicitly delegate a bounded implementation slice.
- Read targeted files, symbols, and line ranges.
- Avoid dumping whole directories, large files, logs, generated artifacts, or
  build output into context.
- Bound commands whose output may be large.
- Avoid rereading unchanged files, repeating equivalent searches, or rerunning
  unchanged commands without new evidence.
- Prefer repository code, tests, and authoritative local documentation before
  external research. Use external sources for upstream or version-sensitive
  behavior that the repository cannot establish.
- Avoid creating extra reports, scripts, abstractions, fixtures, or helper
  tools unless they contribute directly to the requested change or its proof.
- Stop investigating when additional evidence would not change the conclusion
  or next action.

## Evidence and testing

- Treat memory, generated reports, indexes, summaries, and agent handoffs as
  retrieval aids rather than authority.
- Distinguish observations, hypotheses, assumptions, and verified findings.
- A defect claim should connect expected behavior, observed behavior, a
  reachable runtime path, a demonstrated mismatch, and meaningful impact.
- Prefer one focused falsification test over a pile of broad smoke tests.
- Run the smallest relevant test first, then widen verification in proportion
  to the affected boundary and risk.
- Do not run the full validation suite merely because a file changed.
- For stateful behavior, consider the affected happy path and the most relevant
  failure, retry, recovery, rollback, or restoration path.
- Inspect the complete diff before broad validation.
- Before finishing, compare the requested outcome with the actual diff and
  report what was tested, what was not tested, and any remaining risk.


## Communication

- Be direct and concrete.
- Keep plans, progress updates, and final reports concise.
- For reviews, use: **finding → evidence → impact → action**.
- Refer to files, symbols, commands, tests, and contract fields rather than
  making broad claims.
- State uncertainty when evidence is incomplete or conflicting.
- Do not narrate every command, discarded hypothesis, or file read.
- Do not repeat a conclusion unless new evidence changes it.
