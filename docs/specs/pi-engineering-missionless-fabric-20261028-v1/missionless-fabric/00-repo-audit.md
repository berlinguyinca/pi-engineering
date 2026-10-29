# 00 — Repository audit and starting point

## Verified by reading GitHub source on 2026-10-28
- `src/orchestration/autoInvoke.ts`: `decideAutoInvoke` injects mission tooling on qualifying prompts; exception handling for questions, short continuations, headless print, unavailable tool and 30-second resubmits. These are symptoms of implicit mandatory orchestration.
- `src/orchestration/intentRouter.ts`: regex-driven semantic intent plus deterministic policy enrichment. Preserve risk derivation, remove its power to force Mission creation.
- `src/orchestration/missionMode.ts`: `chooseMode` defaults to local unless AutoSpec flags are explicitly enabled. Exploit this existing default and avoid competing mode hierarchies.
- `src/orchestration/scheduler.ts`: Mission DAG scheduler with write-domain conflict control, concurrency, retries and waiting/recovery integration. Preserve its scheduling algorithms; extract mission-agnostic interfaces.
- `src/orchestration/completionGate.ts`: gathers revision-scoped durable evidence from `MissionStore`. Extract pure generic policy/evidence checks and retain Mission adapter.
- `src/runtime/EngineeringRuntime.ts`: currently imports many mission-specific services plus separate legacy `Task`, `Run`, Ledger, ContextBroker, mission capacity code. High-priority consolidation seam.
- `src/runtime/herdr/forkWiring.ts`: Herdr fork provenance and steering already exist; `ForkRuntimeSources` currently depend on Mission lookup. Adapt to generic task/run identities.
- `docs/architecture.md`: existing Engineering Ledger, `ArtifactStore`, `GitRepo`, `ContextBroker`, `Verifier`, worker executors, safeGit and fenced runtime isolation; reuse these.
- `docs/orchestration.md`: explicit natural-language-to-Mission flow, MissionStore, Orchestrator, Broker, CompletionGate, `/mission`, `/mission-status`, control-plane snapshots.
- `docs/superpowers/specs/2026-10-27-mission-presence-design.md`: records disconnected observability updates and incomplete producer wiring on a *previous* branch snapshot. Verify which fixes have since landed; do not assert they remain missing.

Source links: https://github.com/berlinguyinca/pi-engineering/blob/main/src/orchestration/autoInvoke.ts ; https://github.com/berlinguyinca/pi-engineering/blob/main/src/orchestration/missionMode.ts ; https://github.com/berlinguyinca/pi-engineering/blob/main/src/runtime/EngineeringRuntime.ts ; https://github.com/berlinguyinca/pi-engineering/blob/main/docs/architecture.md

## Mandatory fresh audit before modification
- Record exact SHAs, deployment status, worktrees, uncommitted changes, open PRs, in-progress specs and current test baseline in `docs/specs/<package-name>/AUDIT-RESULTS.md`.
- Use `rg` to enumerate every import, export, persisted schema, SQL/JSONL field, CLI route, API endpoint, snapshot, UI surface, test, migration, and environment flag containing `mission`, `mission_id`, `MissionStore`, `orchestrate`, `autoInvoke`, `CompletionGate`, `PI_AUTOSPEC_`.
- Inspect `extensions/index.ts` `before_agent_start` and tools/commands wiring. Distinguish direct, `/engineer`, `/mission`, external AutoSpec entry, supervisor pump and background execution.
- Confirm authoritativeness and ownership of existing ledger vs MissionStore vs Herdr registry vs SQLite vs OpenViking. Build data lineage table. Never create another global task database just because names differ.
- Investigate actual scheduler ownership and admission paths (`MissionScheduler`, `MissionCapacityScheduler`, gateway `AdmissionController`, InferWeave remote scheduler, Slurm). Identify duplicated retries, queueing, backpressure and clock tickers.
- Check latest Herdr rooms/team graphs/handoffs/artifact studio/assistant, planning integration and `/summary` skill before adding any new API.
- Benchmark current legacy flow end-to-end on a controlled fixture including direct and managed modes; attach traces; no production assertions from source alone.

## Deliverable
`AUDIT-RESULTS.md`, `REUSE-MATRIX.md`, `ENTRYPOINT-MAP.md`, `EVENT-OWNER-MAP.md`, `BASELINE-METRICS.json`; link concrete file:line and SHA. Proposed new code requires a documented missing-capability justification.
