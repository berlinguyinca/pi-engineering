# Orchestration Specification → Implementation Ledger

Maps `docs/specs/pi-engineering-orchestration/**` requirements to reuse / modify / new.

| # | Requirement (spec) | Status | Where |
|---|---|---|---|
| 0 | Durable append-only event store | reused | `src/ledger/EventStore.ts`, `src/platform/eventstore/*` (JSONL, torn-tail repair, single-writer) |
| 0 | Worktree isolation + controlled merge | reused | `src/git/GitRepo.ts` (`createWorktree`, `mergeBranch`, `removeWorktree`) |
| 0 | Deterministic verification | reused | `src/verify/Verifier.ts` (`CommandVerifier`) |
| 0 | Agent workers (fresh context) | reused | `src/workers/*` (`PiWorkerExecutor`, `FakeWorkerExecutor`) |
| 0 | Run/Worker lifecycle + heartbeat | reused | `src/platform/WorkGraph.ts` |
| 0 | Concurrency limiter | reused | `src/sched/Scheduler.ts` |
| 0 | Task-DAG topo sort + write-scope conflict | reused | `src/plan/taskDag.ts` |
| 0 | PI WEB operator adapter | reused | `src/platform/ControlPlane.ts` |
| 0 | Model capability routing | reused | `src/routing/ModelRouter.ts` |
| 1 | Mission model | **new** | `src/orchestration/types.ts`, `MissionStore` |
| 1 | Mission/Task/Execution event-sourced store | **new** | `src/orchestration/missionStore.ts` |
| 1 | State transition validation | **new** | `src/orchestration/state.ts` |
| 2 | Intent/policy router (semantic + deterministic) | **new** | `src/orchestration/intentRouter.ts` |
| 2 | Declarative policies | **new** | `src/orchestration/policies.ts` |
| 3 | Unified execution broker | **new** | `src/orchestration/broker.ts` |
| 3 | Cancellation + steering | **new** | broker handles |
| 4 | DAG scheduler + write domains + concurrency + retry | **new** | `src/orchestration/scheduler.ts` |
| 5 | Worktree lifecycle + integrator role | **new** (+ reuse GitRepo) | `src/orchestration/broker.ts` (`allocateWorktree`/`releaseWorktree`), `integrator.ts` |
| 6 | Automatic engineering workflow (no slash cmd) | **new** | `src/orchestration/orchestrator.ts`, extension hook |
| 7 | Review/repair/completion gates | **new** | `src/orchestration/completionGate.ts`, `review.ts` |
| 8 | PI WEB mission/task/execution surface | **modify** | `src/platform/ControlPlane.ts` snapshot + extension |
| 9 | Context packets + artifacts | reused | `src/context/ContextBroker.ts`, `src/artifacts/ArtifactStore.ts` |
| 10 | Capability-based model selection | reused | `src/routing/ModelRouter.ts` |
| 11 | Events/observability/metrics | reused + extend | event store, telemetry |
| 12 | Guardrails (allowlist, redaction, limits) | reused + extend | `src/security/SecurityPolicy.ts`, broker limits |
