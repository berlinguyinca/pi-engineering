# Projection benchmark (O3: incremental LedgerWorkProjection)

Harness: `test/unit/work-projection-bench.test.ts` with generator `test/support/ledgerEventGen.ts` (seeded; per
work item: plan tasks and their lifecycle, a candidate, evidence rows, status updates, 1-3 agent runs with up to 40
heartbeats, some finished, some failed, some left running). The stream is written to a JSONL file and loaded with
`Ledger.create`, so the numbers include a real log. 10k runs in the default suite (bounds: cold < 5 s, warm < 2 s).
100k is opt-in: `PI_ENG_BENCH_100K=1 node --test --import ./test/support/isolatedState.ts test/unit/work-projection-bench.test.ts`
(an env var read only by that test file; node --test gives test files no argument channel).

Machine: shared dev workstation with other agents running; treat figures as order-of-magnitude (2 runs each).

| Events | Metric | Before (full rebuild per call) | After (incremental) |
| --- | --- | --- | --- |
| 10k (645 tasks, 350 runs) | first `graph()` | 25 ms | 19-20 ms |
| 10k | repeat `graph()`, no new events | 10 ms | 0.5-0.6 ms |
| 10k | one new event, then `graph()` | ~10 ms | 0.7-0.9 ms |
| 10k | restart with snapshot, `graph()` | n/a | 7 ms |
| 100k (6037 tasks, 3435 runs) | first `graph()` | 643 ms | 186-197 ms |
| 100k | repeat `graph()`, no new events | 522 ms | 6.6-7.9 ms |
| 100k | one new event, then `graph()` | ~520 ms | 6-9 ms |
| 100k | restart with snapshot, `graph()` | n/a (full replay, ~640 ms) | 140-149 ms |
| 100k | heap retained by projection | 2.3 MB | 4.4 MB |
| 10k / 100k | `Ledger.create` (not the projection) | 35 / 310 ms | unchanged |

Findings:

- The before cost was superlinear (10x events = ~50x warm time): `verificationOf` called `listEvidence(candidateId)` and
  `listCandidates(workItemId)`, each a scan of the whole Ledger view, per work item per call. The new per-owner id
  index removes that.
- Rows are cached per work item and recomputed only for work items an event touched (plus plan-task parents whose
  `result_work_item_id` is that item). An event with no work item (and not an `agent.*`/evidence event) marks everything
  dirty rather than guessing. `agent.*` events only update run facts.
- What remains per call is O(tasks + runs): copying rows and recomputing read-time liveness.
- Restart is bounded by `Ledger.create` (310 ms at 100k), which this change does not touch; the snapshot saves the
  run-fact replay and the first-call row build only partially (rows and indexes are rebuilt from the Ledger views, not
  persisted). The snapshot is therefore a modest win; a larger one needs Ledger-level snapshotting (out of scope).
- Memory grows ~2 MB for the row cache and id index at 100k events.
