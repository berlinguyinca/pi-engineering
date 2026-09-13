# Evidence — Milestone: Parallel execution + multi-model defense

Two of the three remaining roadmap items plus a robustness foundation.

## 1. Optional distinct reviewer worker (anchoring mitigation)

`EngineeringRuntime.open({ cwd, worker, reviewerWorker })` accepts an optional
separate worker for the **independent-review** and **clean-room-challenger**
roles. When omitted it falls back to the single worker, so multiple models are
optional, never required (project constraint). The shared-ledger semantic tools
are bound to the reviewer worker too.

Machine evidence: integration test `a distinct reviewerWorker is used for the
independent review` — the main worker has NO reviewer handler, so a review that
reached it would fail; the tournament promoting proves the review ran on the
distinct worker, and the challenger handler on that worker fires.

## 2. Parallel tournament candidate execution (opt-in)

`tournament(goal, { parallel: true })` (also `/tournament ... --parallel`) runs
the independent candidates concurrently via `Promise.all`. Safe because each
candidate owns an isolated worktree and nothing merges into the main branch
until the winner is selected. Defaults to sequential (a single serial worker
gains nothing).

- Branch names gained a random suffix so concurrently-created candidates never
  collide on `pi-eng-*`.
- Machine evidence: integration test `parallel tournament candidates run
  concurrently` uses a concurrency counter and asserts the implement phase
  overlaps (`maxActive >= 2`), with the winner promoted and no leftover branches.

## 3. Concurrency-safe EventStore (foundation)

`EventStore.append` now serializes concurrent writes through an internal promise
chain, so parallel producers (tournament legs) never interleave file writes or
reorder the in-memory event list.

Machine evidence: `eventstore.test.ts` fires 50 concurrent appends and asserts
all 50 are recorded, the on-disk JSONL is intact and parseable, and a fresh
replay reconstructs the full event set.

## Verification

- `npm run typecheck` — clean.
- `npm run lint` (biome) — clean.
- `npm test` — **68/68 passing**.

## Fresh-context review + fixes

A fresh reviewer session confirmed the core claims (EventStore serialization
correct under 200 concurrent appends; branch names collision-safe; reviewerWorker
routing + fallback correct; no JS data races on the concurrent path) and found
three issues, all fixed with regression tests:

- **(MED) parallel legs were not error-isolated** — a throwing leg crashed the
  whole tournament, orphaned sibling legs, and leaked an `ELIGIBLE` candidate +
  `pi-eng-*` branches + a worktree. Each leg now catches its own errors, records
  a rejected candidate + finding, and cleans up its branch/worktree; the
  tournament continues with survivors. Regression test (`a throwing tournament
  leg is isolated and leaks no git state`) asserts all legs rejected and zero
  leftover branches/worktrees.
- **(MED) overclaimed test** — the parallel test now actually asserts one winner
  PROMOTED, one loser REJECTED, zero leftover `pi-eng-*` branches, and exactly
  one worktree.
- **(LOW) `EventStore.inMemory()` persisted** to a literal `:memory:` file in
  cwd; it is now truly in-memory. Regression test asserts no files are written.
  Unused imports removed.

Also hardened `/tournament --parallel` parsing (only a leading `--parallel`
flag is treated as a flag, not a goal containing the token).

## Real-model dogfood

`scripts/dogfood-parallel.ts` ran a 2-candidate parallel tournament with the
real `PiWorkerExecutor` on a fresh fixture:

| Metric | Result |
| --- | --- |
| Outcome | **promoted**, work item COMPLETED |
| Candidates | 2 (implementer:2, reviewer:2), both verified + reviewed, 0 findings |
| Blocked/failed workers | **0** |
| Max worker context | **8.4k** (well under the 24k reviewer budget) |
| Duration | 104s (single model serializes the model-bound work, as expected) |
| Fixture tests | **6/6 pass** (`clamp` implemented, exported, covered) |
| Leftover branches | **0** (`git branch` has no `pi-eng-*`; worktree list clean) |

As documented, a single model gives no wall-clock speedup for the model-bound
implement/review phases — the value is architectural readiness (safe concurrent
execution + concurrency-safe ledger) realized with a multi-worker/concurrency-
capable backend or a distinct reviewer worker.
