# Master Specification — Brownfield Audit & Remediation (BAR)

## Objective
Add a Brownfield Audit & Remediation mode to Pi Engineering that can take an existing repository with accumulated specs and implementation history and establish a fresh evidence-backed truth state. It must reconstruct atomic requirements, retain provenance, map requirements to source and runtime behavior, execute CAV, preserve a before-repair baseline, cluster findings by likely root cause, plan bounded dependency-ordered repair campaigns, execute them under CAV, and reconcile the project after each campaign.

## Core invariants
- Historical IMPLEMENTED/COMPLETE claims are untrusted inputs.
- All reconstructed requirements begin UNKNOWN until current evidence verifies them.
- The implementer cannot mark its own requirement VERIFIED.
- Deterministic failures cannot be overridden by model judgment.
- Protected acceptance/golden/sabotage/completion-policy artifacts cannot be silently weakened.
- Repair campaigns fix root causes before cosmetic symptoms where dependencies indicate this.
- Every repair campaign reruns affected acceptance gates plus a global smoke/regression gate.
- Baseline evidence is immutable and retained for before/after comparison.
- Existing project architecture is reconciled, not replaced by parallel systems.
- pi-web is an external integration dependency; do not reimplement it. Pi Forge is excluded.

## Requirement states
UNKNOWN, SOURCE_MAPPED, RUNTIME_MAPPED, IMPLEMENTED_UNVERIFIED, VERIFIED, FAILED, PARTIAL, MISSING, BLOCKED, OBSOLETE_CANDIDATE, ORPHAN_IMPLEMENTATION, DEFERRED.

## Audit pipeline
DISCOVER -> INGEST -> ATOMIZE -> PROVENANCE -> SOURCE MAP -> RUNTIME DISCOVERY -> ACCEPTANCE MAP/GENERATION -> CAV EXECUTION -> VISUAL/EXPLORATORY QA -> RECONCILIATION -> IMMUTABLE BASELINE -> ROOT-CAUSE CLUSTERING -> DEPENDENCY GRAPH -> REPAIR CAMPAIGNS -> CAV REVERIFY -> FINAL RECONCILIATION.

## Completion semantics
A project audit may finish with BLOCKED/DEFERRED items, but must report them explicitly. A project may only be called VERIFIED when all required non-deferred requirements are VERIFIED and required global gates pass.
