# Task 8 report — typed bounded recovery and blocked-mission repair

## Outcome

Implemented pure typed failure classification, stable failure fingerprints, durable bounded recovery decisions, and idempotent blocked-mission repair. Recovery now fences orphaned executions, validates durable Git journals before mutation, creates checkpoint-based replacements with explicit supersession, invalidates candidate evidence, dispatches only after durable write-ahead state, and reruns completion gates.

The two carried Task 7 prerequisites are enforced before recovery:

- candidate, integration-run, and promotion journals use canonical complete-payload filenames and reject impossible identity/generation relationships;
- cleanup journals bind mission, repository, worktree path, and branch, and cleanup verifies the exact Git worktree/path/branch mapping before mutation.

Metabolomics remains disabled. No model or package dependency was added.

## RED evidence

- Durable Git record regression tests initially failed because candidate/run/promotion inventory APIs did not exist and cleanup replay did not reject a forged full identity.
- `test/unit/orchestration-recovery-planner.test.ts` initially failed to load because `FailureClassifier` and `RecoveryPlanner` did not exist.
- Blocked-mission integration tests initially failed because `repairBlockedMission` did not exist.
- The completion-path regression initially returned `REPAIRING` instead of `COMPLETE`, proving successful replacement work was not rerunning final gates.
- The orphan crash-state regression failed its write-ahead order assertion because a durable `RUNNING` execution was not fenced or reconciled before replacement creation.
- The atomic-start replay regression returned `REPAIRING` instead of `COMPLETE`, proving restart did not resume a repair after the durable `recovery.started` event. Recovery now reuses the episode decision and deterministic replacement/supersession identities.
- During the bounded full-suite pass, three long-outage resilience tests exposed that the generic two-attempt recovery strategy and a shorter default deadline incorrectly truncated the existing provider outage policy. The fix makes provider transient attempts share the mission ceiling while retaining the durable outage probe/relaunch deadline.
- Tightening collective supersession coverage exposed the existing freshness test (`anchors supersession freshness to execution end time...`): a candidate-backed repair was incorrectly allowed to bypass post-replacement evidence when the failed task was marked non-mutating. The gate now requires fresh mutation proof whenever candidate evidence or required gates exist.

## GREEN evidence

- `node --test test/unit/orchestration-recovery-planner.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts test/unit/git.test.ts test/unit/orchestration-gate.test.ts` — 116 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run lint` — passed (585 files checked).
- `npm test` — 2,464 passed, 0 failed, 1 skipped; the skip requires `TEST_DATABASE_URL` for the optional Postgres OpenViking round trip.
- `git diff --check` — passed.

## Decisions

- Failure fingerprints omit execution IDs so a restarted or relaunched execution with materially identical failure evidence consumes the same durable strategy budget.
- Recovery deadlines use the earliest deadline found in durable history, so restart cannot extend a recovery window.
- Provider transient failures consume the unified mission ceiling but use the existing durable provider-outage budget rather than the generic two-attempt schema-repair budget.
- A repair plan and supersession lineage are durable before `BLOCKED -> REPAIRING` and before dispatch. Replay returns existing terminal/started state instead of duplicating replacement tasks.
- Split replacement tasks satisfy supersession coverage collectively. Candidate-backed or gate-bearing work still requires validation and review evidence whose authoritative executions ended after every replacement completed.
- Any canonical durable repository-record diagnostic creates a blocking finding and exact mission stop before orphan reconciliation, replacement creation, or Git mutation.

## Residual risk / reviewer focus

- Review canonical filename coverage for all candidate/run/promotion identity fields and the generation ordering (`candidateRepositoryGeneration <= originRepositoryGeneration <= reconciliationRepositoryGeneration`).
- Review the ordering in `repairBlockedMission`: ownership acquisition, read-only Git preflight, orphan fencing/reconciliation, durable decision, replacements/supersession/invalidation, `REPAIRING`, dispatch, then gates.
- Review unified recovery accounting between scheduler retries and parent repair, especially provider transient behavior and earliest-deadline replay.
- The optional Postgres-backed OpenViking test was not run because `TEST_DATABASE_URL` is not configured; it is unrelated to this change.
