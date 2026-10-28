# Qwen Loop Reliability Enhancement — 2026-10-27

Target: `berlinguyinca/pi-engineering`, with narrow changes in `InferWeave/inferweave` and `berlinguyinca/herdr-engineering` only when an audit proves necessary.

This is an **enhancement to existing GenerationGuard, APS, and RecoveryController**, not a new service or competing orchestrator.

## Files
- `SPEC.md`: architecture and behavioral requirements
- `IMPLEMENTATION_PLAN.md`: implementation phases, gates, tests
- `AUDIT_MATRIX.md`: known code and verification checklist
- `ACCEPTANCE.md`: test matrix and measurable completion criteria
- `START_PROMPT.md`: copy/paste prompt for Claude/Pi; also reproduced in final answer

## Source inspection caveat
Repository facts in AUDIT_MATRIX are from the GitHub default-branch inspection on 2026-10-27. Do not assume the remote host runs that revision. Inspect actual branches, worktrees, services, configs and logs before editing.
