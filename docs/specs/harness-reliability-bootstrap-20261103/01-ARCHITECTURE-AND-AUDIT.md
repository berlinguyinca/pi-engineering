# Architecture and code audit grounding

## Reuse what exists
- `src/aps/{types.ts,recovery.ts,supervisor.ts,workerActivity.ts}`: progress/loop instrumentation; goal alignment is a new extension, not a new event bus.
- `src/incidents/{types.ts,IncidentController.ts,fingerprint.ts}`: incident domain, dedupe and durable publication events.
- `src/runtime/isolation/SessionEventStore.ts`: per-session append streams and merged read API; prefer this over a second event database.
- `src/inference/retryTrace.ts`: layer ownership trace; avoid multiplying retry owners.
- `src/plannerWorker/{contract.ts,types.ts,executor.ts}`: contract scope, review, post-edit scope check.
- `src/orchestration/{missionPlanner.ts,standaloneEntry.ts,completionGate.ts}`: planner fallback, whole-repo defaults, completion validation.
- `src/context/ContextBroker.ts`: keyword-retrieved bounded context; currently early-six-keyword selection and required file skip/truncation are worth testing.
- `src/workers/contextBudget.ts`: prompt budgets/compaction; task authority must survive handoff and compaction.
- Herdr `packages/*-view.js` and `packages/herdr-web-components`: reuse existing UI patterns and routes.

## Code-observed risks; not proof of production incidents
1. `standaloneEntry.singleTaskPlan` uses `write_domains: ["**"]` by default. This is an authorization-scope **planning default**, not proof of unrestricted host filesystem writes.
2. `missionPlanner.planMission` may call `input.single()` when planner output is bad. Verify injected fallback cannot broaden authorization.
3. `contract.ts` may ignore conflicting deny globs; protect user-origin constraints separately.
4. `plannerWorker/executor.ts` performs `scopeViolations()` after an attempt commit; earlier prevention varies by execution path.
5. Context relevance and context window control are separate from instruction retention.
6. Historical `.pi/engineering.yaml` mentions DeepSeek MXFP4 stalls, Qwen Flash 404/400 failures and Qwen 27B Q8 successes; these are recorded historical comments, **not current runtime inventory**.

## Goal architecture
- Existing append-only session event stream remains source of truth.
- Typed incident occurrence and fingerprint views are derived and rebuildable.
- APS records deviations with evidence. Separate semantic reviewer is optional and never trusted for hard writes.
- Deterministic task authority is applied by lightweight runner, protected handoff and verified candidate diff.
- Existing Herdr frontend renders read-only dashboards. No second orchestrator; no separate frontend.
- Safe automatic recovery remains feature-flagged, limited to idempotent operations, with one retry owner.

## Deployability assumption
Pi sessions can coexist on one machine, but their event namespaces and permissions must be audited. A host-wide view must use only accessible/authorized paths. No host-wide privileged service is assumed.
