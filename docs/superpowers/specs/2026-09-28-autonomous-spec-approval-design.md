# Autonomous Spec Approval Design

## Intent

Pi Engineering should turn an ordinary in-scope engineering request into a reviewed, testable, approved execution contract without waiting for human spec approval. The system must generate a durable specification, critique and refine it for bounded rounds, approve only the exact reviewed revision and normalized task plan, then execute the existing mission pipeline.

Autonomy must not weaken authority. Generated text cannot add repositories, writable paths, credentials, destructive operations, or external production side effects. When requirements conflict, refinement is exhausted, persistence fails, or necessary authority is absent, the mission must recover within its budget or stop with a durable reason and exact resume condition. It must never sit at an unexplained percentage.

## Success Criteria

1. Every material mission persists a structured spec revision before implementation tasks exist.
2. A fresh-context reviewer evaluates the exact spec and normalized plan. With only one available model, review continues in a new session and records a visible `same_model_reduced` warning.
3. Rejected reviews create bounded, requirement-preserving revisions. The default maximum is two semantic refinement rounds.
4. Policy approval binds the spec hash, normalized plan hash, acceptance ID/text hash, workspace manifest identity, base commit, and policy version.
5. No implementation task becomes runnable without a current approval. Changed bound inputs fence authority and invalidate approval atomically before further dispatch.
6. Restart resumes from the last durable spec boundary without resetting deadlines or budgets, duplicating tasks, or accepting stale worker output.
7. Spec approval authorizes execution only. It never satisfies implementation validation, candidate review, acceptance evidence, or mission completion.
8. Spec phase, round, warning, active work, last meaningful progress, deadline, next action, and stop reason remain observable.

## Scope

### Included

- Material mutation workflows using the existing mission and workspace authority model.
- A mission-local durable `draft → review → refine → approve → materialize` controller.
- Structured author/refiner and reviewer outputs with strict validation.
- Exact revision and normalized plan binding.
- Bounded model, persistence, ownership, timeout, and restart recovery.
- Same-model reduced-independence fallback.
- Idempotent approved-task materialization.
- Snapshot, event, documentation, and deterministic dogfood coverage.

### Excluded

- Expanding workspace or credential authority from model output.
- Automatically authorizing destructive, credential-gated, production, or externally irreversible actions.
- Cross-repository promotion or publication coordination beyond existing workspace behavior.
- Replacing the external Plannotator service or treating its autonomous bypass as reviewed approval.
- Reusing post-implementation candidate review evidence for spec approval.
- Unlimited optimization or weakening criteria to obtain approval.
- PR, merge, release, or deployment automation inside the mission runtime.

## Considered Approaches

### 1. Decorate `orchestrationPlanner`

Generate and review a spec inside the current planner callback.

This is initially small, but it has no durable in-progress state, exact approval identity, restart continuation, or supervisor-safe liveness. A taskless mission waiting inside `PLANNING` can be diagnosed as orphaned. This approach is rejected as the production contract.

### 2. Model spec work as ordinary scheduler tasks

Represent draft, review, and refinement as task DAG nodes.

This reuses task execution and retry behavior, but current review execution is candidate-specific and approval tasks fall through to generic agent execution. Dynamic DAG expansion, pre-execution authority, and approval publication would become more complex than the first vertical slice requires. This remains a possible later consolidation.

### 3. Durable mission-local spec controller

Add a dedicated controller before implementation task creation, backed by append-only mission events and existing ownership/recovery infrastructure.

This makes the approval boundary explicit, preserves the existing execution pipeline, supports exact replay and idempotent task materialization, and can expose honest spec-stage progress. It requires dedicated durable records and supervisor awareness, but those are necessary product guarantees. This is the selected approach.

## Architecture

Material mission flow becomes:

```text
classify
  → resolve and authorize workspace
  → derive protected user criteria
  → draft structured spec and proposed tasks
  → normalize/split/scope/validate task plan
  → review exact spec + exact normalized plan
  → refine within bounded budget when requested
  → evaluate deterministic approval policy
  → persist exact approval
  → materialize approved tasks idempotently
  → existing implementation/integration/validation/review pipeline
```

Conversation and passive research retain their current fast path. Existing destructive-operation and external-effect policies remain authoritative after spec approval.

### Modules

- `src/orchestration/specApproval.ts`
  - durable contract types;
  - canonical serialization and hashing;
  - strict output validation;
  - requirement-preservation and scope checks;
  - approval eligibility and invalidation;
  - bounded controller state machine.
- `src/orchestration/specBackends.ts`
  - fresh author, reviewer, and refiner worker requests;
  - model routing and same-model fallback;
  - bounded structured result conversion.
- `src/orchestration/workset.ts`
  - expose one reusable normalize/split/scope/validate function so the approved plan is exactly the plan that later materializes.
- `src/orchestration/missionStore.ts`
  - replay, query, and guarded publication of spec records.
- `src/orchestration/orchestrator.ts`
  - invoke the spec controller after workspace preflight;
  - materialize tasks only from current approval;
  - resume interrupted planning and invalidate stale approval.
- `src/orchestration/supervisor.ts`
  - recognize a current, authoritative, deadline-bounded spec stage;
  - recover expired/interrupted stages without exempting all `PLANNING` missions.
- `src/runtime/EngineeringRuntime.ts`
  - production worker/model routing and supervisor continuation wiring.
- `src/orchestration/missionSnapshot.ts` and observability projection
  - additive spec workflow status.

No new dependency or external service is required.

## Durable Contracts

### `MissionSpecRevision`

An immutable record containing:

- mission ID, revision ID, revision number, predecessor ID;
- original user request and protected constraints;
- protected user acceptance ID/text pairs;
- derived acceptance criteria;
- design summary, test obligations, assumptions, risks, and non-goals;
- exact normalized planned tasks;
- workspace manifest hash/generation, repository ID/root, and base SHA;
- required gates and effective policy version;
- author session/model provenance and timestamps;
- runtime-computed semantic spec hash, normalized plan hash, and optional full-record hash.

Models never choose hashes or authority fields.

`semanticSpecHash` covers only canonical structured requirements and design content. It excludes revision IDs, timestamps, attempt counters, and author/reviewer provenance so equivalent refinements compare equal. Collections whose order is not semantic are deduplicated and byte-sorted before hashing. `planHash` covers deterministically ordered normalized tasks; stable task IDs derive from mission ID, semantic spec hash, repository ID, and normalized task ordinal, and dependencies are serialized by stable task ID. The optional full-record hash covers the complete persisted envelope for integrity checks but is never used for plateau detection.

### `SpecStageAttempt`

Records `draft`, `review`, `refine`, `approve`, or `materialize`, including the input revision hash, ownership generation/fencing identity, session/model provenance, start/deadline/end timestamps, outcome, error classification, and artifact references. Stage start is durable before calling a worker; stage completion is durable before the next transition.

### `SpecReviewEvidence`

Separate from candidate `ReviewEvidence`. It binds the exact spec and plan hashes and records reviewer session/model/provider, verdict, independence mode, validated findings, proposed adjustments, risk/scope results, and an explicit result for every acceptance ID.

### `SpecApproval`

Records the exact spec revision/hash, normalized plan hash, acceptance ID/text hash, workspace identity, base SHA, effective policy hash, review IDs, actor=`policy`, rationale, and timestamp. It means only that this exact work is authorized to enter the existing execution pipeline.

### `SpecWorkflowState`

Projects current revision, active stage, semantic refinement rounds used, transient attempts, overall deadline, current approval, next action/time, warning, and stop information. Budgets and deadlines do not reset on restart.

## Invariants

1. Original `user_request`, explicit constraints, explicit acceptance criteria, required gates, and authorized workspace are protected inputs.
2. Refinement may add testability and derived detail, but cannot remove or materially weaken protected inputs.
3. Generated scope may narrow inside the workspace; it may not add roots, repositories, writable domains, credentials, destructive operations, or external side effects.
4. Every material acceptance criterion is covered by the approved normalized task plan.
5. Every task created for initial execution has the approved spec revision, approval lineage, task fingerprint, mission generation, and fencing identity.
6. Approval is current only when every bound input still matches.
7. A late result from an older revision, owner, generation, resumption, or fencing token is historical diagnostic evidence only.
8. Spec approval cannot set implementation acceptance statuses or satisfy validation/review completion gates.
9. Deterministic derived tasks may inherit authority only through persisted lineage to an approved task and only when repository, write domains, acceptance coverage, privilege, and objective remain inside the approved envelope.
10. Any repair, checkpoint replacement, recovery, or gate task that broadens the approved envelope invalidates approval and re-enters spec review before dispatch.

## Review and Refinement

Reviewer output must contain:

- `approve | request_changes`;
- bounded findings with severity, title, and detail;
- proposed adjustments;
- uncovered risks and scope violations;
- one explicit result for every acceptance ID;
- summary and confidence.

Malformed, incomplete, inaccessible, or provenance-free output cannot approve. Format repair and transient infrastructure retries do not consume a semantic refinement round. A valid `request_changes` verdict does.

Default semantic refinement limit is `2`. A repeated `semanticSpecHash` plus normalized unchanged blocking-finding fingerprint counts toward exhaustion and cannot spin. Approval occurs immediately when all deterministic policy checks pass; the controller does not add an aesthetic optimization round after approval.

When no distinct reviewer model is available, the current model runs in a new session without the author transcript. The evidence and status projection record `same_model_reduced` and a warning. When no usable model identity exists, the controller does not fabricate approval; it enters typed recovery and then an actionable stop if recovery is exhausted.

## Persistence and Publication

Approval publication uses a guarded append-before-observe path equivalent to current authoritative evidence publication. An in-memory approval that was not durably appended cannot unlock task creation.

Task materialization is idempotent. Stable task IDs derive from the approved plan. On replay:

- matching existing tasks are reused;
- missing tasks are created;
- a mismatched task under an approved ID stops materialization;
- `READY` is entered only after the complete approved task set is durable.

Runnable publication and dispatch use guarded authority checks, not a prior best-effort lookup. Every runnable task carries approval ID, semantic spec hash, task fingerprint, mission generation, resumption generation, and fencing token. The store validates those values against the current non-invalidated approval in the same serialized mutation that publishes `READY`, and the broker validates them again immediately before execution. Approval invalidation first advances and fences mission authority and cancels affected executions; a concurrent stale `READY` or dispatch attempt is rejected.

### Approved Derived Tasks

The runtime may create deterministic validation, candidate review, finding-repair, integration-repair, checkpoint-replacement, and recovery tasks after initial approval without repeating spec review only when it persists:

- parent approved task ID and approval ID;
- derivation reason and source evidence, finding, or checkpoint;
- unchanged repository binding and no broader write domains;
- acceptance IDs that are a subset of the approved task or mission coverage;
- an objective that directly repairs, validates, reviews, integrates, or resumes the approved deliverable;
- no additional credential, network, destructive, or external-effect privilege.

The runtime deterministically validates that envelope before task creation and again before dispatch. A derived task that cannot prove these properties is not runnable; it invalidates approval and returns to spec review if the broader work remains inside existing user authority, or stops with the missing authority when it does not.

## Recovery and Restart

The controller maintains mission ownership during long worker calls and gives every stage a finite deadline.

Replay continues from the latest durable boundary:

- draft stored, review missing → review the draft;
- review requests changes → refine using the remaining budget;
- revision stored, review missing → review the revision;
- approval stored, task materialization partial → finish idempotently;
- transient provider failure → named retry with next attempt and deadline;
- stale/late worker result → retain diagnostically and ignore for authority;
- persistence failure → do not approve or dispatch;
- generated scope drift that can be removed while satisfying protected requirements → request an in-scope refinement;
- a protected requirement that genuinely requires unavailable authority → durable actionable stop naming that authority;
- permanent configuration failure, conflicting protected requirements, or exhausted refinement → durable actionable stop.

The supervisor treats an active spec stage as healthy only while its ownership identity is current and deadline is open. An expired or abandoned stage enters bounded spec recovery. A taskless `PLANNING` mission with neither valid spec work nor a named wait remains orphaned and is repaired/stopped under the existing invariant.

## Invalidation

Before further dispatch, the runtime fences current authority, cancels affected work, and durably invalidates approval when any bound input changes, including:

- user request or constraint correction;
- acceptance ID or text;
- required gates;
- workspace manifest hash/generation or repository binding;
- base SHA;
- normalized plan;
- effective approval policy version.

The invalidation event contains the prior approval ID and new fencing identity. The same serialized store boundary rejects stale runnable publication; the broker boundary rejects a stale execution even if it raced task scheduling. The next revision must be reviewed and approved again.

## Observability

Mission snapshots add an optional `specApproval` block containing:

- phase and revision/hash;
- review/refinement round and limit;
- active model/session and reduced-independence warning;
- last meaningful progress and elapsed time;
- stage and overall deadline;
- current findings count and outstanding reason;
- next action/time;
- approval ID or exact stop/resume condition.

Spec work also contributes durable workflow-progress units distinct from verified acceptance coverage:

1. draft persisted;
2. normalized plan persisted;
3. review persisted;
4. each bounded refinement persisted;
5. approval persisted;
6. approved task set materialized.

The progress projector publishes the current completed unit count and the known current denominator for the active revision. A new refinement revision starts a new bounded unit sequence without claiming implementation progress. `lastMeaningfulProgressAt` advances only on durable stage boundaries or substantive worker milestones, never on heartbeat alone. Verified acceptance coverage remains zero until implementation evidence exists.

Example status:

```text
Reviewing spec revision 2 · refinement 1/2 · local/local fresh session
Warning: same-model review has reduced independence
1 blocking finding remains · next: refine acceptance coverage · deadline 00:42
```

Heartbeat activity cannot indefinitely reset meaningful-progress deadlines.

## Failure Semantics

- Invalid structured output: bounded format recovery, then typed stop.
- Reviewer timeout/provider outage: transient recovery with visible next retry; semantic round unchanged.
- `request_changes`: requirement-preserving revision, semantic round incremented.
- Identical revision/finding plateau: consume bounded allowance, then stop.
- Generated scope drift: record the violation and request an in-scope refinement within the remaining budget.
- Protected requirement needs broader authority: preserve the proposal and stop with the explicit authority required.
- Conflicting protected requirements: stop with the unresolved conflict.
- Persistence failure: never dispatch; recover or stop as `PERSISTENCE_FAILURE`.
- Ownership loss/cancellation: cancel active worker and reject late authority publication.

Every nonterminal state has active bounded work, a named scheduled wait, or an actionable stop.

## Testing Strategy

### Unit

- Canonical hashing and strict schema bounds.
- Protected-requirement preservation.
- Scope and acceptance coverage validation.
- Exact approval identity and stale invalidation.
- Same-model provenance rules.
- Refinement and plateau budgets.
- Idempotent materialization rules.
- Deterministic semantic/plan hashes, task IDs, ordering, and finding fingerprints.
- Approved-derived-task envelope validation.
- Atomic approval invalidation versus runnable publication and broker dispatch.

### Integration

- Generate → request changes → refine → approve → existing mission execution.
- Local/local author and reviewer use distinct session IDs and persist the warning.
- Restart at every durable boundary, especially approval-before-tasks and partial materialization.
- Mid-review constraint change fences late output and requires fresh approval.
- Slow current planning is not orphaned; expired planning recovers or clearly stops.
- Failed append cannot unlock execution.
- Approved spec without candidate evidence cannot complete.
- Existing review repair and checkpoint recovery inherit approval only inside the approved envelope.
- Invalidation interleaved with `READY` publication or broker dispatch rejects stale work.
- Durable spec-stage progress advances while verified acceptance coverage remains zero.

### Adversarial

- Requirement deletion or weakening.
- Out-of-scope repository/write-domain proposal.
- Unknown acceptance IDs or incomplete coverage.
- Malformed reviewer output and invented provenance.
- Repeated identical refinement.
- Stale owner, revision, resumption, and late result.
- Policy/manifest/base changes after approval.
- Safely repairable generated scope drift versus a protected requirement needing new authority.
- Derived repair/recovery task privilege or write-scope broadening.
- Heartbeats without durable progress during a slow review.

### Regression

- Existing mission reliability and recovery suites.
- Deterministic orchestration dogfood.
- Snapshot contract tests.
- Package-load smoke tests.
- Typecheck and lint.

## Documentation Changes

Update the authoritative automatic workflow, planning/scheduler, review/completion, recovery, observability, safety, and acceptance specifications. Document that autonomous approval is exact-revision policy authorization, not human approval, Plannotator approval, or implementation correctness evidence.

## Delivery

Implement as independently reviewable slices:

1. durable records, hashing, replay, and invalidation;
2. author/reviewer/refiner backends and same-model fallback;
3. controller, normalized-plan binding, and idempotent materialization;
4. restart/supervisor recovery and observability;
5. integration/adversarial tests, dogfood, and authoritative specs.

No slice may temporarily permit unapproved implementation dispatch.
