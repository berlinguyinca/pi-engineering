# Paste-ready implementation prompt

The package `pi-engineering-brownfield-audit-remediation-specs-2026-09-18.zip` is in `~/Downloads`.

You are in the existing local `pi-engineering` repository. Inspect git status and existing architecture/specs first. Preserve unrelated work.

Unzip the package and merge `docs/specs/bar/` into this repository at `docs/specs/bar/`. Reconcile with existing CAV and Pi Engineering specifications; do not construct a parallel framework.

Read `MASTER.md`, `ROADMAP.md`, every file in `contracts/`, and then execute every numbered file under `steps/` STRICTLY in numerical order.

Do not merely plan. For each atomic step: implement it, run deterministic positive and negative verification, run affected CAV regression/sabotage gates, capture machine-readable evidence, repair failures, rerun, and advance only after the exit gate is VERIFIED. Historical implementation claims are not evidence. Requirements reconstructed from old projects begin UNKNOWN.

The implementer cannot mark its own work VERIFIED. Deterministic failures cannot be overridden by an LLM. Never weaken protected acceptance contracts, sabotage fixtures, golden references, or completion policy to make a test pass. If live infrastructure required for a test is unavailable, record BLOCKED/UNKNOWN; never fake evidence.

Treat external pi-web as an integration dependency and do not implement or replace it. Pi Forge remains excluded. Preserve existing subagent/subprocess orchestration, shared-memory design, engineering/review workflows, InferWeave integration, and CAV architecture.

The final BAR capability must support brownfield audits that: reconstruct requirements/provenance; map source and runtime behavior; execute real-stack CAV; preserve immutable before-repair baselines; classify VERIFIED/FAILED/PARTIAL/MISSING/UNKNOWN/BLOCKED/ORPHAN/OBSOLETE candidates; cluster likely root causes; build dependency ordering; generate bounded repair campaigns; execute campaigns under CAV; and reconcile after every campaign.

After the generic engine is verified, dogfood it and then implement/verify the project profiles in the required sequence: Pi Engineering, AIMS, InferWeave, WeaveForge. Do not start repairing a target project until its immutable baseline audit is frozen.

Continue autonomously through as many sequential VERIFIED steps as the environment genuinely permits. At the end print current step, VERIFIED/FAILED/BLOCKED/UNKNOWN counts, files changed, commands/tests run, evidence locations, sabotage/negative tests, outstanding defects, and exact next step. Never report COMPLETE while required work remains failed, unknown, unverified, unreconciled, or improperly skipped.
