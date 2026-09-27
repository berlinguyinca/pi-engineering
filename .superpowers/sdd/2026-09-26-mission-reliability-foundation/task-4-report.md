# Task 4 Report: Bounded repository-scoped worksets and checkpoints

## Outcome

Implemented bounded, repository-scoped workset validation and durable checkpoint persistence/reconciliation.

- Every executable task is normalized with a stable task ID, one repository binding (except read-only aggregation), acceptance coverage, explicit deliverables, a wall-clock budget, checkpoint cadence, and required artifact classes.
- Worksets fail before dispatch on unknown repositories/dependencies/acceptance IDs, escaped write domains, cycles, uncovered acceptance, broad `**` mutation in multi-repository missions, oversized budgets, mutating aggregation, and any Slice 1 mutation spanning repositories.
- Oversized deliverable lists are split deterministically into dependency-ordered chunks. Multi-repository planner output is expanded into deterministic repository templates, then Slice 1 cross-repository mutation/publication is rejected with an actionable typed stop.
- Executions carry a `checkpoint_id`. Checkpoints persist at meaningful-activity milestones, before the hard execution deadline, and after successful bounded deliverables.
- Checkpoints preserve committed paths and dirty paths separately, carry workspace/task lineage (`repoId`, base/candidate SHA, mission generation, candidate generation, fencing token), retain artifact references, and replay completed/remaining deliverables after store restart.
- Checkpoint persistence never changes acceptance status and exposes reconciliation only; autonomous checkpoint resume remains inactive for Tasks 5/8.

## RED evidence

Initial focused command:

```text
node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-scheduler.test.ts
```

Result: exit 1. Both files failed because `src/orchestration/checkpoints.ts` did not exist, proving the new checkpoint/workset surface was absent.

After the first implementation pass, the focused command reached the new tests but exposed a strip-only TypeScript incompatibility in `WorksetValidationError`; that was corrected before GREEN.

An additional Slice 1 boundary test was then added:

```text
node --test test/unit/orchestration-workset.test.ts
```

Result: exit 1, 9 passed / 1 failed. `rejects a mutating workset that would publish across repositories in Slice 1` reported “Missing expected exception,” proving repository-scoped tasks alone did not yet prevent cross-repository publication.

## GREEN evidence

Final focused verification:

```text
node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-scheduler.test.ts
```

Result: exit 0; 29 tests passed, 0 failed.

Expanded impacted verification before the full suite:

```text
node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-scheduler.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-missionstore.test.ts
```

Result: exit 0; 66 tests passed, 0 failed.

Static verification:

```text
npm run typecheck
npm run lint
git diff --check
```

Result: all exit 0. TypeScript emitted no diagnostics; Biome checked 581 files with no findings; the diff has no whitespace errors.

Full suite (run once as requested):

```text
npm test
```

Result: exit 0; 2,332 tests total, 2,331 passed, 0 failed, 1 skipped. The only skip is the existing Postgres OpenViking test gated by `TEST_DATABASE_URL`.

## Files

- `src/orchestration/workset.ts` — typed actionable workset validation, policy, deterministic decomposition input, and deliverable splitting.
- `src/orchestration/checkpoints.ts` — checkpoint persistence and restart reconciliation without acceptance/gate mutation.
- `src/orchestration/types.ts` — additive task budget/deliverable/checkpoint contracts plus execution/checkpoint lineage.
- `src/orchestration/missionStore.ts` — persists/copies the additive task and execution fields.
- `src/orchestration/orchestrator.ts` — normalizes, decomposes, validates, blocks unsafe worksets, and applies bounded metadata to repair/integration/validation/review tasks.
- `src/orchestration/scheduler.ts` — propagates bounded task/checkpoint policy into broker execution.
- `src/orchestration/broker.ts` — attaches checkpoint identity and serializes milestone/pre-deadline/final checkpoint persistence.
- `src/orchestration/index.ts` — exports the new public contracts.
- `src/runtime/EngineeringRuntime.ts` — replaces the unbounded default task shape with explicit bounded deliverables, budget, checkpoint cadence, and artifact classes.
- `test/unit/orchestration-workset.test.ts` — validation, decomposition, checkpoint separation, and restart replay coverage.
- `test/unit/orchestration-scheduler.test.ts` — execution checkpoint lineage and “checkpoint is not acceptance” coverage.
- `test/unit/orchestration-missionstore.test.ts` — checkpoint generation/fencing replay fixture.

## Self-review and concerns

- Checkpoint writes for one execution are serialized, preventing a slower activity checkpoint from overwriting the final completed-deliverable checkpoint.
- Workset validation happens before task creation/dispatch for manifest-bound missions. Legacy standalone orchestration without a workspace manifest retains its existing behavior.
- Slice 1 deliberately stops mutating worksets that span repositories; read-only aggregation remains allowed. No cross-repository integration or publication path was added.
- Git path-enumeration failures retain the pre-existing fail-open behavior called out for final-review triage; this task did not expand into that deferred issue.
- Authority-loss reconciliation of already-`RUNNING` work remains deferred to Tasks 8/9.
- `CheckpointManager.reconcile()` is read-only and creates no replacement/resume work, preserving the explicit deferral of autonomous recovery.

## Fix Round 1

### Outcome

Addressed all nine review findings against `3d0169d`:

- Write domains are parsed as repository-relative path segments; absolute, empty/dot, and traversal components fail before authorization comparison.
- Material legacy calls receive a documented, single-repository compatibility manifest and pass through the same workset validator. Pure passive conversation remains manifest-free and non-executable.
- Missing planner `acceptance_ids` remain missing and block uncovered material acceptance; only explicit planner mappings and deterministic split inheritance are retained.
- Original task IDs must be unique. Deliverable splitting uses collision-proof deterministic child IDs and an exact original-to-final-child map for dependency rewriting.
- Checkpoint persistence awaits `MissionStore.flush()` and rejects when the backend cannot durably append the event.
- Cancellation disables checkpoint scheduling synchronously, persists the latest dirty/committed work before worktree removal, and preserves the last useful snapshot when later collection is empty/unavailable.
- Execution budgets and checkpoint cadence are finite and positive, checkpoint lead time is smaller than budget, and both timers derive from one absolute execution deadline.
- Required artifact identities are propagated through scheduler/orchestrator dispatch; successful backend exit is downgraded when required artifacts are absent, and checkpoint artifact hashes are retained.
- Checkpoint identity comes from the originating execution. Repository, base, execution assignment, mission/candidate generations, and fencing token are checked before and after snapshot collection so rebind/takeover races reject atomically before append.
- Checkpoints still do not pass acceptance or gates, and no autonomous resume path was added.

The repository binding correction also restored safe same-repository parallelism for disjoint write domains; overlapping domains remain serialized.

### RED evidence

- `node --test test/unit/orchestration-workset.test.ts` initially failed on missing collision-safe split support and invalid path/budget/cadence behavior.
- `node --test test/unit/orchestration-checkpoints.test.ts` initially failed all new durability/origin/preservation cases. The later race-only run failed 2/2 because manifest rebind and authority takeover during snapshot collection were not rechecked.
- Focused broker tests initially failed required-artifact and cancellation dirty-work expectations.
- Focused orchestrator tests initially failed because material legacy work had no compatibility manifest and missing planner acceptance mapping was still implicitly completed.

### GREEN evidence

Focused workset/checkpoint/broker/scheduler/orchestrator matrix:

```text
node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-checkpoints.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-e2e.test.ts test/integration/orchestrator-long-outage.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts
```

Result: exit 0; 105 passed, 0 failed.

Static verification:

```text
npm run typecheck
npm run lint
git diff --check
```

Result: all exit 0; TypeScript emitted no diagnostics, Biome checked 582 files with no findings, and the diff has no whitespace errors.

Full suite (single requested run):

```text
npm test
```

Result: exit 1; 2,347 total, 2,345 passed, 1 failed, 1 skipped. The only failure was the existing timing-sensitive `mission-ownership` lease-renewal test under parallel full-suite load (`mission M-1 lease expired`). Its exact isolated rerun passed: 1 passed, 0 failed. The existing Postgres OpenViking test remained skipped because `TEST_DATABASE_URL` is unset.

### Files

- `src/orchestration/workset.ts`, `src/orchestration/orchestrator.ts`, `src/orchestration/workspaceManifest.ts` — canonical path validation, compatibility authority, explicit acceptance coverage, and collision-safe exact decomposition.
- `src/orchestration/checkpoints.ts`, `src/orchestration/missionStore.ts`, `src/orchestration/types.ts` — durable checkpoint flush and immutable execution-origin identity/race fencing.
- `src/orchestration/broker.ts`, `src/orchestration/scheduler.ts` — absolute deadlines, required-artifact enforcement, synchronous cancellation checkpointing, and safe disjoint-domain concurrency.
- `src/runtime/EngineeringRuntime.ts` — explicit default acceptance mapping without fabricated artifact requirements.
- `test/unit/orchestration-workset.test.ts`, `test/unit/orchestration-checkpoints.test.ts`, `test/unit/orchestration-broker.test.ts`, `test/unit/orchestration-scheduler.test.ts`, `test/unit/orchestration-missionstore.test.ts` — focused unit regressions.
- `test/integration/orchestrator-e2e.test.ts`, `test/integration/orchestrator-long-outage.test.ts`, `test/integration/orchestrator-recovery.test.ts`, `test/integration/orchestrator-resilience.test.ts` — explicit planner mappings plus legacy/passive compatibility and cancellation coverage.

### Self-review and concerns

- The full suite has one unrelated, isolated-green lease timing failure as recorded above; no ownership implementation was changed in this round.
- Git path-enumeration fail-open behavior and authority-loss `RUNNING` reconciliation remain deliberately deferred per the task ruling.
- Artifact identity enforcement uses the stable `artifact://<identity>/<id-or-hash>` contract. Hashes retained by checkpoints are SHA-256 fingerprints of the returned artifact references; content verification remains the artifact store's responsibility.
- Compatibility manifests intentionally authorize only the caller-provided canonical repository root and base, with a broad single-repository domain. They do not authorize multi-repository mutation or create authority for passive conversations.
