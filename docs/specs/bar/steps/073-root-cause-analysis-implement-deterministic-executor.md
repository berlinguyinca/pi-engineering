# BAR-073 — Root-cause analysis: Implement deterministic executor

## Goal
Cluster findings, construct dependency graph and prioritize foundational causes. This atomic step focuses on: implement deterministic executor.

## Requirements
- Integrate with the existing Pi Engineering CAV architecture; do not create a parallel verification framework.
- Preserve unrelated repository work and existing project-specific decisions.
- Produce machine-readable state and evidence with provenance.
- Treat historical success claims as untrusted. New requirements/evidence begin UNKNOWN until verified.
- Never weaken protected acceptance, golden, sabotage, or completion-policy artifacts to obtain PASS.
- Deterministic failures remain failures regardless of model opinion.
- The implementer cannot self-promote requirements to VERIFIED.
- Ensure restart/resume behavior does not lose evidence or duplicate completed work where applicable.

## Implementation guidance
Implement the smallest coherent production-capable increment needed for this step. Reuse existing CAV ledger, gate, worker, browser, visual, review, and artifact mechanisms whenever present. Add schemas/migrations/CLI or automatic orchestration hooks only when required. Record exact source revision and environment context for evidence.

## Verification
- Add deterministic tests for the new behavior.
- Add at least one failure/negative test appropriate to the step.
- Run existing CAV regression/sabotage gates affected by the change.
- Record commands, outputs, artifacts and verifier identity.

## Exit gate
This step is VERIFIED only when its positive and negative tests pass, required evidence exists, no protected verification contract was weakened, and affected pre-existing trusted CAV gates remain passing. Otherwise record FAILED/BLOCKED/UNKNOWN truthfully and do not advance.
