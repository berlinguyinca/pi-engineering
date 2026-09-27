# Task 9 Report — Independent Supervisor and Truthful Dual Progress

## Outcome

Implemented the clock-driven mission supervisor, acceptance-first progress, workflow diagnostics, and actionable status projection. Also completed all three Task 8 carry-forward safety prerequisites: atomic epoch-bound gate publication, epoch-conditional mission completion, and exact-lease-epoch repository authority reference counting.

## RED evidence

- Carry-forward prerequisite suite: `task-9-prereq-red.log`
  - overlapping repository authorities fenced a live sibling;
  - resumption during `captureDiff` still allowed gate settlement;
  - stale mission finalization still completed.
- Task 9 focused suite: `task-9-red.log`
  - `MissionSupervisor` did not exist;
  - acceptance coverage, workflow progress, and actionable snapshot fields were absent.
- Full-suite debugging exposed a same-millisecond evidence-ordering regression: a review-start invalidation could invalidate the review evidence published later in the same millisecond. The atomic publication path now uses the store's strictly-fresh evidence timestamp invariant. The repair recovery scenario then passed 50 consecutive runs.

## GREEN implementation

### Safety prerequisites

- Gate evidence is now built without mutating projections, then published in one conditional durable event that settles the execution, updates the candidate, invalidates prior candidate evidence, and records validation/review evidence.
- Execution authority checks include task/execution identity and current mission resumption generation before evidence building, after every awaited Git operation, and inside the conditional append mutation boundary.
- Mission completion requires an explicit expected resumption generation and checks it immediately before the completion mutation.
- Same-owner repository leases are reference-counted by exact mission/repository/generation/fencing-token epoch. Only the final holder fences the lease.

### Task 9

- Added `MissionSupervisor` with injected clock and interval, independent `start`/`stop`, single-flight ticks, startup reconciliation, durable recovery scheduling, and actionable stops.
- Diagnoses zero-worker runnable work (`ORPHANED`), dependency deadlock (`DEADLOCKED`), expired controller leases (`CONTROLLER_DISCONNECTED`), stalled meaningful progress, and expired named waits.
- Repeated ticks reuse the current durable classification/recovery decision and do not duplicate recovery state.
- Primary progress is current-candidate acceptance coverage. Workflow/DAG progress remains a separately exposed diagnostic. Completed process work with no verified acceptance remains at 0% primary coverage.
- Mission summaries and snapshots now include action, reason, last meaningful progress, recovery attempt/budget, next action/time, owner, repository, task, and preserved work.

## Verification

- Focused reliability/integration matrix:
  - `node --test test/unit/mission-supervisor.test.ts test/unit/observability-progress.test.ts test/unit/observability-service.test.ts test/unit/orchestration-snapshot-observability.test.ts test/unit/mission-ownership.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-missionstore.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-e2e.test.ts test/integration/mission-observability-e2e.test.ts`
  - Result: **181 passed, 0 failed**.
- Flake regression:
  - first-red validation recovery scenario repeated 50 times;
  - Result: **50/50 passed**.
- `npm run typecheck` — passed.
- `npm run lint` — passed; Biome checked 587 files.
- `npm test` — **2561 passed, 0 failed, 1 skipped** (Postgres integration requires `TEST_DATABASE_URL`).
- `git diff --check` — passed.

## Review focus

- Conditional append semantics and replay/quarantine behavior for `execution.gate_evidence_published`.
- Supervisor classification/recovery idempotence across resumption epochs and exhausted wait budgets.
- Acceptance coverage filtering against current manifest, candidate generation, exact identity, invalidations, and explicit passing evidence.
- Exact-epoch lease holder accounting when stale and fresh resumption authorities overlap.

## Known boundary

Runtime lifecycle wiring that starts/stops the supervisor belongs to Task 10 by plan. Task 9 supplies and verifies `start`, `stop`, `tick`, and `reconcileOnStartup` without changing `EngineeringRuntime` lifecycle ownership.
