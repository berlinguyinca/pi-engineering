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

## Fix Round 2

### Outcome

- Removed the lexical compatibility manifest. Every executable legacy workflow now resolves its repository through `WorkspaceManifestResolver`'s shared realpath, protected-root, existence, symlink, and Git checks before planning. Only a truly non-executable conversation omits repository authority.
- Cancellation now serializes dirty-work preservation with checkpoint writes, commits dirty contents onto the checkpoint-identified retained branch, flushes the checkpoint, and only then removes the worktree. The regression reconstructs and reads the canceled file from `candidateSha` after cleanup.
- If cancellation preservation or durable checkpoint persistence fails, cancellation still settles, but the dirty worktree remains in place as the recoverable sole copy; a pre-commit failure regression reads the retained file directly.
- Checkpoint lead time is now finite, strictly positive, and less than the execution budget in both workset validation and direct broker dispatch.
- Write domains are canonicalized to POSIX separators by one shared function. The validated workset persists canonical values, while scheduler overlap and broker path enforcement consume the same canonicalizer. Windows/POSIX-equivalent domains cannot dispatch concurrently.
- The ownership renewal regression now waits for an observed renewal with a five-second lease margin instead of depending on a 30 ms real-time lease and a fixed sleep. Production lease expiry behavior is unchanged.

Checkpointing remains non-approving, and autonomous resume remains inactive.

### RED evidence

Initial round-2 focused run:

```text
node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-e2e.test.ts
```

Result: exit 1; six regressions failed for the intended reasons: protected legacy investigation completed, zero lead was accepted by workset and broker, cancellation's checkpoint SHA lacked the dirty file, Windows/POSIX domains overlapped concurrently, and the validated workset retained backslashes.

The first expanded run then exposed that direct-checkout restriction was being inferred from the task's narrower requested domain instead of the manifest's authorized repository domain. That run was interrupted after the affected cancellation tests waited on work that correctly never dispatched. The broker check was corrected to derive restriction from the canonical repository binding and fail closed when a registry-era binding is missing.

### GREEN evidence

Focused workset/checkpoint/broker/scheduler/orchestrator/ownership matrix:

```text
node --test test/unit/orchestration-workset.test.ts test/unit/orchestration-checkpoints.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-scheduler.test.ts test/unit/mission-ownership.test.ts test/integration/orchestrator-e2e.test.ts test/integration/orchestrator-long-outage.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts
```

Result: exit 0; 121 passed, 0 failed.

Static verification:

```text
npm run typecheck
npm run lint
git diff --check
```

Result: all exit 0; TypeScript emitted no diagnostics, Biome checked 582 files with no findings, and the diff has no whitespace errors.

Full suite:

```text
npm test
```

Result: exit 0; 2,352 total, 2,351 passed, 0 failed, 1 skipped. The sole skip is the existing Postgres OpenViking test gated by `TEST_DATABASE_URL`. The previously flaky mission-ownership renewal test passed under full-suite load.

### Files

- `src/orchestration/workspaceManifest.ts`, `src/orchestration/orchestrator.ts` — shared canonical legacy repository resolution and removal of lexical compatibility authority.
- `src/orchestration/broker.ts` — canonical domains, positive lead validation, content-preserving cancellation checkpoints, and retain-on-preservation-failure behavior.
- `src/orchestration/workset.ts`, `src/orchestration/scheduler.ts` — persisted domain canonicalization and identical scheduler conflict semantics.
- `test/integration/orchestrator-e2e.test.ts` — executable legacy protected-root rejection and non-executable conversation compatibility.
- `test/unit/orchestration-broker.test.ts` — zero lead, post-cleanup content reconstruction, and preservation-failure retention regressions.
- `test/unit/orchestration-workset.test.ts`, `test/unit/orchestration-scheduler.test.ts` — canonicalization and Windows/POSIX conflict regressions.
- `test/unit/mission-ownership.test.ts` — renewal-synchronized, full-suite-stable lease test.

### Self-review and concerns

- Cancellation preservation uses an ordinary Git commit whose message contains both checkpoint and execution identity. The checkpoint's `candidateSha` and retained branch identify the durable content; no automatic restore path was introduced.
- A preservation failure intentionally leaves the worktree allocated/on disk. This is a safety tradeoff: operator cleanup is preferable to deleting the only dirty copy.
- Legacy executable workflows now use the repository's resolved HEAD as their manifest base. Registry-backed workflows retain explicit base-ref ownership validation.
- Git path-enumeration fail-open behavior and authority-loss `RUNNING` reconciliation remain deferred exactly as previously ruled.

## Fix Round 3

### Outcome

- Cancellation now repeats status/commit collection after successful hooks, then verifies the final candidate SHA contains every observed preserved path and has no remaining dirty state before durable checkpoint persistence or cleanup.
- A failed immutable snapshot records the exact retained worktree path at mission scope. Direct execution cleanup, mission cleanup, and integration cleanup all leave that sole content-bearing copy mounted.
- Planner and manifest write domains are canonicalized through the same validator before intersection; canonical POSIX domains are returned for persistence and downstream enforcement.
- Shared overlap semantics now treat bare `**` as repository-wide, so scheduler dispatch cannot run it concurrently with any same-repository mutation.

Checkpointing remains preserve-only and non-approving. No automatic checkpoint resume path was added.

### RED evidence

```text
node --test --test-name-pattern='checkpoints dirty work|retains the dirty worktree|bare \\*\\*' test/unit/orchestration-broker.test.ts test/unit/orchestration-scheduler.test.ts
```

Result: exit 1; 0 passed, 3 failed. The checkpoint SHA omitted a hook-created file, `cleanupMission` deleted the retained worktree, and bare `**` did not serialize with `src/api/**`.

The first expanded focused run also exposed a legacy traversal validation error escaping orchestration rather than entering its fail-closed workset result. The canonical intersection call is now inside the existing `WorksetValidationError` boundary.

### GREEN evidence

Focused broker/workset/checkpoint/scheduler/orchestrator matrix:

```text
node --test test/unit/orchestration-broker.test.ts test/unit/orchestration-broker-recovery.test.ts test/unit/orchestration-workset.test.ts test/unit/orchestration-checkpoints.test.ts test/unit/orchestration-scheduler.test.ts test/unit/orchestration-scheduler-resilience.test.ts test/integration/orchestrator-e2e.test.ts test/integration/orchestrator-long-outage.test.ts test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts
```

Result: exit 0; 128 passed, 0 failed.

Static verification:

```text
npm run typecheck
npm run lint
git diff --check
```

Result: all exit 0; TypeScript emitted no diagnostics, Biome checked 582 files with no findings, and the diff has no whitespace errors.

Full suite (serialized to avoid unrelated browser resource contention, with an empty agent config so the optional live vision reviewer takes its documented unavailable path):

```text
PI_CODING_AGENT_DIR=/tmp/pi-eng-task4-empty-agent node --test --test-concurrency=1 "test/unit/**/*.test.ts" "test/integration/**/*.test.ts"
```

Result: exit 0; 2,354 total, 2,353 passed, 0 failed, 1 skipped. The sole skip is the existing Postgres OpenViking test gated by `TEST_DATABASE_URL`.

### Files

- `src/orchestration/broker.ts` — post-hook immutable snapshot loop, pre-persist content verification, and mission-scoped retained-worktree ownership honored by all cleanup paths.
- `src/orchestration/orchestrator.ts` — canonical planner/manifest intersection returned through the existing fail-closed workset path.
- `src/orchestration/scheduler.ts` — bare `**` repository-wide overlap semantics.
- `test/unit/orchestration-broker.test.ts` — actual hook-created content recovery and post-`cleanupMission` retained-content regressions.
- `test/unit/orchestration-scheduler.test.ts` — bare `**` serialization regression.
- `test/integration/orchestrator-e2e.test.ts` — mixed Windows/POSIX intersection canonicalization regression.

### Self-review and concerns

- Retained dirty worktrees are intentionally not reclaimed by ordinary mission cleanup because they remain the only proven content-bearing copy. Operator-directed recovery/cleanup belongs with the later recovery work; no automatic resume was introduced here.
- Final snapshot verification happens before persistence, so a race that leaves new dirt cannot publish a falsely durable checkpoint; it retains the worktree instead.
- Git path-enumeration fail-open behavior and authority-loss `RUNNING` reconciliation remain deferred exactly as ruled.

## Fix Round 4

### Outcome

- Cancellation now aborts the backend before checkpoint collection and waits up to five seconds for the active backend dispatch to settle. Only an acknowledged, quiescent writer can proceed to the final immutable snapshot.
- A backend that ignores cancellation fails closed after the bounded acknowledgment wait: no cancellation checkpoint is published, the execution is canceled, and the content-bearing worktree remains mounted through ordinary mission cleanup.
- Final snapshot collection verifies a stable `HEAD` across `HEAD -> status -> HEAD`. A concurrent tip change rejects persistence and retains the worktree instead of publishing the stale SHA or removing recoverable content.
- An abort-aware writer may finish a late commit before acknowledging cancellation; the checkpoint then identifies that final commit rather than the pre-abort tip.

Task 5's hard terminal fencing remains out of scope; this round adds only the bounded acknowledgment and retained-work fail-closed behavior requested for Task 4.

### RED evidence

```text
node --test --test-name-pattern='abort-aware writer|writer ignores cancellation' test/unit/orchestration-broker.test.ts
```

Result: exit 1; 0 passed, 2 failed. The late writer raced the broker's preservation commit, and the signal-ignoring writer allowed cancellation to return without error, proving checkpoint collection began before writer quiescence.

The first SHA-stability regression run also failed with “Missing expected rejection,” proving the existing single-HEAD snapshot could publish through a concurrent tip change.

### GREEN evidence

Focused broker/checkpoint/scheduler matrix:

```text
node --test test/unit/orchestration-broker.test.ts test/unit/orchestration-checkpoints.test.ts test/unit/orchestration-scheduler.test.ts
```

Result: exit 0; 59 passed, 0 failed.

Static verification:

```text
npm run typecheck
npm run lint
git diff --check
```

Result: all exit 0; TypeScript emitted no diagnostics, Biome checked 582 files with no findings, and the diff has no whitespace errors.

Full suite (serialized to avoid unrelated browser resource contention, with an empty agent config so the optional live vision reviewer takes its documented unavailable path):

```text
PI_CODING_AGENT_DIR=/tmp/pi-eng-task4-empty-agent node --test --test-concurrency=1 "test/unit/**/*.test.ts" "test/integration/**/*.test.ts"
```

Result: exit 0; 2,357 total, 2,356 passed, 0 failed, 1 skipped. The sole skip is the existing Postgres OpenViking test gated by `TEST_DATABASE_URL`.

An initial parallel `npm test` run had three load-only failures: one Playwright screenshot resource failure and two acknowledgment timeouts at the original one-second/25-millisecond bounds. The production bound was raised to a still-bounded five seconds, the 25-millisecond bound was confined to the intentionally uncooperative regression, and the serialized full suite passed.

### Files

- `src/orchestration/broker.ts` — abort-before-snapshot ordering, bounded backend-settlement acknowledgment, stable double-HEAD snapshot validation, and retained-work fail-closed handling.
- `test/unit/orchestration-broker.test.ts` — deterministic abort-aware late commit, concurrent HEAD movement, and signal-ignoring writer regressions.

### Self-review and concerns

- The five-second acknowledgment wait is deliberately bounded. A writer that outlives it can continue until Task 5 adds hard terminal fencing, but it cannot cause a cancellation checkpoint to be published or its worktree to be automatically removed.
- Stable HEAD validation detects committed tip movement during collection; the existing clean-status requirement independently detects uncommitted dirt. Either failure retains the worktree.
- Checkpoint persistence remains preserve-only and never marks acceptance or gates passed. No autonomous resume path was added.
