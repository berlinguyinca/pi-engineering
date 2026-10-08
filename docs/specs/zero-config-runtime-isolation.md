# Pi Engineering — Zero-Config Runtime Isolation, Concurrency, and Recovery

## Problem

`berlinguyinca/pi-engineering` currently fails or partially disables the engineering runtime when multiple Pi sessions resolve to the same orchestration directory.

Example:

```text
Warning: Engineering runtime did not open for /home/<user>/IdeaProjects:
JSONL writer lock for /home/<user>/IdeaProjects/.pi-eng/orchestration.jsonl is held
(owner metadata is missing or unreadable)

Set PI_ENGINEERING_ORCHESTRATION_DIR to a per-worktree directory
(or launch the session from within the worktree) so concurrent
sessions do not share one orchestration store lock.
```

This is not acceptable normal behavior.

Pi Engineering must own runtime isolation, worktree discovery, locking, stale-lock recovery, and concurrent-session management automatically.

The user should not normally need to:

- launch Pi from a particular directory,
- manually choose an orchestration directory,
- delete stale lock files,
- restart Pi,
- set `PI_ENGINEERING_ORCHESTRATION_DIR`,
- understand internal JSONL writer semantics.

`PI_ENGINEERING_ORCHESTRATION_DIR` should remain available only as an explicit advanced override.

---

# Goals

Implement a **zero-configuration multi-session runtime architecture** supporting:

1. multiple repositories,
2. multiple Git worktrees,
3. multiple Pi sessions in the same worktree,
4. Pi launched from a parent workspace directory,
5. crashes and abnormal process termination,
6. machine reboot,
7. stale/corrupted locks,
8. truncated JSONL files,
9. shared/network filesystems,
10. runtime rebinding when the active repository changes,
11. transparent recovery without disabling Pi Engineering.

Normal concurrency must never result in:

```text
Engineering runtime did not open
```

unless there is a genuinely unrecoverable filesystem or permission failure.

---

# Core Design Principle

Separate runtime state into three scopes.

## Machine scope

Machine-wide runtime/session registry.

Examples:

```text
active Pi sessions
session UUIDs
PIDs
host identity
process start time
heartbeats
worktree mappings
runtime health
```

## Worktree scope

State shared safely by sessions operating on one Git worktree.

Examples:

```text
repository identity
worktree identity
engineering configuration
shared task metadata
persistent project metadata
```

## Session scope

Everything requiring exclusive ownership.

Examples:

```text
event writer
temporary execution state
stream state
runtime lifecycle
session-local logs
recovery generation ID
```

A Pi session must never require exclusive ownership of the entire worktree's orchestration system.

---

# 1. Automatic Repository and Worktree Resolution

Do not infer orchestration ownership simply from the process working directory.

Use Git metadata whenever possible.

Run equivalents of:

```bash
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git rev-parse --git-dir
```

and inspect Git worktree metadata where appropriate.

Create a stable worktree identity from approximately:

```text
canonical git common directory
+
canonical worktree root
```

For example:

```text
worktree_id = hash(realpath(git_common_dir) + "\0" + realpath(worktree_root))
```

Do not use only the repository name because two repositories may share the same name.

---

# 2. Parent Workspace Launches Must Work

A very common workflow is:

```text
cd ~/IdeaProjects
pi
```

and then Pi starts working on:

```text
~/IdeaProjects/inferweave
```

Pi Engineering must support this directly.

Starting Pi in:

```text
/home/<user>/IdeaProjects
```

must NOT cause all projects underneath it to share:

```text
/home/<user>/IdeaProjects/.pi-eng/orchestration.jsonl
```

Instead, Pi Engineering should initially create a session runtime and bind it to a repository/worktree once the active project becomes known.

---

# 3. Runtime Rebinding

The engineering runtime must not permanently bind itself to whatever directory Pi happened to start from.

Example:

```text
Pi starts in:
~/IdeaProjects

User starts working in:
~/IdeaProjects/inferweave
```

Pi Engineering should detect that the effective workspace is now `inferweave` and rebind automatically.

Desired transition:

```text
unbound/session runtime
        ↓
repository discovered
        ↓
worktree identity resolved
        ↓
session attached to worktree runtime
```

This transition must be safe and transactional.

Do not lose existing events when rebinding.

---

# 4. Runtime State Location

Ephemeral runtime files should not normally live inside the source repository.

Follow XDG conventions where practical.

For example:

```text
$XDG_STATE_HOME/pi-engineering/
```

or fallback:

```text
~/.local/state/pi-engineering/
```

Possible structure:

```text
pi-engineering/
├── registry.db
├── worktrees/
│   ├── <worktree-id>/
│   │   ├── runtime.db
│   │   ├── events/
│   │   │   ├── <session-id>.jsonl
│   │   │   └── <session-id>.jsonl
│   │   └── recovery/
│   └── ...
└── sessions/
    ├── <session-id>/
    └── ...
```

`.pi-eng/` inside repositories should primarily contain durable project configuration if needed.

Avoid ephemeral PID/lock/runtime ownership state there.

---

# 5. Session IDs

Every Pi Engineering runtime instance must have a UUID:

```text
session_id
```

Generate it at process/session creation.

A session identity should survive internal runtime reloads during the same Pi session where appropriate.

Example:

```text
4f2c52fa-87dd-4a72-bbf2-4809b5700ab4
```

---

# 6. Machine-Local Runtime Registry

Introduce an authoritative machine-local session registry.

Store at minimum:

```text
session_id
pid
process_start_time
hostname / machine_id
repo_id
worktree_id
worktree_path
runtime_path
started_at
last_heartbeat
state
generation_id
Pi session metadata
```

Example state values:

```text
starting
healthy
recovering
rebinding
stopping
dead
orphaned
```

The registry lets Pi Engineering determine what actually owns runtime resources.

Do not infer ownership solely from the existence of a lock file.

---

# 7. Prefer SQLite for Coordination

Replace fragile single-writer JSONL coordination with a small embedded SQLite database.

Recommended:

```text
SQLite
WAL mode
busy_timeout configured
transactional updates
```

SQLite should hold coordination/runtime metadata.

JSONL may remain as the append-only event/audit format.

Example:

```text
SQLite:
  sessions
  runtimes
  leases
  jobs
  recovery state
  indexes

JSONL:
  durable event history
  debugging/audit stream
```

Do not require one globally exclusive JSONL writer.

---

# 8. Per-Session Event Logs

Instead of:

```text
orchestration.jsonl
```

with one exclusive writer, use:

```text
events/<session-id>.jsonl
```

Each session owns its own append stream.

Example:

```text
events/
├── 12a4....jsonl
├── 6be1....jsonl
└── f03d....jsonl
```

Expose a logical merged event stream to callers.

The API/UI should not care which physical event file contains the event.

Events should include:

```text
timestamp
session_id
worktree_id
sequence
event_type
payload
```

---

# 9. Atomic Ownership / Lease Model

If exclusive ownership is required for a particular resource, implement a lease rather than a primitive lock-file existence check.

Lease metadata:

```text
resource_id
session_id
pid
hostname
process_start_time
generation_id
acquired_at
heartbeat_at
expires_at
```

Use atomic acquisition.

Every acquisition gets a unique:

```text
generation_id
```

A process may only release the generation that it owns.

This prevents an old/stale process from deleting a newly acquired lease.

---

# 10. Heartbeats

Live sessions should heartbeat periodically.

Example:

```text
every 5–15 seconds
```

Heartbeat frequency should be configurable internally but should not require user tuning.

The heartbeat should update:

```text
last_heartbeat
```

A stale heartbeat alone should not immediately prove a process is dead.

Combine heartbeat information with PID/process identity checks when local.

---

# 11. Stale Runtime Detection

Automatically detect and recover stale runtime ownership.

For a local machine, verify:

```text
PID exists
process start time matches
session generation matches
heartbeat age
```

Why process start time matters:

Linux can reuse PIDs.

Therefore:

```text
same PID != same process
```

If PID is gone or process identity differs, ownership is stale.

Automatically reclaim it.

---

# 12. Missing or Corrupted Owner Metadata

This current condition:

```text
owner metadata is missing or unreadable
```

must NOT stop Pi Engineering.

Recovery algorithm:

```text
metadata missing/unreadable
        ↓
inspect runtime registry
        ↓
inspect process ownership if available
        ↓
validate active session
        ↓
if no healthy owner exists:
    quarantine stale metadata
    acquire new generation
    continue
```

Example quarantine:

```text
recovery/stale-lock-20261005T202712Z.json
```

Keep it for diagnostics rather than silently deleting useful evidence.

---

# 13. Multiple Sessions in the Same Worktree

This should be explicitly supported.

Example:

```text
Pi session A → inferweave worktree
Pi session B → inferweave worktree
Pi session C → inferweave worktree
```

All three should operate normally.

Each gets:

```text
its own session_id
its own event writer
its own transient execution state
```

They may share safe worktree metadata through SQLite/WAL.

A second Pi session should not disable engineering features simply because another session already exists.

---

# 14. Multiple Git Worktrees

Example:

```text
inferweave/
inferweave-feature-routing/
inferweave-benchmark/
```

All should resolve independently even though they share one Git common directory.

Their identity must include the actual worktree root.

Expected:

```text
worktree A → isolated runtime namespace
worktree B → isolated runtime namespace
worktree C → isolated runtime namespace
```

---

# 15. Safe Temporary Scope

If Pi Engineering cannot yet determine the repository/worktree, create a session-local temporary runtime.

Example:

```text
sessions/<session-id>/
```

Do not fail initialization.

Later:

```text
workspace detected
        ↓
resolve worktree
        ↓
attach/rebind
```

---

# 16. Transactional Rebinding

Rebinding should behave approximately as:

```text
BEGIN

resolve destination worktree
register destination attachment
flush session-local events
move/import applicable metadata
switch runtime pointer
emit runtime.rebound event

COMMIT
```

If anything fails:

```text
ROLLBACK
```

The existing session runtime remains usable.

Never leave the session half-attached to two runtimes.

---

# 17. Crash Recovery

Explicitly support:

```text
SIGTERM
SIGINT
SIGKILL
terminal disappearance
Pi crash
pi-engineering crash
machine reboot
power loss
OOM kill
```

Graceful shutdown should unregister the session.

Ungraceful shutdown should be detected and repaired automatically on next startup.

---

# 18. Startup Reconciliation

At startup, run a lightweight reconciliation pass.

Inspect:

```text
registered sessions
leases
heartbeat state
known worktree runtimes
event streams
unfinished migrations/rebindings
```

For each stale session:

```text
mark dead/orphaned
release expired leases
flush/recover indexes
preserve event logs
```

This should be fast and safe to run repeatedly.

---

# 19. JSONL Corruption Recovery

A crash may leave:

```text
{"event":"foo","value":
```

at the end of a JSONL file.

Do not fail the entire runtime.

For append-only JSONL:

1. find last valid complete line,
2. preserve the valid prefix,
3. quarantine/truncate only the broken tail,
4. emit a recovery event,
5. continue.

Never throw away the entire event history because one line is malformed.

---

# 20. Shared / Network Filesystems

Detect or account for repositories residing on filesystems such as:

```text
NFS
BeeGFS
Lustre
CIFS/SMB
other distributed filesystems
```

Do not assume POSIX advisory locking semantics behave identically everywhere.

Because coordination state is moved to machine-local XDG state, most locking should avoid the shared filesystem entirely.

If shared coordination is intentionally required, use a mechanism explicitly designed for it.

---

# 21. Runtime Health States

Expose structured health rather than only warnings.

Example:

```text
healthy
degraded
recovering
rebound
isolated
failed
```

A recoverable lock problem should appear briefly as:

```text
recovering
```

and then:

```text
healthy
```

not:

```text
engineering runtime disabled
```

---

# 22. Recovery Policy

When runtime initialization encounters contention:

```text
try desired worktree runtime
        ↓
validate owner
        ↓
recover stale ownership if applicable
        ↓
attach concurrently if supported
        ↓
create session-local writer
        ↓
continue
```

Only fail if no safe state location can be written.

---

# 23. User Experience

Normal operation should produce no warning.

At most, diagnostics/debug output might say:

```text
Engineering runtime recovered stale session 8a71…
```

or:

```text
Engineering runtime rebound:
~/IdeaProjects → ~/IdeaProjects/inferweave
```

Do not instruct ordinary users to manipulate environment variables.

---

# 24. Advanced Override

Continue supporting:

```text
PI_ENGINEERING_ORCHESTRATION_DIR
```

but treat it as an expert override.

When explicitly set:

```text
respect it
```

but still provide:

```text
session isolation
stale-owner recovery
per-session writers
safe concurrency
```

Setting the override should not revert the implementation to unsafe single-writer behavior.

---

# 25. Pi Runtime Introspection

Expose runtime information through Pi.

Suggested information:

```text
Repository: inferweave
Worktree: /home/<user>/IdeaProjects/inferweave
Worktree ID: f8a17…
Session: 31d92…
Runtime: healthy
Event writer: session-local
Concurrent sessions: 3
Last heartbeat: <1s
```

This may be exposed via:

```text
/pi-engineering status
```

or equivalent existing Pi UX.

---

# 26. Doctor Command

Add:

```bash
pi engineering doctor
```

or the equivalent appropriate command for the project CLI.

It should inspect:

```text
repository/worktree resolution
runtime directories
permissions
SQLite health
active sessions
stale sessions
leases
event logs
truncated JSONL
filesystem type
migration state
```

Example output:

```text
Pi Engineering Doctor

Runtime registry        OK
SQLite WAL              OK
Worktree resolution     OK
Active sessions         3
Stale sessions          1
Event streams           OK
Filesystem              ext4
Repairable issues       1
```

Support:

```bash
pi engineering doctor --repair
```

Repairs must only perform safe operations automatically.

---

# 27. Automatic Self-Healing

The normal runtime should automatically perform repairs considered safe.

Examples:

```text
dead PID ownership
expired local session
missing stale owner metadata
orphan heartbeat
truncated final JSONL record
incomplete runtime registration
```

The doctor command is primarily for visibility and unusual cases.

Users should not need to run it during normal operation.

---

# 28. Structured Runtime Events

Emit events such as:

```text
runtime.started
runtime.bound
runtime.rebound
runtime.recovering
runtime.recovered
runtime.stopped

session.registered
session.heartbeat
session.orphaned
session.recovered

lease.acquired
lease.expired
lease.reclaimed

event_stream.recovered
event_stream.corruption_detected
```

These should integrate with existing Pi Engineering observability.

---

# 29. Logging

Every concurrency/recovery decision should produce structured diagnostic logging.

Example:

```json
{
  "event": "lease.reclaimed",
  "resource": "worktree-runtime",
  "previous_session": "...",
  "reason": "pid_not_alive",
  "new_session": "..."
}
```

Do not spam the normal UI.

Detailed information belongs in debug logs.

---

# 30. Do Not Hide Genuine Problems

Automatic recovery should not silently conceal actual data corruption or permission problems.

Classify errors.

## Recoverable

```text
stale lock
dead process
missing owner metadata
truncated final event
concurrent writer
workspace rebinding
```

Recover automatically.

## Degraded but usable

Example:

```text
event index rebuild failed
```

Continue core operation and report diagnostics.

## Fatal

Examples:

```text
state directory is read-only
SQLite cannot be created
filesystem is full
database is irrecoverably corrupt and no isolated fallback is possible
```

Only these should prevent engineering runtime operation.

---

# 31. Fallback Isolation

Even when a worktree runtime cannot be opened, attempt safe session-local isolation.

For example:

```text
worktree runtime inaccessible
        ↓
session fallback runtime
        ↓
engineering features remain operational
        ↓
periodically attempt safe reattachment
```

Do not disable the entire engineering runtime unnecessarily.

---

# 32. Runtime Reload Compatibility

This must work with Pi Engineering's runtime reload/update functionality.

Reloading Pi Engineering should not:

```text
generate false stale locks
lose session identity
duplicate event writers
orphan runtime state
require restarting Pi
```

Preserve the logical `session_id` through an in-process Pi Engineering reload where appropriate.

---

# 33. Concurrency Stress Tests

Add automated tests that intentionally create hostile concurrency conditions.

At minimum:

### Same worktree

Start:

```text
20–50 sessions
```

simultaneously against one worktree.

Expected:

```text
all initialize
no lock failure
unique event writers
shared state remains consistent
```

### Multiple worktrees

Launch many sessions across:

```text
same repo / different worktrees
```

### Parent directory

Launch all sessions from:

```text
~/IdeaProjects
```

then independently select different repositories.

### Simultaneous acquisition

Force all processes to initialize within the same few milliseconds.

### Crash

Kill owners using:

```text
SIGKILL
```

then immediately start replacements.

### PID reuse simulation

Ensure process start time/generation prevents false ownership.

### Corrupted metadata

Test:

```text
missing
empty
partial
invalid JSON
```

lock/owner metadata.

### Truncated JSONL

Kill a writer mid-record.

### Rebinding

Start unbound, then switch worktrees repeatedly.

### Runtime reload

Reload Pi Engineering while work is active.

### Reboot simulation

Populate registry with sessions whose PIDs no longer exist.

---

# 34. Race Testing

Use repeated randomized tests around:

```text
register
heartbeat
lease acquire
lease renew
lease release
rebind
shutdown
recover
```

Run them under high concurrency.

The design must specifically protect against:

```text
ABA ownership problems
PID reuse
old process releasing new lease
double migration
double event writer
session resurrection
```

---

# 35. Acceptance Criteria

The implementation is complete when all of these work without manual configuration.

### Case 1

```bash
cd ~/IdeaProjects
pi
```

Then operate on:

```text
~/IdeaProjects/inferweave
```

Expected:

```text
Pi Engineering automatically binds to inferweave.
```

No warning.

---

### Case 2

Two Pi sessions started from:

```text
~/IdeaProjects
```

Session A uses:

```text
inferweave
```

Session B uses:

```text
pi-engineering
```

Expected:

```text
both work normally
```

---

### Case 3

Five Pi sessions operate on the same worktree.

Expected:

```text
all engineering runtimes open
all have unique session writers
shared metadata remains consistent
```

---

### Case 4

Pi crashes with SIGKILL.

Immediately restart it.

Expected:

```text
old ownership is detected
stale state is reclaimed
runtime opens automatically
```

---

### Case 5

Owner metadata exists but contains garbage.

Expected:

```text
metadata is quarantined
registry/process state is inspected
safe ownership is reconstructed
runtime continues
```

---

### Case 6

Final JSONL record is truncated.

Expected:

```text
valid history remains
broken tail is quarantined/repaired
runtime opens
```

---

### Case 7

Pi begins in one repository and later operates in another.

Expected:

```text
runtime automatically rebinds
events remain consistent
```

---

### Case 8

Pi Engineering is reloaded from inside Pi.

Expected:

```text
no runtime restart required
no false stale ownership
session continues
```

---

# 36. Migration

Existing users may have:

```text
.pi-eng/orchestration.jsonl
```

Provide automatic migration.

Suggested behavior:

1. detect legacy orchestration file,
2. read all valid events,
3. import/index them into the new worktree runtime,
4. preserve the original file,
5. mark migration complete.

Do not destructively remove old history.

Example:

```text
.pi-eng/orchestration.jsonl
```

may become:

```text
.pi-eng/orchestration.jsonl.legacy
```

only after successful migration, if renaming is desirable.

Prefer compatibility over aggressive cleanup.

---

# 37. Compatibility

Do not unnecessarily break existing Pi Engineering APIs.

Introduce internal abstractions such as:

```text
RuntimeRegistry
RuntimeSession
WorktreeIdentity
RuntimeBinding
EventStore
LeaseManager
RecoveryManager
```

Existing consumers should access orchestration state through these abstractions rather than directly opening a particular JSONL file.

---

# 38. Suggested Internal Architecture

Conceptually:

```text
                   Pi
                    │
                    ▼
          Pi Engineering Runtime
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
Workspace Resolver        Session Manager
       │                         │
       ▼                         ▼
Git Worktree Resolver     Runtime Registry
       │                         │
       └────────────┬────────────┘
                    ▼
             Runtime Binding
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
 SQLite Coordination      Session Event Log
      (WAL)              <session-id>.jsonl
        │                       │
        └───────────┬───────────┘
                    ▼
              Merged Event API
                    │
                    ▼
         Pi Engineering Consumers
```

Recovery manager observes the entire lifecycle:

```text
             Recovery Manager
                    │
  stale sessions / leases / files / migrations
                    │
                    ▼
             automatic repair
```

---

# 39. Important Behavioral Rule

Never make users solve an internal Pi Engineering coordination problem.

The following guidance should disappear from normal operation:

```text
Set PI_ENGINEERING_ORCHESTRATION_DIR to a per-worktree directory
```

The software already knows enough to create isolated namespaces itself.

---

# 40. Implementation Priority

Implement in this order:

## Phase 1 — Stop current failures

- stable session IDs,
- automatic worktree resolution,
- per-session orchestration/event files,
- stale-owner validation,
- automatic stale lock reclamation,
- safe fallback runtime.

This immediately eliminates the current warning/failure mode.

## Phase 2 — Coordination redesign

- SQLite runtime registry,
- WAL mode,
- leases/generation IDs,
- heartbeats,
- startup reconciliation.

## Phase 3 — Dynamic workspace behavior

- parent-directory launch support,
- runtime rebinding,
- transactional migration between bindings.

## Phase 4 — Reliability

- JSONL corruption recovery,
- crash/reboot recovery,
- network filesystem handling,
- reload compatibility.

## Phase 5 — UX/observability

- runtime status,
- doctor command,
- repair mode,
- structured recovery events,
- debug views.

## Phase 6 — Stress testing

- multi-process race tests,
- SIGKILL testing,
- same-worktree concurrency,
- parent-workspace testing,
- PID reuse simulation,
- reload/rebind testing.

---

# Definition of Done

A user should be able to open arbitrary numbers of Pi sessions from:

```text
/home/<user>/IdeaProjects
```

operate on different repositories and worktrees, occasionally use multiple sessions against the same worktree, kill Pi unexpectedly, reload Pi Engineering, and restart the machine without ever thinking about:

```text
orchestration.jsonl
JSONL writer locks
.PI_ENGINEERING_ORCHESTRATION_DIR
stale lock files
```

Pi Engineering must discover, isolate, coordinate, recover, and rebind its runtime automatically.

Concurrency should be a supported first-class operating mode, not an error condition.
