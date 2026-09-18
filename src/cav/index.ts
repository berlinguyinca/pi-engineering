/**
 * CAV (Continuous Acceptance & Verification) core — Root of Trust.
 *
 * Provides the deterministic workflow state, role-gated evidence ledger,
 * protected-artifact guard, and hard COMPLETE semantics required by MASTER.md,
 * reconciled with the existing Engineering Ledger and RoadmapEngine.
 */
export * from "./types.ts";
export * from "./steps.ts";
export * from "./evidence.ts";
export * from "./guard.ts";
export * from "./completion.ts";
export * from "./classify.ts";
export * from "./runner.ts";
export * from "./review.ts";
export * from "./stack.ts";
export * from "./browser.ts";
export * from "./contract.ts";
export * from "./ui.ts";
export * from "./visual.ts";
export * from "./a11y.ts";
export * from "./sabotage.ts";
export * from "./vision.ts";
export * from "./defect.ts";
export * from "./explore.ts";
export * from "./reconcile.ts";
export * from "./routing.ts";
export * from "./concurrency.ts";
export * from "./statusSurface.ts";
export * from "./dogfood.ts";
export * from "./pilot.ts";

import { resolve } from "node:path";
import { evaluatePhaseGate } from "./completion.ts";
import type { CavEvidenceLedger } from "./evidence.ts";
import { groupPhases, loadCavSteps } from "./steps.ts";

/** Default on-disk locations for the CAV ledger. */
export function cavPaths(repoRoot: string): { stepsDir: string; ledgerFile: string } {
  return {
    stepsDir: resolve(repoRoot, "docs/specs/cav/steps"),
    ledgerFile: resolve(repoRoot, ".pi-eng/cav/evidence.jsonl"),
  };
}
