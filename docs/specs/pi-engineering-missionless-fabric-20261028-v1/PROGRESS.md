# MEF PROGRESS — resume point

Updated: 2026-10-29. Update this file at every phase boundary.

## Setup facts
- Host: bender. Spec ZIP came from the Mac (`ssh macbook-pro`, `~/Downloads/pi-engineering-missionless-fabric-v1-fixed.zip`), copied via scp, sha256 `cd66d4fc304272d809e4db7aeb4586806b249f11dc50ede6199508989cfb6ec8` verified identical on both ends. Archive listing had no absolute or `..` paths.
- Primary checkout `~/IdeaProjects/pi-engineering` is on `fix/pr372-reconstructed-candidate-replay` (63 ahead, untracked work) — **do not touch**.
- MEF worktree: `~/IdeaProjects/pi-engineering-mef`, branch `feat/missionless-fabric`, from `origin/main` 6082fb9.
- Spec lives at `docs/specs/pi-engineering-missionless-fabric-20261028-v1/missionless-fabric/`.
- In-flight overlap to respect: open PR #460 (rollover handoff edge — the start of the Handoff entity; extend it, do not duplicate); branch `feat/mission-live-activity` edits `extensions/index.ts` (hunks near 333-461 and 1927-2223, not the auto-invoke region at ~1094).

## Phase status
| Phase | State | Notes |
|-------|-------|-------|
| 0 inventory | mostly done | ENTRYPOINT-MAP, AUDIT-RESULTS, REUSE-MATRIX, EVENT-OWNER-MAP written; BASELINE-METRICS.json written (live-model metrics listed as not measured) |
| 1 stop implicit Missions | merged (#463) | default off, `execution.legacy_auto_invoke` restores |
| 2 Task/Session/Run read model | merged (#470) | read-only projection over Ledger + MissionStore |
| 3 run events + completion policy | PR open | `agent.*` events from `runWorker`; pure `evaluateWorkCompletion`; no broker/scheduler extraction (see PHASE-6-RETIREMENT.md) |
| 4 delegation preference | PR open | `team` advisory; handoffs already unified by #461/#465 and projected in Phase 2 |
| 5 UX | PR open | `/work`; Herdr graph/assistant/Plannotator not done |
| 6 canary + retirement | plan written | PHASE-6-RETIREMENT.md; nothing deleted |

## Standing rules
- One branch + one PR per phase. No merge or deploy without the user's OK (flipping a default for every Pi session is sensitive; the user deploys themselves).
- No new `PI_*` env flags (YAML config only). No Pi Forge / Pi-Bolt.
- Performance claims need measured evidence; time-to-first-tool-call needs a live model run and is "not measured" until then.
- herdr-open: baseline state file recorded at task start (scratchpad `state/herdr-open.json`); run `discover` at the very end.
