# Investigation: Compaction Design & Handoff-Based Architecture (TSK-69Vusp)

Status: investigation only — no runtime changes. Findings below; see ledger
FACT-Br1lXj, FACT-hk658H, FACT-qRxZgu, HYPOTHESIS-ejVe1E.

## 1. Current compaction design

### Native Pi (authoritative: `@earendil-works/pi-coding-agent/docs/compaction.md`)
- Auto-compaction triggers at `contextTokens > contextWindow - reserveTokens`
  (plus a `keepRecentTokens` recent-context carve-out).
- Summarization is done by the model via a built-in prompt; the compaction entry
  (summary, firstKeptEntryId, tokensBefore) is committed into the session JSONL
  and the session file is rewritten from the compaction entry onward.
- Fallback: if the summarization request itself fails (busy gateway /
  `queue_deadline_exceeded` / "Stream ended without finish_reason"), the turn
  aborts — this is the failure mode seen on the 128k-window metabolomics
  session.

### Pi Engineering on top of native
- `src/compaction/autoTune.ts`: per-model tuning via extension seams
  (`turn_end`, `session_before_compact`); adjusts `contextWindow` and
  `reserveTokens` per discovered model. Custom compaction instructions are
  supplied (not a duplicated summarizer).
- `src/compaction/summaryInstructions.ts`: caps the summary at ~900 words
  (`SUMMARY_WORD_CAP`), anchors the Goal on the latest substantive user request
  (`latestUserRequest` scans entries in reverse, ignores bare continuations,
  clips quoted request text to 2000 chars).
- Spec `docs/specs/dynamic-context-capabilities/05-compaction-and-context-policy.md`:
  Phase 1 = register correct per-model `contextWindow`/`maxTokens`, keep native
  compaction, no second compaction trigger. Phase 2 (adaptive reserve policy)
  deferred pending benchmarks. Small-model switch path: detect → native compact
  → re-check → fail before dispatch with actionable message.
- Model-switch path: `src/plannerWorker/extension.ts` observes `model_select`,
  calls `assessSessionSwitch` (`sessionSwitch.ts` → `planTransition` in
  `compatibility.ts`); if outcome is `compact` it calls `ctx.compact()` with
  "Preserve task state, decisions, and open files; compress the rest."
- Spec v2 §18.3: custom compaction is scoped to bounded worker sessions only;
  summary priorities: (1) current task, (2) edits made, (3) authoritative
  constraints, (4) test evidence, (5) unresolved failures, (6) artifact
  references.

## 2. Proposed handoff-based architecture

Goal: stop relying on lossy in-session summarization; hand context across
sessions/roles/generations as immutable, verifiable packages at phase
boundaries, so a session never has to compact mid-phase.

Mechanism (all implemented as pure modules, 62 unit tests passing):
- `src/runtime/host/handoffKinds.ts` — 10 typed kinds (`context`, `delegation`,
  `supervisor`, `review`, `review_fix`, `pr`, `merge`, `deployment`, `recovery`,
  `phase_transition`); strict state machine
  `prepared → validated → acknowledged → committed` (`aborted` from any
  non-committed state).
- `src/runtime/host/handoffCheckpointRefs.ts` — immutable checkpoint refs:
  full 40-hex commit SHAs, 64-hex sha256 artifact hashes, `artifact://` refs,
  no duplicates; `attachCheckpointRefs` is immutable.
- `src/runtime/host/handoffResume.ts` — `decideHandoffResume` →
  `resume | restart_fresh | refuse`; fences on lease generation and checkpoint
  SHA; uncommitted side effects force `restart_fresh` (never replay external
  effects, HAND-007).
- `src/runtime/host/handoffRecovery.ts` — `reconcileSideEffects`
  (`committed|present → skip_replay`, `absent non-merge → replay`,
  `merge|unknown → manual`); `decideHandoffFallback` →
  `none | selective_compaction | fresh_restart` where
  `selective_compaction` only applies after a failed handoff with
  `contextUtilization >= 0.75`.
- `src/runtime/host/quotaResume.ts` — `decideQuotaResume` →
  `pause | switch_model | wait | fail` after inference failures;
  `handoffKind: "recovery"`; blocks `switch_model` when uncommitted side
  effects exist.
- `src/plannerWorker/handoff.ts` — `HandoffArtifact` (bounded: summary ≤ 1500
  chars, diff ≤ 24k chars) with `WORKER_INSTRUCTION` forbidding downstream
  re-planning; the only data crossing role boundaries.
- `src/plannerWorker/compatibility.ts` — `planTransition` preference order:
  `other_model → compact → handoff → reject`; `preferHandoff` (always for
  planner → worker) makes a task-specific handoff beat compaction so the
  implementer never inherits planner context.

Spec anchors: spec v2 §18 (Handoffs and Compaction — hand off at phase
boundaries: Discovery → Design → Implementation → Debug/Verification →
Review), `docs/specs/pi-engineering-orchestration/09-context-memory-artifacts.md`
(context packets + artifact store), `docs/specs/session-control.md`,
`docs/specs/pi-engineering-herdr-runtime/HERDR_COMPATIBILITY.md` (declares
`server.live_handoff`).

## 3. Implemented vs planned

Implemented & tested: the four pure `src/runtime/host/handoff*.ts` modules,
`plannerWorker/handoff.ts`, `sessionSwitch.ts` + `compatibility.ts`,
`quotaResume.ts`, `compaction/autoTune.ts` + `summaryInstructions.ts`.

Planned / not wired:
1. `src/orchestration/missionStore.ts:201` still stores handoffs as opaque
   `Array<Record<string, unknown>>` — no `HandoffRecord` validation or
   lifecycle enforcement.
2. `src/orchestration/checkpoints.ts:216` initializes `handoffs: []` with no
   checkpoint-refs attachment.
3. No `/handoff` command in the plannerWorker extension (spec AC-021, Epic B5).
4. `server.live_handoff` declared in HERDR compatibility but no implementation
   in `src/` (rg finds no matches).
5. No phase-boundary handoff triggers in the orchestration state machine.
6. `ctx.compact()` in the `model_select` handler
   (`src/plannerWorker/extension.ts` ~line 185) is still the active
   within-session mechanism.

## 4. Gap & migration steps (not yet implemented)

Gap = integration, not design: the pure modules exist and are tested but the
runtime still routes context pressure through native compaction.

Steps:
1. Type `missionStore.ts` handoffs as `HandoffRecord[]` with
   `validateHandoffRecord` on write.
2. Attach `HandoffCheckpointRefs` at checkpoint creation (`checkpoints.ts`).
3. Implement the `/handoff` command in the plannerWorker extension.
4. Implement `server.live_handoff` in the HERDR runtime.
5. Add phase-boundary handoff triggers to the orchestration state machine.
6. Replace `ctx.compact()` in the `model_select` handler with a handoff-based
   transfer per `planTransition`'s `preferHandoff` semantics.

Risks:
- `selective_compaction` in `decideHandoffFallback` is currently the only
  bridge between handoff and compaction; removing it before phase-boundary
  triggers exist leaves no recovery path for context pressure.
- Native compaction on model switch is load-bearing for interactive sessions;
  replacing it requires the `/handoff` command to be functional first.
- `server.live_handoff` has no implementation, so cross-process handoff is
  currently impossible.
