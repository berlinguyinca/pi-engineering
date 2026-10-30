# Phase 2 — generic Task/Session/Run read model

Stacked on PR #463 (Phase 1). Decision record: `EVENT-OWNER-MAP.md`; component classes: `REUSE-MATRIX.md`.

## What changed
- `src/core/types.ts`: `EventMeta`; `LedgerEvent` gains optional `schema_version`, `task_id`, `session_id`, `run_id`, `correlation_id`, `causation_id`, `idempotency_key`. Events written without them are byte-identical to before.
- `src/ledger/Ledger.ts`: `emitEvent(..., meta?)`. A keyed append commits once (the check and the index update run inside the store's append chain via the existing `appendConditionally`); the key index is rebuilt on replay, so it survives a restart.
- `src/work/types.ts`: `WorkTask/Run/Session/Handoff/Graph` (derived views, not a store) and `mergeWorkGraphs`, which reports any id claimed by two stores.
- `src/work/ledgerProjection.ts`: `LedgerWorkProjection` reuses the Ledger's own materialized work items, plan tasks, candidates and evidence; adds runs and sessions from envelope fields and `agent.*` events; incremental `catchUp()` with a cursor.
- `src/work/legacyMissionAdapter.ts`: `projectLegacyMissions(MissionReader)`. `MissionReader` lists only read methods; `MissionStore` satisfies it. Mission → task, orchestration task → child task, Execution → run, `HandoffRecord` → handoff. Historical ids kept.

## Deliberately not done
- **No new store, no fake Missions for new work.** New tasks are written only to the Ledger; Missions only to MissionStore.
- **`authority_generation` and `expected_revision`**: now enforced at append under the Ledger's cross-process lock (see PHASE-6-RETIREMENT.md); idempotency keys are likewise judged against the true log tail across processes.
- **The runtime does not emit `agent.*` yet.** Today the Ledger never writes `agent.started/completed/failed` (checked: no emitter in `src/`), so Ledger-side runs and sessions are empty in production until Phase 3 emits them. The projection and tests exercise the contract with real Ledger events.
- **No handoff events on the Ledger side.** Handoffs stay on `HandoffRecord` (extended by PR #460); Phase 4 extends that, not a second registry.
- No Herdr emission change: `LineageEmitter` and the outbox are already generic and unchanged.

## Semantics worth knowing
- Task state, verification and run health are separate: a finished run leaves the task `working` (tested).
- Verification is bound to the current candidate revision: evidence for an older candidate yields `stale`, not `passed` (tested).
- `verification_status: "unknown"` is an addition to the spec's five values. A legacy Mission's evidence is not read here, so even `COMPLETE` reports `unknown`, not `passed`. A started work item with no candidate is also `unknown`; `unverified` evidence never counts as a pass.
- `FAILED`/`PARTIAL`/`BUDGET_EXHAUSTED` map to `blocked`, never `done`.

## Independent review (fresh context, diff only) — dispositions
Fixed, each with a test that fails without it:
- Legacy `BLOCKED` tasks projected as working and `SKIPPED` never settled → now `blocked` / `cancelled`.
- Legacy `COMPLETE` Mission claimed `passed` with no evidence read → now `unknown`.
- An idempotency key reused for a different request silently returned the first event → now throws.
- Runs were created from the actor's run id on any event (evidence, claims) and stayed active forever → runs now come from `agent.*` events or an explicit `run_id`; terminal runs are final in both directions.
- `verificationOf`: `unverified` evidence counted as a pass; a started item with no candidate read "not required" → fixed (see above).
- `catchUp` rescanned with a growing seen-set → now an index cursor into the append-only list (`cursor().position`).

Accepted limits (documented, not changed):
- **Idempotency is single-process.** The key index lives in the Ledger instance and the file has no lock. Two processes writing one `ledger.jsonl` can both pass the check. The Ledger was already single-process (no locking, no CAS); cross-process safety needs the Phase 3 fenced owner, not a check here.
- Evidence is matched by candidate id. `candidate.changed` mutates a candidate in place, so a changed diff under the same id keeps its old evidence. The Ledger has no per-revision candidate identity; Phase 3's revision-bound cache (O4) is where that belongs.
- `graph()` is O(items x evidence) per call; fine for current sizes, unmeasured at 10k+ events (O3 benchmark still to run).
- A COMPLETED work item can read `done` with verification `pending`/`failed`; both dimensions are shown, not merged.

## Known defects found, not fixed here
- `Ledger.setTaskStatus("failed")` emits `task.started`, so a failed plan task reads as started.
- Ledger JSONL has no lock; corrupt lines are skipped silently.

## Rollback
Pure additions: no event type, field or file was removed or rewritten. Old readers ignore the new fields. Reverting the PR leaves existing ledgers valid.
