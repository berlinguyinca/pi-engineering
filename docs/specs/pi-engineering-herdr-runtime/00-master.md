# Pi-Engineering Herdr Runtime Integration — Master Spec
## Goal
Adopt Herdr as the default external persistent agent/process runtime while Pi-Engineering remains the workflow brain, InferWeave owns model/GPU scheduling, OpenViking owns semantic memory, PostgreSQL owns operational history, Git owns source state, and Pi-Web remains the external browser/operator UI.

## Hard boundaries
- Herdr is external: do not fork or reimplement it.
- Pi-Web is external: do not rebuild it.
- Pi Forge is excluded.
- All Herdr access goes through a runtime-neutral AgentRuntime abstraction.
- No static model/GPU assignments; InferWeave resolves capabilities and placement.
- Migration is incremental with feature flags, parity tests, canaries and rollback.

## Acceptance
Multiple persistent Pi workers; isolated worktrees; normalized lifecycle/events; artifact-first results; dynamic context/request budgeting; proactive 413 prevention; independent review/repair; remote-host support; restart reconciliation; Pi-Web visibility/intervention; observability/security; successful canary and rollback drill.
