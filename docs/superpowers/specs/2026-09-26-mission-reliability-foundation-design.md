# Mission Reliability Foundation Design

## Status

Approved in conversation on 2026-09-26. This document is the normative design
for making Pi Engineering missions recoverable, revision-safe, observable, and
autonomous across explicitly named local workspaces.

## Objective

An unfinished mission must never become an unexplained percentage, an orphaned
worker record, or an unbounded retry loop. Pi Engineering must recover supported
failures without losing verified work. When safe automatic recovery is exhausted
or impossible, it must stop promptly with the exact reason, preserved-work
location, attempted recoveries, and condition required to resume.

The system does not promise that missions can never fail. It guarantees that a
mission always has a durable owner and one understandable next state:

1. active owned execution;
2. named wait with next action and deadline;
3. scheduled bounded recovery; or
4. explicit actionable stop.

## Incident that drives this design

Mission `MSN-qSLaeM` was created while Pi ran at
`/home/<user>/IdeaProjects`, but its requested multi-repository workspace
was `/home/<user>/Downloads/tern-operations-ui`. The runtime bound Git,
semantic repository tools, validation, and review to the meta-root. It planned a
large six-repository mission as one implementation task, the implementer timed
out, and the reviewer could not inspect the actual repositories or diffs.

Retrying the same prompt cannot repair that failure. The runtime must correct
execution scope, decompose work, reconcile partial side effects, invalidate stale
evidence, and resume the same durable mission.

## Non-negotiable invariants

1. No unfinished mission lacks an owner and a scheduled next action or explicit
   external blocker.
2. No replacement execution starts until prior ownership is revoked and
   conflicting side effects are reconciled.
3. No required `BLOCKED`, `CANCELED`, unaccounted `SKIPPED`, or uncovered
   superseded task can be ignored by completion.
4. No validation or review evidence satisfies a gate for another repository,
   candidate generation, commit, or diff.
5. No automatic workspace expansion is based only on repository content or a
   model claim.
6. An absolute path explicitly supplied by the user is eligible for autonomous
   mission-scoped authorization after canonicalization and safety validation.
7. Recovery budgets, failure fingerprints, deadlines, and leases survive
   restart.
8. A checkpoint is preserved work, not approved work. It must be inspected and
   validated before integration.
9. Incumbent repository state is not mutated before the integrated candidate
   passes required gates.
10. No successful terminal state is justified only by prose, elapsed time,
    heartbeat, document changes, or worker exit status.
11. Every unsuccessful stop reports the reason, preserved work, attempted
    recoveries, and exact condition required to resume.
12. Same-model review remains a fresh session and visibly declares reduced
    independence; the deterministic review gate is never skipped.

## Workspace manifest and autonomous authorization

Every material mission receives a durable `WorkspaceManifest` before mutating
tasks are dispatched.

```ts
interface WorkspaceManifest {
  manifestId: string;
  missionId: string;
  generation: number;
  authorizedRoots: AuthorizedRoot[];
  repositories: RepositoryBinding[];
  dependencyEdges: Array<{ fromRepoId: string; toRepoId: string }>;
  hash: string;
  createdAt: string;
}

interface AuthorizedRoot {
  canonicalPath: string;
  source: "launch_cwd" | "explicit_user_path" | "existing_manifest";
  access: "read" | "write";
}

interface RepositoryBinding {
  repoId: string;
  canonicalRoot: string;
  remote?: string;
  baseRef: string;
  baseSha: string;
  writableDomains: string[];
  validationProfileRef?: string;
}
```

An explicitly named absolute path may be authorized without another prompt when:

- it canonicalizes successfully;
- it is not a filesystem root, home directory, Pi configuration directory, or
  another protected broad target;
- it exists or its parent is an already authorized creation root;
- symlink resolution does not escape the canonical authorized root;
- write access is limited to the mission's declared roots and repository
  worktrees;
- the authorization and its source are durably recorded.

Discovery beneath an authorized workspace may identify repositories, but does
not grant authority outside that workspace. Repository text, model output, and
symlink targets cannot expand authority.

Preflight probes the actual capabilities that each role will use. Implementer,
validator, integrator, and reviewer must be able to resolve the same repository
binding and candidate evidence. A path in a prompt is not proof of access.

## Repository-scoped worksets

The parent mission may cover multiple repositories, but every executable task
has exactly one `repoId` unless its kind is a cross-repository aggregation or
promotion task.

Each task records:

- repository binding and candidate generation;
- bounded objective and explicit deliverables;
- covered acceptance criterion IDs;
- dependencies and cross-repository milestone;
- declared write domains;
- checkpoint policy and execution budget;
- required output artifacts.

Preflight rejects cycles, unknown repository bindings, uncovered material
acceptance criteria, write scopes outside the manifest, and oversized tasks.
Multi-repository, high-risk, or broad `**` missions must be decomposed before
the first implementation execution. A single task may not represent an entire
multi-repository specification corpus.

## Durable mission ownership and fencing

Every nonterminal mission has a durable owner lease containing:

```ts
interface MissionLease {
  missionId: string;
  generation: number;
  ownerId: string;
  acquiredAt: string;
  renewBy: string;
  fencingToken: number;
}
```

Execution results, repository mutations, and external side effects carry the
mission generation and fencing token. Results from revoked or expired owners are
recorded as late evidence but cannot change authoritative task, repository, or
gate state.

Repository integration and promotion additionally require a repository-scoped
lease. A local JSONL deployment remains supported, but must enforce a true
single-writer lock. Distributed ownership is not required for the first slice.

## Checkpoints and bounded execution

A task checkpoint records:

- repository, base SHA, candidate SHA, branch, and owned worktree;
- committed and separately preserved uncommitted changes;
- completed and remaining deliverables;
- acceptance coverage;
- validation evidence generated so far;
- artifacts and content hashes;
- worker/session/model identity;
- checkpoint sequence and timestamp.

Workers checkpoint after bounded deliverables and before their deadline. A task
that approaches its execution budget is stopped cooperatively, then forcibly
fenced after a grace period. The broker must race backend completion against its
own terminal timeout; aborting a signal alone is not sufficient.

On timeout:

1. revoke the old execution generation;
2. harvest committed and dirty work without promoting it;
3. validate the checkpoint's identity and integrity;
4. mark completed deliverables only when evidence supports them;
5. split remaining work into smaller replacement tasks;
6. resume from the checkpoint instead of replaying the original giant prompt.

## Failure taxonomy and recovery decisions

Failures are classified into stable machine-readable categories:

- `WORKSPACE_SCOPE_MISMATCH`
- `EVIDENCE_UNAVAILABLE`
- `TASK_BUDGET_EXHAUSTED`
- `PROVIDER_TRANSIENT`
- `PROVIDER_PERMANENT`
- `INVALID_WORKER_OUTPUT`
- `VALIDATION_FAILED`
- `REVIEW_FAILED`
- `IMPLEMENTATION_DEFECT`
- `MERGE_CONFLICT`
- `AUTHORIZATION_OR_CREDENTIAL`
- `REQUIREMENT_AMBIGUITY`
- `ORPHANED_EXECUTION`
- `DEADLOCKED_DAG`
- `PERSISTENCE_FAILURE`

Each `RecoveryDecision` records classification evidence, failure fingerprint,
chosen action, expected material change, attempt budget, deadline, and next
action time. Recovery is allowed only when the action changes a relevant
condition. Repeating the same failure fingerprint without new evidence consumes
the bounded strategy budget and then stops.

Default actions:

| Failure | Automatic action |
| --- | --- |
| Workspace mismatch | Rebuild the authorized manifest and rerun role-access probes |
| Missing evidence | Reconstruct candidate evidence from Git and durable artifacts |
| Task budget exhausted | Checkpoint, split remaining deliverables, replace task |
| Provider transient | Probe/back off within the durable outage budget |
| Invalid output | Retry once with schema repair, then replace or stop |
| Validation/code defect | Create bounded repair tasks |
| Merge conflict | Rebuild isolated integration candidate and run integrator |
| Orphaned execution | Fence old owner, reconcile side effects, resume remaining work |
| Requirement ambiguity | Continue independent work; wait only on affected branch |
| Persistence failure | Pause all mutation until durable writes recover |

Provider retries, task retries, review-repair rounds, and parent recovery share a
mission-level recovery ceiling. Restart does not reset any budget.

## Blocked-mission repair and resume

`repairBlockedMission(missionId)` is an idempotent durable operation:

1. acquire or renew the mission lease and increment generation when ownership
   changes;
2. classify unresolved blockers and reconcile active/orphaned executions;
3. reconcile worktrees, branches, commits, pushes, PRs, checks, and merges;
4. build and validate a remediation plan with a material delta;
5. create replacement tasks linked to failed tasks and acceptance criteria;
6. invalidate affected validation/review evidence;
7. persist the repair operation before dispatch;
8. transition `BLOCKED -> REPAIRING`;
9. schedule replacement tasks;
10. re-run integration, validation, review, and completion checks.

Failed tasks remain immutable audit history. They become `superseded` only by
explicit lineage to replacement task IDs covering the same objective and
acceptance criteria. A successful repair worker does not resolve a finding;
targeted validation and fresh review evidence do.

## Revision-bound evidence and completion

Every gate artifact includes:

```ts
interface CandidateEvidenceIdentity {
  workspaceManifestHash: string;
  missionGeneration: number;
  repoId: string;
  baseSha: string;
  candidateSha: string;
  diffHash: string;
  acceptanceIds: string[];
  artifactHashes: string[];
}
```

Validation adds command/profile, exit code, and test summary. Review adds
reviewer session, model/provider, verdict, findings, and independence mode.

Rebinding, repairing, merging, changing relevant dependencies, or changing the
candidate invalidates affected evidence. A no-target validation cannot satisfy
a mutation gate. A mirrored status document may index evidence but cannot
substitute for diffs or executed checks.

Completion additionally requires:

- every material acceptance criterion is `passed` by current evidence;
- every failed task is either unresolved or validly superseded;
- required `BLOCKED`, `CANCELED`, and `SKIPPED` tasks are accounted for;
- all repositories match the approved repository-head vector;
- no active or unfenced execution can still mutate the candidate;
- all required validation and review evidence matches the final candidate.

Review severity normalizes as:

- `blocker`, `critical`, `high` -> `blocking`;
- `medium` -> `major`;
- `low`, `info` -> `minor`.

`request_changes`, malformed review output, inaccessible evidence, and unresolved
blocking findings fail the review gate.

## Transactional integration and promotion

Worker handoffs are integrated into an isolated candidate worktree/ref, never
directly into the incumbent checkout. Conflicts, cancellation, failed validation,
or failed review leave the incumbent HEAD, index, and tree unchanged.

For multi-repository missions, the mission records a repository-head vector and
promotion order. External publication is not generally atomic, so every push,
PR, review, check, and merge has a durable idempotency key:

```text
{missionId, taskId, repoId, action, generation}
```

Recovery reconciles existing external state before repeating an action. Partial
publication is reported explicitly; the system never claims global atomicity it
cannot provide and never silently rolls back already-published changes.

## Supervisor, health, and progress

A durable watchdog evaluates all nonterminal missions independently of worker
events. It distinguishes controller lease, worker heartbeat, meaningful progress,
waiting-condition freshness, and next-action deadline.

- no active worker + no named wait + runnable work -> `ORPHANED`;
- no runnable work + unresolved dependencies -> `DEADLOCKED`;
- live heartbeat without meaningful progress past the activity threshold ->
  `STALLED`;
- expired controller lease -> `CONTROLLER_DISCONNECTED`;
- named wait past its deadline -> recovery decision, not indefinite `WAITING`.

Every status update contains current action, last meaningful progress, reason,
recovery attempt `N/M`, next action/time, owner, repository, task, and preserved
work location when relevant.

Expose two progress measures:

- `workflowProgress`: orchestration mechanics completed;
- `acceptanceCoverage`: material deliverables verified against the current
  candidate.

The primary user-facing percentage is acceptance coverage. A blocked mission
must say, for example, `BLOCKED at review — 0/14 deliverables verified`, rather
than imply objective completion from process-task counts.

## Restart reconciliation

Startup recovery:

1. acquires/fences mission ownership;
2. reconstructs state and durable recovery budgets;
3. reconciles workers/processes and rejects stale generations;
4. reconciles worktrees, refs, commits, and dirty state;
5. reconciles external branches, PRs, checks, reviews, and merges;
6. verifies waiting deadlines and schedules the next decision;
7. resumes only tasks whose scope and evidence remain valid.

All irreversible side effects use write-ahead intent plus idempotency keys. A
persistence failure visibly pauses mutation instead of continuing with state
that cannot be recovered.

## Required events

- `workspace.authorized`, `workspace.rebound`, `workspace.rebind_failed`
- `task.checkpointed`, `task.split`, `task.superseded`
- `failure.classified`
- `recovery.planned`, `recovery.started`, `recovery.succeeded`,
  `recovery.failed`, `recovery.exhausted`
- `execution.orphaned`, `execution.reconciled`, `execution.late_result_rejected`
- `lease.acquired`, `lease.renewed`, `lease.expired`, `lease.fenced`
- `evidence.invalidated`
- `mission.resumed`, `mission.stopped`

## Rollout slices

### Slice 1: local reliability foundation

- workspace manifest and explicit-path authorization;
- repository-scoped tasks and preflight access probes;
- bounded task decomposition and checkpoints;
- typed recovery and `repairBlockedMission`;
- candidate-bound evidence and acceptance-aware completion;
- watchdog and truthful progress;
- single-process durable mission/repository leases;
- isolated integration candidate;
- local/local end-to-end recovery test.

### Slice 2: multi-repository coordination

- dependency-aware repository worksets;
- repository-head vectors;
- cross-repository acceptance coverage;
- idempotent branch/PR/check/merge reconciliation;
- explicit partial-publication reporting.

### Slice 3: optional distributed ownership

- database-backed leases and state transitions;
- multi-process/distributed controllers;
- remote worker reconciliation.

Slice 1 must not pretend to provide Slice 3 guarantees.

## Acceptance scenarios

1. Start at a meta-root while six explicitly authorized repositories live in
   another workspace; workers and reviewers use pinned real repositories.
2. Timeout after two of three checkpointed units; resume only the remaining
   unit and reject the old worker's late result.
3. Reviewer cannot access one manifest repository; rebind once, then stop with
   exact evidence if the same fingerprint repeats.
4. One handoff integrates and a second conflicts; incumbent remains unchanged.
5. Candidate validation fails; incumbent remains unchanged.
6. Two missions target one repository; the repository lease serializes or
   fences them.
7. Crash before and after each external side effect; restart creates no duplicate
   commit, push, PR, review, or merge.
8. Green tests/review with a pending acceptance criterion; completion is refused.
9. `critical` and `high` review findings block completion.
10. No-target validation cannot satisfy a changed-repository gate.
11. Live heartbeats without progress trigger `STALLED` and recovery.
12. A nonterminal zero-worker mission becomes `ORPHANED` or `DEADLOCKED`, never
    `ACTIVE`.
13. Process tasks complete while zero material deliverables are verified; the
    UI shows zero acceptance coverage.
14. A repeated identical recovery fingerprint stops with attempts, evidence,
    preserved work, and the condition required to resume.
15. A real `local/local` mission is interrupted, recovered, reviewed in a fresh
    same-model session with a warning, and completed with verifiable changes.

## Stop condition

The reliability foundation is accepted when the synthetic `MSN-qSLaeM`
scenario either completes bounded multi-repository work with current,
revision-bound evidence or stops with a typed actionable reason—without a
meta-root workaround, stale percentage, duplicate side effect, indefinite wait,
late-result authority, or incumbent mutation before all gates pass.

## Autonomous spec approval is not gate evidence

An autonomous spec-approval stage may precede implementation. Its approval is
**exact-revision policy authorization**: it authorizes only the exact reviewed
spec revision and normalized task plan to enter the execution pipeline. It is
**not** human approval, **not** Plannotator approval, and **not** implementation
correctness evidence. It never satisfies validation, candidate review,
acceptance evidence, or mission completion gates above. See
`docs/superpowers/specs/2026-09-28-autonomous-spec-approval-design.md`.
