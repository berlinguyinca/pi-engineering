# Pi Automatic Engineering Lifecycle & Capability-Aware Model Router

Status: Implemented
Target: `pi-engineering-runtime`
Scope: automatic lifecycle controller, capability-aware model routing, independent/specialist review, verification, completion gating, vision routing, destructive-operation gating.

## 1. Problem

A parent engineering model should be able to do ordinary engineering work and have the *harness* own the engineering lifecycle automatically — classification, verification, independent and specialist review, and completion gating. The parent model must not have to remember lifecycle commands (`/review`, `/verify`, reviewer skills). At the same time the runtime must route each role to a model that actually has the capability to perform it, and must preserve legitimate SSH/remote-administration/Ansible/deployment/server-start operations behind risk-aware review/approval gates rather than blanket-disabling them.

## 2. Goals

1. **Automatic lifecycle**: when the agent settles after a turn, the harness runs one lifecycle pass (classify -> implement -> verify -> review -> gate). No manual lifecycle commands required from the parent model.
2. **Harness-owned completion**: the parent model cannot self-declare success; completion is decided by the gate and recorded by the harness.
3. **Capability-aware routing**: models are auto-discovered from configured providers and routed by role/capability/availability/performance, with overrides and fallback.
4. **Independent & specialist review**: reviewers are never the implementing model (separation of duties); specialist reviewers are triggered by change category.
5. **Verification & spec verification**: evidence-based verification of declared commands (package scripts, CI, AGENTS.md, Makefile, config); spec verification when a spec path is present.
6. **Vision routing**: when vision is required (user images, UI changes), route to a vision-capable model or force a hand-off.
7. **Destructive-operation gating**: destructive/remote/admin commands are gated (blocked or approval-gated), never blanket-disabled.
8. **Normal chat stays passive**: non-engineering requests with no repository change never open a run or spawn reviewers.

## 3. Non-goals

- No distributed cluster, no multiple-model requirement, no GitHub dependency (core stays standalone).
- No custom LSP implementation.
- No premature long-term architecture.

## 4. Architecture

Two subsystems under `src/`:

- **`src/capability/`** — model discovery, capability modeling, observed performance, routing.
- **`src/lifecycle/`** — classification, policy, state machine, controller, harness wiring, verification, review, vision, destructive gating, telemetry, persistence.

### 4.1 Capability subsystem (`src/capability/`)

- `modelRecord.ts` — `ModelRecord` normalization (`normalizeModelRecord`), capability keys (`vision`, `reasoning`, `tool_calling`, `streaming`, `long_context` >=200k ctx, `local`), `hasCapability`.
- `registry.ts` — `ModelCapabilityRegistry` (open/refresh/all/get/penalize/clearPenalty/observed/size/isStale/ensureFresh, `recordSaturation`).
- `discovery.ts` — `ModelSource` abstraction; sources for Pi model runtime, agent models file, capacity endpoint, static definitions.
- `observed.ts` — `ObservedStore` recording per-model/per-role quality/latency outcomes.
- `router.ts` — `RoleRouter` (async `select`/`fallback`), `RouteQuery`, `RoutingDecision` with full rationale.
- `roles.ts` — role vocabulary and per-role capability requirements.

### 4.2 Lifecycle subsystem (`src/lifecycle/`)

- `classification.ts` — `WorkCategory`, `Classification` (categories/risk/planTriggers/specialists/visionRequired/reasons), command classification.
- `policy.ts` — `DEFAULT_POLICY` and load/merge; mandatory non-weakenable keys; `admissionConfigFromPolicy`.
- `stateMachine.ts` — `LifecycleState`, `STAGE_ORDER`, `canTransition`/`canTransitionToTerminal`.
- `changeObserver.ts` — `captureChangeSnapshot`/`hasMeaningfulChange`/`changeAreas` over git working tree.
- `verification.ts` — `planChecks` (package scripts, CI, AGENTS.md, Makefile, config), `runChecks`, `CheckOutcome`.
- `reviewResultTool.ts` — `ReviewVerdictPayload`, `ReviewFinding`, `fingerprint`, `toReviewReport`.
- `rolePrompts.ts` — per-role prompts and kickoff; `buildCompletionReport`.
- `roleRunner.ts` — `RoleRunner`/`PiRoleRunner`/`ScriptedRoleRunner`; fresh-context role sessions with tool allowlists; routing-failure is a first-class outcome.
- `vision.ts` — vision path/capability/cache/hand-off decisions.
- `destructive.ts` — command classification and gating patterns (SSH, Ansible, terraform, kubectl, package managers, `rm -rf`, DROP TABLE, force-push, etc.).
- `gate.ts` — `evaluateGate`, `GateInput`, `GateStatus`, blocker computation.
- `controller.ts` — `LifecycleController` (noteRequest/observeToolCall/observeToolResult/settle/ignoreFinding/reopenRun), the automatic pass, remediation, escalation.
- `harness.ts` — `LifecycleHarness`; Pi event wiring (`before_agent_start`, `tool_call`, `tool_result`, `agent_settled`, `model_select`), approval UI, `/engineering` command, admission-retry integration.
- `store.ts` — `LifecycleStore` persistence + transition log.
- `telemetry.ts` — `LifecycleTelemetry` (memory/file sinks), `summarizeMetrics`, admission bridge.

## 5. Automatic activation & completion ownership

- The harness registers Pi event handlers in `harness.ts`.
- On `agent_settled` the harness runs `controller.settle("turn_settled")` unless `policy.lifecycle.automatic === false` or the harness is mid-pass.
- Completion state, gate status and completion reports are harness-owned; the parent model's prose never closes the gate.
- When the gate fails, the harness injects a harness-authored remediation follow-up (`sendUserMessage(..., {deliverAs: "followUp"})`) guarded by a `harnessInjected` flag and the `REMEDIATING` state to prevent recursion.

## 6. Capability-aware routing

- Models are discovered from configured providers via `ModelSource` implementations.
- `RoleRouter.select(query)` scores candidates by capability fit, availability/health, observed performance, cost, and priority; overrides may pin a role to a specific model.
- `RoleRouter.fallback(query, attempted)` excludes already-tried models; failures penalize the model in the registry.
- Every `RoutingDecision` carries candidates, rejected models, rationale, and whether an override/fallback applied, so routing is fully explainable.

## 7. Independent & specialist review

- `independent_review_pass` requires at least one review by a model that is not the implementing model (separation of duties).
- Specialist reviewers (`security_reviewer`, `test_reviewer`, `performance_reviewer`, `api_reviewer`, `database_reviewer`, `infrastructure_reviewer`, `documentation_reviewer`, `ui_reviewer`, `architecture_reviewer`, `vision_reviewer`) are triggered by change classification.
- Structured reviewer output is produced through the `review_result` tool.
- Findings are fingerprinted and tracked; unresolved high-risk findings block completion.

## 8. Verification

- `planChecks` discovers declared verification commands from package scripts, CI workflows, AGENTS.md, Makefile, and config (`command_sources`: `package_json`, `ci`, `agents_md`, `makefile`, `config`).
- `runChecks` executes them and records evidence (exit code, summary, artifact URI).
- A required check that is `not_applicable` (no command declared) is treated as a genuine pass by the gate, never a blocker.
- `tests_when_required` requires a test change or a run test command for behaviour-bearing changes.
- Final re-verification runs after review when needed.

## 9. Spec verification

- When a request references a spec path, a `spec_verifier` review is dispatched and the run passes through `SPEC_VERIFY_PENDING`/`SPEC_VERIFIED` (or `SPEC_VERIFY_FAILED`).

## 10. Vision routing

- When user images are present or a change is UI/visual and the session model lacks vision, the harness either routes to a vision-capable model or forces a hand-off (default), per `shouldHandOffVision`.
- Vision results are cached by content hash in `VisionCache`.

## 11. Destructive-operation gating

- `destructive.ts` classifies commands into risk levels (LOW/NORMAL/HIGH/CRITICAL).
- Irreversible/root/home recursive deletes, disk operations, DROP/TRUNCATE, force-push, `terraform destroy`, `kubectl delete`, shutdown/reboot are CRITICAL/HIGH.
- Legitimate SSH, remote administration, Ansible/deployment, package installs, service/server-start are preserved behind risk-aware review/approval gates (`policies.risk`), never blanket-disabled.
- Approval may be interactive (`ctx.ui.confirm`) or unattended per `policies.risk.unattended`.
- Read-only commands (ls/cat/grep/git status/...) are never gated.

## 12. Policy & precedence

- `DEFAULT_POLICY` is the baseline; layers merge over it with deep-merge (arrays replace).
- Mandatory keys (e.g. independent review, specialist review, verification) are non-weakenable: a layer may not disable them.
- Session overrides apply; invalid layers are rejected.

## 13. Telemetry & persistence

- `LifecycleTelemetry` records run started, invocations, reviews, verifications, gates, approvals, refresh, transitions.
- `LifecycleStore` persists runs under `.pi-eng/lifecycle/` and an append-only transition log for idempotent resume.
- Admission-retry events are bridged into telemetry and surfaced via status/widgets.

## 14. Testing

- `test/unit/capability.test.ts` — normalization, discovery merge, penalties, observed store, hard-reject, SoD, scoring/overrides, fallback, deny/health.
- `test/unit/lifecycle-policy.test.ts` — default validity, layer merge, non-weakenable keys, classification, destructive gating.
- `test/unit/lifecycle-gate-state.test.ts` — gate pass/fail, state transitions, persistence, vision, telemetry.
- `test/unit/lifecycle-verification.test.ts` — plan-checks discovery (package scripts, CI, AGENTS.md, Makefile), runChecks, not_applicable handling.
- `test/integration/lifecycle-automatic.test.ts` — automatic completion with zero manual commands, chat-only passivity, destructive block/approve, remediation escalation.
- `scripts/dogfood-lifecycle.ts` — deterministic end-to-end dogfood (fake or real models).

## 15. Acceptance criteria

- [x] Automatic lifecycle runs on agent settle with zero manual lifecycle commands.
- [x] Completion is harness-owned; parent model cannot self-declare success.
- [x] Capability-aware routing with overrides and fallback; routing is explainable.
- [x] Independent and specialist review enforced (separation of duties).
- [x] Verification and spec verification with evidence.
- [x] Vision routing with hand-off and caching.
- [x] Destructive operations gated, legitimate remote/admin preserved.
- [x] Normal chat stays passive.
- [x] Telemetry + persistence + tests + dogfood.
- [x] Full repo typecheck, lint, and 300+ tests pass.
