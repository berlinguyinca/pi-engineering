# Phase 1 — stop implicit Mission creation

## Change
- `src/lifecycle/policy.ts`: new `execution` section (`preference: direct|adaptive|team`, default `adaptive`; `legacy_auto_invoke`, default `false`), validation, and `loadExecutionConfig` (broken/invalid config falls back to missionless defaults, never to Missions).
- `src/orchestration/autoInvoke.ts`: `decideAutoInvoke` unchanged; new `decideMissionDirective(input, execution)` wrapper.
- `extensions/index.ts`: handler consults the wrapper; config is read only when the legacy classifier would inject.
- Unchanged: `mission` tool, `/mission`, `/mission-status`, `/engineer`, `/plan`, `/execute`, external/standalone AutoSpec entries, supervisor/recovery, `isBareContinuation`, `missionToolReportedUnavailable`, the lifecycle harness (risk classification, `HARNESS_DIRECTIVE`) and every `policies.*` gate.

## Evidence (O1 prompt corpus, deterministic, `PHASE-1-O1-CORPUS.json`)
| | injections / 8 prompts |
|-|-|
| legacy decision | 3 (fix, implement, plan) |
| new default | 0 |
Opting back in (`execution.legacy_auto_invoke: true`) reproduces the legacy decision exactly (unit-tested over the whole corpus).

**Not measured:** time to first useful tool call, unnecessary subagent launches. These need a live model run; no number is claimed.

## Rollback
Set `execution.legacy_auto_invoke: true` in `.pi/engineering.yaml` or the global `engineering.yaml`. No schema or stored-event change; revert is a config flip.

## Open risks
- Prompts that previously forced mission-level planning/review now rely on the lifecycle harness gates (unchanged) plus the model's own choice to call `mission`. Adaptive delegation is Phase 4.

## Independent review (fresh-context reviewer, diff only) — dispositions
- Repo layer can set `legacy_auto_invoke: true` over a global `false`; the key is deliberately **not** mandatory. It is a compatibility default, not a safety gate (review, verification and risk gates are unchanged and remain mandatory). Revisit if "off" should become an operator guarantee.
- Config lookup now goes through `runtimeCwd` like the rest of the extension (fixed).
- Config is read only for prompts the legacy classifier would inject for; no cache added (no measured need).
- Added tests: real-extension default (no injection), string-typed flag rejected, legacy hook tests run opted-in.

## Verification on the final diff
See `PHASE-1-RESULTS.md`.
