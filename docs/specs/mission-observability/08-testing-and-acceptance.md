# 08 — Testing and Acceptance Criteria

## Unit tests

Cover:

- weighted progress calculation,
- dynamic DAG expansion,
- measurable unit progress,
- clamp below 100 before verification,
- completion gate transition,
- health state derivation,
- waiting reason handling,
- heartbeat vs meaningful progress,
- loop heuristics,
- event projection,
- reconnect/idempotency.
- orphan/deadlock/controller-disconnect classification,
- wait deadline expiry,
- acceptance coverage independent of workflow progress,
- recovery fingerprint exhaustion,
- stale execution fencing.

## Integration tests

### Active mission output

Given an EXECUTING mission,
when the user sends an ordinary question,
Pi can answer while the mission remains active.

### Progress

Given a DAG with weighted nodes,
when tasks advance,
the mission percentage updates deterministically.

### Tests

Given a task running 81 tests,
when test results advance from 34 to 35,
the mission records meaningful progress.

### Waiting

Given an InferWeave admission wait,
the mission renders WAITING with a reason and is not labeled STALLED.

### Stall

Given recurring heartbeat but no meaningful progress beyond the task threshold,
the mission becomes STALLED and records a recovery attempt.

### Review

Given implementation complete but review still running,
the mission cannot display 100% or VERIFIED COMPLETE.

### Reconnect

Reload Pi-Web during an active mission.
The current progress, activity, worker state, and history must reconstruct correctly.

### Multiple missions

Run two missions concurrently.
Progress/output for one must not suppress or corrupt the other.

### Wrong workspace and blocked repair

Start a mission at a meta-root while its explicitly named repositories live in
another authorized workspace. Preflight binds the real repositories. If a role
cannot access candidate evidence, classify and repair the scope once; repeated
unchanged failure stops with a precise actionable reason.

### Timeout checkpoint recovery

Interrupt a worker after two of three bounded deliverables. Preserve and verify
the checkpoint, fence the old execution, split the remaining deliverable, and
resume without replaying completed work.

### Revision-bound gates

Change the candidate after green validation/review. Old evidence becomes invalid
and completion is refused until the final candidate is revalidated and
re-reviewed.

### Incumbent immutability

Cause an integration conflict and a validation failure in separate runs. In both
cases the incumbent HEAD, index, and tree remain byte-for-byte unchanged.

## UI tests

Test at desktop/tablet/phone widths.

Verify:

- progress bar visible,
- text health indicator visible,
- current activity visible,
- last progress visible,
- inspector opens,
- tabs render,
- task/worker updates stream,
- long text truncates safely,
- keyboard navigation,
- ARIA progress values,
- no color-only state representation.

## End-to-end scenario

Create a synthetic mission:

1. planning,
2. 3 implementation tasks,
3. one worker waits for model admission,
4. tests run with measurable counts,
5. one worker intentionally loops,
6. stall detector triggers,
7. recovery reassigns work,
8. implementation completes,
9. reviewer finds blocker,
10. repair executes,
11. re-review succeeds,
12. final validation succeeds,
13. CompletionGate passes.

Run an additional real local-only scenario using `local/local`: interrupt the
mission, recover its checkpoint under the same mission ID, perform a fresh
same-model review with the reduced-independence warning, and complete with
revision-bound evidence.

Checkpoint artifact claims are snapshotted to unique checkpoint-owned,
content-addressed URIs. Recovery must resolve every persisted URI and recompute
its aligned SHA-256 hash before dispatch. Equal-content claims remain separate;
missing, overwritten, or replay-corrupt evidence rejects recovery.

The deterministic public-surface proof is
`npm run test:mission-reliability`. The opt-in installed-Pi check is
`npm run dogfood:mission-recovery`; it exits before repository creation unless
the effective model is exactly `local/local` and metabolomics is absent or
disabled. Its default Task 12 path validates one installed package path and its
exact Git SHA, relies on installed discovery (no duplicate `--extension`), and
verifies a clean tracked tree, index, and untracked set before any
extension-loading Pi command. Package discovery itself uses `--no-extensions`.
It rejects any temp parent in/overlapping a Git worktree, checkout, extension, or
installation before `mkdtemp`. It validates contract v3 and prints the durable
mission `id`, revision, status, `observability.acceptanceCoverage`,
`observability.preservedWork`, typed `stop` (when present), and snapshot path.
For `COMPLETE`, review finding severity/status values must be valid runtime
enums, `repaired` must equal `(status === "resolved")`, and `blockingOpen` must
equal every blocking finding whose status is not resolved. Thus an `accepted`
blocking finding is still unresolved and cannot pass dogfood.
Only verified `COMPLETE` or an allowed stopped state with a complete actionable
stop succeeds; `FAILED`/`CANCELED` exit nonzero and retain the exact path. The
explicitly labeled source-only diagnostic uses `--no-extensions` plus one
source `--extension` and is not the installed-package proof.
Every preliminary source-mode Pi command uses `--no-extensions`. Runtime-v3
validation rejects malformed field types, non-finite/negative/non-integer
counters, zero-acceptance `COMPLETE`, criteria not marked passed, coverage that
does not exactly match the declarations, inconsistent test totals, validation
without a passing nonfailure result, review blocking counts inconsistent with
their findings, incomplete current evidence, and stopped states without a
complete typed recovery/preservation payload.

The headline synthetic mission sends its first worker through the real
`PiWorkerExecutor` and a deterministic OpenAI-compatible transport. The model
invokes the production `checkpoint_progress` tool after committing two of
three deliverables; the broker authenticates that checkpoint, times out the
subsequent stalled turn, and repairs only the remainder. Checkpoint artifact
URIs, when present, must resolve through the artifact store and receive aligned
SHA-256 content hashes. Missing, spoofed, or unreadable references cannot
become preserved work. Repository-bound lifecycle diagnostics and preserved
references both fail closed with typed `PERSISTENCE_UNAVAILABLE` when Git or
any required inventory API is absent.

Status text is contractual: workerless runnable work is `ORPHANED`, unresolved
dependency-only work is `DEADLOCKED`, heartbeat without meaningful progress is
`STALLED`, and an exhausted recovery is `BLOCKED` with an actionable stop.
`BLOCKED` is resumable with `/mission resume <missionId>`; `COMPLETE`, `FAILED`,
and `CANCELED` are terminal. Preserved checkpoints and candidate branches are
recoverable work, not approval evidence.

This acceptance suite proves Slice 1 only. Multiple authorized local roots do
not imply cross-repository atomic publication (Slice 2), and local durable
leases do not imply distributed-controller or remote-worker ownership (Slice
3).

The UI and activity stream must make every phase understandable.

## Acceptance criteria

The feature is accepted only when:

- the generic `MISSION` output is replaced by useful mission status;
- active missions no longer suppress ordinary Pi communication;
- all active missions show approximate progress;
- current activity is visible;
- last meaningful progress is visible;
- waiting has an explicit reason;
- stalls can be detected despite healthy heartbeats;
- recovery is observable;
- Mission Inspector provides task/worker/activity/test/review detail;
- progress survives reconnect/restart;
- 100% appears only after CompletionGate pass;
- existing mission/review/autospec behavior remains functional.
- primary percentage reflects verified acceptance coverage,
- workflow progress remains separately visible,
- workerless missions are never generically ACTIVE,
- every wait and recovery has a next action/deadline,
- blocked missions can resume safely without losing mission identity,
- stale evidence and late worker results cannot authorize completion.
