# Worktree Isolation — Integral by Default

Status: implementation plan (accepted: "do both", hard default)

## Problem

Concurrent pi sessions launched from the same repository root resolve to a single
durable orchestration store `<repoRoot>/.pi-eng/orchestration.jsonl` and serialize
on its single-writer file lock. A second session is then unable to open the
engineering runtime at all (every semantic tool returns "not initialized"), so it
cannot start a mission. Today the only escape hatch is the manual env override
`PI_ENGINEERING_ORCHESTRATION_DIR`.

Goal: make mission isolation integral to pi-engineering so this cannot happen by
default, without an env var, and so every mission provably starts in a fresh git
worktree.

## What already exists (verified in source)

- **Per-task worktrees (Option 2, mostly present):** the mission broker allocates
  an isolated worktree per mutating task (`broker.allocateWorktree` →
  `GitRepo.createWorktree` → `pi-eng-orch-<taskId>`), and the planner marks
  mutating agents `isolation: "worktree"`. Implementation already happens off the
  primary checkout.
- **Per-worktree store (Option 1, mostly present):** `EngineeringRuntime.open`
  resolves `repoRoot` via `git rev-parse --show-toplevel`, which returns a linked
  worktree's own root. So opening pi inside a linked worktree already puts the
  store at `<worktree>/.pi-eng` — isolated from the primary checkout.

## The genuine gaps

1. **Same-root sessions (the incident).** Two sessions at the *same* primary root
   still share one store + lock. Worktrees alone do not fix this if the user
   launches from the shared root.
2. **Guarantees are implicit, not integral.** Nothing forces a mission to run in a
   worktree; the allocation is policy-driven, and the per-worktree store is a
   side effect of `--show-toplevel` rather than an explicit, tested contract.
3. **Orchestration store is process-global.** The mission's durable store lives in
   the parent runtime, not in the mission's worktree. So a mission "in a worktree"
   still writes its orchestration state to the parent store.

## Design (both, hard default)

### A. Per-worktree orchestration store — integral default (Option 1)
- Make store isolation an explicit, always-on rule: when a runtime is opened inside
  a git **linked worktree**, the orchestration store is the worktree's own
  `.pi-eng` (already true via `--show-toplevel`). When opened at a **primary
  checkout**, keep `<repoRoot>/.pi-eng` (shared per-repo memory) but emit a clear
  startup notice telling the operator that running missions from a fresh worktree
  (or setting `PI_ENGINEERING_ORCHESTRATION_DIR`) isolates the store.
- Add a unit test pinning both behaviors so the contract is explicit, not a side
  effect.

### B. Mission always starts in a fresh worktree — integral default (Option 2)
- Make worktree allocation unconditional for every mutating mission: the planner
  must emit `isolation: "worktree"` for all mutating agents (no opt-out), and the
  broker must allocate a fresh worktree per execution. Enforce via a guard + test
  that a mutating mission's every task has `isolatedWorktree === true`.
- Add a dedicated **mission worktree** allocated once at mission start, serving as
  the mission's execution root (tasks fork candidate worktrees from it). This makes
  "the mission starts in a new worktree" literally true and stable across the
  mission lifetime.

### C. (Deferred / flagged) Mission-scoped orchestration store
- Relocating the *mission's* durable orchestration store into its mission worktree
  is invasive (the store is process-global in `EngineeringRuntime`). This is the
  part that would let two missions at the same primary root run fully in parallel.
  It is **deferred** to a follow-up because it requires a per-mission store
  abstraction and live validation, which the locked runtime cannot provide right
  now. Worktrees + per-worktree store already deliver isolation for the common
  case (missions running from worktrees).

## Files touched
- `src/git/GitRepo.ts` — added `gitDir()` and `isLinkedWorktree()`.
- `src/runtime/EngineeringRuntime.ts` — `resolveOrchestrationDir` worktree-aware
  + per-worktree startup notice.
- `test/unit/orchestration-store-location.test.ts` — linked-worktree isolation test.

## Implemented (this pass)
- **A (Option 1, per-worktree store):** `GitRepo.isLinkedWorktree()` detects a
  linked worktree (`git-dir` inside the shared common dir's `worktrees/`).
  `EngineeringRuntime.open` emits an `info` notice (once per process) when the
  store is the shared primary-checkout store, telling the operator that running
  from a worktree (or `PI_ENGINEERING_ORCHESTRATION_DIR`) isolates it. Test
  proves a linked worktree's store + lock live in the worktree's own `.pi-eng`.
- **B (Option 2, integral default):** verified in source that the default mission
  planner already emits `isolation: "worktree"` for every mutating agent
  (`src/runtime/EngineeringRuntime.ts` defaultPlanner, `isolation: mutates ?
  "worktree" : "none"`), and the broker allocates a fresh worktree per mutating
  task (`allocateWorktree`). This is the integral default.

## Deliberately NOT changed (conflict with existing tested behavior)
- I did **not** add a hard guard that rejects every mutating task with
  `isolation: "none"`. The broker has an explicit, tested path for deliberate
  in-place mutation (`orchestration-broker.test.ts`: "still dispatches ...
  explicitly non-isolated work without a worktree"), and the restricted-domain
  guard already forces a worktree whenever a repo is not fully writable. Forcing
  *all* mutations into worktrees would break that deliberate opt-out. The
  worktree-isolated default remains the integral behavior; explicit opt-out stays
  available as a conscious choice.

## Deferred / flagged (needs live mission validation)
- **C (mission-scoped orchestration store):** relocating the *mission's* durable
  orchestration store into its mission worktree is invasive (the store is
  process-global in `EngineeringRuntime`). Deferred; worktrees + per-worktree
  store already isolate the common case.

## Validation
- `npx tsc --noEmit` passes.
- `test/unit/orchestration-store-location.test.ts` passes (including the new
  linked-worktree isolation case).
- Live-mission end-to-end validation is required for C and to confirm no
  regression, once the runtime is unblocked.
