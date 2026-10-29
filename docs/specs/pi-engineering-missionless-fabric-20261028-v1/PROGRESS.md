# MEF PROGRESS — resume point

Updated: 2026-10-28. Update this file at every phase boundary.

## Setup facts
- Host: bender. Spec ZIP came from the Mac (`ssh macbook-pro`, `~/Downloads/pi-engineering-missionless-fabric-v1-fixed.zip`), copied via scp, sha256 `cd66d4fc304272d809e4db7aeb4586806b249f11dc50ede6199508989cfb6ec8` verified identical on both ends. Archive listing had no absolute or `..` paths.
- Primary checkout `~/IdeaProjects/pi-engineering` is on `fix/pr372-reconstructed-candidate-replay` (63 ahead, untracked work) — **do not touch**.
- MEF worktree: `~/IdeaProjects/pi-engineering-mef`, branch `feat/missionless-fabric`, from `origin/main` 6082fb9.
- Spec lives at `docs/specs/pi-engineering-missionless-fabric-20261028-v1/missionless-fabric/`.
- In-flight overlap to respect: open PR #460 (rollover handoff edge — the start of the Handoff entity; extend it, do not duplicate); branch `feat/mission-live-activity` edits `extensions/index.ts` (hunks near 333-461 and 1927-2223, not the auto-invoke region at ~1094).

## Phase status
| Phase | State | Notes |
|-------|-------|-------|
| 0 inventory | mostly done | ENTRYPOINT-MAP, AUDIT-RESULTS, REUSE-MATRIX, EVENT-OWNER-MAP written; BASELINE-METRICS (needs live-model fixture) pending |
| 1 stop implicit Missions | PR open, awaiting user review | see PHASE-1-AUDIT.md, PHASE-1-RESULTS.md |
| 2 Task/Session/Run read model | implemented, verifying | branch feat/mef-phase2-work-projection, stacked on #463; see PHASE-2-AUDIT.md. Runs/sessions empty on the Ledger side until Phase 3 emits agent.* |
| 3 broker/scheduler/gate extraction | not started | |
| 4 adaptive delegation + handoffs | not started | build on PR #460 |
| 5 UX / Herdr / assistant | not started | |
| 6 canary + retirement | not started | needs user authorization |

## Standing rules
- One branch + one PR per phase. No merge or deploy without the user's OK (flipping a default for every Pi session is sensitive; the user deploys themselves).
- No new `PI_*` env flags (YAML config only). No Pi Forge / Pi-Bolt.
- Performance claims need measured evidence; time-to-first-tool-call needs a live model run and is "not measured" until then.
- herdr-open: baseline state file recorded at task start (scratchpad `state/herdr-open.json`); run `discover` at the very end.
