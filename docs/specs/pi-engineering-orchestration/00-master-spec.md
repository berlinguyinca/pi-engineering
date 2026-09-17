# 00 — Master Specification

## 1. Objective

Turn Pi Engineering into an engineering orchestration runtime in which a developer can say:

> Implement Google authentication.

and the system automatically:

- understands intent,
- creates a mission,
- derives acceptance criteria,
- inspects the repository when needed,
- decomposes work,
- spawns Pi child sessions/subagents,
- runs deterministic subprocesses,
- isolates parallel mutations with worktrees,
- integrates results,
- runs tests/build/lint/static checks,
- launches fresh independent reviewers,
- creates repair tasks from findings,
- repeats validation,
- and only then reports completion.

The developer should not need to remember `/engineer`, `/review`, `/parallel-review`, `/subagents`, or similar workflow commands.

## 2. Core architecture

```text
Developer
   |
   v
Existing PI WEB
   |
   v
Parent Pi Engineering Session
   |
   +-- Intent / Policy Router
   +-- Mission Controller
   +-- DAG Scheduler
   +-- Execution Broker
   +-- Completion Gate
   |
   +-- Pi child sessions / tracked subsessions
   +-- pi-subagents workflows
   +-- supervised subprocesses
   +-- worktrees
   +-- reviewers
   +-- artifact/event store
```

## 3. Core entities

### Mission

A mission is the durable unit of engineering work.

Required fields:

- `mission_id`
- `title`
- `goal`
- `user_request`
- `repository`
- `base_ref`
- `constraints`
- `acceptance_criteria[]`
- `risk_profile`
- `workflow_class`
- `status`
- `created_at`
- `updated_at`
- `parent_session_id`
- `task_ids[]`
- `artifact_refs[]`
- `decision_refs[]`
- `required_gates[]`

### Task

Tasks form a dependency graph.

Required fields:

- `task_id`
- `mission_id`
- `kind`
- `role`
- `objective`
- `depends_on[]`
- `status`
- `priority`
- `mutates_repo`
- `write_domains[]`
- `isolation`
- `execution_requirements`
- `assigned_execution_id`
- `artifacts[]`
- `attempt`
- `max_attempts`
- `failure_policy`
- `created_at`
- `started_at`
- `completed_at`

Task kinds:

- `agent`
- `process`
- `review`
- `integration`
- `validation`
- `approval`
- `aggregation`
- `research`

### Execution

Represents one concrete child session, subagent, or subprocess.

Required fields:

- `execution_id`
- `task_id`
- `backend`
- `session_id`
- `pid`
- `worktree`
- `model`
- `thinking_level`
- `started_at`
- `ended_at`
- `exit_status`
- `usage`
- `logs`
- `artifact_refs`

## 4. Mission lifecycle

Canonical lifecycle:

```text
NEW
 -> CLASSIFYING
 -> PLANNING
 -> READY
 -> EXECUTING
 -> INTEGRATING
 -> VALIDATING
 -> REVIEWING
 -> REPAIRING (optional loop)
 -> FINAL_VALIDATION
 -> COMPLETE
```

Exceptional states:

- `WAITING_FOR_USER`
- `BLOCKED`
- `CANCELING`
- `CANCELED`
- `FAILED`

The runtime controls state transitions.

## 5. Workflow classes

- `conversation`
- `research`
- `investigation`
- `engineering`
- `review`
- `engineering_review`
- `incident_fix`
- `refactor`
- `migration`
- `security_sensitive`

Classification begins with natural-language intent and is then upgraded by runtime facts.

Example:

```text
"Why does login fail?"
 -> investigation

repository mutated
 -> engineering_review
```

## 6. Hard policy invariants

These must be implemented in code, not merely prompts.

### Source mutation

If source code is materially changed:

- validation is required,
- independent review is required,
- completion is blocked until both pass.

### Security-sensitive mutation

If auth, permissions, secrets, crypto, session management, network exposure, dependency trust, or security policy changes:

- security review is required,
- normal correctness review is still required.

### Schema/migration mutation

If database schema or migrations change:

- migration validation is required,
- backward/forward compatibility checks should be scheduled where applicable.

### Dependency mutation

If lockfiles/manifests/dependency versions change:

- dependency install/build validation is required,
- security/dependency review may be required.

### Public API mutation

If a public API or externally consumed interface changes:

- compatibility review is required.

## 7. Parent session responsibilities

The parent is an executive/orchestrator, not the default code worker.

Responsibilities:

- understand developer intent,
- preserve long-lived conversational context,
- create/update missions,
- approve or refine task decomposition,
- steer/cancel/reprioritize children,
- surface meaningful decisions to the user,
- summarize progress,
- coordinate integration,
- report final evidence.

For substantial missions, the parent should avoid reading huge logs or making large direct edits unless orchestration is unavailable or the change is truly trivial.

## 8. Child execution strategy

Prefer the smallest correct context.

Typical defaults:

- scout: fresh context + repository/task packet
- planner: compact mission context
- implementer: task packet + relevant files + decisions
- integrator: handoffs + patches + conflicts
- reviewer: fresh context + requirements + diff + test evidence
- repair worker: findings + task packet + affected files
- oracle/architect: selected architecture context only

## 9. Artifact-first communication

Children should produce structured handoffs instead of returning giant prose transcripts.

Examples:

- `scout.json`
- `plan.json`
- `handoff.json`
- `review.json`
- `test-results.json`
- `integration.json`
- `completion-evidence.json`

The parent loads detailed content on demand.

## 10. Success definition

The implementation is successful when:

- a normal-language feature request automatically activates engineering workflow,
- repository mutation automatically schedules required validation and review,
- child agents/subsessions are visible/mapped under the parent,
- deterministic commands run as supervised subprocesses,
- parallel mutation is isolated,
- failed validations generate repair work,
- the parent remains interactive,
- mission state survives restart,
- PI WEB can display mission/task/execution status without becoming the orchestration engine,
- completion cannot be declared while mandatory gates remain unresolved.
