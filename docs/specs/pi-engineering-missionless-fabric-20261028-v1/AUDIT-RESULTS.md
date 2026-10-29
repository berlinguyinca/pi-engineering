# AUDIT-RESULTS (Phase 0, partial — updated per phase)

## Repository state (2026-10-28)
- `berlinguyinca/pi-engineering` `origin/main` = `6082fb9` (#459). MEF worktree `feat/missionless-fabric` branched from it.
- Primary checkout `~/IdeaProjects/pi-engineering` is on `fix/pr372-reconstructed-candidate-replay` (63 ahead, untracked `.autospec/`, `.pi/engineering.yaml.bak-*`, a qwen-loop spec dir). Untouched.
- 58 worktrees exist. Open PR: #460 (rollover handoff edge, observed-handoff ack, checkpoint handoff context) — touches `checkpoints.ts`, `missionStore.ts`, `types.ts`, `runtime/herdr/lineage.ts`. Handoff work must extend it.
- `feat/mission-live-activity` edits `extensions/index.ts` outside the auto-invoke region.
- Footprint: 569 `.ts` files under `src/`+`extensions/`; 257 mention "mission"; `src/orchestration/` is 32.5k lines (orchestrator 4959, broker 4387, missionStore 4294, scheduler 1780).

## Test baseline on untouched origin/main (node 22, `npm ci`)
| Check | Result |
|-------|--------|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (1292 files) |
| `npm test` | exit 1: 6554 tests, 6552 pass, 1 fail, 1 skipped |
| Failing test | `parallel tournament candidates run concurrently in isolated worktrees` (`test/integration/vertical-slice.test.ts`). Failed in the full run; not yet known whether it fails alone. |

## Findings that shape the plan
1. Implicit Mission entry is a single seam: `extensions/index.ts` `before_agent_start` → `decideAutoInvoke`. See `ENTRYPOINT-MAP.md`.
2. A Mission-free Task/Run path exists: `/engineer`, `/plan`, `/execute` on Ledger `work_item`s. Phase 2 must evaluate it as the canonical write authority before any new store is considered.
3. `chooseMode` already returns `local` with all `PI_AUTOSPEC_*` flags unset; no change needed.
4. Layered YAML policy (`src/lifecycle/policy.ts`) is the right home for config (operator rule: no new env flags).

## Still to produce
`REUSE-MATRIX.md`, `EVENT-OWNER-MAP.md`, `BASELINE-METRICS.json` (legacy vs new end-to-end needs a live-model fixture; not yet run).
