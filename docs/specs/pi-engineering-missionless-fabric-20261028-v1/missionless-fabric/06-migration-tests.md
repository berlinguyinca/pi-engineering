# 06 — Phases, acceptance, rollback and release

## Phase 0: inventory (no runtime change)
Fresh audit, dependency graph, deployed feature inventory, baselines, fixture tests and owner mapping. Definition of done: each producer/consumer/owner and each legacy persisted field has a mapping and test.

## Phase 1: stop implicit Mission creation behind feature flag
Expose `missionless.enabled`, default on only after smoke tests; legacy auto-invoke default disabled for new users, explicit compatibility preserved. Feature flag precedence and existing `PI_AUTOSPEC_*` documented. Do not disable running external automations by accident. Acceptance: ordinary prompts direct; explicit legacy mission still runnable; no changed safety permissions.

## Phase 2: generic Task/Session/Run read model
Implement projection over canonical existing event log, stable identifiers, session/handoff/graph edges, legacy Mission read adapter. Acceptance: restart-safe replay and mixed legacy/new events; no double writers; migration non-destructive.

## Phase 3: generic broker, scheduler and policy gate extraction
Refactor in thin adapters, parallel legacy vs new tests. Acceptance: same isolation/ownership/quality proof, no hidden Git mutation, invalidated evidence after edits, no stale completion verdict.

## Phase 4: adaptive delegation and handoffs
Use existing subagents, forks and context/checkpoint contracts. Acceptance: multi-agent independent tasks, bounded context, cross-model handoff, collision serialization, user steering and pause semantics.

## Phase 5: UX projections and integration
Terminal compact live status, `/summary`, Herdr room and persistent graph, plans/Plannotator optional, assistant safe task creation. Acceptance: no lost messages or focus theft, dashboards synchronize after reconnect, viewable tasks/PRs/artifacts.

## Phase 6: staged retirement
Shadow comparison → canary selected repos → opt-in adaptive → default general rollout → remove dead mission-only paths after storage migration and compatibility window. Retain legacy viewer and importer. Any regression in ownership, policy bypass, data loss, incorrect completion or major direct UX triggers rollback.

## Contract test cases
1. Direct edit prompt never creates Mission, produces correct diff and quality evidence.
2. `plan` suggests optional Plannotator only after user can inspect plan.
3. `/summary` reconstructs session timeline and unresolved work after days and restarts.
4. 429 retry handled by exactly one configured retry owner; no retry amplification.
5. Crash during concurrent tasks: generation fencing; no dual writers; preserved commits.
6. Context-limit handoff restores bounded context and provenance without fabricated facts.
7. Reviewer cannot approve its own work or stale candidate revision.
8. CI pass on old SHA never approves new HEAD; cache invalidation observed.
9. Escape/pause blocks automatic recovery until explicit resume.
10. Dirty user tree stays intact; untracked files are not silently overwritten.
11. Task graph survives sessions, model switches, Herdr browser reload, and phone reconnect.
12. Personal assistant email ingestion cannot trigger unauthorized send or repo write.
13. Legacy Mission remains inspectable and completes while new tasks work.
14. No background session can hijack the foreground response stream.
15. All actor operations enforce repository scope, permissions and idempotency.
16. Independent review and policy gates apply in direct mode as in adaptive mode.

## Delivery checkpoints
Each phase produces: `PHASE-N-AUDIT.md`, `PHASE-N-DIFFS.md`, test results (exact commands and exits), benchmark JSON and logs, open risks, rollback test, PR link. Run relevant unit/integration/E2E and current repo test suites; if unavailable say so rather than invent counts. Final doc identifies every deleted/retained Mission feature and all compatibility paths.

## Rollback
Feature toggle must restore legacy path without downgrading/mutating event schema. Ensure dual readers work across incremental writes, migrations forward-only and reversible by projection rebuilding rather than destructive DB reverse migrations. Pause new dispatch before rollback, drain or checkpoint active new runs, retain their artifacts and prevent reassignment without ownership reconciliation.
