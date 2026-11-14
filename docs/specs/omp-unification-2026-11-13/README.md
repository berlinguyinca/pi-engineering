# Pi Engineering + OMP Unification — 2026-11-13

Status: implementation-ready investigation and staged migration package; NOT a verified complete code audit.

Repositories:
- https://github.com/berlinguyinca/pi-engineering
- https://github.com/can1357/oh-my-pi

Observed baseline: pi-engineering-runtime 0.2.0 has @earendil-works/pi-* 0.87.1 dev/peer dependencies and an extension entry at src/runtime/host/entry.ts. OMP coding agent package observed at 18.20.0 with @oh-my-pi/pi-* namespace. Pi Engineering already contains durable event-sourced ledger, SQLite custody registry, mission orchestration, worktree safety, deterministic verification, tournament and review, Hindsight through herdr-memory CLI. OMP has built-in review, LSP/DAP, extension hooks, memory/hindsight modules. These observations do NOT prove drop-in API compatibility.

Read specs in order. Each agent should receive ONLY its phase spec, interface contracts, relevant source files, and prior phase artifact summaries. Aim 8k-25k task context, never exceed local agent capacity (60k-120k).

Deliverable is a series of reviewed PRs, not a giant branch. No direct main pushes. Do not claim runtime compatibility without executed tests.

Additional Phase 8: `specs/07-omp-skills-audit-and-adoption.md` — OMP skill inventory, evaluation and adoption.
