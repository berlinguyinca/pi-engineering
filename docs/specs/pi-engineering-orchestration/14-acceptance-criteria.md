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

The executable Slice 1 acceptance proof is
`npm run test:mission-reliability`. It covers the synthetic `MSN-qSLaeM`
multi-root authorization case, timeout checkpoint remainder repair, late-result
rejection, restart replay, repeated-fingerprint exhaustion, zero-worker orphan
detection, repository-lease isolation, integration conflict, red validation,
and incumbent immutability. `npm run dogfood:mission-recovery` is the opt-in
installed-Pi live check; it refuses every model except `local/local`, refuses an
enabled/advertised metabolomics provider, verifies the unique installed package
path and exact Git SHA without an explicit `--extension`, and operates only on
a retained temporary Git repository outside every real Git worktree. The
separately labeled source-only diagnostic disables extension discovery before
loading exactly one explicit source extension. Snapshot contract/version,
`id`, `observability.acceptanceCoverage`, `observability.preservedWork`, and
the typed `stop` are validated; `FAILED`/`CANCELED` are nonzero outcomes.

## Implemented status and recovery semantics

- `EXECUTING` means an authoritative worker or controller owns runnable work;
  it is not a generic label for a workerless mission.
- `WAITING_*` names the wait, next action, and deadline. An expired wait enters
  recovery instead of remaining indefinitely waiting.
- `BLOCKED` is nonterminal. It must have a durable failure classification and
  either a scheduled bounded recovery or an actionable stop containing the
  reason, preserved-work locations, attempted recovery IDs, and exact resume
  condition.
- `REPAIRING` means a durable repair decision and replacement lineage exist;
  failed tasks remain immutable audit history.
- `COMPLETE` requires current candidate-bound validation/review evidence,
  passed material acceptance criteria, accounted failed/canceled/skipped work,
  and no unfenced execution that can still mutate the candidate.
- `FAILED` and `CANCELED` are terminal outcomes and never imply approval.

Operators resume a stopped mission with `/mission resume <missionId>`. The
runtime preserves the mission ID, increments the resumption epoch, fences stale
owners, reconciles side effects, and resumes only remaining checkpoint work.
The old worker's later output is stored as inert
`execution.late_result_rejected` evidence.

## Explicit exclusions

Slice 1 authorizes multiple local roots but executes and promotes one repository
per task. Slice 2 still owns dependency-aware cross-repository worksets,
repository-head vectors, publication ordering, and branch/PR/check/merge
reconciliation. Slice 3 still owns database-backed leases, distributed or
multi-process controllers, and remote-worker reconciliation. Local JSONL
leases and one local controller do not claim Slice 3 guarantees.

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
