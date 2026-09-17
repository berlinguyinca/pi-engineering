# Pi Engineering Orchestration

The orchestration layer (spec: `docs/specs/pi-engineering-orchestration/`)
turns the interactive Pi Engineering session into an orchestration runtime. A
developer says:

> Implement Google authentication.

and the system automatically routes intent, creates a durable **mission**,
plans/executes workers, validates, launches a fresh independent reviewer,
enforces the **completion gate**, and only then reports completion — **without
requiring `/engineer` or `/review`**.

## Architecture

```text
Developer
   |
   v
Existing PI WEB (jmfederico/pi-web)   <- ControlPlane snapshot surfaces missions
   |
   v
Parent Pi Engineering Session
   |   (normal language, no slash command required)
   v
src/orchestration/Orchestrator
   |
   +-- IntentRouter        (Stage A semantic + Stage B deterministic policy)
   +-- MissionStore        (durable Mission/Task/Execution, event-sourced)
   +-- MissionScheduler    (DAG, write-domains, concurrency, retry, cancel)
   +-- ExecutionBroker     (agent / process / review / integration / validation)
   +-- CompletionGate      (deterministic completion verdict)
   |
   +-- realBackends -> existing EngineeringRuntime primitives
        (PiWorkerExecutor, CommandVerifier, GitRepo worktrees, reviewers)
```

## Core entities

- **Mission** — durable unit of engineering work. Holds `goal`, `constraints`,
  `acceptance_criteria[]`, `risk_profile`, `workflow_class`, `required_gates[]`,
  `task_ids[]`, `status`, and timestamps.
- **Task** — one node in the mission's dependency DAG. Holds `kind`, `role`,
  `depends_on[]`, `write_domains[]`, `isolation`, `failure_policy`,
  `max_attempts`, `steer_requests[]`.
- **Execution** — one concrete child/subagent/subprocess. Holds `backend`,
  `session_id`/`pid`, `worktree`, `model`, `exit_status`, `usage`, `logs`,
  `artifact_refs`.

## Intent & policy router

Two stages (spec 01):

1. **Stage A — semantic intent**: keyword/signature classification into
   `explain | research | investigate | implement | modify | refactor | fix |
   review | validate | release | security-review | migrate`, then a suggested
   `workflow_class`.
2. **Stage B — deterministic policy**: observes runtime facts (changed files,
   file classes, manifests, migrations, security paths) and **upgrades** the
   workflow class and required gates regardless of the semantic guess.

Declarative policies (spec 00 §6) in `src/orchestration/policies.ts`:

| Policy | Triggers on | Requires |
| ------ | ----------- | -------- |
| source mutation | any non-generated change | validation + independent_review |
| auth mutation | `**/auth/**`, `**/security/**`, sessions, oauth | + security_review |
| schema mutation | migrations, `*.sql`, schema | migration_validation |
| dependency mutation | package.json, lockfiles | dependency_validation |
| public API mutation | index/exports/d.ts | compatibility_review |

These invariants are enforced in **code** (the CompletionGate), not prompts: a
model cannot mark a failing mission complete.

## Lifecycle

Mission lifecycle (spec 00 §4):

```text
NEW -> CLASSIFYING -> PLANNING -> READY -> EXECUTING
   -> INTEGRATING -> VALIDATING -> REVIEWING -> REPAIRING(loop)
   -> FINAL_VALIDATION -> COMPLETE
```

Exceptional: `WAITING_FOR_USER | BLOCKED | CANCELING | CANCELED | FAILED`.
Illegal transitions are rejected by `src/orchestration/state.ts`.

## Broker backends

`ExecutionBroker.execute(task)` returns an `ExecutionHandle` with
`result()`/`cancel()`/`steer()`. For a task with `isolation=worktree` and
`mutates_repo`, the broker allocates a dedicated **git worktree** (reusing
`GitRepo.createWorktree`/`removeWorktree`) and passes its path to the backend;
non-overlapping parallel mutators therefore edit isolated checkouts.

| Task kind  | Backend (real)                          |
| ---------- | --------------------------------------- |
| agent/research | fresh worker via `WorkerExecutor`  |
| review     | fresh independent reviewer worker       |
| validation/process | deterministic `CommandVerifier`  |
| integration | GitRepo controlled merge (integrator)  |

Real backends live in `src/orchestration/realBackends.ts`, adapting the
EXISTING runtime primitives; tests inject deterministic fakes.

## Scheduler

`MissionScheduler.runMission` executes runnable tasks (deps SUCCEEDED, no
write-domain conflict, concurrency capacity):

- non-overlapping write domains run **concurrently**;
- overlapping write domains **serialize**;
- transient failures **retry** (classified by `classifyFailure`);
- tasks/cancellations propagate; a user constraint steers/cancels affected work.

## Completion gate

A mission may transition to `COMPLETE` only if: all required gates are met,
no blocking findings remain, no task is running, and none failed. The gate is
deterministic application logic in `src/orchestration/completionGate.ts`.

## PI WEB integration

The existing external **PI WEB** (`jmfederico/pi-web`) is NOT rebuilt. The
`ControlPlane` snapshot (`src/platform/ControlPlane.ts`) exposes a normalized
JSON contract including `missions`, their `tasks` and `executions`, plus a
`health` rollup (mission counts). PI WEB consumes this as the operator surface;
Pi Engineering remains the orchestration authority.

## Extension surface

- **Semantic tool `mission`** — the parent session calls it with a
  normal-language request; the runtime auto-invokes the orchestration workflow.
- **`/mission <request>`** — optional power-user control (correctness never
  depends on it).
- **`/mission-status`** — list missions and task progress.
- `EngineeringRuntime.orchestrator` + `EngineeringRuntime.missionStore` are the
  programmatic entry points.

## Storage

Mission/task/execution state is event-sourced into
`<repoRoot>/.pi-eng/orchestration.jsonl` via the shared `JsonlEventStore`
backend and replayed on open — execution state survives restart and is
reconstructable/auditable from events (not stored only in semantic memory).

## Commands

```bash
# in a normal pi session
/mission Add a health endpoint
/mission-status
```

Or use the `mission` semantic tool from any normal-language request.
