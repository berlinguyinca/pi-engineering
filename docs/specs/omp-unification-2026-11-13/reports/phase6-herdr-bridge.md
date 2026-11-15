# Phase 6: Herdr event bridge and UI-preserving capture

Branch `feat/omp-herdr-bridge`, stacked on `test/omp-parity-suite` (PR #697). Default OFF: the only code path touched is the OMP worker, which exists only under `PI_ENGINEERING_OMP_WORKER=1`.

## What exists (investigation)

- Herdr integration (`src/runtime/herdr/*`, `HerdrAgentRuntime`, `MissionAttentionReporter`, `InspectorFeed`, `ControlPlaneIngest`) consumes mission observability and runtime events. It does NOT consume executors directly.
- The one seam executors feed is `WorkerRequest.onActivity` (`WorkerActivity`: kind/phase/toolName/toolTarget/summary...). The orchestrator (`observeWorkerActivity`) turns it into mission activity, which the footer/panel (`formatMissionActivity`, `presence`) and Herdr surfaces render. `/engineer` (lifecycle `roleRunner`) passes no `onActivity` on either path; the mission path (`realBackends`) does.
- Gap found: `OmpWorkerExecutor` emitted only the checkpoint and fallback activity. A legacy worker reports "Worker session started", `Running tool: write · src/add.js`, `Finished tool: write`, "Model response received"; an omp worker showed none of it, so the existing UI would have looked idle.

## What was added

- `src/omp/OmpWorkerExecutor.ts`: frames `tool_execution_start/end` and assistant `message_end` are mapped through the existing `activityFromSessionEvent` + `emitWorkerActivity` (same shapes, same sanitization, same names). `pe_<tool>` replacements report as the built-in they replace; terminating and checkpoint tools are skipped (as legacy); nothing is reported after the terminating tool (legacy ends the session there; omp runs a closing turn). "Worker session started" is emitted when the prompt is sent. No ledger, schema, Herdr or UI change.
- `test/integration/omp-parity-ui-activity.test.ts` (real omp, gated on `OMP_BIN`): legacy `PiWorkerExecutor` vs real omp, same scripted model, through `realBackends`; asserts the normalized activity sequence is identical, then renders each event with the real footer formatter and asserts the text is identical and equals `test/fixtures/legacy-golden/ui-activity-engineer.golden.txt` (`UPDATE_GOLDEN=1` rewrites it).

## Evidence

- typecheck 0, biome lint 0.
- `omp-parity-ui-activity.test.ts` with real omp: 3/3 pass (1 test each).
- `legacy-golden.test.ts`: 27 pass / 0 fail on legacy and under `PARITY_PATH=omp`.
- `npm run test:coverage` (follow-up head): 6972 pass, 0 fail; 85.65 / 83.26 / 83.44 (floors 85/83/83). Full `omp-*.test.ts` set together 3x: 54 pass, 0 fail each. Legacy and `PARITY_PATH=omp` golden gates: 27/27 each.

## Telemetry parity (follow-up)

Derived from omp frames, all through the existing `emitWorkerActivity` shapes:
- "Context usage": assistant `message_end.usage.totalTokens` plus the model's `contextWindow`/`id` from one `get_state` request sent at run start (frames carry usage but not the window). The orchestrator feeds it to `ContextHandoffTrigger` unchanged.
- "Turn ended: stop=<stopReason> tool_error=<category>": `turn_end.message.stopReason` and `classifyError` over failed `tool_execution_end` results, as the legacy executor does.
- "Model streaming" / "Tool still producing output": `StreamingActivityThrottle` over `message_update` / `tool_execution_update`. omp also streams updates for `write`/`edit`, which legacy never reports, so only `bash` updates are forwarded.
- "Awaiting model response" is not emitted by the legacy `PiWorkerExecutor` either (only the gateway planner worker does), so there is nothing to match.

The parity test no longer excludes anything: the full normalized sequence (including context tokens/window/model) and the rendered text are identical, and the same context signals drive a real `ContextHandoffTrigger` to identical handoff records on both paths.

## Lifecycle test isolation

`omp-worker-lifecycle` "negotiates once per runtime open" compared a machine-wide `pgrep` snapshot before/after, so omp processes of other test files running in the same `omp-*.test.ts` invocation counted as leaks. It now counts only omp processes whose cwd is this test's repo or its `pi-eng-<hash>-*` candidate worktrees, with a positive control that the matcher sees live processes during the tournament.

## UNVERIFIED

- Pixel screenshots of the TUI: not deterministically capturable here (no terminal rendering harness, time-dependent layout); the text render of the footer formatter is the evidence.
- A live Herdr room consuming omp-path activity (only the activity seam and the footer formatter were exercised).
- Full mission DAG on real omp (unchanged from Phase 4).
- CI does not set `OMP_BIN`: the new test skips there.

## Rollback

Revert the commit, or leave `PI_ENGINEERING_OMP_WORKER` unset (default): nothing in the legacy path changed.
