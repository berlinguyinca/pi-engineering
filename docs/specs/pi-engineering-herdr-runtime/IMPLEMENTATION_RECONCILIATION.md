# Pi-Engineering Herdr Runtime — Implementation Reconciliation (PHASE A)

Date: 2026-09-21
Branch: `feat/herdr-runtime-recon`
Scope: Map every requirement in specs 01–16 to the existing repository before any
architecture change. Status legend:

- **EXISTING** — implemented and tested already.
- **PARTIAL** — implemented but does not fully meet the spec (gaps listed).
- **MISSING** — not present; must be built.
- **CONFLICTING** — present but in tension with the spec; needs reconciliation.
- **EXTERNAL** — owned by an external dependency (Herdr / Pi-Web / InferWeave / OpenViking / PostgreSQL), must not be reimplemented.

> This is a **staged migration, not a rewrite**. Existing working code is reused.
> Nothing is deleted yet. Herdr, Pi-Web, Pi Forge (excluded), InferWeave and
> OpenViking are external. See `00-master.md`, `IMPLEMENTATION_PROMPT.md`.

---

## 01 — Architecture Boundaries

| Requirement | Status | Source / test |
|---|---|---|
| ADR / ownership matrix / dependency & failure-domain diagrams / forbidden coupling | PARTIAL | `docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md` and `docs/specs/pi-engineering-orchestration/` document boundaries. A consolidated ADR for the Herdr adoption is MISSING (Phase D will add it). |
| Pi-Engineering owns work/DAG/policy/review/repair | EXISTING | `src/orchestration/` (`types.ts`, `broker.ts`, `orchestrator.ts`, `missionStore.ts`, `scheduler.ts`, `policies.ts`, `completionGate.ts`, `integrator.ts`); `src/lifecycle/` (controller/harness/policy/roleRunner/reviewResultTool); `src/platform/WorkGraph.ts` |
| Herdr owns persistent process/agent runtime (external) | EXTERNAL | Not installed/integrated yet. See PHASE D. No `src` reference. |
| InferWeave owns model/runtime/GPU scheduling | EXTERNAL | `src/inference/admission*.ts`, `src/gateway/`, `src/routing/ModelRouter.ts`, `src/capability/` integrate with an InferWeave gateway. No static model→GPU map in repo. |
| OpenViking semantic memory | EXTERNAL | `src/blackhole/OpenViking.ts`, `durable.ts`, `memoryOutbox.ts`, `promotion.ts` |
| PostgreSQL / event store operational history | PARTIAL | `src/platform/eventstore/backend.ts` defines the Postgres compatibility seam; current backend is JSONL (`eventstore/jsonl.ts`, `src/ledger/EventStore.ts`). Postgres backend not yet wired. |
| Git owns source state | EXISTING | `src/git/GitRepo.ts` |
| Pi-Web operator UI (external) | EXTERNAL | `src/platform/ControlPlane.ts` is the normalized adapter for Pi Web; no UI is rebuilt. |
| Pi Forge excluded | EXTERNAL | No Pi Forge code present; must never be added. |

---

## 02 — AgentRuntime

| Requirement | Status | Source / test |
|---|---|---|
| Runtime-neutral interface: create/start/sendTask/get/list/boundedOutput/waitFor/interrupt/terminate/resume-or-reconcile/attach/health/capabilities | MISSING | The closest abstraction is `WorkerExecutor.run(req)` (`src/workers/WorkerExecutor.ts`). It covers only run/get-result; no start/sendTask/boundedOutput/waitFor/interrupt/terminate/reconcile/attach/health/capabilities. **This is the primary Phase C deliverable.** |
| Opaque runtime IDs | PARTIAL | `src/core/ids.ts` (`id`, `newRunId`); `Execution.execution_id`, `Worker.id` opaque. No runtime-prefixed opaque ID yet. |
| Declarative WorkerRequest (role, capabilities, isolation, duration/persistence, review, context policy, permissions) | PARTIAL | `WorkerRequest` (`src/workers/WorkerExecutor.ts`) has role/task/context/tools/cwd/timeoutMs/maxContextTokens/modelOverride/systemPromptOverride/images/resultTool. Missing explicit isolation, duration/persistence, review policy, permissions, capabilities. |
| Contract tests usable by legacy and Herdr runtimes | MISSING | No AgentRuntime contract suite. Will be added in Phase C (`test/unit/agentruntime*.test.ts`). |

---

## 03 — Herdr Adapter

| Requirement | Status | Source / test |
|---|---|---|
| Compatibility spike against current Herdr / pi-herdr | MISSING | No Herdr inspection. Phase D produces `HERDR_COMPATIBILITY.md`. |
| `HerdrAgentRuntime` + version/capability negotiation | MISSING | No `AgentRuntime`, no Herdr adapter. Phase D. |
| Never fork Herdr | — | Constraint enforced; no fork present. |
| Lifecycle fidelity / structured errors / worktrees / recovery / remote / testability | MISSING | Nothing yet. Phase D records these in `HERDR_COMPATIBILITY.md`. |

---

## 04 — Worker Model and Session Factory

| Requirement | Status | Source / test |
|---|---|---|
| Ephemeral subagent / persistent worker / non-agent service worker | PARTIAL | Ephemeral subagents exist (`WorkerExecutor`, `PiWorkerExecutor`). Persistent worker + non-agent service worker models are not formalized. `platform/types.ts` `Worker` is the closest. |
| Roles: planner/architect/engineer/frontend+backend/tester/reviewer/security/UI/researcher/debugger/repair | PARTIAL | `WorkerRole` (`src/core/types.ts:90`), `ROLE_BUDGETS`, `src/lifecycle/rolePrompts.ts`, `src/capability/roles.ts`, `src/routing/ModelRouter.ts` `WorkerRoleName`. Repair/security/UI roles partially covered. |
| Session Factory consuming task+capabilities+isolation+duration+dependencies+security → WorkerPlan/DAG | PARTIAL | `src/orchestration/scheduler.ts` builds task DAGs; `src/orchestration/missionStore.ts`. A formal "Session Factory → WorkerPlan" emitting a plan is not a distinct unit. |
| Herdr executes, does not decide why workers exist | EXTERNAL | Design boundary; enforced in Phase D by keeping DAG/policy in Pi-Engineering. |

---

## 05 — State and Events

| Requirement | Status | Source / test |
|---|---|---|
| Normalized lifecycle CREATED/STARTING/READY/WORKING/WAITING/BLOCKED/COMPLETED/FAILED/INTERRUPTED/RECOVERING/LOST/TERMINATED | CONFLICTING | `platform/types.ts` `WorkerStatus` = IDLE/BOOTSTRAPPING/RUNNING/BLOCKED/WAITING/COMPLETED/FAILED/CANCELLED/RECOVERING. `RunStatus` = PENDING/PLANNING/RUNNING/WAITING/COMPLETED/FAILED/CANCELLED. Missing CREATED/STARTING/READY/WORKING/INTERRUPTED/LOST/TERMINATED. `orchestration/types.ts` `TaskStatus`/`ExecutionStatus` differ again. **Spec wants one normalized vocabulary — reconcile across the three.** |
| Persist runtime mapping, host/project/workflow/task/role, timestamps, worktree/branch, capabilities, current op, failures, recovery count | PARTIAL | `Worker`/`Run` (`platform/types.ts`) persist id/role/status/model/worktree/location/heartbeat/generation. `Execution` (`orchestration/types.ts`) persists session/pid/worktree/model/usage/logs/artifacts. Missing workflow/task linkage on Worker, current operation, failure list, recovery count. |
| Publish idempotent correlated worker/task/review/repair/runtime events | PARTIAL | `EventStoreBackend` + `StoredEvent` (`src/platform/eventstore/backend.ts`), `PlatformEventType`, `src/ledger/EventStore.ts`. No explicit review/repair event correlation. |
| EventStore/PostgreSQL authoritative | PARTIAL | JSONL backend current; Postgres seam defined (`eventstore/backend.ts`). |

---

## 06 — Artifacts, Context and 413 Prevention

| Requirement | Status | Source / test |
|---|---|---|
| Structured `WorkerResult`: status, concise summary, artifact refs, changed files, commits, tests, findings, questions, recommendations, metrics | CONFLICTING | `WorkerResult` (`src/core/types.ts:225`) = status/summary/claims/evidence_refs/new_hypotheses/proposed_tasks/details/error. Missing explicit changed_files, commits, tests, findings, questions, recommendations, metrics fields. Spec wants a richer contract — extend, do not replace. |
| Raw transcripts separate, never auto-injected into parent context | EXISTING | `ArtifactStore` (`src/artifacts/ArtifactStore.ts`) stores content on disk, returns only `summary`; lazy `readContentByUri`. `ContextBroker` (`src/context/ContextBroker.ts`). `src/context/usage.ts`. |
| Discover context/request limits dynamically from runtime/InferWeave metadata | EXISTING (token) / MISSING (bytes) | `src/context/capability.ts` discovers `contextWindow`/`maxTokens` from model metadata (guaranteed_routable_tokens, context_window, max_model_len) — NOT a fixed 260k. Serialized request-byte budgeting is MISSING (only token budgets in `src/budget/BudgetManager.ts`, `WorkerLimits.maxTokens`). |
| Budget tokens and serialized bytes with safety headroom | PARTIAL | Token budget exists (`BudgetManager`, `WorkerLimits`). Serialized byte budget is MISSING. |
| Strategies: direct/retrieve-on-demand/summarize/split/delegate/fan-out | PARTIAL | Retrieve-on-demand (`ArtifactStore`), summarize (compaction in `src/guard/`, `src/context/usage.ts`). No explicit split/delegate/fan-out subsystem. |
| Reusable fan-out/synthesis | MISSING | No `FanOut`/synthesis unit. `grep` shows only incidental matches. Phase E deliverable. |
| 413 regression test proving transformation before HTTP submission | MISSING | No 413 test. Phase F deliverable (spec 15). |

---

## 07 — Git Isolation and Integration

| Requirement | Status | Source / test |
|---|---|---|
| Isolated worktrees for long independent workers | EXISTING | `src/git/GitRepo.ts` (`open`, `createWorktree`, worktree lifecycle); `src/orchestration/broker.ts` `allocateWorktree/harvestWorktree/releaseWorktree`; `GitRepo.createWorktree` used by runtime candidates. |
| Persist repo/base/branch/worktree/worker/task | PARTIAL | `Execution.worktree`, `Worker.worktree`, `WorktreeInfo` (branch/path). Missing explicit repo/base/branch/task linkage on the persisted worktree record. |
| Prevent accidental shared mutable checkouts | EXISTING | Worktree isolation + `IsolationMode` (`orchestration/types.ts`). |
| Workers commit but do not merge to main | EXISTING | `broker.ts` commits candidate; `integrator.ts` merges; `MergeQueue` (`src/merge/MergeQueue.ts`). |
| Integration/conflict-resolution/test/review phase | EXISTING | `src/orchestration/integrator.ts` (merge + runChecks); `completionGate.ts`. |
| Worktree creation/cleanup idempotent and crash-safe | PARTIAL | `createWorktree`/`releaseWorktree` exist; crash-safe cleanup on coordinator restart is not proven. |

---

## 08 — Review and Repair

| Requirement | Status | Source / test |
|---|---|---|
| Separate implementer and reviewer workers | EXISTING | `src/lifecycle/roleRunner.ts`, `controller.ts`, `reviewResultTool.ts`; `realBackends.ts` review backend; `src/orchestration/orchestrator.ts` review tasks. |
| Independently suitable models via InferWeave | PARTIAL | `src/routing/ModelRouter.ts`, `src/capability/router.ts` select models per role/capability. Wiring to InferWeave admission for review is partial. |
| Flow implementation→tests→review→pass|repair→re-review | EXISTING | `src/lifecycle/controller.ts`, `src/orchestration/state.ts`, `completionGate.ts`, `orchestrator.ts` (REPAIRING state). |
| Bound cycles by attempts/token/context/wall-time/resources, then human intervention | EXISTING | `WorkerLimits` (maxTokens/maxAttempts/timeoutMs/maxTools), `BudgetManager`, `FailurePolicy`. Human intervention path (`WAITING_FOR_USER`). |
| Reviewer findings are structured artifacts | PARTIAL | `ReviewFinding` (`orchestration/types.ts`), `normalizeFindings` (`realBackends.ts`), `ReviewResult` tool. Not always materialized as artifacts. |

---

## 09 — InferWeave Routing

| Requirement | Status | Source / test |
|---|---|---|
| Workers request capabilities; InferWeave selects model/runtime | PARTIAL | `src/capability/roles.ts` role→capability; `src/routing/ModelRouter.ts` `ROLE_CAPABILITIES`; `src/capability/router.ts`. Direct InferWeave capability resolution partial. |
| No static GPU/model mapping | EXISTING | No static model→GPU map present. Constraint holds. |
| Surface model/runtime/context/queue/token-rate telemetry | PARTIAL | `src/inference/admissionStatus.ts`, `admissionEvents.ts`, `src/lifecycle/telemetry.ts`. |
| Handle admission/concurrency failures with bounded queue/retry | EXISTING | `src/inference/admissionTransport.ts`, `admissionConfig.ts`, `retryDelay.ts`, `src/gateway/`. |

---

## 10 — Remote Hosts and Security

| Requirement | Status | Source / test |
|---|---|---|
| Tailscale/secure connectivity below Herdr | PARTIAL | `RemoteWorker`/`RemoteHttpTransport` use outbound authenticated channels. Tailscale-specific wiring is an operator concern. |
| Host registry (HostId, profile, capabilities, health, allowed roots/projects) | PARTIAL | `ProjectRegistry` (`src/platform/ProjectRegistry.ts`), `Worker.location {host,remote}`. No explicit HostId/health/capability registry entity. |
| Host scheduling = process placement, not inference placement | PARTIAL | Placement via `Worker.location`; no host scheduler unit. |
| Least privilege: fs/repo/shell/network/MCP/secrets/Git/services/deploy/remote | EXISTING | `src/security/SecurityPolicy.ts` (ToolPolicy, redactSecrets, scanUntrustedInstructions, INJECTION_MARKERS), `src/platform/redact.ts`, `src/platform/security.ts`. |
| Audit privileged actions; prevent path escape; no broad secret injection | EXISTING | `ToolPolicy`, `redactDeep` (ControlPlane strips worktree paths/remotes), `MemoryCommit` redaction. |

---

## 11 — Pi-Web

| Requirement | Status | Source / test |
|---|---|---|
| Pi-Web stays external operator UI | EXTERNAL | `src/platform/ControlPlane.ts` is the normalized adapter; no UI rebuilt. |
| Normalized APIs/events for workflow/worker status, current op, branch/worktree, host/runtime, model, artifacts, diff, tests, failures | PARTIAL | `ControlPlaneSnapshot` exposes projects/runs/workers/events/tests/reviews/routing/memory. Missing current operation, worktree/branch per worker, host/runtime, model per worker surfaced uniformly. |
| Actions: inspect/attach/interrupt/resume/clarify/cancel/reconcile/retry/review | PARTIAL | `WorkerCommand` (run_task/cancel/restart/heartbeat), `ControlPlane` interventions. Missing attach terminal / resume / reconcile / review actions. |
| No direct Herdr coupling except narrow terminal bridge | — | Design boundary for Phase D. |

---

## 12 — Observability

| Requirement | Status | Source / test |
|---|---|---|
| Metrics: active workers by role/host, duration, failures/blocked, recoveries, completed, review failures, repair cycles, tokens/rate, model usage, InferWeave queue/admission, context/request utilization, prevented oversized requests, artifacts | PARTIAL | `src/lifecycle/telemetry.ts`, `src/telemetry/` (`sink.ts`, `TelemetryExport.ts`, `throttle.ts`), `admissionEvents.ts`. Missing metrics for prevented oversized requests, review failures, repair cycles, request-byte utilization. |
| Health from Herdr state + Pi lifecycle + InferWeave + process + output + heartbeat; terminal silence ≠ failure | PARTIAL | Heartbeat (`Worker.heartbeat_at`, `RemoteWorker`). Silence-not-failure policy is design guidance not yet encoded. |
| Grafana=time-series; Pi-Web=workflow/operator | PARTIAL | Telemetry export exists; no Grafana wiring. |

---

## 13 — Recovery and Idempotency

| Requirement | Status | Source / test |
|---|---|---|
| On restart load unfinished workflows, query runtimes, reconcile persisted WorkerIds, classify alive/resumable/completed-offline/failed/missing, restore orchestration | MISSING | No coordinator restart reconciliation. `missionStore.ts` persists state but no resume/reconcile loop. Phase E deliverable. |
| Never blindly rerun work that may have mutated Git | PARTIAL | Idempotent command `generation` on RemoteWorker; `settledElsewhere` in broker. Not a general recovery guarantee. |
| Every dispatch carries RunId+TaskId+attempt/idempotency key | PARTIAL | `Execution.execution_id`, `Task.attempt`/`max_attempts`, `WorkerCommandEnvelope.generation`. No explicit RunId+TaskId+attempt composite idempotency key on dispatch. |
| Reconcile events, worktree/commits, artifacts, runtime state before retry | MISSING | Phase E deliverable. |
| Test coordinator crash, Herdr restart, remote disconnect, worker death, partial completion | MISSING | Some remote reconnect tests; no crash/reconcile tests. Phase F (spec 15). |

---

## 14 — Migration and Rollback

| Requirement | Status | Source / test |
|---|---|---|
| 0 inventory overlaps; 1 legacy behind AgentRuntime + pass contracts; 2 Herdr behind flag; 3 parity/shadow/canary no deletion; 4 selected workloads; 5 Herdr default after gates; 6 remove legacy only after rollback drill + telemetry window | MISSING | No migration state machine. Phase H. |
| Backward-compatible DB migrations during dual runtime | PARTIAL | `eventstore/backend.ts` compatibility seam; no migration versioning. |

---

## 15 — Test Plan

| Requirement | Status | Source / test |
|---|---|---|
| AgentRuntime contracts, Herdr integration, mock runtime, multi-worker DAG, worktrees, service workers, structured-result enforcement, fan-out/synthesis, context/request budget + 413 regression, review/repair bounds, InferWeave admission, remote reconnect, coordinator/Herdr restart, lost worker, partial Git mutation, idempotent replay, security/path/secret, Pi-Web APIs/events, metric correlation | MISSING (as a plan) | Existing tests cover pieces: `test/unit/platform-*.test.ts`, `test/unit/workgraph*.test.ts`, `test/unit/git-worktree*.test.ts`, `test/unit/context*.test.ts`, `test/unit/security*.test.ts`, `test/unit/inference-admission*.test.ts`, `test/integration/orchestration*.test.ts`. No consolidated spec-15 suite; **no 413 regression test**. |
| Canary: planner → 2 engineers → tester → reviewer → repair → re-review | MISSING | No end-to-end canary harness for this. Phase G. |

---

## 16 — Definition of Done

All 16 gates are gated on Phase C–H. Current status: only boundary/ownership and a
large EXISTING foundation are in place. See `IMPLEMENTATION_LOG.md` for the phase DAG.

---

## Old runtime code that may eventually be deprecated (nothing deleted yet)

- `src/ledger/Ledger.ts`, `src/ledger/EventStore.ts`, `src/runtime/EngineeringRuntime.ts` — the original single-project runtime. It predates the orchestration/platform modules and may be superseded as the default execution path once AgentRuntime + Herdr parity passes.
- `src/workers/PiWorkerExecutor.ts` — legacy fresh-context worker executor; will remain as the `LegacyAgentRuntime` backend, not deleted.
- `src/bench/`, `src/benchmark/`, `src/roadmap/` — roadmap/tournament tooling, not part of the runtime migration but present.
- These are flagged for potential deprecation only after parity/recovery/canary/rollback gates pass (spec 14, Phase H). Nothing is removed in this phase.

---

## Summary counts

| Status | Count (by requirement row) |
|---|---|
| EXISTING | 16 |
| PARTIAL | 22 |
| MISSING | 18 |
| CONFLICTING | 3 |
| EXTERNAL | 6 |
| **Total rows** | **65** |

The largest gaps (Phase C/E/F/H): runtime-neutral `AgentRuntime` (02), the 413-prevention
byte/fan-out subsystem (06), restart reconciliation + idempotency (13), migration/rollback
state machine (14), the spec-15 test suite (15), and the end-to-end canary (15/16).
