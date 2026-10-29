# EVENT-OWNER-MAP — data lineage and the canonical-writer decision

Audited at `6082fb9` + Phase 1. Citations are `file:line` from the audit sweep.

## Who owns what today
| Store | Backend | Writers | Strengths | Gaps vs. target envelope |
|-------|---------|---------|-----------|--------------------------|
| **Ledger** (`src/ledger/Ledger.ts`) | append-only `ledger.jsonl` (`EventStore.ts:12`), in-memory maps rebuilt on replay | `EngineeringRuntime` (`engineer` :4035, `plan` :3734, `executePlan` :3862, `tournament` :3530); Blackhole via `emitEvent` | Owns the Mission-free path (`WorkItem`, `Task`, `Candidate`, `Evidence`) | No `task_id`/`session_id`/`run_id` at top level, no `schema_version`, no correlation/causation/idempotency/revision/generation; `actor` has no stable `id`; no run entity (`RUN-` ids live only in `Actor.run_id`, `Candidate.producer_run_id`); `appendConditionally` exists (`EventStore.ts:79`) but Ledger never uses it |
| **MissionStore** (`src/orchestration/missionStore.ts`) | `EventStoreBackend`; per-session `events/<sessionId>.jsonl` via `SessionEventStore`, or `orchestration.jsonl` | Orchestrator, broker, supervisor | `revision` per emit, leases + fencing tokens, generations, conditional append, handoff records | Mission-shaped: stored `run_id` = `missionId`; no correlation/causation/generic idempotency; unknown event types are dropped on replay (:773) |
| **Herdr lineage** (`src/runtime/herdr/lineage.ts`) | push-only envelope v2 → durable outbox → `POST /api/v1/ingest` | `LineageEmitter` | Generic node/edge vocabulary (agent, attempt, session, handoff, artifact, commit, pr, ci, review…); idempotent hashed event ids; resync | Pi never reads the graph back; `ForkRuntimeSources` needs `getMission` (`forkWiring.ts:22`) |
| `SessionEventStore` | per-session JSONL | MissionStore | session/worktree/sequence file envelope | not a domain store |

## Decision (Phase 2)
1. **The Ledger is the single write authority for new tasks.** No new store, and no fake Mission objects for new work (spec invariant).
2. **The Ledger event envelope gains additive, optional fields** (`schema_version`, `task_id`, `session_id`, `run_id`, `correlation_id`, `causation_id`, `idempotency_key`, `authority_generation`, `expected_revision`). Old lines replay unchanged; unknown fields are ignored by old readers. Idempotent append uses the existing `appendConditionally`.
3. **MissionStore stays the authority for existing Missions** and is only read, through a read-only `LegacyMissionAdapter`. Nothing new writes Mission events; no task is writable in both stores.
4. **One read projection** (`WorkProjection`) merges both into generic task/run/session/handoff nodes using the existing lineage vocabulary. It is derived state, rebuilt from the logs, with a cursor for incremental updates.
5. Herdr emission reuses `LineageEmitter` and the outbox; no second transport or graph.

## Known defects found (not fixed in Phase 2 unless noted)
- `Ledger.setTaskStatus("failed")` emits `task.started` (any non-completed, non-blocked status maps to started).
- Ledger JSONL has no locking; corrupt lines are skipped silently.
