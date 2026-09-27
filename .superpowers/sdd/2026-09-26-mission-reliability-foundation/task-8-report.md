# Task 8 report — typed bounded recovery and blocked-mission repair

## Outcome

Implemented pure typed failure classification, stable failure fingerprints, durable bounded recovery decisions, and idempotent blocked-mission repair. Recovery now fences orphaned executions, validates durable Git journals before mutation, creates checkpoint-based replacements with explicit supersession, invalidates candidate evidence, dispatches only after durable write-ahead state, and reruns completion gates.

Fix round 1 closes all nine adversarial findings: complete canonical candidate/promotion identity, action-specific recovery execution, exact checkpoint import, single-flight blocked episodes with transitive leaf supersession, one restart-persistent recovery ledger, conservative provider classification, terminal failure classification, generation-bound stop/resume records, and durable ownership-release diagnostics.

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
- A forged candidate record with a self-consistent filename initially loaded despite a non-deterministic path and branch; canonical replay now derives and verifies both.
- A completed promotion without reconciliation authority initially loaded; completion now requires `candidateRepositoryGeneration <= originRepositoryGeneration <= reconciliationRepositoryGeneration`, with initial completion explicitly setting reconciliation to origin.
- Auth/model/configuration/unknown provider refusals initially fell through to transient provider recovery; permanent classification now precedes the generic provider branch and unknown codes fail closed.
- Concurrent blocked-repair calls initially raced into an illegal transition; the mission-local single-flight regression now proves one atomic episode result.
- Requirement and persistence actions initially created generic replacement work; action tests now prove wait/pause paths do not dispatch replacements.
- A mission ownership release exception was initially swallowed; the regression now observes the existing durable ownership diagnostic.
- Terminal gate failures initially transitioned tasks before any durable classification; the scheduler regression proves classification precedes failure state.
- Replacement work initially discarded dependency and checkpoint state, and downstream dependencies ignored transitive replacement leaves; the new regressions prove exact recovery requirements and leaf satisfaction.
- A stop after explicit resumption initially reported the old recovery deadline; the generation-bound deadline regression failed red and now reports only the current resumption epoch.

## GREEN evidence

- `node --test test/unit/git.test.ts test/unit/orchestration-missionstore.test.ts test/unit/orchestration-recovery-planner.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts test/unit/orchestration-gate.test.ts test/integration/orchestrator-e2e.test.ts` — 190 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run lint` — passed (585 files checked).
- `npm test` — 2,473 passed, 0 failed, 1 skipped; the skip requires `TEST_DATABASE_URL` for the optional Postgres OpenViking round trip.
- `git diff --check` — passed.

## Decisions

- Failure fingerprints omit execution IDs so a restarted or relaunched execution with materially identical failure evidence consumes the same durable strategy budget.
- Recovery deadlines use the earliest deadline found in durable history, so restart cannot extend a recovery window.
- Provider transient failures consume the unified mission ceiling but use the existing durable provider-outage budget rather than the generic two-attempt schema-repair budget.
- A repair plan and supersession lineage are durable before `BLOCKED -> REPAIRING` and before dispatch. Replay returns existing terminal/started state instead of duplicating replacement tasks.
- Split replacement tasks satisfy supersession coverage collectively. Candidate-backed or gate-bearing work still requires validation and review evidence whose authoritative executions ended after every replacement completed.
- Any canonical durable repository-record diagnostic creates a blocking finding and exact mission stop before orphan reconciliation, replacement creation, or Git mutation.
- Candidate journal filenames bind parent/run lineage, seed/base/candidate SHAs, repository and mission generations, branch, and path; replay additionally derives the deterministic mission-owned branch/worktree mapping.
- The selected recovery action remains authoritative: wait and pause stop before dispatch, manifest rebuild requires a new probed manifest generation, evidence reconstruction requires invalidation, fencing requires an orphan/replacement delta, and repair actions require current-leaf replacements.
- Explicit resumption starts a new deadline epoch but does not reset the unified mission ceiling or identical-fingerprint attempt count. Stop records bind stop generation, resumption generation, blocked episode, current deadline, and every known preserved repository asset.

## Residual risk / reviewer focus

- Review canonical filename coverage for all candidate/run/promotion identity fields and the generation ordering (`candidateRepositoryGeneration <= originRepositoryGeneration <= reconciliationRepositoryGeneration`).
- Review the ordering in `repairBlockedMission`: ownership acquisition, read-only Git preflight, orphan fencing/reconciliation, durable decision, replacements/supersession/invalidation, `REPAIRING`, dispatch, then gates.
- Review unified recovery accounting between scheduler retries and parent repair, especially provider transient behavior and earliest-deadline replay.
- Review action postconditions and error settlement in `repairBlockedMission`, especially manifest probe failures and checkpoint mismatch findings.
- Review exact checkpoint recovery requirements (`candidateSha`, committed/dirty paths, artifacts) and transitive supersession leaf behavior in scheduler and completion gates.
- The optional Postgres-backed OpenViking test was not run because `TEST_DATABASE_URL` is not configured; it is unrelated to this change.
