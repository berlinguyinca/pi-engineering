# Multi-Mission Lanes — per-repo concurrency coordination

**Date:** 2026-10-05
**Status:** approved design, pending spec review
**Extends:** `docs/specs/pi-engineering-orchestration/02-mission-dag-scheduler.md`, `05-worktrees-integration.md`
**Depends on:** `fix/stream-truncation-mission-recovery` (P0 stream-cut recovery, P1 orphan repair), `feat/concurrency-config` inc 1 (env-configurable limits, allocation diagnostics)

## 1. Problem

Dozens of missions on the same project cannot make parallel progress today:

- The scheduler serializes **any** two mutating tasks with overlapping write domains — including across missions — against an in-memory `activeTasks` map. A queue of missions on one repo effectively runs one mutating task at a time.
- The in-memory map is **per-runtime**: two hosts running missions against the same repo do not coordinate at all. `MissionOwnership` leases live in each host's local store; the only promotion critical section that exists (`GitRepo.assertPromotionUnlocked`, a `commonDir()` file lock) is local-filesystem-only. Cross-host, the only shared truth is the git repo itself.
- Concurrency attempts have surfaced as failures: 12 executions + 3 tasks died on worktree-allocation errors, and the global 3-agent ceiling (now env-configurable, inc 1) is the remaining hard serialization.

### Goals

- G1: Concurrent missions on the same repo make parallel progress when their write domains do not overlap.
- G2: Overlapping work stays serialized (safe by construction); integration conflicts are repairable, never permanent.
- G3: Correct across hosts: lane state lives in the shared git repo, self-heals after host crashes, no new infrastructure.
- G4: No new STOP/death-spiral path: lane acquisition is a wait, never a failure.
- G5: Single-host, local-only repos pay zero push round-trips.

### Non-goals (this increment)

- Cross-host duplicate-work dedup (two hosts planning the same request).
- Live rebasing of in-flight workers onto a moving base.
- FIFO lane fairness or per-lane priorities.
- GitHub-API-based coordination (rejected in approach selection; git refs are the substrate).

## 2. Decisions made during brainstorming

| Question | Decision |
|---|---|
| Overlapping-domain policy | **Serialize true overlaps only** (a): non-overlapping domains run in parallel; overlap-serialization telemetry is recorded to support an evidence-driven relax later |
| Stale base | **Resolve at integration** (a): integrator merges candidate against the current head of the base branch; conflict → existing `MERGE_CONFLICT` → `REBUILD_INTEGRATION_CANDIDATE` repair path |
| Scope | **Multi-host from the start** (b): lane state is durable and cross-host from day one |
| Substrate | **Git-ref-backed lane leases** (approach 1): one CAS-mutated ref per repo holds all live lane claims |

## 3. Requirements

- **R1 (parallel disjoint work):** two missions whose mutating tasks have non-overlapping write domains on the same repo may execute concurrently (same host or different hosts).
- **R2 (overlap serialization):** two mutating tasks with overlapping write domains (equality, prefix, or `**` per the existing `domainsOverlap` semantics) never execute concurrently on the same repo.
- **R3 (repo writer cap):** at most `PI_ENGINEERING_MAX_REPO_WRITERS` (default 4) concurrent mutating tasks per repo, across hosts.
- **R4 (crash self-heal):** when a lane holder's host dies, its lanes are takeable by any host after the lease expires; no operator intervention required.
- **R5 (wait, never fail):** a task blocked on lanes stays in a nonterminal schedulable state (returned to `READY`, or re-dispatched by its retry loop) and consumes no attempt; lane unavailability never produces a `FailureClassification`, a `STOP` recovery action, or a `BLOCKED` mission.
- **R6 (single integrator):** at most one integration task per repo at a time, across hosts.
- **R7 (stale base):** a candidate whose base moved while the worker ran is merged against the current base head at integration; a conflict enters the existing repairable conflict path.
- **R8 (local fast path):** a repo without a remote origin uses the in-memory coordinator; no network round-trips.
- **R9 (auditability):** every lane transition is a durable event; a blocked task's event names the blocking claim.

## 4. Design

### 4.1 Lane model

A **lane claim** is one row in the repo's lane index:

```jsonc
// ref: refs/lanes/<sha256(repoId)>   (ref name is the 64-hex-char digest)
{
  "version": 1,
  "claims": [
    {
      "domain": "src/orchestration",   // normalized write domain (existing canonicalizeWriteDomain, trailing "/**" stripped)
      "ownerId": "host-abc/owner-xyz", // runtime instance id (host + owner, as in MissionOwnership)
      "missionId": "MSN-xxxx",
      "taskId": "TSK-xxxx",
      "fence": 3,                       // monotonic per (repo, domain); takeover reads max + 1
      "acquiredAt": "2026-10-05T12:00:00.000Z",
      "renewBy":  "2026-10-05T12:05:00.000Z"
    }
  ]
}
```

- **One ref per repo** holds **all** live claims for that repo. Every mutation of the array (acquire, renew, release, stale-takeover) is a **compare-and-swap push**: read current content → compute new content → push; a push rejection (remote content changed) is the CAS failure → re-read and retry with bounded exponential backoff + jitter (reuse `backoffDelayMs` from `src/guard/transient.ts`). One CAS point per repo makes the overlap check race-free; no per-domain refs.
- **Live** means `renewBy >= now`. Stale entries are ignored by overlap/cap checks and are removed opportunistically by the next acquirer (recorded as a `lane.stale_taken` event).
- **Overlap is checked against claims, not lane keys:** the acquirer applies the existing `domainsOverlap` logic between its own (normalized) domains and each live claim's domain. This catches prefix overlaps (`src` vs `src/orchestration`) that a lane-per-declared-domain scheme would miss.
- **Reserved domain:** the string `<integration>` (no repo path can collide with it) is the integration lane. It overlaps only other `<integration>` claims — workers may start and run while an integrator is active (worker bases are frozen at allocation), but two integrators never are.
- **Cap:** the number of live non-`<integration>` claims on the repo must be below `PI_ENGINEERING_MAX_REPO_WRITERS` for a new worker claim to be granted.

### 4.2 `LaneCoordinator` interface

```ts
export interface LaneClaim {
  domain: string;
  ownerId: string;
  missionId: string;
  taskId: string;
  fence: number;
  acquiredAt: string;
  renewBy: string;
}

export interface LaneLease {
  repoId: string;
  domains: string[];
  ownerId: string;
  fence: number;
  renewBy: string;
}

export interface LaneCoordinator {
  /**
   * Acquire lane claims for all of the task's write domains (or the
   * <integration> domain). Resolves once every domain is held.
   * Rejects with LaneBlockedError { blockingClaims } when an overlap or the
   * repo writer cap prevents acquisition. Never times out on its own — the
   * scheduler decides how long to wait.
   */
  acquire(input: {
    repoId: string;
    domains: string[];
    ownerId: string;
    missionId: string;
    taskId: string;
    leaseMs: number;
    now?: () => number;
  }): Promise<LaneLease>;

  /** CAS-refresh renewBy. Rejects if this owner's entry is gone (taken over). */
  renew(lease: LaneLease): Promise<LaneLease>;

  /** CAS-remove this owner's entries. Idempotent (renewal-loss is not an error). */
  release(lease: LaneLease): Promise<void>;

  /** Live (non-stale) claims on a repo, for pre-checks and telemetry. */
  listClaims(repoId: string): Promise<LaneClaim[]>;
}
```

#### Backends

- **`InMemoryLaneCoordinator`** — the full semantics over a `Map<repoId, claims>` with an injectable clock. Used by hermetic unit tests and as the local-only fast path.
- **`GitRefLaneCoordinator`** — the CAS-push protocol over a `GitRepo`. New small `GitRepo` methods:
  - `readRemoteRef(name): Promise<string | null>` — `git ls-remote`/`git fetch` + `git show` of the ref (batched: one fetch per dispatch pass serves all repos).
  - `casRemoteRef(name, newContent, expectedContent): Promise<void>` — push with rejection as the CAS failure signal (re-read + retry loop lives in the coordinator, not in GitRepo).
  - Only reachable for repos with a remote origin (see selection). Pushes of `refs/lanes/*` are non-destructive metadata; they never touch branch heads.
- **Selection** (`resolveLaneCoordinator(repo, env)`, default `auto`): repo has a remote origin → `GitRefLaneCoordinator`; local-only → `InMemoryLaneCoordinator`. `PI_ENGINEERING_LANE_BACKEND=memory|git` overrides. A `git` override on a local-only repo is a configuration error (refused at open, surfaced as a finding) — it would silently provide no cross-host guarantee.

#### Lease lifecycle and crash semantics

- Lease TTL default 300000 ms (`PI_ENGINEERING_LANE_LEASE_MS`); renewed at TTL/2 while the owning task is `RUNNING`, piggybacking the broker's existing activity-heartbeat timer (one renewal per heartbeat tick that falls due).
- **Host crash:** renewals stop → entries go stale after TTL → any host's next acquire removes them (`lane.stale_taken`, names the dead owner). A crashed host's late renewal fails CAS (its entry is gone) and is dropped; its fence is superseded (takeover uses max fence + 1). No external watcher, no reaper process.
- **Corrupt lane index** (invalid JSON, wrong version): fail closed. The coordinator raises `LaneIndexCorrupt`; the broker records a `blocking` persistence finding (same pattern as `durableRepositoryDiagnostics`) and the repo's lanes are unusable until an operator repairs the ref. A corrupt index is never silently rewritten to empty.

### 4.3 Scheduler integration

- **Pre-check in `runnable()`:** a mutating task is runnable only if, against the coordinator's claim view, (a) no live claim overlaps its domains and (b) the repo writer cap has room. The git backend's claim view is a cached index refreshed per dispatch pass (the 10 ms loop already re-runs `runnable()`; refresh is at most once per pass, batched fetch). The existing in-process `activeTasks` domain check stays as a zero-latency pre-filter; the coordinator view is the authority.
- **Acquire at dispatch:** after `acquireAuthority` and before `broker.execute`, the scheduler acquires the task's lane (its write domains; `<integration>` for integration tasks). Outcomes:
  - granted → proceed, hold the lease;
  - blocked → task returns to `READY` with a short delay (no attempt consumed, `lane.wait` event names the blocking claim). The dispatch-time acquire is the backstop for same-pass races; the loser simply yields.
- **Hold and release:**
  - held across resilience-window retries (a task parked in `WAITING_FOR_LLM` keeps its lane so a queued mission cannot jump the line while the gateway is down);
  - **released when the mission pauses** (`PAUSED_INFRASTRUCTURE`) and re-acquired on resume — a paused mission must not hold repo lanes indefinitely;
  - released in `runOne`'s `finally` alongside the existing capacity `release()` (success, failure, cancellation, and the terminal-failure paths all flow through it).
- **No new failure path:** lane wait is the only new outcome, and it is a `READY` re-queue. Lane unavailability cannot produce a `FailureClassification`, a `STOP`, or a `BLOCKED` mission.
- **Global caps unchanged:** `maxAgents`/`maxActive`/`maxPerRole` (inc 1) remain the gateway-load axis; lanes are the repo-mutation axis.

### 4.4 Integration lane and stale base

- Integration tasks acquire the `<integration>` lane for their repo.
- The integrator merges the candidate against the **current head of the mission's target branch** (the branch the mission's `base_ref` points to — `main` in the common case; fetched at integration time), not against the worker's frozen base:
  - clean merge → publish (existing flow);
  - conflict → existing `MERGE_CONFLICT` classification → `REBUILD_INTEGRATION_CANDIDATE` (recoverable end-to-end after P0/P1).
- Workers are **never** rebased live; a mission planned against commit X keeps working against X (spec 05 invariant).
- Push belt-and-suspenders: if the merged push to the base branch is rejected (should not happen under the lane; can happen against a crashed lane holder's in-flight push), the integrator re-fetches, re-merges against the new head, retries once; a second conflict enters the repair path.

### 4.5 Configuration and telemetry

| Env var | Default | Meaning |
|---|---|---|
| `PI_ENGINEERING_LANE_BACKEND` | `auto` | `auto` \| `memory` \| `git` (see 4.2 selection) |
| `PI_ENGINEERING_LANE_LEASE_MS` | `300000` | lane lease TTL; renewed at TTL/2 |
| `PI_ENGINEERING_MAX_REPO_WRITERS` | `4` | concurrent mutating tasks per repo, across hosts (0 = unlimited) |

Events (durable, on the mission event stream): `lane.acquired` (repo, domains, fence), `lane.released`, `lane.wait` (blocking claims), `lane.stale_taken` (dead owner, domains — this is also where a renewal loss surfaces, on the takeover side), `lane.index_corrupt` (blocking finding). Successful renewals are deliberately **not** events: they are the hot path and carry no decision information. The **overlap-serialization record** (`lane.wait` with the blocking claim) is the telemetry that decides, later, whether narrow-domain missions justify relaxing to merge-time conflict resolution.

## 5. Testing

- **Unit — in-memory coordinator (injected clock):** acquire/grant, overlap rejection (equality, prefix both directions, `**`), cap enforcement, renew refresh, idempotent release, stale takeover (fence = max+1, dead entry removed), corrupt-index rejection.
- **Unit — git-ref coordinator (local bare origin fixture):** CAS contention with two coordinators mutating the same index (both succeed, serialized, no lost updates), stale takeover after lease expiry, push-rejection retry, corrupt-index finding.
- **Unit — scheduler:** two missions, disjoint domains → both dispatch concurrently; overlapping → the second stays `READY` until the first settles; `**` claim blocks all new mutating tasks; repo writer cap enforced; lane released on task settle and on mission pause; blocked acquire consumes no attempt.
- **Integration — two orchestrators, shared bare origin, separate stores:** disjoint-domain missions complete in parallel; overlapping domains serialize across hosts; a "crashed" holder (coordinator discarded without release) is taken over after lease expiry and the waiting mission proceeds.
- **Regression:** full unit suite, mission-reliability foundation, orchestrator resilience/long-outage/recovery, worker stream truncation — all green.

## 6. Rollout

1. `LaneCoordinator` interface + `InMemoryLaneCoordinator` + full unit coverage (no behavior change yet).
2. `GitRefLaneCoordinator` + `GitRepo` ref methods + git-fixture unit coverage.
3. Scheduler integration (pre-check, acquire/hold/release, pause release) + scheduler unit coverage.
4. Integration lane + merge-against-current-head + push-retry + cross-host integration tests.
5. Telemetry events + config resolution + docs (`docs/usage.md` lane section).

Each step lands green (unit + lint + typecheck) before the next.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Push-rejection storms under many lanes | one CAS point per repo (not per domain); batched fetch per dispatch pass; backoff + jitter from the existing `backoffDelayMs`; repo writer cap bounds contenders |
| Lane ref bloat / GC | released claims are removed at release; acquirers prune stale entries opportunistically; the ref holds only live claims, bounded by the writer cap |
| Clock skew across hosts taking over live lanes | lease TTL (5 min) ≫ typical NTP skew; renewals at TTL/2 leave a full TTL/2 margin; takeover removes and re-claims in one CAS, so a skew-induced double-take still serializes |
| Corrupt index wedges a repo | fail-closed finding with explicit operator remedy (ref repair); never silently reset |
| Scheduler latency from fetches | cached claim view refreshed at most once per 10 ms dispatch pass; local-only repos use the in-memory backend (zero round-trips) |
