# 02 — Mission Controller and DAG Scheduler

## Goal

Replace conversational step-by-step execution with durable dependency-aware missions.

## Scheduler requirements

A task becomes runnable when:

- all required dependencies are complete,
- required approvals are present,
- no write-domain conflict prevents execution,
- resource/concurrency policy permits launch,
- mission is not paused/canceled.

## States

Task states:

```text
PENDING
READY
RUNNING
WAITING
SUCCEEDED
FAILED
RETRYING
CANCELED
SKIPPED
BLOCKED
```

## Parallelism

Launch independent work concurrently.

Good:

- backend implementation
- frontend implementation
- independent test authoring

Potentially unsafe:

- multiple agents modifying the same implementation file or tightly coupled module.

## Write domains

Tasks that mutate repositories must declare intended write domains.

Examples:

```text
src/server/auth/**
src/web/login/**
tests/auth/**
```

Scheduler behavior:

- non-overlapping domains: parallel allowed
- overlapping domains: sequence by default
- explicit isolated candidate/tournament work: parallel worktrees allowed, but merge/integration is mandatory

## Concurrency controls

Support:

- global max active tasks
- max agent executions
- max subprocesses
- per-model limits
- per-repository limits
- per-role limits
- owner/interactive priority
- queue age
- cancellation

Do not let each child recursively spawn unlimited descendants.

## Retry and recovery

Failure classifier should distinguish:

- transient provider/model error
- subprocess failure
- context overflow
- invalid output/schema
- merge conflict
- test failure
- implementation dead end
- ambiguous product requirement

Suggested responses:

```text
transient model error -> retry
context overflow -> fresh child with compact packet
test failure -> diagnostic/repair task
merge conflict -> integration task
dead end -> replan
ambiguous requirement -> WAITING_FOR_USER
```

### Typed recovery and task replacement

Generic retry is insufficient. Persist a machine-readable failure
classification, fingerprint, expected material change, attempt budget, deadline,
and next action. Recovery budgets survive process restart.

Multi-repository, high-risk, or oversized objectives must be split into bounded,
repository-scoped tasks before implementation. A timeout after useful work is
`TASK_BUDGET_EXHAUSTED`: checkpoint and validate partial work, supersede the
failed task with explicit replacement lineage, and schedule only remaining
deliverables. Do not replay the same oversized prompt.

`BLOCKED` missions are repairable through an idempotent
`repairBlockedMission(missionId)` path. Repair acquires ownership, reconciles old
executions and side effects, requires a material change, invalidates stale
evidence, transitions through `REPAIRING`, and re-runs affected gates.

Repeated identical failure fingerprints without new evidence exhaust the
strategy and stop explicitly rather than loop.

## Persistence

Mission and scheduler state must survive process restart.

Minimum acceptable persistence:

- SQLite or durable equivalent for state
- append-only event stream for replay/audit

Persist retry windows, recovery budgets, failure fingerprints, ownership
generations, fencing tokens, next-action deadlines, checkpoints, and task
supersession. Replaying entity state without reconciling workers, worktrees, and
external side effects is not recovery.
