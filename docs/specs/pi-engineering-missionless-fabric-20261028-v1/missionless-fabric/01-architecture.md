# 01 — Canonical architecture / domain contracts

## Core domain
- `Task`: user-visible objective (title, acceptance criteria, project/repository scope, risk, authority policy, lifecycle, optional plan); may exist without execution.
- `Session`: conversational identity for Pi, Claude, Codex, OpenCode or assistant; context checkpoints, agent role and model history; sessions can switch tasks.
- `Run`: discrete execution attempt, backend, session, worktree, commit base/head, checkpoints, parent run, owner generation, timing and outcome.
- `Handoff`: immutable from/to session lineage, reason (context limit, review, specialized capability, operator steering), bounded context refs, remaining work.
- `Artifact`: existing artifact reference; refs for diffs, tests, documents, plans, data, screenshots, logs and summaries.
- `Event`: durable append-only authoritative mutation, idempotent and causally linked; projections rebuild work views and graph edges.
- `Team`: optional membership / shared room / assignments; not an independent orchestration store.
- `Plan`: optional versioned artifact with steps/risks/acceptance; Plannotator is an optional editor suggestion *after* generating the plan, never mandatory.

## Canonical lifecycle and separate dimensions
User task states: `open`, `working`, `needs_input`, `blocked`, `done`, `cancelled`. Keep `verification_status` distinct (`not_required`, `pending`, `passed`, `failed`, `stale`), `publication_status` distinct (`not_requested`, `pr_open`, `merged`, `deployed`), run health (`active`, `waiting`, `stalled`, `recovering`, `failed`, `finished`). Do not conflate a successful run with task completion or deployment.

## Event envelope (TypeScript conceptual contract)
```ts
type WorkEvent = {
  event_id: string; schema_version: number;
  task_id?: string; session_id?: string; run_id?: string;
  type: string; timestamp: string; actor: { kind: 'human'|'agent'|'system'; id: string };
  causation_id?: string; correlation_id?: string; idempotency_key?: string;
  authority_generation?: number; expected_revision?: number;
  payload: unknown; artifact_refs?: string[];
};
```
Invariants: monotonic scoped revisions, optimistic concurrency, idempotent append, replay-stable projections, explicit redaction, no secrets in telemetry, signed/authorized remote actions as applicable. Persist internal detailed states as typed event data, rather than forcing all into public task state.

## Reuse and adapters
- Prefer existing Ledger and store event backends. Do NOT run Ledger and MissionStore as two writable authoritative records for the same new task. Choose one canonical write authority after inventory; event snapshots/projectors can differ.
- Extract broker's worktree worker dispatch, role restrictions and execution handles behind a `RunExecutor` accepting `taskId`, `runId`, policy, context refs and execution ownership, not `missionId`.
- Extract scheduler's conflict detection and dependency sorting behind `RunQueue`; avoid forked orchestration implementation.
- Extract `CompletionGate` checks as `EvidencePolicyEvaluator` against candidate revision + acceptance criteria, with a read-only legacy Mission adapter.
- `LegacyMissionAdapter` maps old mission/task/execution events to graph projection and retains historical IDs and viewer links. New task writes never create fake Mission objects.
- Herdr, Pi Web, terminal, phone are projections/clients, not competing authorities. OpenViking supplies retrieval memory, not transactional state.

## Minimal APIs (proposal; cross-check existing endpoints first)
- `createTask`, `getTask`, `listTasks`, `updateTask`, `linkArtifact`, `appendEvent`.
- `startRun`, `steerRun`, `pauseRun`, `resumeRun`, `cancelRun`, `handoffRun`, `requestReview`, `verifyTask`.
- `watchTaskEvents(cursor)`, `getTaskGraph`, `getSessionSummary`, `getRunEvidence`.
- All writes enforce explicit actor authorization, repo scope, expected revision and idempotency; reads support projection version and cursor.
- Generic command aliases replace `/mission` gradually; preserve legacy read-only `/mission-status` alias through migration.

## Scope
Do not rebuild existing upstream services; adapter contracts and targeted refactors only. Avoid renaming all existing types globally in one commit: introduce compatibility mapping and migrate bounded feature slices.
