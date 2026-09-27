# 14 — Definition of Done

The project is not complete until all of these are true.

## User experience

- Developer can request implementation in normal language.
- No mandatory workflow requires `/engineer`.
- No mandatory review requires `/review`.
- Parent session remains usable while background work runs.
- User can steer/cancel/reprioritize active work.

## Orchestration

- Missions are durable.
- Tasks form a DAG.
- Independent tasks run concurrently.
- Conflicting write domains are protected.
- Execution survives/reconciles after restart.
- Explicit user-named workspaces outside launch cwd are safely authorized and
  bound before workers start.
- Multi-repository missions use repository-scoped bounded tasks.
- Blocked missions can be repaired and resumed under the same mission identity.
- Recovery budgets, ownership, checkpoints, and next actions survive restart.

## Agents

- Parent can spawn/track Pi children/subagents.
- Child contexts are task-specific.
- Fresh independent review is supported.
- Recursive delegation is bounded.

## Processes

- Deterministic commands run as supervised subprocesses.
- Output, exit status, timeout, cancellation, and artifacts are captured.
- Parent does not block waiting unnecessarily.

## Engineering workflow

- Repository mutation automatically requires appropriate validation.
- Material code mutation automatically requires independent review.
- Security-sensitive changes automatically receive security review.
- Review findings can create repair tasks.
- Failed gates block completion.
- Validation/review evidence is bound to current repository revisions and diffs.
- Pending or failed material acceptance criteria block completion.
- Critical/high review findings are blocking.
- Worker success alone cannot resolve a review finding.
- Integration, validation, and review occur before incumbent promotion.

## PI WEB

- Uses existing `jmfederico/pi-web`.
- No alternate PI WEB clone is created.
- Mission/task/execution state is visible through supported integration.
- Acceptance coverage and workflow progress are shown separately.
- Every workerless mission shows a wait, recovery, orphan/deadlock diagnosis,
  or actionable terminal reason with next action/deadline.
- Existing PI WEB sessions/worktrees are reused where possible.

## Architecture constraints

- Pi Forge remains out of scope.
- InferWeave manages hardware placement.
- OpenViking may provide durable semantic/shared memory, but does not replace mission state persistence.
- Runtime policy, not prompt memory, enforces mandatory workflow behavior.

## Quality

- unit tests
- integration tests
- failure/retry tests
- restart/recovery tests
- concurrency tests
- worktree conflict tests
- review gate tests
- PI WEB integration tests where practical
- wrong-root and external-workspace recovery tests
- timeout checkpoint/split/resume tests
- stale/late execution fencing tests
- candidate-bound evidence invalidation tests
- isolated integration/incumbent immutability tests
- blocked-mission repair idempotency tests
- repeated-fingerprint recovery exhaustion tests
- real `local/local` interrupted-mission recovery test

## Documentation

Document:

- architecture
- mission/task schemas
- event schema
- execution adapters
- policy rules
- PI WEB integration
- configuration
- debugging
- migration from existing workflow behavior
