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
