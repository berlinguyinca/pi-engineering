# REUSE-MATRIX

Classes: REUSE / EXTEND / REFACTOR / CONSOLIDATE / REPLACE / RETIRE / MISSING.

| Component | Where | Class | Plan |
|-----------|-------|-------|------|
| Auto-invoke directive | `autoInvoke.ts`, `extensions/index.ts:~1094` | REPLACE (default) | Phase 1 done: gated behind `execution.legacy_auto_invoke`; RETIRE after compat window |
| Execution mode (`chooseMode`) | `missionMode.ts` | REUSE | Already `local` by default |
| Intent router | `intentRouter.ts` | REUSE | Keep risk derivation; no power to force Missions |
| Lifecycle policy / harness / gates | `lifecycle/policy.ts`, `harness.ts`, `policies.*` | REUSE / EXTEND | `execution` section added (Phase 1) |
| Ledger | `ledger/Ledger.ts`, `EventStore.ts` | EXTEND | Canonical writer for new tasks; additive envelope + idempotency (Phase 2) |
| MissionStore | `orchestration/missionStore.ts` | REUSE (read-only for new work) | Legacy authority; `LegacyMissionAdapter` reads it |
| Task/Run (`EngineeringRuntime`) | `runtime/EngineeringRuntime.ts` | CONSOLIDATE | Phase 3: extract `RunExecutor` seam |
| MissionScheduler | `orchestration/scheduler.ts` (1780) | REFACTOR | Phase 3: mission-agnostic `RunQueue`, keep algorithms |
| ExecutionBroker | `orchestration/broker.ts` (4387) | REFACTOR | Phase 3: `RunExecutor` taking taskId/runId |
| CompletionGate | `orchestration/completionGate.ts` | REFACTOR | Phase 3: pure `EvidencePolicyEvaluator` + Mission adapter |
| Herdr lineage emitter/outbox/transport | `runtime/herdr/*` | REUSE | Generic already |
| `ForkRuntimeSources` | `herdr/forkWiring.ts:22` | REFACTOR | Phase 4: resolve generic run identity, not only `getMission` |
| Handoff records | `HandoffRecord`, `runtime/host/handoffKinds.ts`, PR #460 | EXTEND | Phase 4: extend, no new registry. Unread: `handoffRecovery.ts`, `handoffResume.ts`, `handoffCheckpointRefs.ts`, `herdr/liveHandoff.ts`, `phaseBoundaryHandoff.ts`, `plannerWorker/sessionHandoff.ts` — audit before Phase 4 |
| Checkpoints | `orchestration/checkpoints.ts` | REUSE / EXTEND | PR #460 adds `CheckpointHandoffContext` |
| Forks | `orchestration/forks.ts` | REUSE | |
| `/engineer`, `/plan`, `/execute` | `extensions/index.ts` | REUSE | Already Mission-free |
| `mission` tool, `/mission`, `/mission-status` | | REUSE (legacy) | Keep; read alias |
| WorkProjection / LegacyMissionAdapter | — | MISSING → new (Phase 2) | Justified: no generic cross-store read model exists |
| Terminal compact status, `/summary` | to audit in Phase 5 | MISSING/unknown | |
| Plannotator, OpenViking, assistant, Artifact Studio | external | REUSE | Not rebuilt |
