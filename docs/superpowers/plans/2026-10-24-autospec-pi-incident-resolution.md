# AutoSpec–Pi Incident Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first autonomous incident-resolution vertical slice: Pi durably records and emits a normalized agent failure, AutoSpec consumes it idempotently into an issue, and a dry-run debugger handoff is produced without changing production state.

**Architecture:** Pi owns failure evidence and emits a versioned event through an injected sink. A small incident domain layer computes stable fingerprints and deduplicates events against the append-only event store. AutoSpec exposes an incident-ingest command that validates the event, writes an audit record, creates or updates an issue through the existing GitHub command boundary, and returns a machine-readable debugger dispatch plan. Deployment and automatic merge remain later slices; this slice proves the durable handoff before enabling them.

**Tech Stack:** TypeScript/Node test runner in `pi-engineering-runtime`; Rust workspace and existing `gh` command boundary in `autospec`.

**Spec:** `docs/specs/2026-10-24-autospec-pi-incident-resolution-design.md`

## Global Constraints

- All implementation and test changes must be made in dedicated git worktrees; never edit the active dirty AutoSpec checkout or the Pi primary checkout.
- Pi events are append-only and must be persisted before external delivery is attempted.
- Large logs remain artifact references; event payloads contain bounded summaries only.
- Delivery is at-least-once; AutoSpec ingestion must be idempotent by incident ID and fingerprint.
- Repository content and agent output are untrusted data; configured policy remains authoritative.
- No new dependency is required.
- No production deployment, destructive operation, force-push, or direct protected-branch write is introduced by this slice.

---

### Task 1: Add Pi incident domain types and deterministic fingerprinting

**Files:**
- Create: `src/incidents/types.ts`
- Create: `src/incidents/fingerprint.ts`
- Create: `test/unit/incidents-fingerprint.test.ts`
- Modify: `src/core/types.ts` to add the `incident.detected` event type only if the existing event union requires it.

**Interfaces:**
- Produces `AgentFailureIncident`, `IncidentClassification`, `IncidentRisk`, `incidentFingerprint`, and `toIncidentEventPayload` for later Pi and AutoSpec adapters.
- Consumes only JSON-safe primitive values and bounded artifact references.

- [ ] **Step 1: Write the failing tests** for identical fingerprints across volatile timestamps/absolute worktree paths, distinct fingerprints for different causes, bounded summary validation, and JSON payload shape.
- [ ] **Step 2: Run the focused test** with `npm test -- --test-name-pattern='incidents-fingerprint'` and confirm failure because the module does not exist.
- [ ] **Step 3: Implement the minimal pure types and canonicalization helpers** using the existing hashing/canonicalization conventions; strip only the configured worktree prefix and volatile fields.
- [ ] **Step 4: Run the focused test** and confirm all cases pass.
- [ ] **Step 5: Commit** with `feat: add deterministic pi incident fingerprints`.

### Task 2: Persist Pi incidents and deduplicate notifications

**Files:**
- Create: `src/incidents/IncidentController.ts`
- Create: `test/unit/incident-controller.test.ts`
- Modify: `src/index.ts` to export the incident controller and types.

**Interfaces:**
- `IncidentController.recordFailure(input): Promise<IncidentDecision>` appends the durable event before calling the injected `publish` function.
- `IncidentDecision` is `{ incidentId, fingerprint, duplicate, state, eventId, publishAttempted }`.
- Dependencies are injected: `EventStoreBackend`, `now`, `id`, and `publish`.

- [ ] **Step 1: Write failing tests** for first-seen persistence-before-publish, duplicate fingerprint suppression, publisher failure leaving a retryable durable event, and bounded room summary generation.
- [ ] **Step 2: Run the focused test** and confirm the expected missing-module failures.
- [ ] **Step 3: Implement the controller** with an in-memory index rebuilt from `backend.all()`, conditional append for deduplication, and no transcript storage in the event payload.
- [ ] **Step 4: Run the focused test** and confirm pass.
- [ ] **Step 5: Commit** with `feat: persist and deduplicate pi incidents`.

### Task 3: Emit failures from the Pi worker lifecycle seam

**Files:**
- Create: `src/incidents/AutoSpecIncidentSink.ts`
- Modify: the existing worker failure/lifecycle seam identified by symbol search (expected candidates: `src/aps/supervisor.ts` and/or the mission worker result path).
- Create or modify: the nearest existing lifecycle integration test.

**Interfaces:**
- `AutoSpecIncidentSink.publish(event): Promise<void>` sends one JSON event to an injected command/function boundary; it never embeds raw logs.
- The worker failure path calls the controller once with role, run, repository, revision, exit status, bounded summary, classification, and artifact URIs.

- [ ] **Step 1: Add a failing lifecycle test** proving a failed worker yields one `agent_failure` payload with artifact references and no raw transcript.
- [ ] **Step 2: Run the targeted lifecycle test** and confirm failure.
- [ ] **Step 3: Wire the controller into the existing failure seam** without changing successful worker behavior.
- [ ] **Step 4: Run the targeted lifecycle test plus the existing APS/lifecycle unit suite**.
- [ ] **Step 5: Commit** with `feat: emit normalized pi agent failures`.

### Task 4: Add an isolated AutoSpec worktree and incident ingest command

**Files in a second worktree based on the current AutoSpec HEAD:**
- Create: `crates/autospec-cli/src/commands/incident.rs`
- Modify: `crates/autospec-cli/src/commands/mod.rs`
- Create: `crates/autospec-core/src/incident.rs` and export it from `crates/autospec-core/src/lib.rs`.
- Modify: `test/fixtures/autospec-protocol/schemas/autospec-protocol-event.v1.schema.json` only if the existing event envelope cannot carry the additive `agent_failure` name and details.
- Create: `crates/autospec-cli/src/commands/incident_tests.rs` or add unit tests beside the command module.

**Interfaces:**
- CLI: `autospec incident ingest --repo OWNER/REPO --event-file PATH [--dry-run] [--json]`.
- Core parser: `parse_agent_failure_event(json: &str) -> Result<AgentFailureEvent, IncidentError>`.
- Projection: `IncidentIssueProjector::plan(event, existing_issue) -> IssueProjection` is pure; GitHub writes remain behind the existing `gh` command helper.
- Dry-run output includes `fingerprint`, `deduplicated`, `issue_title`, `issue_body`, labels, and `debugger_dispatch` without calling GitHub.

- [ ] **Step 1: Create the AutoSpec worktree** at `/home/wohlgemuth/IdeaProjects/.worktrees/autospec-incident-resolution` from the current AutoSpec HEAD; do not copy dirty primary-worktree changes.
- [ ] **Step 2: Write failing parser/projection tests** for valid events, malformed/missing required fields, stable issue body markers, duplicate fingerprint handling, and dry-run no-write behavior.
- [ ] **Step 3: Run the focused Rust tests** and confirm expected failures.
- [ ] **Step 4: Implement the parser, pure issue projection, and CLI dispatch** using existing `CommandFailure` and `gh` invocation conventions.
- [ ] **Step 5: Run focused Rust tests and the command validation tests**.
- [ ] **Step 6: Commit** with `feat: ingest pi agent failure incidents`.

### Task 5: Connect Pi to AutoSpec through a safe local handoff

**Files:**
- Modify in the Pi worktree: `src/incidents/AutoSpecIncidentSink.ts` and its tests.
- Modify in the AutoSpec worktree: CLI contract documentation and fixture coverage.
- Create: `test/integration/incident-autospec-handoff.test.ts` in the Pi worktree if the repository's integration harness can invoke the local command safely.

**Interfaces:**
- The sink writes a temporary event file with mode `0600`, invokes `autospec incident ingest --dry-run --json`, and removes only that exact temporary file in a `finally` block.
- The sink treats non-zero exit as retryable and preserves the durable Pi event; it never reports issue creation unless the command returns a validated success envelope.

- [ ] **Step 1: Write failing handoff tests** for successful dry-run projection, malformed AutoSpec output, command failure, and exact temporary-file cleanup.
- [ ] **Step 2: Run the targeted handoff test** and confirm failure.
- [ ] **Step 3: Implement the injected process runner and sink** with no shell interpolation of event fields.
- [ ] **Step 4: Run Pi integration tests and AutoSpec focused command tests**.
- [ ] **Step 5: Commit** with `feat: hand off pi incidents to autospec safely`.

### Task 6: Verify the vertical slice and document operation

**Files:**
- Modify: `docs/specs/2026-10-24-autospec-pi-incident-resolution-design.md` only for verified contract corrections.
- Create: `docs/operations/pi-autospec-incidents.md`.

- [ ] Run Pi formatting, typecheck, focused unit/integration tests, and the relevant full test subset.
- [ ] Run AutoSpec formatting, focused Rust tests, `cargo test --workspace --no-fail-fast`, and required shell/lock-step validation where feasible.
- [ ] Exercise a local dry-run event end-to-end and capture the JSON result as test evidence.
- [ ] Confirm both worktrees are clean except for committed changes and report any unavailable external GitHub/deployment checks explicitly.
- [ ] Commit documentation with `docs: document pi autospec incident handoff`.

## Spec coverage review

This plan implements the approved first vertical slice: durable failure event,
stable deduplication, room/consumer handoff boundary, AutoSpec issue projection,
and dry-run debugger dispatch. Automatic merge, versioned deployment,
post-deploy health checks, and rollback are intentionally separate follow-up
slices because they require deployment-controller contracts not present in the
current Pi runtime repository.

## Self-review

- No placeholders or unspecified “appropriate” steps remain.
- Pi and AutoSpec write sets are isolated into separate worktrees.
- Every production behavior has a failing-test step before implementation.
- The handoff is at-least-once and idempotent; external writes are dry-run in
  the first slice.
