# ENTRYPOINT-MAP — what can start or steer a Mission

Audited at `origin/main` 6082fb9 (2026-10-28). Phase 1 changes **only** the row marked IMPLICIT.

| # | Entry | Where | Starts a Mission? | Phase 1 action |
|---|-------|-------|-------------------|----------------|
| 1 | **Implicit auto-invoke** — `before_agent_start` injects "call the `mission` tool … Do not implement the change directly in this session" | `extensions/index.ts:1094`, decision in `src/orchestration/autoInvoke.ts` `decideAutoInvoke` | Indirectly: the injected directive makes the model call the `mission` tool | **IMPLICIT — gate behind `execution.legacy_auto_invoke` (default off)** |
| 2 | `mission` tool (semantic tool) | `src/tools/coreTools.ts:369` | Yes, when the model or user calls it | Keep registered, unchanged |
| 3 | `/mission` command | `extensions/index.ts:2455` | Yes, explicit | Unchanged |
| 4 | `/mission-status` | `extensions/index.ts:2660` | No (read) | Unchanged (spec: keep as read alias) |
| 5 | `/engineer <goal>` | `extensions/index.ts:2724` → `rt.engineer()` | **No** — Ledger `work_item` path | Unchanged; Phase 2 reuse candidate |
| 6 | `/plan`, `/execute` | `extensions/index.ts:2778,2806` → `rt.plan()/executePlan()` | **No** — Ledger task DAG | Unchanged; Phase 2/3 reuse candidate |
| 7 | External AutoSpec entry | `src/orchestration/externalEntry.ts:280` | Yes, explicit external call | Unchanged |
| 8 | Standalone entry | `src/orchestration/standaloneEntry.ts:227` | Yes, explicit CLI | Unchanged |
| 9 | AutoSpec plan CLI | `src/integrations/autospec/planCli.ts:111` | Yes, explicit | Unchanged |
| 10 | Orchestrator internal | `src/orchestration/orchestrator.ts:2230` | Yes, behind 2/3 | Unchanged |
| 11 | Supervisor pump / recovery | `src/orchestration/supervisor.ts`, `recovery.ts` | Resumes existing missions only; does not create | Unchanged (must keep working: legacy missions stay resumable) |

## Other `before_agent_start` handlers (not mission entrypoints; must keep working)

| Where | Purpose | Touch? |
|-------|---------|--------|
| `extensions/index.ts:1192` | Tool Transition Rule + generation-guard recovery prompt | No |
| `extensions/index.ts:2077` | Fallback coordinator / stream retry / stand-in refresh | No |
| `src/lifecycle/harness.ts:120` | Lifecycle harness: `noteRequest`, risk classification, `HARNESS_DIRECTIVE` | No — this is the policy/risk layer that must stay in force in direct mode |
| `src/blackhole/interactiveMemory.ts:376` | Memory | No |

## Exports with outside importers (must stay exported)

- `isBareContinuation` — imported by `src/plannerWorker/sessionHandoff.ts:22`, `src/compaction/summaryInstructions.ts:12`
- `missionToolReportedUnavailable` — used by the `tool_result` handler in `extensions/index.ts`

## Flags and config in play

- Legacy env flags `PI_AUTOSPEC_ENABLED`, `PI_AUTOSPEC_MANAGED_ENABLED`, `PI_AUTOSPEC_AUTO_CLASSIFY` (`src/orchestration/missionMode.ts`): left untouched. `chooseMode` already returns `local` with every flag unset, so no change is needed there.
- New config (YAML, per operator rule "no env variables, YAML config only"): `execution.preference` and `execution.legacy_auto_invoke` in the layered `engineering.yaml` policy (`src/lifecycle/policy.ts`). No new `PI_*` env flags.
