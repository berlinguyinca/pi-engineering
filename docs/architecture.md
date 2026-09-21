# Architecture

This document describes how `pi-engineering-runtime` is built. The authoritative
**product** specification is `docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`;
this document describes the *implementation*.

## Design goals

- Work with a normal pi install in an ordinary git repo.
- **No** AutoSpec, InferWeave, GitHub, multiple models, or distributed infra.
- Deterministic tests (no model endpoint required in CI).
- Context discipline: workers run in fresh sessions, receive bounded context,
  and return bounded structured results. No parent transcripts are passed to
  workers (INV-001).
- Evidence before promotion: nothing becomes the incumbent without passing
  deterministic gates (INV-005).

## Components

```
extensions/index.ts          pi entry point: registers /commands + semantic tools
src/runtime/EngineeringRuntime.ts   facade + adaptive /engineer pipeline
src/orchestration/           mission orchestration (spec pi-engineering-orchestration)
                             IntentRouter, MissionStore, Scheduler, Broker, CompletionGate, Orchestrator
src/ledger/                  event-sourced Engineering Ledger (append-only JSONL)
src/artifacts/               filesystem artifact store (artifact:// URIs, lazy reads)
src/git/GitRepo.ts           worktree isolation, diff capture, controlled merge
src/context/ContextBroker.ts bounded task-context package (repo map + git grep -E)
src/verify/Verifier.ts       CommandVerifier + VerificationProvider abstraction
src/workers/                 role prompts, worker_result tool, executors
src/tools/coreTools.ts       semantic tools bound per-cwd
src/capability/              model discovery, capability modeling, observed perf, routing
src/lifecycle/               automatic lifecycle controller + harness, gates, vision,
                            destructive-op gating, telemetry, persistence
```

## Durable state

All state lives under `<repoRoot>/.pi-eng/`:

- `ledger.jsonl` — append-only event stream; replayed into an in-memory
  materialized view on open (INV-001).
- `artifacts/<category>/<id>.json` (meta) + `<id>.txt` (content) — candidate
  diffs, verification logs, scout context. Read lazily by `artifact://` URI.

## The Engineering Ledger

The ledger is **event-sourced**: every mutation appends an event
(`entity_created`, `entity_status_changed`, ...). On `open()` it replays the
stream to build materialized work items, candidates, and entities. Entities:

- `work_item` — a goal plus lifecycle (`OPEN` → `COMPLETED` / `FAILED`).
- `candidate` — an implementation attempt in an isolated worktree, with
  `base_commit`, `diff`, `changed_files`, `parent_id` (fix-lineage), `status`
  (`pending` → `verified` → `promoted` / `rejected`).
- `hypothesis` — a claim from a scout/worker. **Never silently promoted to a
  fact** (INV-006); promoted only when backed by evidence.
- `finding` — a reviewer finding with a severity.
- `requirement` / `decision` — recorded goals and decisions.

## Workers (fresh context, bounded results)

A worker is a **fresh** pi SDK session (in-process `createAgentSession`) with a
role-specific system prompt, a restricted toolset, and a budget. It must finish
by calling the terminating **`worker_result`** tool, which returns a bounded
structured result:

```ts
{ status: "completed"|"blocked"|"failed",
  summary: string,
  claims: [{ claim, evidence }],
  evidence_refs: string[],
  new_hypotheses: string[],
  proposed_tasks: string[] }
```

`FakeWorkerExecutor` provides a deterministic executor for tests;
`PiWorkerExecutor` drives real model sessions (and registers local
Ollama-style providers from `~/.pi/agent/qwen-nodes.json` when present).

## Candidate isolation (INV-003 / INV-004)

Each implementation candidate runs in a **git worktree** on its own branch
created at the incumbent's base commit. The worker can only mutate the
worktree. If the candidate passes verification and review, the runtime performs
a **controlled merge** (`git merge --no-ff`) of the candidate branch into the
incumbent branch — the worker never writes to the incumbent directly, and a
conflicting merge is aborted without mutating the incumbent.

## Verification (INV-005)

`CommandVerifier.detect(cwd)` inspects the repo's `package.json` (and fallbacks)
to pick a risk-appropriate profile (`typecheck`/`test`/`build`, plus a
`syntax-check` fallback). `run()` executes each stage, captures the log to an
artifact, and returns a deterministic pass/fail outcome. `VerificationProvider`
abstraction permits alternate backends later.

## The `/engineer` pipeline

1. Classify risk (`low`/`medium`/`high`) from the goal.
2. Assemble bounded task context (repo map + symbol search) within the
   implementer budget.
3. If `medium+`, run a fresh scout; record claims as hypotheses.
4. Loop (max `MAX_ROUNDS`):
   - create an isolated candidate worktree;
   - run a fresh implementer that edits the worktree;
   - verify deterministically; record evidence;
   - if verification fails → reject, spawn a **child** candidate;
   - run a fresh independent reviewer; collect material findings;
   - if clean (or last round) → controlled-merge + promote; else fix round.
5. Mark the work item `COMPLETED`/`FAILED` and return a compact `EngineerReport`.

## Automatic lifecycle & model router (`src/lifecycle/`, `src/capability/`)

The lifecycle harness activates automatically on `agent_settled` and runs one
pass (classify → implement → verify → review → gate). Completion is
harness-owned; the parent model cannot self-declare success. The model router
discovers models from configured providers and routes each role by capability,
availability, observed performance, and cost with overrides and fallback.

- `src/capability/registry.ts` — `ModelCapabilityRegistry`, penalties, saturation.
- `src/capability/router.ts` — `RoleRouter` (async select/fallback), explainable decisions.
- `src/lifecycle/controller.ts` — `LifecycleController`, the automatic pass.
- `src/lifecycle/harness.ts` — `LifecycleHarness`, Pi event wiring + `/engineering` command.
- `src/lifecycle/gate.ts` — `evaluateGate`, completion gating.
- `src/lifecycle/destructive.ts` — command risk classification and gating.
- `src/lifecycle/vision.ts` — vision routing, cache, hand-off.
- `src/lifecycle/store.ts` — run persistence under `.pi-eng/lifecycle/`.
- `src/lifecycle/telemetry.ts` — lifecycle + admission telemetry.

State persists under `<repoRoot>/.pi-eng/lifecycle/`. See
`docs/specs/pi-automatic-engineering-lifecycle-model-router-spec.md`.

## Extension surface

- Commands: `/engineer`, `/ledger`, `/context`, `/verify`, `/review`, `/challenge`.
- Tools: `ledger_read`, `ledger_claim`, `artifact_read`, `repo_search`, `symbol`,
  `tests_for` — resolved against the runtime for the calling cwd, so worker
  sessions and the interactive session share one durable ledger.
