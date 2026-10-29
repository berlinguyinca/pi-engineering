# Missionless Execution Fabric (MEF)

**Package:** pi-engineering-missionless-fabric-2026-10-28-v1  
**Target:** `berlinguyinca/pi-engineering` (primary); audit `berlinguyinca/herdr-engineering`, `InferWeave/inferweave`, existing dashboard and personal assistant adapters only as integration owners.  
**Status:** implementation specification, not implemented.  
**Repository audit basis:** GitHub default branch fetched 2026-10-28. Recheck SHA, diff and deployed configuration before changes.

## Decision
Retire **Mission** as a user-facing and mandatory execution abstraction. Introduce a first-class **Task / Session / Run / Handoff / Artifact / Event** model. Direct, normal Pi conversation is default. Adaptive delegation and team execution are opt-in preferences, dynamically adjustable during work. Do not implement another competing orchestrator.

## Non-negotiable invariants
1. Never automatically wrap ordinary chat or edits in a Mission.
2. Existing active missions are not deleted, abandoned, or rewritten destructively.
3. Independent review, security-sensitive gates, reproducible validation, safe Git, permission checks, and fencing still apply as defined by policy; direct mode does not mean unsafe mode.
4. A task can have several sessions, runs, branches, plans, artifacts, PRs and CI results. All remain discoverable after restarts.
5. Every execution has one authoritative owner; no double execution after lease expiry without fencing/reconciliation.
6. Do not rebuild upstream Pi, Pi Web, Plannotator, OpenViking, InferWeave, Slurm, or existing agent integrations. Do not use Pi Forge or Pi-Bolt.
7. Web/dashboard consumes shared projections, CLI and Pi commands remain authoritative for engineering changes and artifact authoring.
8. Audit, enhance, refactor, consolidate, never duplicate existing components/services/schemas.

## Package reading order
1. `00-repo-audit.md` — known code, evidence and mandatory fresh investigation.
2. `01-architecture.md` — canonical domain, events, API, compatibility.
3. `02-user-experience.md` — UI, CLI, controls and behavior.
4. `03-runtime-quality.md` — run execution, policies, handoffs, recovery.
5. `04-optimizations.md` — measurable performance and complexity improvements.
6. `05-integration.md` — Herdr, InferWeave, assistant, plans, artifact graph.
7. `06-migration-tests.md` — sequencing, safety, gates, tests and rollout.
8. `IMPLEMENTATION_PROMPT.md` — copy-paste implementation prompt.

## Delivery rules
Each phase ships with tests and an evidence-backed migration note. All modifications on feature branches / worktrees, not directly on main. Document already-existing functionality, reused APIs, refactoring, and explicitly rejected duplicate implementations. Completion claims require tests and actual evidence. If other teams are changing the same code, coordinate and integrate rather than overwrite.
