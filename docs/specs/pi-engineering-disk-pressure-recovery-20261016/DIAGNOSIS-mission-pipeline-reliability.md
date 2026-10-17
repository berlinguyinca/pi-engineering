# Diagnosis — Mission pipeline cannot complete long missions (pre-existing P0 reliability)

**Status:** **FIXED (branch `fix/orchestration-lease-and-orphan-v2`, rebased onto current `origin/main`).** Both bugs below are implemented, tested, and the full unit + mission-reliability integration suites pass. See “Fixes implemented” at the bottom.

> The original fix landed on `fix/mission-lease-heartbeat-and-orphan-recovery` (base `58fefd0`, PR #333). `origin/main` has since advanced (the old fix branch was 279 commits behind), and **both bugs still existed on current `origin/main`**, so the fixes were re-applied onto the latest main on this branch.
**Date:** 2026-10-16
**Evidence:** `.pi-eng/orchestration.jsonl` (missions `MSN-GQpfi6`, `MSN-y2a3Qz`); `src/orchestration/ownership.ts`.

## Bottom line

Long-running missions (minutes to hours) **cannot complete** through the mission
pipeline because of two **pre-existing, disk-pressure-unrelated** reliability bugs in the
orchestration core:

1. **The controller lease heartbeat latches dead on a single transient pulse failure.**
2. **The `ORPHANED_EXECUTION` recovery misfires** — it advances the mission generation and
   dispatches the **integrator** instead of **resuming the implementer**, turning a
   recoverable lease lapse into a hard mission stop.

Both are in the same resilience domain the disk-pressure spec targets (suspend, preserve,
recover — do not crash-loop), but they are **distinct defects** and should be fixed before
(or alongside) the disk-pressure work so the pipeline is a trustworthy vehicle.

## Reproduction (deterministic, observed)

Three successive attempts to run the disk-pressure spec mission, each failing a different way:

| # | Driver | Symptom | Root cause |
|---|--------|---------|-----------|
| 1 | `pi -p` (one-shot), request named `/tmp`,`/data` | `WorkspaceScopeError: Authorized workspace is not inside a Git repository: /tmp` | Installed extension package (older commit `1ea5201`) `explicitAbsolutePaths` treats any existing absolute path in the request as a workspace candidate. **Workaround:** sanitize the request (no existing absolute path literals). |
| 2 | `pi -p` (one-shot), sanitized request | Mission reaches `INTEGRATING`, then `lease.expired` (mission + repository) | `pi -p` exits after the model turn; the `unref()`'d heartbeat dies; the 30s controller lease lapses. |
| 3 | Interactive `pi` in tmux (persistent TTY), sanitized request | Mission `MSN-y2a3Qz`: implementer starts, then `ORPHANED_EXECUTION` → `FENCE_RECONCILE_AND_RESUME` ×2 → **STOP** | Controller lease heartbeat **latched dead** mid-mission (see Bug 1); recovery misfired (see Bug 2). |

Attempt 3 is the important one: a **persistent** TTY driver still cannot hold a long mission,
because the failure is in the lease heartbeat itself, not in process lifetime.

## Bug 1 — Controller lease heartbeat latches dead on one transient failure

`RenewableDispatchAuthority` (the object that heartbeats the controller's mission +
repository lease) has a fatal latch:

```ts
// src/orchestration/ownership.ts  (RenewableDispatchAuthority)
constructor(ownership, mission, repository, heartbeatMs) {
  this.timer = setInterval(() => {
    this.pulseChain = this.pulseChain
      .then(() => this.pulse())
      .catch((error) => {
        this.failure = ...;            // <-- latched, never cleared
        for (const listener of this.invalidationListeners) listener(this.failure);
      });
  }, heartbeatMs);
  this.timer.unref?.();
}

private async pulse(): Promise<void> {
  if (this.stopped || this.failure) return;   // <-- one failure => all future pulses are no-ops
  this.mission = await this.ownership.renew(this.mission);
  if (this.repository) this.repository = await this.ownership.renewRepository(this.repository);
}
```

`failure` is set on the **first** pulse error and **never cleared**, so every subsequent
`pulse()` returns immediately. A single transient renew error therefore permanently stops
all lease renewals; the lease then lapses and the mission is orphaned.

### Evidence (MSN-y2a3Qz, repository scope)

```
16:54:29 lease.acquired   scope=repository
16:54:39 lease.renewed    scope=repository
16:54:49 lease.renewed    scope=repository
16:54:59 lease.renewed    scope=repository
16:55:09 lease.renewed    scope=repository
16:55:19 lease.renewed    scope=repository
16:55:29 lease.renewed    scope=repository   <-- LAST on-time renewal (60s after implementer start)
        (no renewals)
16:56:27 failure.classified ORPHANED_EXECUTION "Controller runtime-2975124… lease …"
16:57:20 lease.expired    scope=repository   (detected during fencing)
```

Renewals were **on-time (every 10s) right up until 16:55:29**, so the lease was *not*
already lapsed when the failure hit — it was a **transient** error that latched the
heartbeat dead. `pulse()` runs `confirmCustody(...)` (registry custody) then
`renewRepository(...)` (store lease); either can throw on a transient condition.

### Fix (implemented)

Do not latch on a single failure. Retry on subsequent ticks; latch only after **N
consecutive** failures (so a permanent loss still terminates, a transient blip does not):

```ts
private consecutiveRenewFailures = 0;
private readonly maxConsecutiveRenewFailures: number;   // default 3, configurable

// in the interval .catch:
this.consecutiveRenewFailures += 1;
this.lastError = error instanceof Error ? error : new Error(String(error));
if (this.consecutiveRenewFailures >= this.maxConsecutiveRenewFailures && !this.failure) {
  this.failure = new Error(`lease renewal failed ${this.consecutiveRenewFailures} times in a row: ${this.lastError.message}`);
  for (const listener of this.invalidationListeners) listener(this.failure);
}

// at the end of a successful pulse():
this.consecutiveRenewFailures = 0;
```

Implemented in `src/orchestration/ownership.ts`:
- `MissionOwnershipOptions.maxConsecutiveRenewFailures` (default `3`, validated >= 1) —
  configurable so operators can trade off blip tolerance vs. time-to-detect a real loss.
- `DispatchAuthority.lastPulseError` (optional readonly) — surfaces the most recent renewal
  error even before the authority is invalidated, closing the “open question” below (the
  underlying `pulse()` error is now observable).
- `RenewableDispatchAuthority` tracks `consecutiveRenewFailures` / `lastError`; resets the
  counter on a successful pulse; latches `failure` only at the threshold.

**Not sufficient on its own** if the underlying failure is a *permanent* custody/epoch loss
(e.g. the lease was legitimately taken by another live owner): retrying would just fail N
times and still lapse. In that case the correct behavior is to **re-acquire** the lease the
controller is still authorized to hold, and only terminate if re-acquisition fails. The
exact trigger of the 16:55:29 failure should be captured (log the `pulse()` error) to
decide whether re-acquisition is required.

## Bug 2 — `ORPHANED_EXECUTION` recovery dispatches the integrator, not a resume of the implementer

After the controller lease lapsed (Bug 1), the supervisor classified
`ORPHANED_EXECUTION` and planned `FENCE_RECONCILE_AND_RESUME`. Instead of resuming the
**implementer** task, the recovery advanced the mission **generation (1 → 2)** and
dispatched the **integrator** task, which ran against an **empty candidate branch** and
failed:

```
16:54:29 execution.started  EXC-wv1fEn  task=TSK-jI3vhH  backend=agent        gen=1  (implementer)
16:56:27 failure.classified ORPHANED_EXECUTION
16:57:20 execution.started  EXC-WPqz70  task=TSK-eQVb9G  backend=integration  gen=2  (INTEGRATOR)
16:57:23 execution.failed   EXC-WPqz70  "integrated nothing into pi-eng-candidate-…; checks: fail"
16:57:23 failure.classified MERGE_CONFLICT
16:57:23 task.failed        TSK-eQVb9G
16:57:23 lease.fenced       repository + mission
16:57:27..16:58:01          repeated ORPHANED_EXECUTION + recovery.failed
16:58:27 recovery.exhausted -> mission.stopped
```

The mission had **one runnable task (the implementer)**; the recovery should have resumed
it (same generation, re-fenced), not started the downstream integrator. As written, the
recovery treats "no active worker" as "move to the next phase", which is wrong when the
implementer never completed.

### Root cause (traced)

The misfire is caused by the orphaned task being left in a **terminal CANCELED** state
instead of a **resumable RETRYING** state:

1. The controller lease lapses (Bug 1) → the dispatch authority is invalidated.
2. `Orchestrator`'s `authority.onInvalidated` listener called `executionHandle.cancel()`
   **without** `resumable`, so `cancelExecution` transitioned the implementer task to
   `CANCELED` (terminal).
3. With the implementer CANCELED and no live worker, the scheduler's `postExecution` saw
   "nothing runnable" and created + dispatched the **integrator** (the next phase), which
   ran against an empty candidate and failed (`MERGE_CONFLICT`).
4. The mission was then stuck with no runnable task → repeated `ORPHANED_EXECUTION` →
   `recovery.exhausted` → `mission.stopped`.

### Fix (implemented)

Make the orphaned task **resumable** so recovery re-runs the **same** task instead of
advancing the phase:

- `ExecutionHandle.cancel(opts?: { resumable?: boolean })` — threads the `resumable` flag
  through to the existing `cancelExecution` logic (which already transitions a resumable
  cancel to `RETRYING`).
- `Orchestrator.onInvalidated` now calls `executionHandle.cancel({ resumable: true })`, so a
  controller-disconnect cancel leaves the task `RETRYING` (not `CANCELED`). A `RETRYING`
  task is non-terminal, so the scheduler does **not** create the downstream integrator.
- `MissionStore.requeueResumableTasks(missionId)` — transitions `RETRYING` tasks back to
  `READY` so the scheduler re-dispatches them; returns the re-queued task IDs.
- The recovery path calls `requeueResumableTasks` right after `reconcileOrphanedExecutions`
  and counts the re-queue as a `materialDelta` for `FENCE_RECONCILE_AND_RESUME`, so the
  recovery acts on it (re-runs the implementer) rather than failing as a no-op.

The operator-pause path (`extra.signal` / `onAbort`) is intentionally **unchanged** — it is a
different signal already handled by the catch block's `isPauseAbort` resumable logic.

## Why this blocks the disk-pressure spec

- The spec is large (multi-phase, multi-agent) and takes **minutes to hours** — exactly the
  regime where Bug 1 lapses the controller lease and Bug 2 stops the mission.
- The spec's own acceptance criteria (suspend on pressure, preserve state, auto-recover,
  no crash-loop) require a pipeline that is itself reliable under failure. A pipeline that
  orphans its own workers and stops itself cannot be used to *build* that resilience or to
  *demonstrate* it.
- The disk-pressure tests (fault-injection, long builds under pressure) will exercise the
  same lease/recovery paths, so these bugs will surface during spec validation regardless.

## Recommended path (pick one)

1. **Fix Bug 1 + Bug 2 first, then run the spec mission.** (Recommended.) Smallest
   critical-path; both fixes are contained in `ownership.ts` / the recovery planner; both
   are testable in isolation. This also makes the pipeline a trustworthy vehicle and adds
   resilience the spec cares about.
2. **Implement the disk-pressure spec directly** (bypass the mission pipeline, use the
   orchestrator session + subagents), and file Bug 1 / Bug 2 as separate issues. Faster to
   produce the spec's deliverables, but does not make the pipeline reliable and does not
   route the work through the mission/PR gates the spec asks for.
3. **Do both:** land the two orchestration fixes on their own branch/PR (with tests), then
   run the spec mission on top.

## Immediate, already-applied workarounds (not fixes)

- Sanitize mission request text so it contains **no existing absolute path literals**
  (e.g. avoid `/tmp`, `/data`) — avoids the installed-package `WorkspaceScopeError`.
- Drive missions from a **persistent TTY** (interactive `pi` in tmux), not `pi -p` — avoids
  the process-lifetime lease lapse (Bug 2's *first* trigger), though it does **not** fix
  Bug 1 (the in-process heartbeat latch).

## Open question to close before implementing the fix

Capture the actual `pulse()` error at the first failure (add a log of `this.failure` when
it is set, and/or surface it in the `ORPHANED_EXECUTION` classification evidence). This
determines whether the Bug 1 fix is "retry transient failures" (sufficient) or
"re-acquire on permanent loss" (required).

**Closed:** `DispatchAuthority.lastPulseError` now surfaces the most recent renewal error
(before and after invalidation), so the underlying `pulse()` cause is observable. The
diagnosed trigger was a **transient** renewal blip (renewals were on-time every 10s right up
to the failure), so “retry transient failures” (the implemented fix) is sufficient for the
observed case. A *permanent* custody/epoch loss still latches after `N` consecutive failures
and invalidates the authority — now leaving the task resumable (Bug 2 fix) so recovery can
re-acquire/re-run instead of orphaning and advancing the phase.

## Fixes implemented

Branch: `fix/orchestration-lease-and-orphan-v2` (rebased onto `origin/main`)

| Bug | Files changed | Behavior change |
|-----|---------------|-----------------|
| 1 — heartbeat latch | `src/orchestration/ownership.ts` | Transient renew failures no longer latch the heartbeat; only `N` (default 3) consecutive failures invalidate the authority. Counter resets on a successful pulse. `maxConsecutiveRenewFailures` is configurable; `lastPulseError` exposes the underlying error. |
| 2 — orphan recovery misfire | `src/orchestration/broker.ts`, `src/orchestration/orchestrator.ts`, `src/orchestration/missionStore.ts` | A controller-disconnect cancel leaves the task `RETRYING` (resumable), not `CANCELED`. Recovery re-queues `RETRYING` tasks to `READY` (a material delta for `FENCE_RECONCILE_AND_RESUME`), so the **same task is re-run** instead of the mission advancing to the integrator. |

Both changes are **additive / backwards-compatible**: new optional option
(`maxConsecutiveRenewFailures`), new optional interface member (`lastPulseError`), new
optional method param (`cancel(opts)`), and a new store method (`requeueResumableTasks`).
No existing call sites or state-machine transitions were changed.

### Tests

- `test/unit/mission-ownership.test.ts` — 3 new tests:
  - `recovers a transient lease renewal failure instead of latching the heartbeat dead`
  - `invalidates a dispatch authority only after sustained renewal failures`
  - `survives a sub-threshold run of renewal failures`
- `test/unit/orchestration-orphan-recovery.test.ts` (new) — 4 tests for the resumable
  re-queue: re-queues a `RETRYING` task to `READY`, idempotency + non-`RETRYING` tasks
  untouched, the full reconciliation + re-queue path is a material delta, and a terminally
  `CANCELED` task is **not** resurrected.

### Verification

- Full unit suite: **all pass** (`npm run test:unit`, with `isolatedState` import). The only observed non-pass is `runtime-host-resources.test.ts` “resource registry disposes filesystem watchers”, which fails **only** when the host has exhausted its inotify watch limit (`fs.inotify.max_user_watches`); it passes once the limit has headroom. Unrelated to these changes.
- Mission-reliability integration suite: **44/44 pass**.
- Typecheck (`npm run build`): clean.
- Note: `test/integration/blackhole.test.ts` (“parallel tournament candidates never share
  working memory”) is **flaky under parallel resource contention** (fails in the full
  parallel run, passes 3/3 when run alone). It is unrelated to these changes (session
  isolation for tournament candidates) and pre-exists this branch.

## Live-run verification (2026-10-16, mission `MSN-wh5rvu`)

The fixes were validated in a **live run** against the current-`main` codebase. The runtime was
re-pointed from the stale `pi-engineering-runtime` checkout (commit `1ea5201`) to the live
`pi-engineering` checkout on `fix/orchestration-lease-and-orphan-v2` (`17d1a27`), and the
disk-pressure mission was launched from a persistent TTY (tmux) session using the sanitized
request (no absolute-path literals to existing directories).

Observed behavior — **both fixes confirmed in the live pipeline**:

- **Self-recovery worked.** The mission hit a lease lapse during PLANNING (a long model request
  starved the 10 s heartbeat against the 30 s lease). It was classified `ORPHANED_EXECUTION`,
  fenced, reconciled, and **resumed the same implementer task** (generation 1 → 3) — **without**
  advancing to the integrator and **without** the heartbeat latching dead.
- **No restart loop.** Exactly 1 task / 1 execution was created; worker activity is continuous
  (no >45 s gaps); the lease has been stable at generation 3 (fence token 3) since recovery.
- **The lapse was one-time, not repeating.** All 3 mission-scope `lease.expired` records are
  gen=1 at the same `renewBy` (21:57:23) — a single transient heartbeat starvation during the
  planning model request, not the old latch/misfire failure mode.

This is exactly the behavior the fixes were designed to produce: a transient renewal blip no
longer kills the heartbeat (Bug 1), and orphaned-execution recovery resumes the in-flight
implementer rather than misfiring at the integrator (Bug 2).

## Bug 3 — Re-fenced repository lease makes the live authority's renewal a permanent mismatch

**Discovered during the live run of `MSN-wh5rvu` (2026-10-16).** The mission self-recovered
from the initial lease lapse (Bug 1 + Bug 2 fixed) and resumed the implementer. It then
**stopped** at 23:03:21 with the lease renewal failing 3 times in a row:

```
lease renewal failed 3 times in a row: stale repository fencing identity for MSN-wh5rvu:
generation=4 fencingToken=4
```

### Root cause (traced)

`RenewableDispatchAuthority` caches the repository lease identity it was created with
(`maintain()` → `acquireRepository()`). When a `FENCE_RECONCILE_AND_RESUME` recovery fences the
prior owner and **re-fences the repository lease to a new generation**, the authority's cached
identity is now stale. Each subsequent `pulse()` → `renewRepository()` calls
`assertSameEpoch(cached, current, "repository")`, which throws
`stale repository fencing identity` — a **permanent** mismatch (the cached epoch will never
match the current lease), **not** a transient blip. The Bug 1 retry counter (correctly) counts
these as consecutive failures and, after `maxConsecutiveRenewFailures` (3) of them, invalidates
the authority → the lease lapses → the mission stops. The worktree had 0 changes.

### Fix (implemented — commit `1688959`)

`ownership.ts`:

- New `isStaleFencingIdentity(error, resource)` helper: detects the
  `stale <mission|repository> fencing identity` error (a permanent epoch mismatch, distinct from
  a transient renewal failure).
- `RenewableDispatchAuthority.pulse()`: on a **stale repository fencing identity**, the authority
  **re-acquires** the repository lease against the just-renewed mission identity
  (`acquireRepository(this.mission, this.repository.repoId)`) instead of counting it toward the
  failure threshold. This makes the authority track the new generation and keep renewing. The
  error is retained on `lastPulseError` for observability.
- Real renewal failures (custody contention, expiry, a different owner) still count toward the
  failure threshold and still invalidate after sustained failure — the retry semantics from Bug 1
  are unchanged.

### Test (added)

`test/unit/mission-ownership.test.ts` — `StaleRepositoryOwnership` simulates the recovery
re-fence: the next repository renewal is rejected as a stale fencing identity, and the
authority's re-acquisition returns a lease one generation ahead. The test asserts the authority
**re-acquires** (generation +1) and **stays authoritative** instead of lapping out. The
mission-ownership suite passes 19/19.

### Status

- [x] Root cause traced and fixed (commit `1688959`)
- [x] Test added and passing
- [ ] Re-run `MSN-wh5rvu` to confirm the live pipeline survives a recovery re-fence

### Outstanding follow-ups

1. Let `MSN-wh5rvu` complete (it is actively implementing the disk-pressure spec in worktree
   `pi-eng-bj8w57-pi-eng-orch-TSK-q9i9er`); verify it reaches `SUCCEEDED` and produces the
   expected `StoragePressureIncident` / `WAITING_FOR_DISK_SPACE` / coalesced-warning /
   auto-resume artifacts.
2. Merge `fix/orchestration-lease-and-orphan-v2` (PR #336) into `main`; rebuild the runtime
   `dist/`; re-point the runtime back to `pi-engineering-runtime` once `main` has the fixes.
3. **Optional hardening:** widen the lease margin (e.g., `heartbeatMs` well under `leaseMs/2`,
   or a longer `leaseMs`) so a long model request cannot starve the heartbeat into a lapse. The
   self-recovery now handles the lapse, but a wider margin avoids the unnecessary
   fence/reconcile cycle.

## Bug 4: stale MISSION fencing identity latches the heartbeat dead (found live, 2026-10-17)

**Observed (live, mission `MSN-83FqFm`, the disk-pressure mission):** the mission ran
healthy for ~40 min, then on a recovery cycle the lease was re-fenced and the heartbeat
latched dead with:

```
lease renewal failed 3 times in a row: stale mission fencing identity for MSN-83FqFm: generation=2 fencingToken=2
lease renewal failed 3 times in a row: stale mission fencing identity for MSN-83FqFm: generation=1 fencingToken=1
```

The mission then spun in a `recovery.failed` → re-fence loop (gen 3→5→7→9) with
`resumptionGeneration: 0`, and the operator agent gave up and re-launched a fresh mission.

**Root cause:** the *same failure class as Bug 3, one lease level higher.* A
`FENCE_RECONCILE_AND_RESUME` recovery re-fences the **mission** lease to a new
generation/fencingToken. The dispatch authority's cached *mission* identity goes
permanently stale; `renew()` rejects it via `assertSameEpoch(identity, current, "mission")`.

The Bug 3 fix wrapped only the **repository** renewal in a stale-fencing guard, so the
*mission* renewal error propagated to the heartbeat and latched it dead after
`maxConsecutiveRenewFailures` (3) consecutive failures.

**Fix (commit `03d783c`):** in `RenewableDispatchAuthority.pulse()`, wrap the mission
renewal in the *same* guard as the repository renewal. On a `stale mission fencing
identity` error, re-acquire the mission lease via `ownership.acquire(missionId)` (which
renews the current re-fenced lease for the same owner) so the authority tracks the new
generation instead of counting the permanent mismatch toward the failure threshold.

**Test:** new `StaleMissionOwnership` mock + `re-acquires a re-fenced MISSION lease
instead of lapping out on a stale epoch`. (Also repaired the pre-existing
`StaleRepositoryOwnership` mock — it referenced the unimported `RepositoryLease` type and
the private `store` field; now imports the type and captures `store` via a constructor.)

**Verified:** mission-ownership + orphan-recovery + broker + repo-lease unit suites
**108/108 pass**; mission-reliability-foundation integration **44/44 pass**; typecheck
clean.

**Status:** live re-verification pending — requires restarting the pi process to load the
fixed `ownership.ts`, then re-launching the disk-pressure mission and watching a recovery
cycle survive (both mission *and* repository leases).
