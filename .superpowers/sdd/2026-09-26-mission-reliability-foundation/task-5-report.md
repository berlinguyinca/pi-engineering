# Task 5 Report: Authoritative timeout and cancellation

## Outcome

Implemented a broker-owned hard terminal race for deadline and cancellation handling.

- `handle.result()` now stops awaiting a backend at the configured deadline plus bounded cancellation grace, even when the backend ignores `AbortSignal` forever.
- The broker publishes a failed `timeout` outcome, removes the execution from active scheduling, and allows the scheduler to dispatch the next queued task.
- Execution status plus mission/candidate generation, fencing token, and assigned execution ID form an explicit result/mutation fence.
- All normal post-dispatch checkpoint, worktree, handoff, and result publication paths assert the originating execution identity before mutation.
- A timed-out worktree is retained immediately and marked ineligible for integration. Existing stable checkpoints remain recoverable evidence but do not become approval or gate evidence.
- Late backend resolution/rejection is detached and observed through `execution.late_result_rejected`; it cannot overwrite terminal status, artifacts, findings, recovered merge refs, or review/gate evidence.
- Explicit cancellation retains its Task 4 checkpoint/preservation owner and remains bounded without allowing a late backend result to regain authority.

## TDD evidence

The initial focused run failed four new regressions for the intended reasons:

```text
node --test test/unit/orchestration-broker.test.ts test/unit/orchestration-broker-recovery.test.ts test/unit/orchestration-scheduler.test.ts
```

Failures proved that an uncooperative backend prevented broker settlement, prevented scheduler slot release, prevented checkpoint-only preservation from becoming integration-ineligible, and allowed late success to remain the controlling result.

Final focused result: exit 0; 67 passed, 0 failed.

## Verification

```text
npm run typecheck
npx biome check src/orchestration/broker.ts src/orchestration/missionStore.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-broker-recovery.test.ts test/unit/orchestration-scheduler.test.ts
git diff --check
```

Result: all exit 0 with no diagnostics or formatting/whitespace findings.

```text
npm test
```

Result: exit 0; 2,361 total, 2,360 passed, 0 failed, 1 skipped. The existing Postgres OpenViking test was skipped because `TEST_DATABASE_URL` is unset.

## Files

- `src/orchestration/broker.ts` — hard terminal timeout/cancel race, bounded grace, execution revocation, scheduler release, retained timeout worktrees, and detached late-result observation.
- `src/orchestration/missionStore.ts` — execution identity assertion and append-only late-result evidence that preserves terminal outcomes.
- `test/unit/orchestration-broker.test.ts` — uncooperative deadline and inert late-success regressions.
- `test/unit/orchestration-broker-recovery.test.ts` — stable checkpoint preservation with unreconciled work excluded from integration.
- `test/unit/orchestration-scheduler.test.ts` — scheduler capacity release and non-overwriting takeover evidence.

## Self-review and concerns

- Timed-out worktrees intentionally remain mounted because writer quiescence is uncertain; Tasks 8/9 own reconciliation and eventual cleanup.
- Authority-loss reconciliation for unrelated already-`RUNNING` orphans remains deferred to Tasks 8/9. This task explicitly settles only its own broker deadline/cancellation boundary.
- Git path-enumeration failures remain final-review triage as directed; no fail-open/fail-closed policy was changed here.
- No auto-repair or automatic integration of checkpointed work was added.

## Fix Round 1

Addressed the six high-severity review findings:

- Cancellation and timeout now share idempotent terminalization. Preservation is bounded; uncertain worktrees are retained, execution/task authority is revoked, and active scheduler ownership is removed before the public promise settles.
- Checkpoints assert execution authority before snapshotting, after every asynchronous repository/persistence boundary, and immediately before publication. Terminal/stale attempts retain the previous checkpoint and append typed inert evidence.
- Integration reasserts authority after every awaited repository operation and before findings, handoffs, recovered-merge evidence, and cleanup. Authority loss retains all uncertain branches/worktrees and records evidence only.
- Backend resolution or rejection after abort is always late evidence; the public result remains the broker's authoritative cancellation/timeout outcome.
- Each handle memoizes one exact execution promise, preventing duplicate dispatch.
- One typed late-outcome serializer preserves exit status, summary/error, findings, artifacts, handoffs, recovery metadata, and gate metadata. Detached append failures remain visible through `persistenceDiagnostics()`.

### RED

The focused regression run failed as expected before implementation:

```text
node --test --test-name-pattern='memoizes|authoritative cancellation|finishes snapshot' \
  test/unit/orchestration-checkpoints.test.ts test/unit/orchestration-broker.test.ts
```

Observed failures: distinct result promises/duplicate dispatch, backend rejection controlling cancellation, and a late checkpoint replacing the authoritative snapshot.

Additional regressions cover stalled checkpoint cancellation, late integration cleanup/findings, complete inert late evidence, and detached evidence append failure.

### GREEN

Focused broker/recovery/checkpoint/mission-store/scheduler suites: 97 passed, 0 failed.

Final verification:

- `npm run typecheck` — passed.
- `npm run lint` — 582 files checked, no diagnostics.
- `npm test` — 2,367 total, 2,366 passed, 0 failed, 1 Postgres-dependent test skipped because `TEST_DATABASE_URL` is unset.
- `git diff --check` — passed.

## Fix Round 2

Closed the remaining timeout/cancellation authority gaps:

- Explicit cancellation marks its branch integration-ineligible before terminal status changes, so cancellation can never race the result path into a clean handoff.
- Checkpoint publication is now a store-serialized conditional operation: it drains prior writes, verifies execution/generation/fence/repository/base identity, appends durably, and only then applies the checkpoint in memory. A takeover while an earlier append is blocked leaves both durable and in-memory checkpoint state unchanged.
- Successful integration records worktrees for separately owned cleanup instead of deleting branches/worktrees while execution authority can disappear across a Git await.
- The hard abort race now covers repository resolution, worktree allocation, and setup. Late allocations are retained and timeout remains the authoritative reason.
- Cancellation-grace timers are captured, unrefed, and cleared when checkpoint preservation wins the race.

### RED

```text
node --test --test-name-pattern='explicitly canceled|worktree allocation is blocked|queued append is blocked|defers destructive' \
  test/unit/orchestration-broker.test.ts \
  test/unit/orchestration-checkpoints.test.ts \
  test/unit/orchestration-broker-recovery.test.ts
```

Result before implementation: 4 tests, 0 passed, 4 failed. Failures demonstrated canceled work entering a handoff, setup owning settlement past the deadline, stale checkpoint replacement, and destructive integration cleanup beginning under revocable execution authority.

### GREEN

```text
node --test \
  test/unit/orchestration-broker.test.ts \
  test/unit/orchestration-broker-recovery.test.ts \
  test/unit/orchestration-checkpoints.test.ts \
  test/unit/orchestration-missionstore.test.ts \
  test/unit/orchestration-scheduler.test.ts \
  test/unit/orchestration-scheduler-resilience.test.ts \
  test/unit/orchestration-workset.test.ts
```

Result: 116 tests, 116 passed, 0 failed. This is the corrected focused command/count for the complete Task 5 authority surface.

Final verification:

- `npm run typecheck` — passed.
- `npm run lint` — 582 files checked, no diagnostics.
- `npm test` — 2,371 total, 2,370 passed, 0 failed, 1 Postgres-dependent test skipped because `TEST_DATABASE_URL` is unset.
- `git diff --check` — passed.
