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

### Worker limits: no default budget, a stall check

The broker stops a running worker for one of these reasons only:

- **User abort or cancel.** The execution and task become `CANCELED`.
- **A configured hard budget.** It comes from policy
  `workers.execution_budget_ms`, a task's explicit `execution_budget_ms`, or
  `PI_ENGINEERING_WORKER_TIMEOUT_MS`. The broker aborts with `TimeoutError`,
  and `exit_status` becomes `timeout`. There is **no default budget**: absent
  or 0 means no deadline, never "already expired". The planner, the spec
  approval normalizer and the runtime's default planner no longer invent one.
  The deadline checkpoint (`checkpoint_policy.before_deadline_ms`) is scheduled
  only when there is a deadline.
- **The stall check** (`workers.stall_timeout_ms`, default 20 minutes, 0 = off;
  agent, review and research backends only). The broker counts every
  non-heartbeat worker event as activity: a model response, a throttled
  "Model response streaming", a tool `started`/`completed`/`failed`, a
  checkpoint claim. It also keeps a count of tool calls in flight. Starting a
  new session resets that count, so a lost end event cannot switch the check
  off. "Waiting for model capacity" holds the check until the next event. The
  broker aborts only when no tool call is running and no event has arrived
  for the timeout. The abort reason is `WorkerStalledError`, `exit_status` is
  `stalled`, and the summary reads "Worker stalled: no activity for N
  minutes ...".

A stall preserves work exactly like a timeout: `FAILED`, the worktree kept, a
cancellation checkpoint written, and the branch ineligible for integration.
The orchestrator classifies it as `WORKER_STALLED` (recovery action
`FENCE_RECONCILE_AND_RESUME`) and stops the mission at `BLOCKED` before review.
Both `TASK_BUDGET_EXHAUSTED` and the c379a80 build-time hint still apply when a
budget is configured.

The older stall signals do not stop a live but silent worker:

- The supervisor's observability `stalled` projection fires only when
  heartbeats stop. The broker emits heartbeats on an interval, so a live but
  silent worker shows as `slow`.
- `src/resilience/watchdog.ts` is advisory and not wired into missions.

`lifecycle.budget_ms` bounds the automatic *lifecycle* pass (review fan-out),
not mission workers.

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
- **Auto-invocation hook** — a `before_agent_start` handler classifies every
  user prompt with the deterministic `IntentRouter`; engineering/review intent
  injects a directive to call the `mission` tool, making auto-invocation
  hands-free (not model-discretionary). Deduped per prompt for 30s; enforcement
  still comes from the runtime completion gate.
- **`/mission <request>`** — optional power-user control (correctness never
  depends on it).
- **`/mission-status`** — list missions and task progress.
- `EngineeringRuntime.orchestrator` + `EngineeringRuntime.missionStore` are the
  programmatic entry points.

## Worktree isolation, harvest, and integration

For a task with `isolation=worktree` and `mutates_repo`, the broker allocates a
dedicated **git worktree** (reusing `GitRepo.createWorktree`/`removeWorktree`)
and tracks it per-mission. When the mission reaches its `integration` task, the
broker collects those worker worktrees as handoffs and the real integration
backend merges each branch into the current checkout sequentially (via
`GitRepo.mergeBranch`), runs integration checks, then releases the worktrees.
Merge conflicts surface as a `conflict` outcome that blocks completion.

**Harvest before teardown.** A worktree directory is removed when its execution
settles, and uncommitted edits die with it. Before teardown the broker commits
the worker's edits onto the task branch (`harvestWorktree`) and releases the
worktree with `keepBranch`, so integration has something to merge. Without this,
a mutating mission could report COMPLETE having changed the repository not at all.

Ordering is therefore `EXECUTING -> INTEGRATING -> VALIDATING -> REVIEWING ->
FINAL_VALIDATION`: integration runs **before** validation and review, so both
observe the merged result rather than an untouched tree. Integration is skipped
when no worktree holds unmerged work (a mission with no git provider edits the
checkout directly). Repair tasks follow the same path — they are worktree-isolated
and re-merged before the mandatory re-review.

Reviewer findings from the real backend are normalized from several shapes
(structured objects, plain strings, JSON strings) into `{severity, summary, …}`
records that the orchestrator persists and the completion gate blocks on.

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

## Cross-session status

An active PI session now owns a private Unix socket and descriptor under
`$XDG_RUNTIME_DIR/pi-engineering` (or a mode-0700 per-user directory under the
system temporary directory). Use the package CLI from another terminal or agent:

```bash
pi-engineering sessions list --json
pi-engineering sessions ping <instance-id> --json
pi-engineering sessions status <instance-id> --json
pi-engineering sessions note <instance-id> "Please report progress"
pi-engineering sessions watch --repo=/path/to/repository
```

`ping` is a fresh reply from the target process. `status` adds bounded mission
state from that repository's snapshot; process heartbeat and mission progress
have separate timestamps. `note` shows an informational UI notification and
does not inject text into the model or steer an in-flight tool. Instance IDs
are unique to a process, even when two processes resume the same PI session.
`list` queries at most eight instances at once; an unreachable descriptor is
reported rather than silently selecting another process. Existing PI
processes acquire this channel after restarting with the updated extension.

The protocol and trust boundary are defined in
[`docs/specs/session-control.md`](specs/session-control.md).

## Closing out stale missions offline

A mission whose controlling `pi` process is gone keeps being reported (and,
when repairable, repaired) by the supervisor of every later runtime over the
same store. To close such missions out, with no `pi` session open on that store:

```bash
pi-engineering missions list   --store <repo>/.pi-eng [--repo-id <id>] [--created-after <ISO>] [--all] [--json]
pi-engineering missions cancel --store <repo>/.pi-eng --repo-id <id> --created-after <ISO>   # dry run
pi-engineering missions cancel --store <repo>/.pi-eng --mission <id> [--mission <id> ...] --yes
```

`cancel` takes the store's single-writer lock (it refuses while a live session
owns the store) and refuses a mission whose controller lease is still live. It
cancels unfinished tasks and executions, fails open recovery decisions and
moves the mission to `CANCELED` through the normal lifecycle transitions. It
starts no supervisor and leaves Git alone: candidate worktrees and branches stay
in place for diagnosis and are listed in the output.

A gate repair that has no Git-verified current candidate (for example because
the only integration failed, so no candidate evidence was ever published) is
refused once, recorded as one `recovery_candidate_baseline` finding, and the
mission is durably stopped with a `resumeCondition`. It is not retried on every
supervisor tick.
