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

## Fix round 1

Addressed all six review findings with failing regressions before implementation:

- Mission finalization now captures a required resumption generation before ownership awaits or observer callbacks. Completion performs the store CAS before publishing verified-complete observability, and no call path can adopt a later generation through a default fallback. A reentrant progress callback that resumes the mission now causes stale finalization to fail without publishing verified completion.
- Supervisor dependency readiness uses `isTaskSatisfiedBySupersession` for both runnable and unresolved classification, including transitive replacement leaves.
- An explicitly present empty `acceptanceIds` contract remains 0% primary coverage even after verified completion. Only `undefined` retains legacy workflow fallback, while workflow completion remains separately reported.
- Every nonterminal mission without an active execution, runnable work, unresolved dependency, or named wait is classified for durable orphan recovery; zero-task `EXECUTING` missions cannot report `HEALTHY`/`MONITOR` only.
- Supervisor single-flight state is mission-scoped, so concurrent targeted ticks for distinct missions return only their requested mission while overlapping full/targeted ticks can coalesce per mission.
- Snapshot timing fields serialize explicit `null` values. Preserved work is the deduplicated union of each task's latest checkpoint refs and durable stop refs, including stopped work visible during a later recovery generation.

### Fix-round RED evidence

- `node --test test/unit/mission-supervisor.test.ts test/unit/observability-progress.test.ts test/unit/orchestration-snapshot-observability.test.ts test/integration/orchestrator-e2e.test.ts`
  - Result before implementation: **59 passed, 6 failed**, one intentional failure for each review finding.
- The broader observability run then exposed the stale legacy assumption that explicit empty acceptance could become 100%; the updated history assertion failed until history computation used the same acceptance-first contract as the summary.

### Fix-round verification

- Focused reliability/integration matrix (`task-9-fix1-focused.log`): **187 passed, 0 failed**.
- `npm run typecheck` (`task-9-fix1-typecheck.log`): passed.
- `npm run lint` (`task-9-fix1-lint.log`): passed; Biome checked 587 files.
- `npm test` (`task-9-fix1-full-suite.log`): **2567 passed, 0 failed, 1 skipped** (Postgres integration requires `TEST_DATABASE_URL`).
- `git diff --check`: passed.

### Fix-round reviewer focus

- Resumption races before finalization versus reentrant observers after a successful completion CAS.
- Per-mission supervisor flight cleanup when full and targeted ticks overlap.
- Whether latest-per-task checkpoint selection and cross-generation stop refs expose all recoverable work without reviving stale checkpoint versions.

## Fix round 2

Addressed both high-severity follow-up findings with failing regressions before implementation:

- Supervisor flights are keyed by mission ID and captured resumption generation. `reconcile`, full ticks, and startup reconciliation validate that generation after every await and immediately before state-changing actions or return. An overlapping generation-0 targeted tick and generation-1 startup reconciliation now create distinct decisions; the stale flight rejects and cannot dispatch or return its prior generation's result.
- Latest checkpoint selection is centralized in `latestTaskCheckpoints` and reused by `CheckpointManager`, `MissionSupervisor`, and `MissionObservability`. Sequence is compared only within one checkpoint ID/lineage. Across recovery executions, `createdAt` determines chronology and later durable event order deterministically breaks timestamp ties, so a newer recovery checkpoint at sequence 1 supersedes an older execution checkpoint at sequence 5.

### Fix-round RED evidence

- `node --test test/unit/mission-supervisor.test.ts test/unit/orchestration-snapshot-observability.test.ts`
  - Result before implementation: the generation-1 startup joined the stale generation-0 flight, and the checkpoint chronology helper was absent.

### Fix-round verification

- Expanded focused reliability/checkpoint matrix (`task-9-fix2-focused.log`): **197 passed, 0 failed**.
- `npm run typecheck` (`task-9-fix2-typecheck.log`): passed.
- `npm run lint` (`task-9-fix2-lint.log`): passed; Biome checked 587 files.
- `npm test` (`task-9-fix2-full-suite.log`): **2569 passed, 0 failed, 1 skipped** (Postgres integration requires `TEST_DATABASE_URL`).
- `git diff --check`: passed.

### Fix-round reviewer focus

- Generation checks surrounding `MissionStore.flush()` and the startup `beforeDispatch` callback.
- Cleanup and coexistence of overlapping per-generation supervisor flight keys.
- Checkpoint ordering when different lineages share an identical `createdAt`; later durable event order is the replay-stable tie-breaker.

## Fix round 3

Addressed both high-severity replay and detached-timer findings with failing regressions before implementation:

- `MissionStore` now materializes an explicit last-event ordinal for each checkpoint lineage on both live publication and replay. Checkpoint listings are sorted by that replay-stable ordinal, so the centralized latest-checkpoint helper compares cross-lineage timestamps and then durable event order. Equal-time `A1, B1, A2` events therefore select `A2` in the live store and after reopen; supervisor status and observability preserved-work projections consume the same result.
- Supervisor interval ticks now attach a rejection handler. A typed stale-resumption error is treated as expected cancellation when a blocked tick is invalidated by resume. Every other detached tick failure is retained in bounded, inspectable diagnostics and delivered to the optional error callback; callback failures are also retained rather than creating another unhandled rejection.

### Fix-round RED evidence

- `node --test --experimental-strip-types test/unit/orchestration-snapshot-observability.test.ts test/unit/mission-supervisor.test.ts`
  - Result before implementation: **14 passed, 3 failed**. The real-store equal-time lineage test selected `B1`; stale and unexpected interval failures both escaped as unhandled rejected promises.

### Fix-round verification

- Expanded focused reliability/checkpoint matrix: **192 passed, 0 failed**.
- `npm run typecheck`: passed.
- `npm run lint -- --diagnostic-level=error`: passed; Biome checked 587 files.
- `npm test`: **2572 passed, 0 failed, 1 skipped** (Postgres integration requires `TEST_DATABASE_URL`).
- `git diff --check`: passed.

### Fix-round reviewer focus

- Replay parity of the per-lineage last-event ordinal when one checkpoint ID is updated after another lineage at the same `createdAt`.
- Centralized selection precedence: sequence is lineage-local, while cross-lineage chronology uses `createdAt` then durable event ordinal.
- Detached interval behavior: only typed stale-generation cancellation is ignored; operational failures remain visible through `diagnostics()` and `onError`.

## Fix round 4

Addressed the remaining high-severity detached-callback finding with a failing regression before implementation:

- `MissionSupervisorOptions.onError` now explicitly accepts synchronous or asynchronous handlers. Detached tick failure handling assimilates and awaits the handler result, captures a rejected handler as a second bounded diagnostic, and never invokes the failing handler recursively.
- The interval regression uses an async-rejecting handler and asserts that no `unhandledRejection` is emitted while diagnostics retain both the original tick failure and the callback failure. Existing synchronous-handler, no-handler stale-cancellation, and generation-fencing coverage remains green.

### Fix-round RED evidence

- `node --test --experimental-strip-types --test-name-pattern='async error callback rejection' test/unit/mission-supervisor.test.ts`
  - Result before implementation: **0 passed, 1 failed** because `async callback failure` escaped the detached tick failure path.

### Fix-round verification

- Supervisor unit suite: **13 passed, 0 failed**.
- Expanded Task 9 reliability matrix: **193 passed, 0 failed**.
- `npm run typecheck`: passed.
- `npm run lint -- --diagnostic-level=error`: passed; Biome checked 587 files.
- `npm test`: **2573 passed, 0 failed, 1 skipped** (Postgres integration requires `TEST_DATABASE_URL`).
- `git diff --check`: passed.

### Fix-round reviewer focus

- Promise assimilation on the detached interval error path and absence of `unhandledRejection` for rejecting async handlers.
- Callback-failure diagnostics remain bounded and bypass `onError`, preventing a recursive callback-failure loop.

## Fix round 5

Addressed the final high-severity diagnostic-cap finding with a failing concurrent regression before implementation:

- Detached timer failures are now capped as atomic incidents. The tick's root failure is the capped entry, while an `onError` rejection annotates that same incident with its own timestamp, name, and message instead of consuming a second diagnostic slot.
- `diagnostics()` deep-copies the nested callback detail, preserving an actionable public projection without exposing mutable internal state.
- The stress regression overlaps 125 failed timer callbacks behind a shared async gate, then releases them to reject together. The public cap remains 100 incidents, every retained incident contains its tick root cause and its corresponding callback failure, and no rejection escapes to `unhandledRejection`.

### Fix-round RED evidence

- `node --test --experimental-strip-types --test-name-pattern='async error callback rejection|atomic incidents' test/unit/mission-supervisor.test.ts`
  - Result before implementation: **0 passed, 2 failed**. The single callback rejection occupied a separate diagnostic, and the failure storm retained callback-only entries without their root tick failures.

### Fix-round verification

- Supervisor unit suite: **14 passed, 0 failed**.
- Expanded Task 9 reliability matrix: **194 passed, 0 failed**.
- `npm run typecheck`: passed.
- `npm run lint -- --diagnostic-level=error`: passed; Biome checked 587 files.
- `npm test`: **2574 passed, 0 failed, 1 skipped** (Postgres integration requires `TEST_DATABASE_URL`).
- `git diff --check`: passed.

### Fix-round reviewer focus

- Incident ordering stays rooted in timer-failure occurrence order even when async callbacks reject in a different order.
- Eviction removes a complete oldest incident; a late callback rejection can only annotate its own retained root and never creates a callback-only diagnostic.
- The cap remains 100 under overlapping callback failures, while synchronous callbacks, no-handler behavior, stale-generation cancellation, and supervisor start/stop semantics remain unchanged.
