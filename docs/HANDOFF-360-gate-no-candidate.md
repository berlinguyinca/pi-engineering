# Handoff — #360: recovery-gate no-candidate dead loop

**Status:** foundation landed, orchestrator wiring remaining.
**Issue:** [#360](https://github.com/berlinguyinca/pi-engineering/issues/360)

## What the bug is

A BLOCKED mission whose repair gate refuses `CREATE_REPAIR_TASKS` because **no
candidate is recorded** dead-loops: with no candidate the gate refuses, and with
no repair tasks no candidate can ever be produced. Observed on MSN-leG4ua (14
consecutive auto-recoveries, all the same gate refusal).

## What landed (this PR)

1. **`MissionStore.recordReconstructedCandidate`** (`src/orchestration/missionStore.ts`)
   — records a **Git-verified, checkpoint-traceable** candidate **without**
   requiring a SUCCEEDED authoritative execution (the producing execution failed
   before publishing). The trust anchor is the source checkpoint's
   `candidateSha` matching the identity. The candidate is marked with
   `reconstructedFrom` (checkpoint/branch/sha/timestamp) so it stays auditable.
   - Guards: mission exists; identity matches the current workspace manifest +
     base; source checkpoint exists and its `candidateSha`/`repoId` match the
     identity; supersedes a prior differing candidate.
2. **`CandidateRevision.reconstructedFrom?`** + `ReconstructedCandidateSource`
   (`src/orchestration/types.ts`) — the audit marker. `copyCandidateRevision`
   deep-copies it.
3. **Unit tests** (`test/unit/orchestration-reconstructed-candidate.test.ts`) — 5
   passing tests for the primitive.
4. **Acceptance spec** (`test/integration/gate-no-candidate-reconstruction.test.ts`)
   — 2 end-to-end tests, **skipped** (`describe.skip`) documenting the required
   behavior:
   - (a) no candidate + preserved Git-verifiable commit ahead of base →
     reconstruct, record, re-run validation/review, COMPLETE.
   - (b) no candidate + no preserved work → clean FINITE stop (no refusal loop)
     with an operator-facing explanation.

## What remains (the hard part)

The orchestrator wiring in the **gate-refusal branch**
(`src/orchestration/orchestrator.ts`, the `CREATE_REPAIR_TASKS &&
!startingCandidateContent && ... preCandidateImplementers.length === 0` branch,
~line 797):

1. **Select** a Git-verifiable preserved checkpoint:
   `store.listTaskCheckpoints(missionId)` → pick one whose `candidateSha`
   resolves, `git.isAncestor(baseSha, candidateSha)`, and
   `git.revListCount(`${baseSha}..${candidateSha}`) > 0`.
2. **Seed the candidate-TARGET worktree** with that content. **This is the
   blocker.** Validation/review with `candidateScoped: true` run in the candidate
   target worktree (`broker.missionCandidates.get(missionId).lifecycle.path`) and
   throw `CANDIDATE_UNAVAILABLE` if it is absent. So the reconstructed content
   must land in the broker's candidate-target lifecycle (a durable,
   broker-managed record — see `loadCandidateLifecycles` /
   `persistCandidateLifecycle` in `src/orchestration/broker.ts`), not just be
   recorded. Two viable approaches:
   - **Checkpoint-driven integration:** create an integration task configured to
     merge the preserved branch/ref, run it (the integration backend anchors the
     candidate target + publishes a candidate), then `finalizeMission(gateOnly)`.
     Note: the integration backend merges from `missionWorktrees`
     (pending integrations), which `rehydrateMission` builds from **non-superseded**
     tasks — but in the real leG4ua state the preserved work is on a
     **superseded** task's branch, so this path needs the checkpoint's ref fed
     explicitly.
   - **Direct lifecycle seed:** create/anchor a candidate-target lifecycle at the
     preserved sha and record via `recordReconstructedCandidate`.
3. **Record** the reconstructed candidate (`recordReconstructedCandidate`) and
   **re-run the gate** (`finalizeMission(..., { gateOnly: true })`).
4. **Finite stop (path b):** when no preservable checkpoint exists, keep the
   existing refuse + durable stop, and add the regression test that a second
   `repairBlockedMission` does **not** re-enter (no new recovery decisions).

## Why it was not finished in-session

Seeding the candidate-target lifecycle touches the broker's durable candidate
records and the integration/merge machinery — a delicate trust-boundary area.
Completing it safely (with the integration spec green) requires focused iteration
that exceeded the session budget. The primitive + spec + this handoff are the
safe, correct foundation to build on.

## Verification of what landed

- `npm run typecheck` → clean.
- `test/unit/orchestration-reconstructed-candidate.test.ts` → 5/5 pass.
- `test/integration/gate-no-candidate-reconstruction.test.ts` → skipped (spec).
- `test/unit/orchestration-missionstore.test.ts` → green (no regressions).
