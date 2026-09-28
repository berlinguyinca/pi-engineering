# Task 8 report — typed bounded recovery and blocked-mission repair

## Outcome

Implemented pure typed failure classification, stable failure fingerprints, durable bounded recovery decisions, and idempotent blocked-mission repair. Recovery now fences orphaned executions, validates durable Git journals before mutation, creates checkpoint-based replacements with explicit supersession, invalidates candidate evidence, dispatches only after durable write-ahead state, and reruns completion gates.

Fix round 1 closes all nine adversarial findings: complete canonical candidate/promotion identity, action-specific recovery execution, exact checkpoint import, single-flight blocked episodes with transitive leaf supersession, one restart-persistent recovery ledger, conservative provider classification, terminal failure classification, generation-bound stop/resume records, and durable ownership-release diagnostics.

Fix round 2 closes six replay and materiality findings: durable recovery-owned phase replay, typed immutable checkpoint import, resumption-generation decision rollover, provider-first terminal gate classification, genuinely mutating repair tasks with candidate-delta proof, and staged workspace-manifest replacement.

Fix round 3 closes the six remaining authority findings: checkpoint context now comes only from an exact durable task/checkpoint/execution/supersession lineage; the production `WorkerRequest` carries that immutable typed context; replacement replay is bound by an explicit decision ID and complete fingerprint; every awaited recovery phase is fenced by resumption generation; mutating recovery requires Git-recomputed candidate SHA and diff identity; and repository contexts are scoped to the exact mission/manifest generation/hash with durable bind before activation.

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
- Three crash-point regressions (after replacement flush, after `REPAIRING`, and during dispatch) initially returned `BLOCKED`; replay now resumes the recovery-owned supersession lineage and treats its current leaves as the durable material delta.
- Explicit resumption initially reused the prior generation's started decision. Recovery now fails the stale started decision, creates a decision bound to the new resumption deadline, and retains cumulative fingerprint/mission accounting.
- A real Git checkpoint-import regression saw exact formerly dirty bytes in the replacement worktree but no typed completed-work context. The broker now validates and exposes checkpoint identity, source path/branch, committed/formerly-dirty paths, completed deliverables, and artifact identities.
- Unreproducible dirty paths, traversal/absolute repository paths, relative source worktrees, and unmatched artifact hashes initially reached dispatch; all now fail before execution creation.
- Permanent provider failures in validation/review/integration were initially overwritten by task-kind categories. Structured provider/error classification now wins, with gate/merge fallback only for genuine gate failures.
- `CREATE_REPAIR_TASKS` initially cloned failed validation/review tasks. It now creates bounded mutating implementer work in isolated worktrees and durably records the starting candidate identity; recovery cannot succeed without changed candidate evidence and fresh gates.
- Manifest rebuild initially bound generation 2 before probes, so a failed probe survived restart as authoritative. Registry contexts are now staged and probed before commit and durable manifest bind; the restart regression retains generation 1 on failure.
- The full suite exposed a filesystem-order-dependent promotion test that sometimes forged a stale intent instead of the completed record. The regression now selects the completed promotion explicitly and remains deterministic under concurrent full-suite load.
- Forged recovery fields in `execution_requirements` initially reached a replacement worker. The broker now rejects all caller-supplied recovery fields and reconstructs context only from the durable checkpoint authority attached to the task.
- A deterministic replacement task ID with a forged role/lineage fingerprint initially reused recovery work. Exact decision, task, execution, checkpoint, supersession, role, mutation, repository, generation, and fence equality is now required before execution creation.
- A repair blocked in an awaited preflight initially remained the mission's single-flight after an operator resumption. Flights are now generation-scoped, and the stale generation fails before publishing any subsequent side effect.
- Candidate invalidation/metadata churn initially counted as repair material. The materiality regression now requires a Git-recomputed candidate SHA and diff hash/content for every repository-mutating recovery lineage.
- Registry contexts were keyed only by `repoId`, allowing same-ID bindings from different missions to overwrite each other, and a staged manifest was activated before its bind flushed. Contexts now use mission + manifest generation + manifest hash; removed bindings disappear on activation, staged contexts remain invisible, and a failed durable bind leaves the old manifest authoritative after restart.
- The first bounded full-suite pass found one repository-tool regression after manifest scoping: an explicit repository lookup outside the execution async context returned “Not a git repository.” Resolution now permits one unambiguous path match across active exact manifests while rejecting ambiguous shared bindings; the 18-test real-runtime acceptance file passes after the fix.

## GREEN evidence

- `node --test test/unit/git.test.ts test/unit/orchestration-missionstore.test.ts test/unit/orchestration-recovery-planner.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts test/unit/orchestration-gate.test.ts test/integration/orchestrator-e2e.test.ts` — 200 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run lint` — passed (585 files checked).
- `npm test` — 2,483 passed, 0 failed, 1 skipped; the skip requires `TEST_DATABASE_URL` for the optional Postgres OpenViking round trip.
- `git diff --check` — passed.
- Fix-round-3 focused set (`orchestrator-recovery`, mission store, scheduler, real backends, workspace manifest) — 100 passed, 0 failed.
- `test/integration/orchestration-runtime.test.ts` after the full-suite-discovered scoped-tool regression — 18 passed, 0 failed.
- Fix-round-3 bounded full suite: `npm test` — 2,490 passed, 0 failed, 1 skipped (optional Postgres test).

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
- Recovery phase is reconstructed from the generation-bound decision plus deterministic recovery-owned task/supersession IDs. Existing current leaves are resumed, not recreated, across every write-ahead crash boundary.
- Checkpoint recovery always creates a fresh worktree at the exact verified candidate commit. The typed backend context carries preserved completed work and artifact identities; no opaque requirement alone can claim imported state.
- Workspace registry replacement is a stage/probe/commit operation. The durable manifest generation advances only after every staged role probe succeeds.
- Replacement recovery authority is a first-class persisted task field, not prompt/model input. Its fingerprint binds every immutable execution and lineage field, and the broker recomputes it before allocating a worktree or creating an execution.
- Manifest replacement uses a durable conditional append that applies in-memory authority only on commit. Registry activation is synchronous and occurs strictly after that durable bind succeeds.
- Explicit repository execution resolution always supplies mission ID, manifest generation, and manifest hash. Path-only tool resolution is allowed only when exactly one active manifest context matches.

## Residual risk / reviewer focus

- Review canonical filename coverage for all candidate/run/promotion identity fields and the generation ordering (`candidateRepositoryGeneration <= originRepositoryGeneration <= reconciliationRepositoryGeneration`).
- Review the ordering in `repairBlockedMission`: ownership acquisition, read-only Git preflight, orphan fencing/reconciliation, durable decision, replacements/supersession/invalidation, `REPAIRING`, dispatch, then gates.
- Review unified recovery accounting between scheduler retries and parent repair, especially provider transient behavior and earliest-deadline replay.
- Review action postconditions and error settlement in `repairBlockedMission`, especially manifest probe failures and checkpoint mismatch findings.
- Review exact checkpoint recovery requirements (`candidateSha`, committed/dirty paths, artifacts) and transitive supersession leaf behavior in scheduler and completion gates.
- Review the durable `startingCandidateIdentityHash` baseline and the post-integration material-delta gate for `CREATE_REPAIR_TASKS`.
- Review staged registry replacement for the invariant that failed probes cannot mutate either active in-memory repository authority or replayed manifest generation.
- Review `durableRecoveryContext` for the exact task/checkpoint/execution/supersession comparisons and the deliberate rejection of all caller recovery fields.
- Review resumption fencing after awaits, especially stale-flight settlement and generation-scoped single-flight keys.
- Review Git materiality: candidate SHA and diff hash are recomputed from the exact active repository binding; artifacts, generation increments, and invalidations cannot satisfy a mutating repair.
- Review registry ambiguity behavior for shared repository paths: mission-aware execution is exact, while path-only tools fail closed when more than one active manifest matches.
- The optional Postgres-backed OpenViking test was not run because `TEST_DATABASE_URL` is not configured; it is unrelated to this change.

## Fix round 4

### Outcome

- Replacement replay and dispatch now bind the complete immutable task specification, exact manifest identity, complete checkpoint snapshot, and ordered artifact reference/hash pairs. The broker independently recomputes the same fingerprint before worktree allocation.
- Only resume-preserved-worker actions import a checkpoint. Validation/review/implementation repair starts from an independently Git-verified current candidate and carries no checkpoint authority.
- Recovery flights, leases, task authority, awaited phases, settlement, and return paths are fenced by resumption generation. A stale flight releases only the exact generation-local lease it acquired.
- Mutating repair work is integrated under fencing before materiality evaluation. Materiality requires changed Git content and diff identity, so a SHA-only empty commit is rejected.
- Workspace-manifest binding is a true predecessor-generation/hash CAS. A bind-before-activate crash is recoverable by idempotently restaging and activating the durable manifest.
- Registry async-local and path lookups validate against the current active manifest. Obsolete scopes are inaccessible, and path resolution requires exactly one direct/common-Git match.
- Worker prompt compaction applies only to ordinary context; the immutable durable recovery block is appended intact.

### Adversarial TDD evidence

- RED: gate repair inherited checkpoint authority; same-generation manifest binds both committed; stale async-local scopes and unmatched paths remained usable; long ordinary context truncated durable recovery fields.
- GREEN: a 32-case fingerprint mutation matrix covers task, manifest, checkpoint, path, candidate/base, and artifact identity; recovery integration tests cover no-checkpoint gate repair, generation races after awaited phases, overlapping flight leases, genuine integration, and SHA-only empty-commit rejection.
- Registry/store tests cover concurrent same-predecessor manifest CAS, bind-before-activate restart recovery, removed-repository async-local invalidation, and unmatched/ambiguous path failure.
- Worker tests prove long ordinary prompt context is compacted while the durable recovery block remains complete.

### Verification

- Recovery-focused final run: `node --test` over Git, mission-store, recovery-planner, scheduler, broker-recovery, workspace-manifest, workers, orchestrator-recovery/resilience, gate, and orchestration-runtime tests — 174 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run lint` — passed; 585 files checked.
- `git diff --check` — passed.
- Bounded full suite: `timeout 180s npm test` — 2,534 passed, 0 failed, 1 skipped in 38.4 seconds. The skip is the optional Postgres OpenViking round trip because `TEST_DATABASE_URL` is unset.

### Reviewer focus

- Confirm the replacement fingerprint has no mutable or omitted authority surface and that both replay and dispatch compare the complete object.
- Confirm every recovery await is followed by a generation assertion before mutation, settlement, lease release, or result publication.
- Confirm manifest CAS checks the exact persisted predecessor at append time and restart activation cannot expose an uncommitted manifest.
- Confirm mutating repair materiality is evaluated only after fenced integration and requires a changed diff, not merely a new commit SHA.
- Confirm path-only registry resolution fails closed for zero or multiple matches and stale async-local scopes cannot reach removed bindings.

## Fix round 5

### Outcome

- Explicit resumption is now a durable dispatch epoch carried by mission leases, tasks, executions, scheduler authority, broker settlement, integration, and promotion guards. Recording a resumption fences the prior mission/repository leases, and blocked repair cancels active older-generation backends before any new dispatch.
- Same-owner overlapping acquisitions are reference-counted per lease epoch. Releasing one flight cannot fence a second holder, while a new resumption receives a distinct generation/fencing epoch and stale release cannot affect it.
- Recovery authority is reconstructed from durable current-lineage decisions instead of depending on the orchestrator's in-memory task map. Ownership-enabled restart tests now cover replacement flush, `REPAIRING`, and already-dispatched replacement crash points.
- Replacement fingerprints now bind the authoritative recovery decision (mission, classification, action, blocked episode, resumption, deadlines, and candidate baselines), supersession identity (failed task, repository, coverage, and ordered replacements), complete immutable replacement spec, manifest, checkpoint snapshot, and ordered artifact proof. Recovery supersessions require exactly one fingerprint per replacement, and broker dispatch rejects missing, zero-lineage, multiple-lineage, or unequal fingerprints.
- Once any mission manifest is active, unmatched repository paths throw `WorkspaceScopeError`; `EngineeringRuntime` core tools can no longer fall back to the launch broker, Git provider, or base ref for an out-of-scope execution cwd.

### Adversarial TDD evidence

- RED: same-owner overlapping release fenced the live lease; explicit resumption reused the old epoch; active-manifest path misses returned `null` and core tools used the runtime-global broker; full fingerprint mutations for decision/blocked episode/baseline/lineage ordering/proof deletion were not bound.
- GREEN: real backend races cover stale worker settlement, candidate integration, and incumbent promotion during explicit resumption; every stale path remains nonterminal and leaves incumbent HEAD unchanged.
- Ownership-enabled crash replay passes after replacement flush, after `BLOCKED -> REPAIRING`, and after replacement dispatch with the original failed task excluded by its durable supersession.

### Verification

- Focused authority/recovery/runtime set — 205 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run lint` — passed; 585 files checked.
- `npm test` — 2,548 passed, 0 failed, 1 skipped in 40.4 seconds. The skip remains the optional Postgres OpenViking round trip because `TEST_DATABASE_URL` is unset.
- `git diff --check` — passed.

### Reviewer focus

- Confirm no mutation path trusts only the outer recovery-generation checks: broker settlement and Git guards must observe the lease/task/execution resumption epoch directly.
- Confirm `resumeMission` fences the old durable lease before a new recovery flight can acquire or dispatch, and stale release never fences a newer same-owner epoch.
- Confirm fingerprint recomputation starts from exactly one durable supersession lineage and cannot omit a decision baseline, ordered replacement, checkpoint field, or artifact proof.
- Confirm runtime-global repository dependencies are reachable only while no mission manifest is active.
