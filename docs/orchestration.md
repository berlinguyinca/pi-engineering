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
- **External mission entry (AutoSpec adapter)** — see the [`External mission entry (AutoSpec adapter)`](usage.md#external-mission-entry-autospec-adapter) section in the usage docs.

## External mission start selection

Externally submitted missions (created by `src/orchestration/externalEntry.ts`
with ids `MSN-ext-*` in status `NEW`) are **never** dispatched by the normal
scheduler. Instead they are adopted by a runtime-side **pump** that runs as a
side effect of the supervisor lifecycle.

### When the pump runs

`EngineeringRuntime.pumpExternalMissions` is invoked from
`consumeSupervisorStatuses`, which is the `onStatuses` callback of the runtime's
`MissionSupervisor`. Because `onStatuses` is called on **every supervisor tick**
(startup reconcile and each periodic/explicit tick — even when there are no
statuses to consume), the pump effectively runs once per supervisor tick.

The pump is a no-op unless **all** of the following hold:

- the runtime has not stopped its external pump (`externalPumpStopped` is false);
- a mission store and orchestrator are initialized;
- the runtime has an `ownershipId`;
- `PI_AUTOSPEC_ENABLED` is on (`readAutospecFlags(process.env).enabled`), the
  master switch for autospec and mission modes.

It never dispatches external missions itself through the scheduler — pure side
effects live behind the supervisor-driven pump.

### Selection rules

`pumpExternalMissions` gathers every mission still in status `NEW`, reads each
one's lease, and asks the pure function `selectExternalMissionsToStart`
(`src/orchestration/externalStartSelection.ts`) for the ids to start, passing
the runtime's `ownershipId`, the current time, `maxExternalMissions()` (the
concurrency budget), and the count of currently running external missions.

Selection is deterministic and mirrors the external-admission contract:

- **`MSN-ext-` prefix required** — only ids starting with `MSN-ext-` are
  candidates; all others are ignored.
- **Only `NEW` status** — a mission may start only while it is still `NEW`;
  everything else (including `QUEUED`) is skipped (fail closed).
- **Live foreign lease skipped** — a mission with a lease held by another owner
  is never started while that lease is live. A lease is live when its `renewBy`
  is a present, parseable timestamp that is not earlier than now; an unparseable
  `renewBy` is treated as live (we cannot prove it has lapsed).
- **Absent, expired, or self-owned lease is eligible** — a mission with no
  lease, an expired lease, or a lease owned by the runtime itself may start.
- **Oldest first, id tiebreak** — eligible ids are returned oldest `created_at`
  first (missing/invalid dates last), with ties broken by `mission_id`
  ascending.
- **Concurrency cap** — at most `max(0, maxConcurrent - runningExternalCount)`
  ids are returned. `maxConcurrent` defaults to **1** and can be overridden via
  `PI_ENGINEERING_MAX_EXTERNAL_MISSIONS` (the runtime's `maxExternalMissions`
  reads that env var and falls back to 1 when unset, non-integer, or ≤ 0).

### Starting a selected mission

For each selected id, the pump adds it to its `runningExternal` set (so a later
tick will not double-start it) and calls the orchestrator's
`runSubmittedMission(missionId, {})`. That method:

1. **External-mission check** — the mission must be externally submitted: an
   `MSN-ext-` id **or** a constraint starting with `__pi_idempotency_key:`.
   Otherwise it returns `{ started: false, reason: "not_external" }`.
2. **Status check** — it must still be `NEW`, else `{ started: false, reason:
   "status_<status>" }`.
3. **Ownership acquire** — the runtime must be configured with a
   `MissionOwnership`; it acquires the mission lease. If the lease is held by
   another owner, acquisition fails and the method returns `{ started: false,
   reason: "leased_until <date>" }`.
4. **Idempotency sentinel stripped** — before the pipeline runs, the mission
   copy has every `__pi_idempotency_key:` constraint filtered out (the sentinel
   is internal bookkeeping and must never reach spec approval).
5. **Normal mission pipeline** — the stripped `missionCopy` then goes through
   `runMissionPipeline`, exactly as any orchestrated mission: intent routing,
   workspace resolution, planning, worker dispatch, validation, review, and the
   completion gate.

The pump does not await the outcome: `runSubmittedMission` is dispatched
fire-and-forget (the call is `void`-prefixed), so `pumpExternalMissions` returns
as soon as the starts are dispatched. Whatever the outcome — started, not
started, or a thrown error — the `.finally` handler removes the id from
`runningExternal` and publishes a fresh mission snapshot.

### Observability

- A **redacted start reason** is reported: when `runSubmittedMission` returns
  `{ started: false, reason }`, the pump emits a warning telemetry event
  `external mission <id> not started: <redactSecrets(reason)>`.
- **Skipped external missions are logged**: any mission that could not be
  started (not external, wrong status, leased by another owner, or an error
  during the start) surfaces as a warning telemetry event with the reason
  passed through `redactSecrets` (and start failures redact the thrown error
  text too).
- A pump-level error (thrown outside the per-mission loop) is logged as
  `external mission pump: <redactSecrets(error)>`.

### Worked example: expired receipt lease

An externally submitted mission `MSN-ext-abc123` is created in status `NEW`.
Its submitter holds only a short **submission-receipt lease** of
`SUBMISSION_RECEIPT_LEASE_MS = 5 * 60 * 1000` (5 minutes); the submitter is not
actively renewing it. While that 5-minute lease is live, `selectExternalMissionsToStart`
sees a live lease owned by the external submitter (not the runtime) and skips
the mission. Once the lease expires (its `renewBy` is earlier than now), the
mission is eligible. On the **next supervisor tick**, `pumpExternalMissions`
picks it up, adds it to `runningExternal`, and calls
`runSubmittedMission("MSN-ext-abc123", {})`. The orchestrator acquires
ownership (no live foreign lease blocks it), strips the `__pi_idempotency_key:`
sentinel (if present), and runs the normal mission pipeline — moving the mission
past `NEW`.

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

Mission/task/execution state is event-sourced into the worktree's orchestration
namespace under the machine-local state directory
(`~/.local/state/pi-engineering/worktrees/<worktree-id>/events/<session-id>.jsonl`,
one stream per session, read merged through `SessionEventStore`) and replayed on
open — execution state survives restart and is reconstructable/auditable from
events (not stored only in semantic memory). Use `EngineeringRuntime.orchestrationEvents()`
rather than reading a particular file. A legacy `.pi-eng/orchestration.jsonl` is
imported automatically and preserved.

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

## Closing out stale missions

A mission whose controlling `pi` process is gone keeps being reported (and,
when repairable, repaired) by the supervisor of every later runtime over the
same namespace. End it from any `pi` session in that repository with
`/mission cancel <id>`; that is the supported path.

`pi-engineering missions list|cancel --store <repo>/.pi-eng ...` works only on a
legacy single-writer `orchestration.jsonl` that no current runtime has imported
yet (that is, a repository only older Pi Engineering versions have used):

```bash
pi-engineering missions list   --store <repo>/.pi-eng [--repo-id <id>] [--created-after <ISO>] [--all] [--json]
pi-engineering missions cancel --store <repo>/.pi-eng --repo-id <id> --created-after <ISO>   # dry run
pi-engineering missions cancel --store <repo>/.pi-eng --mission <id> [--mission <id> ...] --yes
```

There, `cancel` takes the legacy store's single-writer lock (it refuses while an
older live session owns the store) and refuses a mission whose controller lease
is still live or unreadable. It cancels unfinished tasks and executions, fails
open recovery decisions and moves the mission to `CANCELED` through the normal
lifecycle transitions. It starts no supervisor and leaves Git alone: candidate
worktrees and branches stay in place for diagnosis and are listed in the output.

Current runtimes import that file once into a machine-local runtime namespace
(see [zero-config runtime isolation](specs/zero-config-runtime-isolation.md))
and keep every later mission there, with no cross-process writer lock. Once a
store has been imported, `missions cancel` refuses (the file lacks later
missions, and its lock no longer excludes a live session) and `missions list`
marks its output as a legacy snapshot.

A gate repair that has no Git-verified current candidate (for example because
the only integration failed, so no candidate evidence was ever published) is
refused once, recorded as one `recovery_candidate_baseline` finding, and the
mission is durably stopped with a `resumeCondition`. It is not retried on every
supervisor tick.
