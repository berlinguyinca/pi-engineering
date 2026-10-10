# Multi-Mission Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Concurrent missions on the same repo make safe parallel progress — overlapping write domains serialize through durable, crash-self-healing lane claims, correct across hosts.

**Architecture:** One CAS-mutated git ref per repo (`refs/lanes/<sha256(repoId)>`) holds all live lane claims; a `LaneCoordinator` interface fronts two backends (in-memory fast path, git-ref cross-host). The scheduler pre-checks a cached claim view in `runnable()`, acquires the lane for the whole run (held across resilience retries, released on terminal/pause), and treats lane contention as a wait that never consumes an attempt.

**Tech Stack:** TypeScript (strict, ESM `.ts` imports), Node built-in test runner (`node --test`), `async-scheduler` pool, existing `GitRepo` git-plumbing wrapper, `biome` format/lint.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-mission-lanes-design.md` — argue from the spec; read both.

## Global Constraints

- Work lands on branch `feat/concurrency-config` (stacks P0 `5cbfa79` + P1 `c14fd11` + inc1 `4ca28cc` + spec `9c6e956`). **The live orchestrator process switches branches in this checkout mid-work**: re-check `git branch --show-current` immediately before every commit and re-checkout `feat/concurrency-config` if it moved. Never commit lane work to `feat/worktree-isolation-integral`.
- No new runtime npm dependencies. Git access only through `GitRepo` (its private `git(args)` helper).
- Env names exactly: `PI_ENGINEERING_LANE_BACKEND` (`auto`|`memory`|`git`, default `auto`), `PI_ENGINEERING_LANE_LEASE_MS` (default `300000`), `PI_ENGINEERING_MAX_REPO_WRITERS` (default `4`, `0` = unlimited). Invalid values fall back to the default for that key (same pattern as `resolveSchedulerLimits`).
- Lane wait is never a failure: no `FailureClassification`, no `STOP`, no `BLOCKED` may result from lane contention (spec R5).
- Local-only repos (no remote origin) must issue zero network calls (spec R8).
- Every task ends with: touched test files green (`node --test <file>`), `npm run lint` clean, `npm run typecheck` clean, one commit.
- `npm run test:unit` has a pre-existing git-fixture flake while the live orchestrator shares this checkout (40–46 cancels, moves between runs). Judge by per-file isolated runs, not suite noise.

### Spec refinements (already decided — implement as stated here)

1. **Timestamps are epoch milliseconds** (internal + ref JSON), not ISO strings — needed for the injectable clock in tests.
2. **Renewals piggyback the scheduler's existing 10 ms `runMission` loop** (not the broker heartbeat): same intent (no new timer), and lane logic stays cohesive in the scheduler. Renew due-ness is checked per pass; a renewal fires at most once per `leaseMs/2` per held lease, with a per-task in-flight guard.
3. **`renew()` resolves `null` on lease loss** (entry gone/taken over) instead of rejecting; the scheduler then stops renewing silently (the taker already emitted `lane.stale_taken`).
4. **Lane repo key** is `task.repo_id ?? mission.repository`. The existing in-process `activeTasks` overlap check (which treats an undefined `repo_id` as matching any repo) stays unchanged as the same-host pre-filter, so same-host behavior is bit-identical to today; the lane layer adds the cross-host claim keyed by the concrete repo path.

---

## Review Focus

Failure modes no task's happy-path tests exercise, most likely to bite first. Each line gets a pinning test in the named task:

1. **Renewal-loss race:** a lease renewed by a task whose claim was already taken over must not resurrect or clobber the new owner's entry (expect: `renew` → `null`, new claim untouched) — Task 1/3.
2. **Same-taskId redispatch:** a retried task re-acquiring its own live claim must not self-deadlock or double-count against the cap (expect: acquire with matching `taskId` refreshes its own entry) — Task 1/5.
3. **Boundary instant of `renewBy == now`:** a claim is live while `renewBy >= now` (takeover only strictly after expiry) — Task 1.
4. **Mutating task with empty `write_domains`:** must claim `**` (the most conservative domain), never nothing — Task 1.
5. **Corrupt lane index:** invalid JSON / unknown version must throw `LaneIndexCorruptError` and never be overwritten with empty content — Task 3.

---

### Task 1: Lane core — types, config, overlap relocation, `InMemoryLaneCoordinator`

**Files:**
- Create: `src/orchestration/lanes.ts`
- Modify: `src/orchestration/workset.ts` (append `normalizeDomain` + `domainsOverlap`, moved from `scheduler.ts:198-218`)
- Modify: `src/orchestration/scheduler.ts` (`normalizeDomain`/`domainsOverlap` bodies replaced by re-export from `workset.ts`; keep the same exported names — `test/unit/orchestration-scheduler.test.ts` imports them from `scheduler.ts` and must keep passing untouched)
- Test: `test/unit/lanes-core.test.ts`

**Interfaces:**
- Consumes: `canonicalizeWriteDomain` from `src/orchestration/workset.ts`
- Produces (all exported from `src/orchestration/lanes.ts`; Tasks 3, 5, 6 rely on these exact names):
  - `const INTEGRATION_DOMAIN = "<integration>"`
  - `interface LaneClaim { domain: string; ownerId: string; missionId: string; taskId: string; fence: number; acquiredAt: number; renewBy: number }`
  - `interface LaneLease { repoId: string; ownerId: string; missionId: string; taskId: string; domains: string[]; fence: number; renewBy: number }`
  - `class LaneBlockedError extends Error { constructor(readonly blockingClaims: LaneClaim[]) }` (`message`: `"lane blocked by ${n} live claim(s)"`)
  - `class LaneIndexCorruptError extends Error` (message contains `"lane index is corrupt"`)
  - `class LaneBackendMisconfiguredError extends Error` (message contains `"PI_ENGINEERING_LANE_BACKEND=git"`)
  - `interface LaneCoordinator { acquire(i: { repoId: string; domains: string[]; ownerId: string; missionId: string; taskId: string }): Promise<LaneLease>; renew(lease: LaneLease): Promise<LaneLease | null>; release(lease: LaneLease): Promise<void>; listClaims(repoId: string): Promise<LaneClaim[]>; readonly maxRepoWriters: number }`
  - `class InMemoryLaneCoordinator implements LaneCoordinator { constructor(opts: { config?: Partial<LaneConfig>; now?: () => number }) }`
  - `interface LaneConfig { backend: "auto" | "memory" | "git"; leaseMs: number; maxRepoWriters: number }`
  - `function resolveLaneConfig(env?: Record<string, string | undefined>): LaneConfig` (defaults `{ backend: "auto", leaseMs: 300_000, maxRepoWriters: 4 }`; invalid → per-key default; unknown `backend` value → `"auto"`)
  - `function laneKeyFor(repoId: string): string` → `` `refs/lanes/${sha256hex(repoId)}` `` (64-hex digest, `node:crypto`)
  - `function laneDomainsOf(task: { kind: string; write_domains: string[] }): string[]` — `kind === "integration"` → `[INTEGRATION_DOMAIN]`; else normalized `write_domains`; empty/missing → `["**"]`
  - `type LaneEventKind = "lane.acquired" | "lane.released" | "lane.wait" | "lane.stale_taken" | "lane.index_corrupt"`
  - `type LaneEventSink = (kind: LaneEventKind, missionId: string, payload: Record<string, unknown>) => void`

- [ ] **Step 1: Write the failing test file** `test/unit/lanes-core.test.ts` (pattern: `test/unit/transient.test.ts` — pure, injected clock). Cover with these exact behaviors:
  - `resolveLaneConfig({})` deep-equals defaults; `{ PI_ENGINEERING_MAX_REPO_WRITERS: "9", PI_ENGINEERING_LANE_LEASE_MS: "60000", PI_ENGINEERING_LANE_BACKEND: "git" }` resolves all three; `"abc"` / `"0"` for lease/writer keys → per-key default; `backend: "nonsense"` → `"auto"`.
  - `laneKeyFor("repo-a")` matches `/^refs\/lanes\/[0-9a-f]{64}$/` and is stable/digest-keyed.
  - `laneDomainsOf({ kind: "integration", write_domains: [] })` = `[INTEGRATION_DOMAIN]`; `{ kind: "agent", write_domains: ["src/a/**"] }` = `["src/a"]`; `{ kind: "agent", write_domains: [] }` = `["**"]`.
  - InMemory coordinator (injectable `now`): disjoint domains both acquire; overlapping acquire rejects `LaneBlockedError` naming the blocker; prefix overlap both directions (`src` vs `src/orchestration`) rejects; `**` overlaps everything and is overlapped by everything; **boundary**: claim with `renewBy === now()` is live (blocks), at `now() + 1` past expiry another acquirer takes it over (old entry gone, `fence = old + 1`); cap: with `maxRepoWriters: 2`, third disjoint claim rejects `LaneBlockedError`, `maxRepoWriters: 0` is unlimited; integration domain blocks only integration (`<integration>` vs `src` never overlaps; second integration rejects while first held; integration claims do not count against the writer cap); redispatch: re-acquire same `taskId` + overlapping domains succeeds (refresh, no cap double-count); `renew` refreshes `renewBy`, `renew` after `release` → `null`; `release` idempotent (double release resolves); `listClaims` shows only live claims.

- [ ] **Step 2: Run to verify red** — `node --test test/unit/lanes-core.test.ts` (fails: module not found).

- [ ] **Step 3: Implement.** Move `normalizeDomain`/`domainsOverlap` verbatim into `workset.ts`; in `scheduler.ts` delete the two bodies and add `export { domainsOverlap, normalizeDomain } from "./workset.ts";` (adjust the existing `import { canonicalizeWriteDomain }` — scheduler no longer needs it directly unless other call sites remain). Write `lanes.ts`: the types above; `InMemoryLaneCoordinator` over `Map<repoId, LaneClaim[]>`:
  - `acquire`: prune stale (`renewBy < now`); if own live `taskId` entry exists for this repo → replace those entries (redispatch refresh) reusing `fence = max(existing fence for each domain) + 1`; else overlap-check each domain against live claims (`domainsOverlap([domain], [claim.domain])`, integration never overlaps non-integration), cap-check live non-integration claim count when claiming non-integration domains; grant appends one claim per domain with `acquiredAt = renewBy = now + leaseMs`.
  - `renew`: entries matching `(taskId, fence)` → refresh `renewBy`, return updated lease; none → `null`.
  - `release`: drop entries matching `(taskId, fence)`; never throws.

- [ ] **Step 4: Run tests green** — `node --test test/unit/lanes-core.test.ts && node --test test/unit/orchestration-scheduler.test.ts` (the re-export keeps the old imports working).

- [ ] **Step 5: Lint/typecheck + commit** — `npx biome format --write src/orchestration/lanes.ts src/orchestration/workset.ts src/orchestration/scheduler.ts test/unit/lanes-core.test.ts && npm run lint && npm run typecheck`; commit `feat(orchestration): lane core — types, config, in-memory coordinator` (verify branch first).

---

### Task 2: `GitRepo` remote-ref CAS primitives

**Files:**
- Modify: `src/git/GitRepo.ts` (three new public methods)
- Test: `test/unit/git-remote-ref.test.ts`

**Interfaces:**
- Consumes: private `git(args: string[])` helper already on `GitRepo`
- Produces (Task 3 relies on these):
  - `async hasRemoteOrigin(): Promise<boolean>`
  - `async readRemoteRef(ref: string): Promise<{ sha: string; content: string } | null>` — `null` when ref absent
  - `async casPushRef(ref: string, content: string, expectedSha: string | null): Promise<{ ok: boolean; remoteSha: string | null }>` — never rejects on CAS loss

- [ ] **Step 1: Write the failing test** `test/unit/git-remote-ref.test.ts`. Fixture (mirror the `execFile` git setup used in `test/unit/orchestration-broker.test.ts`): temp dir → `git init --bare origin.git`; `git init work` + commit + `git remote add origin ../origin.git`; `GitRepo.open(work)`. Assert: `hasRemoteOrigin()` true (false for a repo with no remote); `readRemoteRef` → `null` for absent ref; `casPushRef(ref, "c1", null)` → `{ ok: true }`, then `readRemoteRef` returns `{ sha, content: "c1" }`; re-push same content with correct `expectedSha` → ok; push with stale `expectedSha` → `{ ok: false, remoteSha: <current> }` and remote content unchanged; concurrent-style race: read sha, push v2 (ok), then push v3 with the pre-v2 sha → `{ ok: false }`.

- [ ] **Step 2: Run to verify red** — FAIL (methods don't exist).

- [ ] **Step 3: Implement on `GitRepo`** (bodies use the private `git()`; the plumbing sequence below is the chosen algorithm):
  - `hasRemoteOrigin`: `git remote get-url origin` success → true; nonzero exit → false.
  - `readRemoteRef`: `ls-remote origin <ref>` → empty → `null`; else `fetch origin <ref>:refs/pieng-lane-tmp` then `show refs/pieng-lane-tmp:lanes.json` (content) + `rev-parse refs/pieng-lane-tmp` (sha); finish `update-ref -d refs/pieng-lane-tmp`.
  - `casPushRef`: write content via `hash-object -w --stdin`; build tree with `mktree` (line `100644 blob <sha>\tlanes.json`); orphan commit via `commit-tree <tree> -m "pi-eng lane index"`; push: `expectedSha === null` → plain `push origin <commit>:<ref>` (rejected if ref appeared = CAS loss); else `push --force-with-lease=<ref>:<expectedSha> origin <commit>:<ref>`. On push failure re-`ls-remote` and return `{ ok: false, remoteSha }`; on success `{ ok: true, remoteSha: commit }`.

- [ ] **Step 4: Run tests green** (isolated file; git-fixture suite noise per Global Constraints).

- [ ] **Step 5: Format/lint/typecheck + commit** — `feat(git): remote-ref read and compare-and-swap push primitives`.

---

### Task 3: `GitRefLaneCoordinator` — CAS lane claims over git

**Files:**
- Create: `src/orchestration/lanesGit.ts`
- Test: `test/unit/lanes-git.test.ts`

**Interfaces:**
- Consumes: Task 1 (`LaneCoordinator`, `LaneClaim`, `InMemoryLaneCoordinator`, `resolveLaneConfig`, `laneKeyFor`, `INTEGRATION_DOMAIN`, error classes, `LaneEventSink`), Task 2 (`GitRepo.readRemoteRef`, `casPushRef`, `hasRemoteOrigin`), `backoffDelayMs(attempt, config, rand)` from `src/guard/transient.ts` (reuse the `DEFAULT_BACKOFF`-style config used in `src/guard/transient.ts` if exported, else construct `{ baseMs: 20, maxMs: 400, factor: 2 }` — check the real export name in that file and use it).
- Produces (Task 6 wires this):
  - `class GitRefLaneCoordinator implements LaneCoordinator { constructor(opts: { config: LaneConfig; openRepo: (repoId: string, missionId: string) => Promise<GitRepo | null>; onLaneEvent?: LaneEventSink; now?: () => number; rand?: () => number }) }`

- [ ] **Step 1: Write the failing test** `test/unit/lanes-git.test.ts`. Fixture: shared bare origin + two clones (`hostA`, `hostB`), each with its own `GitRepo` and its own `GitRefLaneCoordinator` whose `openRepo` returns that host's GitRepo (Task 2 patterns). Assert:
  - A acquires `src/a`, B acquires `src/b` → both succeed; B's `listClaims` after a fresh operation sees A's claim.
  - B acquiring `src/a` rejects `LaneBlockedError` (blocker names A's ownerId).
  - CAS contention: with clock frozen, interleave — A reads, B reads, A renews/releases, B then acquires a disjoint domain — final index contains both claims (no lost update).
  - Stale takeover: A acquires with short lease (config `leaseMs: 100`), advance injected `now` past expiry, B acquires overlapping domain → succeeds, index no longer holds A's entry, `onLaneEvent` received `lane.stale_taken` naming A's ownerId + missionId.
  - Renewal loss: after the takeover, A `renew` → `null` and B's claim is untouched (Review Focus 1).
  - Corrupt index: write garbage to the lane ref (via `casPushRef` with non-JSON content), then `acquire` rejects `LaneIndexCorruptError`; index content unchanged afterward (Review Focus 5).
  - No-origin repo, `backend: "auto"`: coordinator with `openRepo` on an origin-less `GitRepo` delegates to in-memory (claims work, `hasRemoteOrigin` not exercised over network); same setup with `backend: "git"` rejects `LaneBackendMisconfiguredError`.

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement** `lanesGit.ts`. Per-operation flow (shared `withIndex(repoId, missionId, mutate)` helper): resolve `repo = await openRepo(...)`; `repo === null` → delegate to an internal `InMemoryLaneCoordinator` (auto/memory) ; `backend === "git" && !(await repo.hasRemoteOrigin())` → throw `LaneBackendMisconfiguredError`; else read `laneKeyFor(repoId)` → parse `{ version: 1, claims }` (parse failure → `LaneIndexCorruptError`), prune stale into a `taken` list, run the same grant/overlap/cap/renew/release logic as the in-memory core (share it: extract the pure claim-array mutations — grant/renew/release/prune/overlap — from `InMemoryLaneCoordinator` into exported pure helpers in `lanes.ts` in this step: `grantClaims(claims, input, cfg, now)`, `renewClaims`, `releaseClaims`, `pruneStale`, `findOverlaps` so both backends run identical semantics), then `casPushRef(key, JSON, expectedSha)`; on CAS loss retry up to 8× with `backoffDelayMs`; after the loop emit `lane.stale_taken` for each pruned claim via `onLaneEvent`. `listClaims` = read + prune-in-view (no push).

- [ ] **Step 4: Run tests green.**

- [ ] **Step 5: Format/lint/typecheck + commit** — `feat(orchestration): git-ref lane coordinator with CAS claims and stale takeover`.

---

### Task 4: Lane events on the mission event stream

**Files:**
- Modify: `src/orchestration/missionStore.ts` (`OrchestrationEventType` at :49; new public method near `addFinding` :1600)
- Test: `test/unit/orchestration-lane-events.test.ts`

**Interfaces:**
- Consumes: private `emit(type, missionId, payload, timestamp?)` (:361)
- Produces (Task 5 calls this):
  - `OrchestrationEventType` gains exactly: `"lane.acquired" | "lane.released" | "lane.wait" | "lane.stale_taken" | "lane.index_corrupt"`
  - `recordLaneEvent(type: LaneEventKind-ish union, missionId: string, payload: Record<string, unknown>): void` — wraps `emit` with `actor: "system"` merged-defaulted payload; mission id required (all lane events are mission-scoped; stale_taken uses the dead holder's missionId from the claim).

- [ ] **Step 1: Write the failing test** — open `MissionStore.open(JsonlEventStore.inMemory())`, create a mission, `store.recordLaneEvent("lane.acquired", id, { repo_id, task_id, domains: ["src/a"], fence: 1 })`; assert `store.listEvents(id)` (use the store's real event-listing API — check how `test/unit/orchestration-recovery-planner.test.ts` inspects events) contains the typed event with `actor === "system"` and payload fields; `lane.wait` payload carries `blocking_claims`.

- [ ] **Step 2: Red.** **Step 3: Implement** the type additions + method (fire-and-forget like other emitters). **Step 4: Green.** **Step 5: Format/lint/typecheck + commit** — `feat(orchestration): durable lane events on the mission stream`.

---

### Task 5: Scheduler integration — pre-check, acquire/hold/release, renewal, lane for integrations

**Files:**
- Modify: `src/orchestration/scheduler.ts`
- Test: `test/unit/orchestration-scheduler-lanes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`LaneCoordinator`, `InMemoryLaneCoordinator`, `LaneBlockedError`, `laneDomainsOf`, `INTEGRATION_DOMAIN`, `domainsOverlap`), Task 4 (`store.recordLaneEvent`).
- Produces: `SchedulerOptions` gains `lanes?: LaneCoordinator` (default `new InMemoryLaneCoordinator({ config: { maxRepoWriters: 0 } })` — unlimited: the built-in default must not serialize anything existing tests do; production always injects the config-resolved coordinator through Task 6 wiring, where the cap-4 default applies) and `ownerId?: string` (default `lane-owner-${crypto.randomUUID()}`); `laneRepoKey(task, missionRepository)` helper (exported for tests): `task.repo_id ?? missionRepository`.

- [ ] **Step 1: Write the failing test** `test/unit/orchestration-scheduler-lanes.test.ts`. Scaffold: copy the mission/task creation helpers from `test/unit/orchestration-scheduler.test.ts` (`createExecutingMission`-style); scheduler constructed with explicit `limits: { maxAgents: 4, maxPerRole: 4 }` (above the writer cap so lanes are the binding constraint) and a shared `InMemoryLaneCoordinator` with injected clock; broker with a **deferred agent backend** (promise the tests resolve manually — pattern from `test/integration/worker-stream-truncation.test.ts`) so task completion is test-controlled. Assert:
  - two missions, disjoint domains (`src/a` / `src/b`): both executions start (both backends invoked without resolving any).
  - overlapping (`src/a` vs `src/a/**`): second mission's task never starts; after resolving the first backend, the second starts on a later pass; a `lane.wait` event exists naming the blocker (via `store.listEvents`).
  - `**` claim blocks a second mutating task; non-mutating validation task runs regardless.
  - cap `maxRepoWriters: 2`: third disjoint mutating task waits.
  - blocked acquire consumes no attempt: waiting task's `attempt` stays 0 and its status is never FAILED/BLOCKED; `lane.wait` emitted.
  - release on settle: after the first task's backend resolves + mission settles, a previously-blocked same-domain task proceeds.
  - foreign live claim (seeded via `coordinator.acquire` for another owner): task waits; advance injected clock past its lease; task proceeds (takeover path through the scheduler).
  - integration task: integration task waits while a foreign integration claim is held, and a normal agent task runs *during* a held integration claim (spec 4.4).

- [ ] **Step 2: Run to verify red** (constructor ignores `lanes`).

- [ ] **Step 3: Implement in `scheduler.ts`:**
  - Fields: `private readonly lanes`, `private readonly ownerId`, `private laneView = new Map<string, LaneClaim[]>()`, `private lastLaneViewAt = new Map<string, number>()` (refresh throttle: skip re-fetch for a repo key within 1000 ms of the last — the 10 ms loop must not hammer `listClaims`), `private laneRenewals = new Map<string, { lease: LaneLease; nextRenewAt: number }>()`, `private laneRenewInFlight = new Set<string>()`.
  - `runMission` while-loop, once per pass before `const runnable = ...`: `await this.refreshLaneViews(missionId)` (collect distinct `laneRepoKey(t, mission.repository)` for non-terminal mutating tasks of this mission; refresh those not throttled) then `await this.renewDueLanes()`.
  - `runnable(missionId)` and `hasConflict`: keep the in-process checks **exactly as-is**; add to the runnable filter for `t.mutates_repo`: `this.laneViewBlocked(t, missionRepository)` — sync check against `laneView`: overlaps a live claim with `taskId !== t.task_id` → blocked; writer-cap full with live non-integration claims (skip cap check when `laneDomainsOf(t)` is the integration domain).
  - `runOne`: before `this.executeWithRetry`, for `task.mutates_repo`: `lease = await this.lanes.acquire({ repoId: laneRepoKey(task, repo), domains: laneDomainsOf(task), ownerId: this.ownerId, missionId: task.mission_id, taskId: task.task_id })` — on `LaneBlockedError`: `store.recordLaneEvent("lane.wait", mission_id, { task_id, repo_id, blocking_claims })` and `return` (the existing `finally` releases capacity; task stays READY; attempt untouched); on `LaneIndexCorruptError`/other: `store.addFinding` (severity `blocking`, summary names the error) + `store.recordLaneEvent("lane.index_corrupt", ...)` + `return` (wait, never fail — R5). On success: `laneRenewals.set(task_id, { lease, nextRenewAt: now + leaseMs/2 })`, `store.recordLaneEvent("lane.acquired", ...)`. Add to the existing `finally`: `laneRenewals.delete`, `await this.lanes.release(lease).catch(() => undefined)` when a lease was held, `lane.released` event.
  - `renewDueLanes()`: for due, not-in-flight renewals: mark in-flight, `const next = await this.lanes.renew(lease)`; `null` → delete from `laneRenewals` (silently, per refinement 3); else update lease + `nextRenewAt`. Never throw out of the loop.

- [ ] **Step 4: Green** — new file + `test/unit/orchestration-scheduler.test.ts` + `test/unit/orchestration-scheduler-resilience.test.ts` (no behavior change without lanes contention: the built-in default coordinator is overlap-checking but cap-unlimited, and same-host overlaps were already serialized by the untouched `activeTasks` pre-filter).

- [ ] **Step 5: Format/lint/typecheck + commit** — `feat(orchestration): scheduler lane integration (wait-never-fail)`.

---

### Task 6: Orchestrator wiring, config resolution, integration proof, docs

**Files:**
- Modify: `src/orchestration/orchestrator.ts` (scheduler construction :256 + constructor opts)
- Modify: `docs/usage.md` (short "Concurrency lanes" section: env vars, defaults, cross-host behavior, operator remedy for `lane.index_corrupt`)
- Test: `test/integration/multi-host-lanes.test.ts`

**Interfaces:**
- Consumes: Tasks 1/3/5 (`resolveLaneConfig`, `GitRefLaneCoordinator`, `SchedulerOptions.lanes`), `GitRepo.open`
- Produces: `OrchestratorOptions` gains `lanes?: LaneCoordinator` (test seam; production default resolved here).

- [ ] **Step 1: Write the failing integration test** `test/integration/multi-host-lanes.test.ts` (scaffold: `test/integration/orchestrator-resilience.test.ts` for orchestrator construction; Task 2 for the bare-origin fixture). Two in-process orchestrators (own `MissionStore.open(JsonlEventStore.inMemory())`, own worktree clone of one bare origin, `lanes:` = `GitRefLaneCoordinator` per host over a 200 ms lease + injected clock, deferred agent backends). Scenario A: mission on each host, disjoint write domains → both `execution.started` before either resolves (parallel). Scenario B: overlapping domains → host B's execution starts only after host A's resolves (serialize), both complete. Close with the deterministic scheduler-level takeover already pinned in Task 5 (foreign claim expiry) — do not build a timing-based crash test here.

- [ ] **Step 2: Red** (orchestrator ignores `opts.lanes`).

- [ ] **Step 3: Wire in `orchestrator.ts` constructor:** `this.lanes = opts.lanes ?? new GitRefLaneCoordinator({ config: resolveLaneConfig(), openRepo: async (repoId, missionId) => { /* mission.repository when repoId matches it or task-less; else resolve via opts.repositoryRegistry + store.getWorkspaceManifest(missionId) exactly like the broker's resolveRepository closure at :230-250, then GitRepo.open(context.root) */ }, onLaneEvent: (kind, missionId, payload) => this.store.recordLaneEvent(kind, missionId, payload) })`; pass `lanes: this.lanes` into `new MissionScheduler({...})`. Keep `InMemoryLaneCoordinator` reachable for single-repo-no-origin setups through `PI_ENGINEERING_LANE_BACKEND=memory` (coordinator-level, already implemented).

- [ ] **Step 4: Green** — `node --test test/integration/multi-host-lanes.test.ts`; then regression: `node --test test/integration/orchestrator-recovery.test.ts test/integration/orchestrator-resilience.test.ts test/integration/orchestrator-long-outage.test.ts test/integration/mission-reliability-foundation.test.ts test/integration/worker-stream-truncation.test.ts` (expect 92+ pass, 0 fail — baseline before this plan).

- [ ] **Step 5: Docs + format/lint/typecheck + commit** — `feat(orchestration): wire lane coordinators into orchestrator (multi-host by default)`.

---

## Self-review notes (author, pre-handoff)

- Spec coverage: R1/R2 (Tasks 1/5), R3 (1/5), R4 (3 + Task 5 foreign-claim expiry), R5 (5: wait path, no-attempt pin), R6 (5: integration lane), R7 — **already shipped** in the integrator's merge path? No: R7 (merge-against-current-head + push-retry) is spec 4.4 work not represented by any task here. **Added as Task 7 below.**
- R8 (Task 3 no-origin delegation), R9 (Task 4/5 events).
- Type consistency: `renew` returns `LaneLease | null` everywhere; `LaneCoordinator.maxRepoWriters` readonly property used by scheduler cap check; `laneRepoKey(task, missionRepository)` same name in Tasks 5/6.

### Task 7: Integration lane enforcement in the integrator — merge against current head + push retry (spec 4.4 / R7)

**Files:**
- Modify: `src/orchestration/integrator.ts` (the merge/push path — locate `mergeCandidate`/push-to-base logic and wrap it)
- Test: `test/unit/orchestration-integrator-stale-base.test.ts`

**Interfaces:**
- Consumes: `GitRepo` (existing merge helpers), scheduler Task 5 (integration tasks already claim `INTEGRATION_DOMAIN`; this task makes the *merge target* current-head instead of frozen-base).
- Produces: integrator behavior change only; no new exports.

- [ ] **Step 1: Write the failing test** — fixture repo; candidate branched at base X; advance the repo head with an unrelated commit to X' (touching a different file); run integration: merged head includes both (clean merge against current head); second case: move-head commit touches the same lines → integration reports a conflict failure whose message matches `/(merge conflict|conflict)/i` (so `classifyFailure` keeps routing it to `REBUILD_INTEGRATION_CANDIDATE`) and the repo head is unchanged (no partial publish). Push-rejection case (simulate via a second head advance between merge and push): integrator re-fetches, re-merges, retries once (assert two merge attempts logged via injected log callback, then success).
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement**: before merging, fetch the current head of the mission's target branch and merge the candidate onto it (keep the frozen-base diff as the *change under review* — candidate SHA evidence stays bound to the candidate per spec 07; the merge result is a new integration commit); on push rejection: refetch → re-merge → one retry → conflict path.
- [ ] **Step 4: Green** + regression `node --test test/integration/mission-reliability-foundation.test.ts` and any existing integrator unit tests.
- [ ] **Step 5: Format/lint/typecheck + commit** — `feat(orchestration): integrator merges against current head with push-retry (stale-base)`.
