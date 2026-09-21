# Pi Engineering Continuous Acceptance & Verification (CAV) — Master Bootstrap Specification

Date: 2026-09-17
Status: implementation roadmap

## Purpose
This pack bootstraps Pi Engineering from today's agent-driven implementation workflow into an evidence-driven engineering harness that cannot claim COMPLETE merely because an LLM says work is done. It is deliberately ordered so each phase establishes machinery used to verify the next phase.

## Non-negotiable architecture
- Pi orchestrates; deterministic tools produce hard evidence.
- The implementer cannot promote its own requirement to VERIFIED.
- A failed deterministic gate cannot be overridden by an LLM reviewer.
- Acceptance contracts, golden references, sabotage fixtures, and completion policy are protected artifacts.
- UI changes require real-browser functional verification; visual requirements additionally require visual verification.
- Test the real stack, not only source or mocked components, whenever the acceptance contract requires integration.
- Independent reviewer context is separated from implementer rationale.
- External pi-web is integrated, never reimplemented. Pi Forge is out of scope.
- InferWeave performs dynamic capability/model routing; do not statically bind GPUs/models in Pi Engineering.
- Open-weight/self-hosted models remain sufficient: deterministic verification is the root of trust; model judgment adds findings but cannot waive failures.

## Completion states
SPECIFIED → IMPLEMENTED → TESTED → INTEGRATION_VERIFIED → E2E_VERIFIED → VISUALLY_VERIFIED (when applicable) → INDEPENDENTLY_REVIEWED → RECONCILED → VERIFIED.

`COMPLETE` is derived only when all in-scope requirements are VERIFIED or explicitly WAIVED by an authorized human with recorded rationale. UNKNOWN is not PASS. SKIPPED is not PASS.

## Bootstrap rule
Implement strictly in numeric phase order. Do not begin phase N+1 until the phase-N completion gate passes. Within a phase, execute the five step specs in order unless the step explicitly permits parallel work. CAV v0 verifies v1; v1 verifies v2; later versions dogfood the prior trusted layer.

## Phases
- **00 Root of Trust** — Build deterministic workflow state, evidence ledger, protected artifacts, hard COMPLETE semantics.
- **01 Change Classification** — Classify diffs and automatically derive required verification gates.
- **02 Deterministic Test Execution** — Normalize build/unit/integration execution with machine-readable evidence.
- **03 Real Stack Lifecycle** — Start/stop/health-check the actual deployed development stack.
- **04 Browser Instrumentation** — Add Playwright, console/network/exception capture, traces and videos.
- **05 Acceptance Contracts** — Translate specs into executable user journeys and requirement IDs.
- **06 UI Interaction Verification** — Verify clicks, forms, tables, navigation, state transitions and keyboard behavior.
- **07 Visual Regression** — Golden screenshots, viewport matrix, diffs and protected references.
- **08 Accessibility and UX Mechanics** — Automated accessibility, focus, overflow, loading/error/empty states.
- **09 Sabotage Suite** — Seed known defects and prove the verifier detects them.
- **10 Independent Review** — Separate implementer, test engineer and reviewer contexts/permissions.
- **11 Vision Review Advisory** — Use local/open-weight vision review for design fidelity without overriding hard gates.
- **12 Defect Ledger and Repair Loop** — Convert failures into defects, repair, selectively rerun and close with evidence.
- **13 Exploratory UI Agent** — Bounded browser exploration/monkey testing with reproducible traces.
- **14 Spec Reconciliation** — Compare every original requirement to implementation and evidence.
- **15 Model Routing** — Route implement/review/vision/bounded tasks through InferWeave capabilities.
- **16 Concurrency and Isolation** — Safe parallel workers, worktrees, ports, test data and ledger writes.
- **17 Pi-Web Integration** — Expose status, evidence, defects, screenshots, traces and worker activity in external pi-web.
- **18 Dogfood Pi Engineering** — Run the acceptance system against Pi Engineering itself.
- **19 Pilot AIMS** — Adopt on AIMS console and calibrate UI/visual verification.
- **20 Pilot InferWeave** — Adopt on InferWeave UI/API/topology and failure scenarios.
- **21 Pilot WeaveForge** — Adopt on WeaveForge and validate shared-project portability.
- **22 Autonomous Overnight Operation** — Continue implement-test-review-repair loops without false COMPLETE.
- **23 Hardening and Release** — Mutation testing, anti-bypass controls, metrics, docs and stable CAV 1.0 release.

## Global evidence schema
Every command execution records requirement IDs, git commit/tree, worker identity/role, start/end timestamps, command/tool identity, exit status, stdout/stderr artifact hashes, environment/stack identity, and produced artifacts. Browser evidence adds URL, viewport, console events, page exceptions, failed requests, response failures, trace, screenshot, and video on failure.

## Global anti-bypass rules
The implementer may not edit protected acceptance artifacts during a normal implementation task. Missing evidence fails closed. Tests changed in the same task are diff-reviewed. Golden updates require a separate approval path. Mocking a required real integration is a failure. Deleting/skipping a required test is a failure. Reviewer prose cannot synthesize PASS evidence.

## Adoption target
The shared CAV core lives in Pi Engineering and is project-configurable. AIMS, InferWeave, WeaveForge, and future repositories consume the same verification contract with project-specific adapters and acceptance journeys.
