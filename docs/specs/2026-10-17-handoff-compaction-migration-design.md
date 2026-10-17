# Handoff-Based Context Management (Retire In-Session Compaction)

Date: 2026-10-17
Status: design — to be implemented via `/autospec-split` (Phase 3) → `/autospec-run`
Source investigation: `docs/notes/handoff-compaction-investigation.md` (TSK-69Vusp)
Companion docs: `docs/specs/dynamic-context-capabilities/05-compaction-and-context-policy.md`

## 1. Goal

Replace in-session **lossy compaction** with **handoff-based context transfer** at phase
boundaries, so a long session no longer depends on a model summarization call that can
fail under gateway load. Compaction is **demoted to a last-resort fallback**
(`selective_compaction`), never the primary mechanism.

Success looks like: a long mission crossing a phase boundary hands off its state through a
bounded `HandoffArtifact` and continues in a fresh session, with **zero** native-compaction
entries, even when the gateway is flaky.

## 2. Background / motivation

- A 128k-window reasoning session crashed when context hit the ceiling and auto-compaction
  (turn-prefix summarization) failed on a busy gateway: `queue_deadline_exceeded` /
  "Stream ended without finish_reason" / "model was cut off after nothing".
- Native compaction has **no non-model fallback**: if the summary call fails, the turn
  aborts. The whole session is at the mercy of one summarization call.
- The handoff machinery (pure modules) is already implemented and unit-tested (62 tests)
  but is **not wired into the runtime** — context pressure still routes through native
  compaction. This spec closes that gap.

## 3. Architecture (handoff mechanism — already built)

- `handoffKinds.ts` — 10 typed handoff kinds; state machine
  `prepared → validated → acknowledged → committed` (`aborted` on failure).
- `handoffCheckpointRefs.ts` — immutable checkpoint refs (commit SHAs, artifact hashes,
  `artifact://` refs); `attachCheckpointRefs` is immutable.
- `handoffResume.ts` — `decideHandoffResume → resume | restart_fresh | refuse`; fenced on
  lease generation + checkpoint SHA; uncommitted side effects → `restart_fresh`.
- `handoffRecovery.ts` — `reconcileSideEffects`; `decideHandoffFallback →
  none | selective_compaction | fresh_restart` (`selective_compaction` only after a failed
  handoff with `contextUtilization >= 0.75`).
- `quotaResume.ts` — `decideQuotaResume → pause | switch_model | wait | fail` after
  consecutive inference failures.
- `plannerWorker/handoff.ts` — `HandoffArtifact` (bounded: summary ≤ 1500, diff ≤ 24k) —
  only data crossing role boundaries.
- `plannerWorker/compatibility.ts` — `planTransition` preference
  `other_model → compact → handoff → reject`; `preferHandoff` for planner→worker.

The gap is purely **runtime wiring**: nothing in the orchestration path currently emits or
consumes these artifacts; context pressure still goes to native compaction.

## 4. Work breakdown (6 units, ordered)

Each unit is a self-contained, independently-mergeable change. Dependencies are strict: a
unit may not start until its **Depends on** units are merged. Units A1/A2 are additive and
low-risk; B2/B1 are the fix; C1 is the gated demotion; D1 is independent/parallel.

### Unit A1 — Type handoffs in the mission store (Foundation)
- **Goal:** `missionStore.ts` stores handoffs as validated `HandoffRecord[]`, not opaque objects.
- **Files:** `src/orchestration/missionStore.ts` (around the handoff read/write at `:201`).
- **Scope:** define/import `HandoffRecord`; add `validateHandoffRecord`; validate on write;
  reject or repair invalid rows.
- **Out of scope:** checkpoint refs (A2), any runtime trigger.
- **Tests:** unit tests for `validateHandoffRecord` (valid + each invalid shape); store
  round-trip preserves records.
- **Acceptance criteria:**
  - [ ] missionStore stores handoffs as `HandoffRecord[]` (no `Record<string,unknown>` for handoffs)
  - [ ] `validateHandoffRecord` rejects missing/invalid fields with a typed error
  - [ ] existing handoff read/write paths still pass current tests
- **Depends on:** none

### Unit A2 — Attach checkpoint refs at checkpoint creation (Foundation)
- **Goal:** `checkpoints.ts` attaches `HandoffCheckpointRefs` when creating checkpoints.
- **Files:** `src/orchestration/checkpoints.ts` (around `:216`, where `handoffs:[]` is initialized).
- **Scope:** replace the empty `handoffs:[]` init with refs attachment via
  `attachCheckpointRefs` (immutable).
- **Tests:** a checkpoint carries valid refs; `attachCheckpointRefs` immutability holds.
- **Acceptance criteria:**
  - [ ] checkpoint creation attaches `HandoffCheckpointRefs` (non-empty where a handoff exists)
  - [ ] `attachCheckpointRefs` immutability unit test passes
- **Depends on:** A1

### Unit B2 — `/handoff` command in plannerWorker (Manual handoff)
- **Goal:** an operator can trigger a handoff explicitly via `/handoff`.
- **Files:** `src/plannerWorker/extension.ts` (+ command registration).
- **Scope:** register the `/handoff` command; build a `HandoffArtifact`; drive the state
  machine `prepared → committed`; emit the artifact.
- **Tests:** the command produces a committed `HandoffArtifact` with bounded summary/diff.
- **Acceptance criteria:**
  - [ ] `/handoff` command exists and is invokable
  - [ ] it produces a committed `HandoffArtifact` (summary ≤ 1500, diff ≤ 24k)
  - [ ] the failure path aborts the handoff (state `aborted`)
- **Depends on:** A1, A2

### Unit B1 — Phase-boundary handoff triggers (The fix)
- **Goal:** the orchestration state machine initiates a handoff at each phase boundary
  (Discovery → Design → Implementation → Debug → Review) instead of letting context
  balloon to compaction.
- **Files:** the orchestration scheduler/state machine (identify the exact file; candidate
  `src/orchestration/scheduler.ts`).
- **Scope:** detect a phase boundary; if `contextUtilization` is above the threshold, emit a
  `phase_transition` handoff and start a fresh session from the artifact; keep compaction as
  fallback only.
- **Tests:** an in-process simulated long run crosses a boundary and hands off **without**
  compaction; the fallback fires only when the handoff fails.
- **Acceptance criteria:**
  - [ ] a phase-boundary transition emits a `phase_transition` handoff
  - [ ] a fresh session resumes from the `HandoffArtifact`
  - [ ] native compaction is **not** invoked when the handoff succeeds
- **Depends on:** B2

### Unit C1 — Demote compaction in `model_select` (HUMAN-GATED)
- **Goal:** replace `ctx.compact()` in the `model_select` handler with a handoff-based
  transfer per `planTransition` / `preferHandoff`.
- **Files:** `src/plannerWorker/extension.ts` (the `model_select` handler, ~`:185`).
- **Scope:** swap `ctx.compact()` for a handoff transfer; keep `selective_compaction` as a
  last-resort fallback (do **not** delete it).
- **Gate (phase gate):** only after B1 is merged **and** a live run proves a phase-boundary
  handoff works with zero compaction. Human review required; **no auto-merge**.
- **Tests:** a model switch transfers via handoff; fallback to `selective_compaction` still
  works when the handoff fails.
- **Acceptance criteria:**
  - [ ] `model_select` no longer calls `ctx.compact()` on the handoff-preferred path
  - [ ] `selective_compaction` remains reachable as fallback (regression test)
  - [ ] live-run: a model switch mid-session completes via handoff without a compaction entry
- **Depends on:** B1

### Unit D1 — `server.live_handoff` in HERDR runtime (Cross-process)
- **Goal:** implement `server.live_handoff` so handoffs can cross process boundaries.
- **Files:** the HERDR runtime server (locate the `live_handoff` handler / `HERDR_COMPATIBILITY`).
- **Scope:** implement the declared `server.live_handoff` RPC; serialize/deserialize
  `HandoffArtifact` + checkpoint refs across the process boundary.
- **Tests:** a handoff issued in process A is consumable in process B.
- **Acceptance criteria:**
  - [ ] the `server.live_handoff` handler exists and responds
  - [ ] a cross-process handoff round-trips a `HandoffArtifact`
  - [ ] the `HERDR_COMPATIBILITY` declaration matches the implementation
- **Depends on:** A1 (independent of B/C; can run in parallel; pull earlier only if the
  deployment requires cross-process handoff)

## 5. Ordering & gates

```
A1 → A2 → B2 → B1 → [ LIVE-RUN GATE ] → C1
        D1  (independent, parallel)
```

- **C1** is the only unit that removes a load-bearing path. It is **human-gated** and
  requires a live-run verification before merge.
- `selective_compaction` must remain reachable as a fallback through **all** units.
- Run the implementation missions on a **fast text model** (e.g. a `*-flash` variant) to
  avoid re-triggering the 128k-context problem during the migration work itself.

## 6. Team personality

Reliability / backend: platform engineer, backend developer, SRE, test engineer, security
advisor. Emphasis: state-machine correctness, **no replay of external effects**, robust
recovery paths, and real (not mocked) end-to-end verification.

## 7. Review counter-team

Correctness / adversarial: a reviewer focused on failure modes (what breaks a handoff
mid-commit, partial side effects, fence/generation races), a test engineer demanding
live-run proof for the C1 gate, and an architecture reviewer checking the
handoff/compaction boundary for regressions (especially that `selective_compaction` is not
accidentally deleted).

## 8. Testing strategy

- **Unit:** extend the existing 62 handoff unit tests per unit (A1 validation, A2 refs, B2
  command, B1 boundary trigger, C1 fallback, D1 round-trip).
- **Integration:** an in-process simulated long session that crosses a phase boundary and
  hands off without compaction.
- **Live-run (C1 gate):** a real mission on a real gateway crossing a boundary with **zero**
  compaction entries.

## 9. Risks

- Removing compaction before B1 is live leaves no recovery path → mitigated by the C1 gate.
- `ctx.compact()` is load-bearing for interactive sessions → mitigated by keeping
  `selective_compaction` as fallback.
- `server.live_handoff` unimplemented → cross-process handoff impossible until D1.
- Flaky gateway during the migration itself → mitigated by small units + a fast text model
  for implementation missions.
