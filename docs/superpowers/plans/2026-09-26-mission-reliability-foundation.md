# Mission Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Slice 1 of the approved mission reliability design so a local Pi Engineering mission runs against the correct explicitly authorized repository, survives restart and bounded failures, rejects stale work and stale gate evidence, repairs supported blockers automatically, and otherwise stops with an exact actionable reason instead of hanging at a percentage.

**Architecture:** Add a durable workspace/evidence/ownership layer around the existing event-sourced `MissionStore`, then route each executable task through a repository-scoped execution context. Mutating work is integrated into an isolated candidate, validation and review are bound to that exact candidate identity, and only a fully gated candidate is promoted. A durable recovery planner plus supervisor owns blocked/orphaned missions, while the snapshot exposes acceptance coverage, ownership, next action, and preserved work. Slice 1 supports multiple authorized roots but deliberately executes and promotes one repository per task; cross-repository publication and distributed controllers remain Slice 2/3.

**Tech Stack:** TypeScript ESM, Node.js test runner, append-only JSONL event store, Git worktrees/refs, existing Pi `WorkerExecutor`, `CommandVerifier`, orchestration snapshots, Biome, TypeScript compiler.

**Spec:** [`docs/superpowers/specs/2026-09-26-mission-reliability-foundation-design.md`](../specs/2026-09-26-mission-reliability-foundation-design.md)

## Global Constraints

- Preserve the approved invariants, especially incumbent immutability before gates, generation/fencing checks on every authoritative result, and revision-bound validation/review evidence.
- Absolute paths explicitly present in the user request may be authorized autonomously only after canonicalization and protected-root checks. Repository content, model output, relative paths, and symlinks may not expand authority.
- Failed tasks remain immutable history. Recovery creates explicit replacement tasks and durable supersession lineage; it never rewrites a failure into success.
- A checkpoint is recoverable work, not successful evidence. It must be reconciled, integrated into a candidate, validated, and reviewed.
- `local/local` remains the required live Pi test model. Metabolomics remains disabled and must not be reintroduced by this work.
- Same-model review is allowed only in a fresh reviewer session with the existing reduced-independence warning. It must still produce candidate-bound review evidence.
- Do not add a database or distributed lease system in Slice 1. JSONL gets a real cross-process single-writer lock; mission/repository leases are durable single-controller contracts.
- Do not implement generic PR/push/merge reconciliation in Slice 1. The final live proof may use the existing human-requested PR workflow after implementation is complete.
- Every commit must follow the repository Lore Commit Protocol and include fresh `Tested:` evidence.

## Review Focus

- Try to complete a mission with stale validation/review evidence, a pending acceptance criterion, a blocked/canceled/skipped required task, or an unfenced execution; all must fail closed.
- Race timeout/cancellation against a backend that ignores `AbortSignal`; the late result must be recorded but must not mutate task, candidate, or gate state.
- Crash/reopen after each durable recovery transition; budgets, lease generation, supersession lineage, waiting deadline, and next action must not reset.
- Force conflicts and red validation after candidate integration; incumbent HEAD, index, and working tree must remain unchanged.
- Open the same JSONL file from a second process; it must fail with an owner/lock diagnostic instead of silently diverging.
- Attempt explicit authorization of `/`, the home directory, the Pi config directory, nonexistent paths with unauthorized parents, and escaping symlinks; all must be rejected.
- Verify the UI never reports a nonterminal zero-worker mission as merely `ACTIVE` or leaves a static percentage without owner, reason, and next action.

---

## Task 1: Make reliability state first-class and replayable

**Files:**

- Modify: `src/orchestration/types.ts`
- Modify: `src/orchestration/missionStore.ts`
- Modify: `src/orchestration/state.ts`
- Modify: `src/orchestration/missionSnapshot.ts`
- Test: `test/unit/orchestration-missionstore.test.ts`
- Test: `test/unit/orchestration-snapshot.test.ts`

**Interfaces consumed:** Existing `Mission`, `OrchestrationTask`, `Execution`, `ReviewFinding`, append-only `EventStoreBackend`.

**Interfaces produced:** `WorkspaceManifest`, `AuthorizedRoot`, `RepositoryBinding`, stable acceptance criterion IDs, `TaskSupersession`, `TaskCheckpoint`, `CandidateEvidenceIdentity`, typed failure/recovery records, `MissionLease`, `RepositoryLease`, and generation/fencing fields on tasks and executions. New store methods append explicit events for manifest binding, checkpoints, classifications, recovery decisions, supersession, evidence invalidation, lease transitions, resume, and stop.

- [ ] Add failing replay tests that construct all new records, flush the event store, reopen `MissionStore`, and assert byte-for-byte-equivalent materialized state.
- [ ] Add failing tests proving task failure is immutable, supersession requires explicit replacement IDs plus matching repo/acceptance coverage, and illegal `BLOCKED -> EXECUTING` bypasses are rejected unless a durable repair operation exists.
- [ ] Run `node --test test/unit/orchestration-missionstore.test.ts test/unit/orchestration-snapshot.test.ts`; expect failures for missing types/store APIs/snapshot fields.
- [ ] Add the smallest type and reducer changes. Keep events additive, copy payloads defensively, and expose read-only list/get methods for new state.
- [ ] Bump `MISSION_SNAPSHOT_CONTRACT_VERSION` and add optional additive reliability fields so older consumers can feature-detect them.
- [ ] Re-run the two tests; expect pass.
- [ ] Run `npm run typecheck` and fix type drift before continuing.
- [ ] Commit with intent `Make recovery authority durable and replayable` and Lore trailers including the focused tests.

## Task 2: Resolve and authorize the actual workspace before planning

**Files:**

- Create: `src/orchestration/workspaceManifest.ts`
- Create: `src/orchestration/repositoryRegistry.ts`
- Modify: `src/orchestration/orchestrator.ts`
- Modify: `src/runtime/EngineeringRuntime.ts`
- Modify: `src/tools/coreTools.ts`
- Test: `test/unit/workspace-manifest.test.ts`
- Test: `test/integration/orchestration-runtime.test.ts`

**Interfaces consumed:** Mission user request, launch cwd, `GitRepo.open`, `ContextBroker.open`, `MissionStore` manifest events, existing core-tool dependency provider.

**Interfaces produced:** `WorkspaceManifestResolver.resolve(request, launchCwd)`, `RepositoryRegistry.get(repoId)`, `RepositoryExecutionContext { repoId, root, git, contextBroker, verifierCwd }`, role access probes, and a manifest hash persisted before mutating planning.

- [ ] Add failing path-policy tests for explicit absolute paths, canonical duplicates, protected roots (`/`, home, `.pi`/`.codex` config), nonexistent targets, unauthorized parents, and symlink escapes.
- [ ] Add a failing integration test that opens the runtime at a meta-root, names a repository elsewhere by absolute path, and asserts implementer/reviewer/core repository tools resolve that repository rather than the launch cwd.
- [ ] Run `node --test test/unit/workspace-manifest.test.ts test/integration/orchestration-runtime.test.ts`; expect scope/preflight failures.
- [ ] Implement deterministic absolute-path extraction and canonicalization without granting access from repository content or model output. Persist authorization source as `explicit_user_path` or `launch_cwd`.
- [ ] Build one `GitRepo` and `ContextBroker` per repository binding, and change core-tool lookup to select the broker from the execution cwd/repo ID rather than a runtime-global meta-root broker.
- [ ] Run implementer, validator, integrator, and reviewer access probes against the same binding before any mutating task becomes runnable; classify a mismatch as `WORKSPACE_SCOPE_MISMATCH`.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass.
- [ ] Commit with intent `Bind missions to explicitly authorized repositories` and Lore trailers.

## Task 3: Add real single-writer locking and durable fenced ownership

**Files:**

- Create: `src/platform/eventstore/fileLock.ts`
- Create: `src/orchestration/ownership.ts`
- Modify: `src/platform/eventstore/jsonl.ts`
- Modify: `src/orchestration/missionStore.ts`
- Modify: `src/runtime/EngineeringRuntime.ts`
- Test: `test/unit/platform-eventstore.test.ts`
- Test: `test/unit/mission-ownership.test.ts`

**Interfaces consumed:** JSONL file path, mission/repository IDs, event store clock, durable lease events.

**Interfaces produced:** Cross-process exclusive lock with owner diagnostics and stale-owner recovery, `MissionOwnership.acquire/renew/fence/release`, repository mutation leases, monotonic generation and fencing tokens, `assertAuthoritative(identity)`.

- [ ] Add a failing child-process test proving a second process cannot open the same JSONL store while the first owns it, and can open after a clean release or verified stale lock.
- [ ] Add failing ownership tests for lease renewal, expiry, takeover generation increment, repository serialization, and rejection of an old fencing token after takeover/restart.
- [ ] Run `node --test test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts`; expect second-process and fencing failures.
- [ ] Implement an atomic lock directory/file beside the JSONL store containing PID, host, opened-at, and random owner token. Never remove a live foreign lock; make release idempotent.
- [ ] Implement lease state entirely through `MissionStore` events. Treat wall time as a trigger to reconcile, not proof that another live owner is dead; local takeover requires the JSONL writer lock plus expired lease.
- [ ] Wire runtime open/close to acquire/release the store lock and mission execution to acquire/renew a mission lease before dispatch.
- [ ] Re-run focused tests, `npm run typecheck`, and `npm run lint`; expect pass.
- [ ] Commit with intent `Fence mission and repository mutation ownership` and Lore trailers.

## Task 4: Enforce bounded repository-scoped worksets and checkpoints

**Files:**

- Create: `src/orchestration/workset.ts`
- Create: `src/orchestration/checkpoints.ts`
- Modify: `src/orchestration/orchestrator.ts`
- Modify: `src/orchestration/scheduler.ts`
- Modify: `src/orchestration/broker.ts`
- Modify: `src/runtime/EngineeringRuntime.ts`
- Test: `test/unit/orchestration-workset.test.ts`
- Test: `test/unit/orchestration-scheduler.test.ts`

**Interfaces consumed:** Planner output, workspace manifest, acceptance criteria, task execution requirements, worker activity/artifacts.

**Interfaces produced:** `validateWorkset`, task `repo_id`, `acceptance_ids`, deliverables, checkpoint policy/budget, `CheckpointManager.persist/reconcile`, and deterministic task-splitting input.

- [ ] Add failing tests rejecting unknown `repoId`, write domains outside the authorized repository, uncovered material acceptance IDs, cyclic dependencies, broad `**` multi-repository tasks, and task budgets above policy.
- [ ] Add failing checkpoint tests that preserve committed and dirty work separately and replay completed/remaining deliverables after restart.
- [ ] Run `node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-scheduler.test.ts`; expect validation/checkpoint failures.
- [ ] Change the default planner from one giant task to bounded per-repository task templates. Require a deterministic decomposition pass when more than one repository or more than the configured deliverable limit is present.
- [ ] Attach checkpoint identity to broker executions and persist checkpoints after bounded deliverables/activity milestones and before deadline. Never mark checkpointed acceptance IDs passed.
- [ ] Keep Slice 1 aggregation tasks read-only; reject cross-repository mutating tasks with a typed actionable stop.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass.
- [ ] Commit with intent `Bound mission work into checkpointed repository tasks` and Lore trailers.

## Task 5: Make timeout and cancellation authoritative even for uncooperative backends

**Files:**

- Modify: `src/orchestration/broker.ts`
- Modify: `src/orchestration/scheduler.ts`
- Modify: `src/orchestration/missionStore.ts`
- Test: `test/unit/orchestration-broker.test.ts`
- Test: `test/unit/orchestration-broker-recovery.test.ts`
- Test: `test/unit/orchestration-scheduler.test.ts`

**Interfaces consumed:** Abortable backend promise, execution generation/fencing token, checkpoint manager, broker timeout policy.

**Interfaces produced:** Hard terminal timeout race, cooperative grace period, execution revocation, `execution.late_result_rejected`, and a settled outcome that cannot be overwritten by a late backend result.

- [ ] Add a failing test with a backend promise that ignores `AbortSignal` forever; `handle.result()` must settle at the deadline plus grace period and scheduler capacity must release.
- [ ] Add a failing late-success test: after timeout/takeover, resolve the old backend and assert its result is recorded as late evidence but cannot change task status, candidate refs, findings, or gate evidence.
- [ ] Add a failing checkpoint-harvest test that preserves old work while keeping it ineligible for integration until reconciliation.
- [ ] Run `node --test test/unit/orchestration-broker.test.ts test/unit/orchestration-broker-recovery.test.ts test/unit/orchestration-scheduler.test.ts`; expect timeout/fencing failures.
- [ ] Race backend completion against a broker-owned timeout promise. Abort cooperatively, wait a bounded grace period, revoke the execution identity, settle the handle, and detach/observe the late backend promise without awaiting it.
- [ ] Guard every store update and worktree handoff with `assertAuthoritative`; emit the typed late-result event on rejection.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass with no leaked timers/unhandled rejections.
- [ ] Commit with intent `Prevent late workers from owning mission state` and Lore trailers.

## Task 6: Bind gate evidence to the exact candidate and acceptance criteria

**Files:**

- Create: `src/orchestration/evidence.ts`
- Modify: `src/orchestration/completionGate.ts`
- Modify: `src/orchestration/realBackends.ts`
- Modify: `src/orchestration/orchestrator.ts`
- Modify: `src/orchestration/missionStore.ts`
- Test: `test/unit/orchestration-gate.test.ts`
- Test: `test/integration/orchestrator-e2e.test.ts`

**Interfaces consumed:** Candidate SHA/base SHA/diff, manifest hash, mission generation, repo ID, artifact hashes, validation output, reviewer output, acceptance IDs.

**Interfaces produced:** Hashed `CandidateEvidenceIdentity`, typed validation/review evidence, evidence invalidation, strict severity normalization, and acceptance-aware `CompletionGate` verdicts.

- [ ] Add failing gate tests for stale generation, wrong repo/candidate/diff, no-target validation, pending/failed acceptance criteria, unresolved `BLOCKED`/`CANCELED`/`SKIPPED` tasks, unfenced active executions, and invalid supersession lineage.
- [ ] Add failing review tests mapping `blocker|critical|high` to blocking, `medium` to major, and `low|info` to minor; malformed output, inaccessible evidence, and `request_changes` must fail the review gate.
- [ ] Run `node --test test/unit/orchestration-gate.test.ts test/integration/orchestrator-e2e.test.ts`; expect stale-evidence/acceptance failures.
- [ ] Compute evidence identity from canonical JSON and content hashes. Persist validation command/profile/exit/test summary and reviewer session/model/provider/verdict/independence mode.
- [ ] Invalidate affected evidence on manifest rebind, candidate change, integration, dependency-relevant change, repair, or generation change.
- [ ] Replace historical-success counting in `CompletionGate.gather()` with exact final-candidate matching and require every material acceptance ID to have current evidence.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass.
- [ ] Commit with intent `Require current candidate evidence for completion` and Lore trailers.

## Task 7: Integrate and verify in an isolated candidate before promotion

**Files:**

- Modify: `src/git/GitRepo.ts`
- Modify: `src/orchestration/repositoryRegistry.ts`
- Modify: `src/orchestration/broker.ts`
- Modify: `src/orchestration/realBackends.ts`
- Modify: `src/orchestration/orchestrator.ts`
- Test: `test/unit/git.test.ts`
- Test: `test/unit/orchestration-broker.test.ts`
- Test: `test/integration/orchestration-runtime.test.ts`

**Interfaces consumed:** Repository binding/base SHA, worker handoffs, repository lease/fencing token, validator/reviewer cwd, candidate evidence identity.

**Interfaces produced:** Candidate worktree/ref lifecycle, merge-in-candidate operations, candidate-scoped validation/review, atomic local promotion guarded by unchanged incumbent base, and preserved-candidate diagnostics.

- [ ] Add failing Git tests proving a conflict in the second handoff leaves incumbent HEAD/index/tree unchanged and preserves the candidate ref.
- [ ] Add failing runtime tests proving red validation, failed review, cancellation, or stale fencing never promotes the candidate.
- [ ] Add a passing-path assertion that validation and review both receive the candidate worktree cwd and candidate evidence, then promotion changes the incumbent exactly once.
- [ ] Run `node --test test/unit/git.test.ts test/unit/orchestration-broker.test.ts test/integration/orchestration-runtime.test.ts`; expect incumbent-mutation failures.
- [ ] Add `GitRepo` operations that merge refs inside a candidate worktree and promote only after verifying incumbent HEAD still equals the bound base SHA. Abort safely on divergence.
- [ ] Refactor `realBackends` to resolve Git, verifier cwd, context broker, and worker cwd from the task's `RepositoryExecutionContext`/candidate rather than construction-time runtime cwd.
- [ ] Hold the repository lease for candidate integration and promotion, and reject stale tokens immediately before every Git mutation.
- [ ] Re-run focused tests, `npm run typecheck`, and `npm run lint`; expect pass.
- [ ] Commit with intent `Gate an isolated candidate before incumbent promotion` and Lore trailers.

## Task 8: Implement typed bounded recovery and blocked-mission repair

**Files:**

- Create: `src/orchestration/recovery.ts`
- Modify: `src/orchestration/orchestrator.ts`
- Modify: `src/orchestration/scheduler.ts`
- Modify: `src/orchestration/state.ts`
- Modify: `src/orchestration/missionStore.ts`
- Test: `test/unit/orchestration-recovery-planner.test.ts`
- Test: `test/integration/orchestrator-recovery.test.ts`
- Test: `test/integration/orchestrator-resilience.test.ts`

**Interfaces consumed:** Typed failure evidence, durable recovery history/budgets, workspace resolver, checkpoints, task supersession, evidence invalidation, ownership service.

**Interfaces produced:** `FailureClassifier`, `RecoveryPlanner.decide`, stable failure fingerprints, mission-level recovery ceiling, and idempotent `Orchestrator.repairBlockedMission(missionId)`.

- [ ] Add table-driven failing tests for every specified failure category and default action, including provider permanent vs transient and workspace/evidence mismatch.
- [ ] Add failing tests that identical fingerprints consume a bounded strategy budget across restart, while materially changed evidence permits the next strategy.
- [ ] Add failing end-to-end repair tests for `BLOCKED -> REPAIRING`, checkpoint-based task splitting, explicit supersession, evidence invalidation, and exact stop details after exhaustion.
- [ ] Run `node --test test/unit/orchestration-recovery-planner.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts`; expect missing recovery APIs.
- [ ] Implement pure classification/fingerprint/decision functions first; keep dispatch outside the planner.
- [ ] Implement `repairBlockedMission` as write-ahead/idempotent steps: acquire/fence, reconcile, decide, persist plan, create replacements, invalidate evidence, transition, schedule, and re-run gates.
- [ ] Unify provider retry, task retry, repair rounds, and parent recovery under one durable mission ceiling. Restart must not reset attempts or deadlines.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass.
- [ ] Commit with intent `Repair blocked missions with bounded durable decisions` and Lore trailers.

## Task 9: Add an independent supervisor and truthful dual progress

**Files:**

- Create: `src/orchestration/supervisor.ts`
- Modify: `src/orchestration/observability/types.ts`
- Modify: `src/orchestration/observability/health.ts`
- Modify: `src/orchestration/observability/progress.ts`
- Modify: `src/orchestration/observability/MissionObservability.ts`
- Modify: `src/orchestration/missionSnapshot.ts`
- Test: `test/unit/mission-supervisor.test.ts`
- Test: `test/unit/observability-progress.test.ts`
- Test: `test/unit/observability-service.test.ts`
- Test: `test/unit/orchestration-snapshot-observability.test.ts`

**Interfaces consumed:** Mission/task/execution/lease/recovery projections, waiting deadline, meaningful progress, acceptance evidence.

**Interfaces produced:** `MissionSupervisor.tick/reconcileOnStartup`, health states `ORPHANED`, `DEADLOCKED`, `CONTROLLER_DISCONNECTED`, expired-wait recovery, `workflowProgress`, `acceptanceCoverage`, and an actionable status payload.

- [ ] Add failing supervisor tests for nonterminal zero-worker runnable work, dependency deadlock, expired controller lease, live heartbeat without progress, and named wait past deadline.
- [ ] Add failing progress tests proving completed process tasks with zero verified acceptance IDs display 0% primary coverage, while workflow progress remains separately visible.
- [ ] Add failing snapshot tests requiring action, last meaningful progress, reason, recovery `N/M`, next action/time, owner, repo, task, and preserved work when applicable.
- [ ] Run `node --test test/unit/mission-supervisor.test.ts test/unit/observability-progress.test.ts test/unit/observability-service.test.ts test/unit/orchestration-snapshot-observability.test.ts`; expect missing health/progress fields.
- [ ] Implement a clock-injected periodic supervisor independent of worker events. It must schedule a recovery decision or persist an actionable stop; it may never merely relabel an orphan and walk away.
- [ ] Preserve heartbeat as liveness only. Base primary percentage on current acceptance evidence; use workflow progress as a secondary diagnostic.
- [ ] Add startup reconciliation before new dispatch and ensure supervisor actions are idempotent under repeated ticks.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass.
- [ ] Commit with intent `Make mission ownership and next action continuously visible` and Lore trailers.

## Task 10: Wire autonomous repair/resume into Pi commands and persistent UI

**Files:**

- Modify: `src/runtime/EngineeringRuntime.ts`
- Modify: `extensions/index.ts`
- Modify: `src/orchestration/missionSnapshot.ts`
- Test: `test/integration/runtime-mission-live-snapshot.test.ts`
- Test: `test/integration/mission-observability-e2e.test.ts`
- Create: `test/integration/extension-mission-commands.test.ts`

**Interfaces consumed:** Supervisor projection, `repairBlockedMission`, detailed stop payload, existing mission progress callbacks and snapshot publisher.

**Interfaces produced:** Startup auto-reconciliation, automatic repair for supported blockers, `/mission resume <missionId>` fallback control, detailed `/mission-status`, and persistent panel/footer messages that cannot collapse to an unexplained `N%`.

- [ ] Reuse the lightweight command-registration harness pattern from `test/integration/extension-gateway-wiring.test.ts` in the new mission-command test; do not boot a second extension framework.
- [ ] Add failing tests that a recoverable blocked mission repairs automatically on runtime reopen and an unrecoverable mission clearly stops with reason, attempts, preserved work, and resume condition.
- [ ] Add failing UI tests proving `Agent failed · workers 0 active` is never the only visible explanation and a static percentage always has an owner/wait/recovery/stop detail.
- [ ] Run the focused runtime/extension/UI tests; expect missing resume and detail output.
- [ ] Start the supervisor when `EngineeringRuntime` opens, reconcile all nonterminal missions, and shut it down cleanly with the runtime.
- [ ] Parse `/mission resume <id>` before treating the argument as a new request. Keep the command idempotent and route both manual and automatic paths through `repairBlockedMission`.
- [ ] Render acceptance coverage as primary progress plus workflow progress, health, repository/task, last progress, current recovery, next action, and terminal resume condition.
- [ ] Re-run focused tests and `npm run typecheck`; expect pass.
- [ ] Commit with intent `Turn stalled mission displays into autonomous recovery` and Lore trailers.

## Task 11: Prove the local reliability slice end to end

**Files:**

- Create: `test/integration/mission-reliability-foundation.test.ts`
- Create: `scripts/dogfood-mission-recovery.ts`
- Modify: `package.json`
- Modify: `docs/specs/pi-engineering-orchestration/14-acceptance-criteria.md`
- Modify: `docs/specs/mission-observability/08-testing-and-acceptance.md`
- Modify: `README.md`

**Interfaces consumed:** Public runtime/extension surfaces only, temporary real Git repositories, fault-injected worker/verifier doubles, and installed Pi CLI for the final live check.

**Interfaces produced:** Reproducible synthetic `MSN-qSLaeM` regression, `npm run test:mission-reliability`, dogfood command, and documented operator semantics/remaining Slice 2 limits.

- [ ] Add the synthetic multi-root scenario: launch at a meta-root, explicitly name repositories elsewhere, force a timeout after a checkpoint, resolve the old worker late, repair remaining work, review with same-model warning, and either complete with current evidence or stop with a typed actionable reason.
- [ ] Add conflict, red-validation, restart, repeated-fingerprint exhaustion, zero-worker orphan, and second-mission repository lease subtests. Assert incumbent immutability on every failed path.
- [ ] Run `node --test test/integration/mission-reliability-foundation.test.ts`; expect initial failures until all prior task APIs are integrated, then pass.
- [ ] Add a dogfood script that refuses non-`local/local` model configuration, confirms metabolomics is absent/disabled, uses a temporary repository, and prints durable mission/snapshot evidence without modifying a real project.
- [ ] Run `npm run test:mission-reliability`, `npm run test:unit`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, and `npm run test:e2e`; all must pass freshly.
- [ ] Update acceptance specs and README with implemented behavior, exact status meanings, repair/resume command, preserved-work recovery, and explicit Slice 2/3 exclusions.
- [ ] Commit with intent `Prove local missions recover without silent stalls` and Lore trailers.

## Task 12: Independent review, PR, merge, reinstall, and live local-model verification

**Files:**

- Review: all files changed since `origin/main`
- Verify install target: `/home/<user>/.pi/agent/git/github.com/berlinguyinca/pi-engineering`
- Do not modify source solely to manufacture review evidence.

**Interfaces consumed:** Git branch, GitHub CLI/remote workflow already used by the repository, installed Pi extension, local model inventory.

**Interfaces produced:** Independent review report, merged PR, reinstalled extension at the printed target path, and live `local/local` recovery proof.

- [ ] Run a fresh independent code review focused on the `Review Focus` attacks above. If no distinct model exists, use the current model in a fresh session and record the reduced-independence warning; do not skip review.
- [ ] Fix all blocking/major findings with regression tests, then repeat the review against the new HEAD until blocking/major findings are zero.
- [ ] Run the full verification matrix again and record exact command summaries plus final commit SHA.
- [ ] Push `feat/mission-reliability-foundation`, open a PR with spec/test evidence and known Slice 2/3 exclusions, wait for required checks, and merge only after green review/checks.
- [ ] Reinstall the merged extension into `/home/<user>/.pi/agent/git/github.com/berlinguyinca/pi-engineering` using the repository's supported install/update path; print that path in the handoff.
- [ ] Verify the installed code matches the merged SHA, run `omx doctor` only if the extension install surface depends on OMX health, and confirm Pi lists `local/local` while listing no metabolomics model.
- [ ] Run the dogfood recovery scenario through installed Pi with `local/local`. Capture evidence that progress moves or explains why it waits, the same-model review warning appears, recovery resumes or stops explicitly, and no mission remains nonterminal with zero workers and no next action.
- [ ] If the live check fails, diagnose and fix on a follow-up branch/PR rather than declaring completion; repeat review, merge, reinstall, and live verification.
- [ ] Final handoff must include PR URL, merge SHA, install path, local-model proof, test totals, review result, and any remaining Slice 2/3 limitations.

## Plan Self-Review

- [ ] **Spec coverage:** Every Slice 1 bullet and acceptance scenarios 2–15 map to an implementation task. Scenario 1 is supported at authorization/preflight/task-binding level; coordinated multi-repository publication remains explicitly deferred to Slice 2.
- [ ] **Step specificity:** Every task names exact production/test files, expected failing test, smallest implementation seam, passing command, and commit boundary.
- [ ] **Type consistency:** Workspace, generation, fencing, repo ID, acceptance ID, and candidate evidence identities flow unchanged from store through broker/backends/gates/snapshot.
- [ ] **Safety order:** Durable state and fencing precede timeout recovery; evidence binding precedes completion; isolated candidates precede autonomous repair/promotion; supervisor/UI wiring comes after recovery semantics.
- [ ] **Reviewability:** No task mixes source implementation with PR/install operations. Commits are independently testable and follow the Lore protocol.
- [ ] **Proportion:** Slice 1 is large because it closes correctness holes across persistence, Git mutation, execution authority, recovery, completion, and observability; distributed ownership and external multi-repository publication are excluded.
