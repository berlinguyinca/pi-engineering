# Pi Engineering — Live Self-Update, Hot Reload & Transactional Runtime Handover

Repository: `berlinguyinca/pi-engineering`

Status: Implementation specification

## 1. Goal

Allow `pi-engineering` to update and reload itself **from inside a running Pi session without restarting Pi**.

Required commands:

```text
/engineering update
/engineering update --check
/engineering update --force
/engineering update --channel stable
/engineering update --channel main
/engineering update --commit <sha>

/engineering reload
/engineering rollback
/engineering version
```

The system must be:

- transactional;
- crash-safe;
- rollback-capable;
- safe during active engineering missions;
- compatible with persistent `.pi-eng` state;
- aware of currently running Pi compatibility;
- resistant to duplicated handlers/workers after reload;
- integrated with existing Pi Engineering mission recovery and inference resilience.

Normal Pi Engineering updates MUST NOT require restarting Pi.

---

# 2. Fundamental Architecture

Do not treat updating as `git pull` followed by hoping Node notices the changed files.

Introduce a stable host boundary:

```text
Pi Process
    │
    ├── Pi Core
    │
    └── PiEngineeringRuntimeHost
            │
            ├── Runtime Generation N
            │
            │      └── EngineeringRuntime
            │
            ├── RuntimeLoader
            ├── RuntimeResourceRegistry
            ├── UpdateManager
            ├── UpdateJournal
            ├── StateMigrationManager
            └── RuntimeHealthChecker
```

Pi Core remains running.

The reloadable component is the Pi Engineering runtime.

---

# 3. RuntimeHost

Create a persistent `RuntimeHost` that owns exactly one active Pi Engineering runtime generation.

Suggested modules:

```text
src/runtime/
    runtimeHost.ts
    runtime.ts
    runtimeLoader.ts
    runtimeGeneration.ts
    runtimeResources.ts
    runtimeSnapshot.ts
    operationRegistry.ts
    health.ts
```

Suggested runtime contract:

```ts
interface EngineeringRuntime {
  start(): Promise<void>;

  quiesce(
    reason: RuntimeQuiesceReason
  ): Promise<void>;

  waitForSafePoint(
    options?: SafePointOptions
  ): Promise<SafePointResult>;

  snapshot(): Promise<RuntimeSnapshot>;

  stop(): Promise<void>;

  health(): Promise<RuntimeHealth>;
}
```

Only one runtime generation may process Pi events at any given time.

Example:

```text
RuntimeHost
    │
    └── Generation 42
          └── pi-engineering 0.2.0
```

After reload/update:

```text
RuntimeHost
    │
    └── Generation 43
          └── pi-engineering 0.2.1
```

---

# 4. Runtime Resource Ownership

Every resource created by Pi Engineering MUST belong to a runtime generation and be disposable.

This includes:

- Pi event listeners;
- command registrations;
- timers;
- intervals;
- filesystem watchers;
- lifecycle hooks;
- model listeners;
- InferWeave listeners;
- telemetry subscriptions;
- status/UI callbacks;
- background workers;
- update checkers;
- retry timers.

Introduce something equivalent to:

```ts
class RuntimeResourceRegistry {
  add(resource: Disposable): void;
  disposeAll(): Promise<void>;
}
```

Reloading must never result in duplicate:

```text
agent_settled handlers
tool handlers
review workers
model requests
timers
telemetry events
status renderers
commands
```

---

# 5. Runtime Generation Fencing

Every asynchronous operation started by a runtime should know the generation that created it.

Example:

```ts
if (!runtimeHost.isGenerationActive(myGeneration)) {
  return;
}
```

Workers should carry:

```text
runtime_generation=42
```

When generation 43 becomes active, stale callbacks from generation 42 must no longer mutate current runtime state.

This is a second safety layer in addition to proper resource cleanup.

---

# 6. `/engineering reload`

Implement hot reload first.

Command:

```text
/engineering reload
```

Flow:

```text
Acquire runtime mutation lock
        ↓
Prevent new engineering work from starting
        ↓
Wait for safe point
        ↓
Quiesce runtime
        ↓
Snapshot transient state
        ↓
Dispose old runtime/resources
        ↓
Increment generation
        ↓
Load current Pi Engineering code
        ↓
Restore runtime state
        ↓
Start new runtime
        ↓
Health check
        ↓
Resume missions/work
```

This should work without restarting Pi or losing the current conversation.

---

# 7. ESM Cache Handling

Node ESM module caching must be handled explicitly.

Do NOT assume:

```ts
await import("./runtime.js");
```

loads changed code.

Each generation must have a unique import identity.

For example:

```ts
const url = pathToFileURL(runtimeEntry);

url.searchParams.set(
  "generation",
  String(generation)
);

const module = await import(url.href);
```

Prefer versioned runtime directories as well.

There MUST be an automated test proving that changed code is actually loaded after `/engineering reload`.

---

# 8. Runtime Module Contract

Define a narrow stable boundary between RuntimeHost and dynamically loaded runtime code.

Example:

```ts
interface EngineeringRuntimeModule {
  runtimeApi: number;

  createRuntime(
    context: RuntimeContext
  ): Promise<EngineeringRuntime>;
}
```

The RuntimeHost should remain minimal and stable.

Feature code should live inside the reloadable runtime.

---

# 9. Live Development Workflow

The following must work:

```text
edit pi-engineering source
        ↓
/engineering reload
        ↓
new source loaded
        ↓
same Pi process
        ↓
same conversation continues
```

This is an explicit goal of the feature.

---

# 10. Never Update Running Files In Place

Do NOT overwrite the code currently being executed.

Use staged/versioned installations.

Conceptually:

```text
~/.pi/pi-engineering/

    versions/
        0.2.0/
        0.2.1/

    current -> versions/0.2.0
    previous -> versions/0.1.9

    staging/
        update-abc123/

    update-journal.json
```

Exact paths may follow Pi's actual installation conventions.

Critical invariant:

> The currently working Pi Engineering runtime remains intact until its replacement has been validated.

---

# 11. `/engineering update`

Main update pipeline:

```text
CHECK
  ↓
FETCH
  ↓
STAGE
  ↓
VALIDATE
  ↓
WAIT FOR SAFE POINT
  ↓
QUIESCE
  ↓
SNAPSHOT
  ↓
MIGRATE STATE IF REQUIRED
  ↓
ACTIVATE
  ↓
LOAD NEW GENERATION
  ↓
RESTORE
  ↓
HEALTH CHECK
  ↓
COMMIT
  ↓
RESUME
```

If anything fails after activation begins:

```text
ROLLBACK
```

---

# 12. Update Sources

Support at least:

```text
stable
main
specific commit
```

Commands:

```text
/engineering update --channel stable
/engineering update --channel main
/engineering update --commit abc123
```

A commit override should normally be one-off and not automatically change the saved preferred update channel.

---

# 13. `/engineering update --check`

Must perform no mutations.

Example:

```text
Pi Engineering

Current:      0.2.0
Commit:       abc123
Channel:      main

Available:    0.2.1
Commit:       def456

Pi compatible: yes
Migration:     none

Update available.
```

---

# 14. Automatic Update Checks

Pi Engineering may check for updates automatically.

Default:

```text
automatic check: enabled
automatic installation: disabled
```

Display unobtrusively:

```text
Pi Engineering 0.2.0 · 0.2.1 available
```

Do not automatically install a new runtime unless explicitly configured.

---

# 15. Staging

Fetch the candidate version into an isolated staging location.

Example:

```text
staging/update-def456/
```

Staging MUST NOT alter:

```text
current runtime
previous runtime
.pi-eng/
Engineering Ledger
mission worktrees
candidate branches
existing runtime state
```

---

# 16. Candidate Validation

Before touching the active runtime, validate the candidate.

At minimum:

```text
dependency resolution
runtime API compatibility
running Pi compatibility
typecheck
critical unit tests
hot-reload smoke test
runtime initialization test
state schema compatibility
migration dry-run
```

Do not automatically run the entire long test suite for every update.

Optional:

```text
/engineering update --verify-full
```

may run full validation.

---

# 17. Pi Version Compatibility

The current Pi Engineering package uses Pi ecosystem dependencies such as:

```text
@earendil-works/pi-agent-core
@earendil-works/pi-ai
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
```

A candidate runtime must declare what running Pi versions/API it supports.

Example package metadata:

```json
{
  "piEngineering": {
    "runtimeApi": 1,
    "minimumPiVersion": "...",
    "maximumPiVersion": "..."
  }
}
```

If the candidate requires a newer Pi core:

```text
Pi Engineering 0.3.0 requires a newer Pi runtime.

Candidate downloaded but not activated.
Pi update/restart required.
```

Do NOT attempt to hot-swap Pi Core itself.

---

# 18. Runtime API Version

Introduce:

```ts
export const PI_ENGINEERING_RUNTIME_API = 1;
```

RuntimeHost advertises which runtime API versions it understands.

The candidate declares its required runtime API.

Reject incompatible candidates before unloading the current runtime.

---

# 19. Safe Points

Do not reload while Pi Engineering is in the middle of an atomic operation.

Unsafe:

```text
active streaming inference
tool execution
file mutation
git mutation
candidate promotion
verification subprocess
deployment
state transaction
migration
```

Safe:

```text
between model calls
between tool calls
between lifecycle stages
between verification steps
between reviewer invocations
between work items
```

Example:

```text
IMPLEMENTING
    │
    ├── model call
    ├── file edit
    ├── test
    │
    ▼
SAFE POINT
    │
    ▼
runtime handover
```

---

# 20. Active Missions Must Survive

An update/reload must not terminate:

```text
/engineer
/execute
/plan
/tournament
/review
/challenge
specialist review
spec verification
remediation
```

Example:

```text
> /engineering update

Pi Engineering 0.2.1 ready.
Waiting for a safe runtime handover point…

Implementer currently running.
```

Then:

```text
✓ safe point reached
✓ runtime reloaded
✓ mission restored

Continuing mission.
```

The existing mission ID remains unchanged.

---

# 21. Quiescing

`quiesce()` should:

- stop starting new missions;
- stop launching new lifecycle stages;
- stop launching new workers;
- prevent new model calls;
- allow active atomic operations to finish;
- drain to a safe boundary.

Do NOT abruptly kill healthy operations.

New requests arriving during handover should be queued temporarily.

---

# 22. Operation Registry

Track active operations centrally.

Example:

```ts
interface ActiveRuntimeOperation {
  id: string;
  generation: number;

  type:
    | "inference"
    | "tool"
    | "verification"
    | "git"
    | "deployment"
    | "state_transaction";

  interruptible: boolean;
  startedAt: string;
}
```

This lets `waitForSafePoint()` report what it is actually waiting for.

Example:

```text
Update ready.
Waiting for safe point:

1 active inference request
1 verification command
```

---

# 23. Never Wedge Forever Waiting For Safe Point

Safe-point waiting must remain observable and cancellable.

The user can cancel a pending update.

Do not forcibly terminate critical operations simply to install an update.

Inference requests already covered by the Pi Engineering resilience/retry system should reach a recoverable boundary naturally.

---

# 24. Durable State Is Authoritative

Do NOT try to serialize the entire live JavaScript object graph.

Existing persisted state remains authoritative:

```text
Engineering Ledger
LifecycleStore
EventStore
mission state
candidate state
worktrees
verification evidence
roadmap state
OpenViking durable memory
other persisted Pi Engineering state
```

Only small transient handover information belongs in the runtime snapshot.

Example:

```ts
interface RuntimeSnapshot {
  generation: number;

  activeMissionIds: string[];
  pendingMissionIds: string[];

  selectedModels?: Record<string, string>;

  runtimePreferences?: Record<string, unknown>;

  createdAt: string;
}
```

Prefer rebuilding state from durable stores after reload.

---

# 25. Persistent State Schema Versioning

Every Pi Engineering-owned persisted state format must have an explicit schema version.

Example:

```json
{
  "schemaVersion": 7
}
```

Each runtime declares:

```text
minimum readable schema
maximum readable schema
schema version it writes
```

---

# 26. Migration Framework

Add something equivalent to:

```text
src/runtime/migrations/
    v6-v7.ts
    v7-v8.ts
```

Flow:

```text
candidate runtime
      ↓
inspect existing schema
      ↓
calculate migration path
      ↓
dry-run migration
      ↓
create rollback checkpoint
      ↓
perform migration
      ↓
activate candidate
```

Migrations must be:

- deterministic;
- journaled;
- tested;
- recoverable;
- idempotent where practical.

---

# 27. Rollback-Safe Migrations

An update must not make rollback impossible simply because a schema changed.

Use:

- reversible migrations; or
- copy-on-write state migration; or
- pre-migration backup/checkpoint.

Do not destroy the previous schema/state until the candidate runtime transaction commits successfully.

---

# 28. Runtime Mutation Lock

Only one operation may mutate the active runtime at a time.

Mutually exclude:

```text
update
reload
rollback
activation
migration
```

Use both:

```text
in-process mutex
filesystem/process lock where necessary
```

Example:

```text
.pi-eng/runtime-update.lock
```

Concurrent request:

```text
Pi Engineering runtime update already in progress.
```

---

# 29. Update Journal

Before mutating state, create a crash-safe update journal.

Example:

```json
{
  "transaction": "update-def456",

  "fromVersion": "0.2.0",
  "fromCommit": "abc123",

  "toVersion": "0.2.1",
  "toCommit": "def456",

  "phase": "activating",

  "previousRuntime": "...",
  "candidateRuntime": "...",

  "migration": {
    "from": 7,
    "to": 8
  },

  "startedAt": "..."
}
```

Phases:

```text
checking
fetching
staging
validating
waiting_safe_point
quiescing
snapshotting
migrating
activating
loading
restoring
health_check
committing
committed
rolling_back
rolled_back
failed
```

---

# 30. Crash Recovery

If Pi dies during an update, startup must inspect the update journal before normal Pi Engineering initialization.

Example:

```text
journal.phase = activating

candidate health = bad
previous runtime = valid
```

Automatically:

```text
restore state checkpoint
        ↓
restore previous runtime pointer
        ↓
load previous runtime
        ↓
health check
        ↓
mark transaction rolled_back
        ↓
continue Pi startup
```

A failed self-update must never permanently brick Pi Engineering.

---

# 31. Atomic Runtime Activation

Prefer one atomic filesystem operation.

For example:

```text
current -> versions/0.2.0
```

switches atomically to:

```text
current -> versions/0.2.1
```

Never copy thousands of candidate files over the running installation during activation.

Keep previous known-good code intact until commit.

---

# 32. Runtime Loading

New runtime activation:

```text
RuntimeLoader
     ↓
resolve candidate runtime
     ↓
dynamic import unique generation
     ↓
verify runtime API
     ↓
create EngineeringRuntime
     ↓
restore transient snapshot
     ↓
start()
     ↓
health check
```

Do not start delivering normal Pi events to the candidate until initialization completes.

---

# 33. Health Check

Before committing, verify:

```text
runtime module loaded
runtime API compatible
start() completed
commands registered
lifecycle initialized
ledger readable
persistent state readable
router initialized
listeners registered once
no initialization exception
```

Inference availability is NOT part of runtime health.

For example:

```text
InferWeave currently has no workers
```

must not cause rollback of an otherwise healthy Pi Engineering runtime.

---

# 34. Commit

Only after successful health checking:

```text
candidate becomes current
old runtime becomes previous
transaction marked committed
queued work resumed
lock released
```

Example:

```text
Pi Engineering

✓ downloaded
✓ validated
✓ compatible
✓ safe point reached
✓ runtime handover
✓ health check

Updated 0.2.0 → 0.2.1

Pi restart not required.
```

---

# 35. Automatic Rollback

If candidate load/start/restore/health fails:

```text
stop candidate runtime
        ↓
restore state checkpoint
        ↓
activate previous runtime
        ↓
load previous generation
        ↓
health check previous runtime
        ↓
resume work
```

Example:

```text
Pi Engineering 0.2.1 failed during initialization.

Rolled back to 0.2.0.
Current Pi session remains usable.
```

Rollback itself must be journaled.

---

# 36. Manual Rollback

Support:

```text
/engineering rollback
```

Optionally:

```text
/engineering rollback 0.2.0
```

Only locally retained known-good versions should be selectable.

Rollback must use the same transactional handover architecture as forward updates.

---

# 37. Previous Version Retention

Keep at minimum:

```text
current
previous known-good
```

Prefer keeping the latest 2–3 validated runtime versions if disk usage is negligible.

Never delete a runtime referenced by an incomplete update journal.

---

# 38. `/engineering version`

Example:

```text
Pi Engineering

Version:        0.2.1
Commit:         def456
Channel:        main

Runtime API:    1
Generation:     43
State schema:   8

Pi compatibility: OK

Previous:
0.2.0 / abc123

Last update:
18 minutes ago
```

Expose this information in the Engineering panel as well.

---

# 39. `/engineering update --force`

`--force` means:

```text
re-fetch/re-stage/reload the selected version
even when it matches the currently installed version
```

It MUST NOT mean:

```text
ignore failed tests
ignore runtime API incompatibility
ignore Pi incompatibility
ignore corrupt state
ignore migration failures
ignore failed health checks
```

Safety invariants remain mandatory.

---

# 40. Dirty Development Checkout

If Pi Engineering is running from a local Git checkout with uncommitted changes:

```text
/engineering update
```

must not silently overwrite those changes.

Return:

```text
Local pi-engineering checkout contains uncommitted changes.
Automatic update refused.
```

However:

```text
/engineering reload
```

should still be allowed.

This is important for development.

---

# 41. Integration With Inference Resilience

Integrate directly with the previously specified resilient inference subsystem.

During runtime quiescence:

- do not begin new inference requests;
- active inference calls may finish;
- recoverable stream failures remain recoverable;
- old-generation retry timers must be disposed;
- long-lived retry/wait state must be reconstructable;
- mission state remains durable.

An inference outage MUST NOT prevent Pi Engineering from updating itself.

A runtime update MUST NOT convert:

```text
WAITING_FOR_INFERENCE_CAPACITY
```

into mission failure.

---

# 42. InferWeave State After Reload

Refresh ephemeral InferWeave state after runtime replacement.

Rediscover:

```text
models
logical aliases
workers
nodes
capacity
health
routes
availability
```

Do not unnecessarily preserve stale fabric topology across a runtime reload.

Persist user configuration, not transient cluster state.

---

# 43. Background Workers

Every Pi Engineering background worker must belong to a runtime generation.

Before handover it must either:

```text
finish at safe point
```

or:

```text
persist enough state to be reconstructed by the next generation
```

Old-generation workers must never continue modifying current runtime state after handover.

---

# 44. Engineering Panel

Add a Runtime/Update section.

Example:

```text
Runtime

Version       0.2.1
Commit        def456
Generation    43
Channel       main
Health        healthy

Update
Latest        0.2.2
Status        available

Previous
0.2.0         retained

Last reload
18m ago
```

During update:

```text
Updating 0.2.1 → 0.2.2

✓ staged
✓ validation
◌ waiting for safe point

Active:
1 inference request
```

---

# 45. Telemetry

Emit structured events:

```text
runtime.update.check
runtime.update.available

runtime.update.started
runtime.update.fetched
runtime.update.staged
runtime.update.validated

runtime.safe_point.waiting
runtime.safe_point.reached

runtime.quiesce.started
runtime.quiesce.completed

runtime.snapshot.created

runtime.migration.started
runtime.migration.completed
runtime.migration.failed

runtime.activation.started
runtime.activation.completed

runtime.generation.loaded
runtime.generation.started

runtime.health.passed
runtime.health.failed

runtime.update.committed

runtime.rollback.started
runtime.rollback.completed
runtime.rollback.failed

runtime.reload.started
runtime.reload.completed

runtime.crash_recovery.started
runtime.crash_recovery.completed
```

Include:

```text
transaction_id
from_version
to_version
from_commit
to_commit
old_generation
new_generation
runtime_api
state_schema
channel
mission_ids
duration
failure_reason
rollback_version
```

---

# 46. Security Requirements

Self-update is a supply-chain boundary.

The updater must:

- fetch only from configured trusted sources;
- verify repository/source identity;
- preserve normal TLS verification;
- reject malformed version metadata;
- prevent path traversal during extraction;
- avoid shell interpolation using remote version strings;
- verify requested commit/version identity;
- avoid arbitrary execution from untrusted update metadata;
- use signatures/checksums when supported.

The updater manages Pi Engineering only.

It must not silently self-update Pi Core.

---

# 47. Failure Isolation

Failures during:

```text
update check
fetch
download
checkout
dependency resolution
validation
migration dry-run
```

must have **zero effect** on the currently running runtime.

Do not touch the active runtime until the candidate is fully staged and validated.

This is a hard invariant.

---

# 48. Tests — Runtime Lifecycle

Test:

- exactly one active generation;
- generation increment;
- resource disposal;
- timer disposal;
- listener disposal;
- generation fencing;
- operation tracking;
- quiescence;
- safe-point detection;
- transient snapshot restoration;
- queued work resumption.

Critical test:

```text
reload runtime 5 times
trigger agent_settled once

expected:
one lifecycle reaction
```

---

# 49. Tests — ESM Reload

Generation 1:

```ts
export const VALUE = "A";
```

Modify runtime.

Generation 2:

```ts
export const VALUE = "B";
```

After `/engineering reload`, runtime MUST observe:

```text
B
```

This proves stale ESM modules are not being reused.

---

# 50. Integration Test — Idle Reload

Sequence:

```text
Pi running
/engineering reload
```

Expected:

```text
same Pi process
same conversation
new generation
commands operational
exactly one listener set
```

---

# 51. Integration Test — Active Mission Reload

Sequence:

```text
mission active
update staged
runtime waits
worker reaches safe point
runtime reloads
mission rehydrates
mission continues
```

Expected:

- same mission ID;
- no completed tool call replay;
- no duplicate worker;
- no lost verification state;
- no mission failure.

---

# 52. Integration Test — Broken Candidate

Candidate loads but throws in:

```text
start()
```

Expected:

```text
candidate rejected
previous runtime restored
previous runtime healthy
Pi session continues
journal = rolled_back
```

---

# 53. Integration Test — Process Crash During Update

Simulate hard process termination during:

```text
migration
atomic activation
candidate load
health check
before commit
```

Restart Pi.

Expected:

```text
journal inspected
consistent runtime selected
persistent state restored
no corrupt current pointer
Pi Engineering starts successfully
```

---

# 54. Integration Test — Migration Failure

Current:

```text
schema 7
```

Candidate:

```text
requires schema 8
```

Migration fails.

Expected:

```text
candidate not committed
schema 7 remains recoverable
old runtime restored
missions preserved
```

---

# 55. Integration Test — Pi Incompatibility

Candidate requires a Pi runtime API/version unavailable in the currently running Pi process.

Expected:

```text
candidate may be staged
activation refused
current runtime untouched
user told Pi restart/update is required
```

---

# 56. Integration Test — Dirty Checkout

With uncommitted local Pi Engineering changes:

```text
/engineering update
```

must refuse destructive update.

```text
/engineering reload
```

must remain usable.

---

# 57. Integration Test — Inference Outage During Update

Sequence:

```text
mission waiting for InferWeave capacity
        ↓
/engineering update
        ↓
candidate validates
        ↓
runtime handover
        ↓
mission restored as WAITING_FOR_INFERENCE_CAPACITY
        ↓
capacity returns
        ↓
mission automatically resumes
```

The runtime update must not incorrectly fail the engineering mission.

---

# 58. Integration Test — Repeated Reload Leak Detection

Run:

```text
/engineering reload
/engineering reload
/engineering reload
/engineering reload
/engineering reload
```

Verify there are no leaked:

```text
listeners
timers
filesystem watchers
gateway subscriptions
model listeners
background jobs
review workers
```

---

# 59. Acceptance Criteria

Implementation is complete when:

- [ ] `/engineering reload` reloads Pi Engineering code without restarting Pi.
- [ ] `/engineering update` updates Pi Engineering without restarting Pi.
- [ ] The current Pi conversation survives reload.
- [ ] Active engineering missions survive runtime handover.
- [ ] Exactly one runtime generation processes Pi events.
- [ ] All runtime resources are disposable.
- [ ] Generation fencing prevents stale callbacks from modifying current state.
- [ ] Changed source code is genuinely loaded despite ESM caching.
- [ ] Updates are staged before activation.
- [ ] Candidate runtime is validated before touching current runtime.
- [ ] Runtime/API/Pi compatibility is checked before activation.
- [ ] Active operations drain to safe points.
- [ ] Persistent `.pi-eng` data remains authoritative.
- [ ] Persistent schemas are versioned.
- [ ] State migrations are tested and rollback-safe.
- [ ] Runtime mutations are locked.
- [ ] Every update uses a crash-safe journal.
- [ ] Interrupted updates recover automatically on next startup.
- [ ] Activation is atomic or equivalent.
- [ ] Failed updates automatically roll back.
- [ ] Previous known-good runtime is retained.
- [ ] `/engineering rollback` works.
- [ ] Dirty development checkouts cannot be silently overwritten.
- [ ] Inference outages do not block or corrupt runtime updates.
- [ ] Reloading repeatedly does not duplicate handlers/workers/timers.
- [ ] Engineering panel exposes version/generation/update state.
- [ ] Existing Pi Engineering tests remain green.

---

# 60. Implementation Order

Implement incrementally.

## Phase 1 — Hot Reload Foundation

Implement:

```text
RuntimeHost
EngineeringRuntime
RuntimeLoader
RuntimeResourceRegistry
generation fencing
operation registry
safe points
```

Deliver first:

```text
/engineering reload
```

This proves the core architecture.

---

## Phase 2 — Versioned Runtime Loading

Implement:

```text
versioned runtime directories
unique ESM generations
current/previous runtime
atomic activation
runtime health checks
automatic rollback
```

---

## Phase 3 — Crash-Safe Persistence

Implement:

```text
runtime mutation lock
update journal
startup recovery
state schema versions
migration framework
rollback checkpoints
```

---

## Phase 4 — Self-Updater

Implement:

```text
update discovery
stable/main/commit channels
fetch
staging
candidate validation
/engineering update
/engineering update --check
```

---

## Phase 5 — Mission Handover

Integrate:

```text
quiescence
safe-point waiting
active mission rehydration
queued work
inference resilience
InferWeave recovery
```

---

## Phase 6 — UX + Hardening

Implement:

```text
Engineering panel
automatic update checks
manual rollback
version diagnostics
security hardening
retention cleanup
dogfood tests
```

---

# 61. Critical Architectural Rule

DO NOT implement this as:

```text
git pull
npm install
reload some handlers
```

and do NOT initialize another Pi Engineering extension instance over the existing one.

That approach will eventually produce:

```text
duplicate event handlers
stale ESM modules
mixed old/new code
duplicate reviewers
orphaned workers
orphaned retry timers
state corruption
```

The architecture must be:

```text
Stable RuntimeHost
        │
        ▼
Reloadable EngineeringRuntime generation
        │
        ▼
Durable Pi Engineering state
```

---

# 62. Desired User Experience

Updating:

```text
> /engineering update

Pi Engineering 0.2.7 → 0.2.8

✓ downloaded
✓ validated
✓ safe point reached
✓ runtime switched
✓ mission state restored
✓ health check passed

Running Pi Engineering 0.2.8.

Pi restart not required.
```

Development:

```text
edit source
     ↓
/engineering reload
     ↓
new source active
     ↓
continue current Pi session
```

Failed release:

```text
> /engineering update

Pi Engineering 0.2.9 failed its runtime health check.

✓ previous state restored
✓ rolled back to 0.2.8

Current Pi session remains operational.
```

This RuntimeHost/handover architecture should become the foundation for future Pi Engineering self-updates, configuration reloads, runtime recovery, development iteration, and dynamically reloadable Pi Engineering components.
