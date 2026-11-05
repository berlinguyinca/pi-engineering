# MEF PROGRESS — resume point

Updated: 2026-10-30. Update this file at every phase boundary.

## Setup facts
- Host: bender. Spec ZIP came from the Mac (`ssh macbook-pro`, `~/Downloads/pi-engineering-missionless-fabric-v1-fixed.zip`), copied via scp, sha256 `cd66d4fc304272d809e4db7aeb4586806b249f11dc50ede6199508989cfb6ec8` verified identical on both ends. Archive listing had no absolute or `..` paths.
- Primary checkout `~/IdeaProjects/pi-engineering` is on `fix/pr372-reconstructed-candidate-replay` (63 ahead, untracked work) — **do not touch**.
- MEF worktree: `~/IdeaProjects/pi-engineering-mef`, branch `feat/missionless-fabric`, from `origin/main` 6082fb9.
- Spec lives at `docs/specs/pi-engineering-missionless-fabric-20261028-v1/missionless-fabric/`.
- In-flight overlap to respect: open PR #460 (rollover handoff edge — the start of the Handoff entity; extend it, do not duplicate); branch `feat/mission-live-activity` edits `extensions/index.ts` (hunks near 333-461 and 1927-2223, not the auto-invoke region at ~1094).

## Phase status (updated 2026-10-30)
| Phase | State | Notes |
|-------|-------|-------|
| 0 inventory | done | ENTRYPOINT-MAP, AUDIT-RESULTS, REUSE-MATRIX, EVENT-OWNER-MAP, BASELINE-METRICS.json |
| 1 stop implicit Missions | merged (#463) | default off, `execution.legacy_auto_invoke` restores; now documented as deprecated |
| 2 Task/Session/Run read model | merged (#470) | read-only projection over Ledger + MissionStore |
| 3 run events + completion policy | merged (#476), enforced (#536) | `agent.*` events, heartbeats, `execution.strict_completion` gate, Ledger revision/generation guards |
| 4 delegation preference | merged | `team` advisory |
| 5 UX | merged (`/work`); `/summary`, status row, `/task`, `/team` in flight | Herdr graph read-back in flight |
| 6 canary + retirement | plan written; step 1 (deprecation docs) done | steps 2-3 need the criteria in PHASE-6-RETIREMENT.md and written approval |

Also merged: Mission pins to the session starting model (#524) with an implicit-pin give-up (#528) and `hold_mission_model` (#525); Ledger lock + fencing (#529, #533); neutral ForkRuntimeSources (#530); task lineage + plan artifact ref (#532); assistant task read (herdr-engineering #519); dashboard model-use (#506, #514).

## Ledger plan record and Work Graph plan edges
`plan.recorded` (payload `{plan_id, revision, digest, steps:[{task_id,title}] (max 50, titles max 120), total_steps, artifact?:{id,version}, supersedes?}`, scope = the plan work item, `plan_id` = `<work_item_id>/<n>`) is written by `Ledger.recordPlan` / `LedgerTransitions.recordPlan` (revision + authority-generation guarded, idempotency key `plan:<plan_id>:<digest>`). Identical steps are a no-op; changed steps mint the next revision which supersedes the last. `EngineeringRuntime.plan()` records it after the tasks exist; a failure is logged and never fails the plan. Old logs replay unchanged (the event is ignored when absent or malformed). Projection (`ledgerTaskRefs` -> `emitTaskRefEdges`): node `plan:<work_item_id>/<n>` (state `open`, or `superseded`), edge `dependency` task -> plan (the contract has no `plans` kind; this is the same edge the Mission side uses), `supersession` new plan -> old plan, and PRs from `work_item.pr_linked` stay `issue_link` task -> pr. Read back through Herdr `getTaskGraph`. Not done: attempt -> pr edges (a PR is linked to a work item, not a run) and a producer for `artifact` (the runtime has no plan artifact ref to pass yet).

## Standing rules
- One branch + one PR per phase. No merge or deploy without the user's OK (flipping a default for every Pi session is sensitive; the user deploys themselves).
- No new `PI_*` env flags (YAML config only). No Pi Forge / Pi-Bolt.
- Performance claims need measured evidence; time-to-first-tool-call needs a live model run and is "not measured" until then.
- herdr-open: baseline state file recorded at task start (scratchpad `state/herdr-open.json`); run `discover` at the very end.
