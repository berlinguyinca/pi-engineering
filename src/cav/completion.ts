import type { CavEvidenceLedger } from "./evidence.ts";
import type { CavGateStatus, CavPhase, CavStep } from "./types.ts";

/**
 * Hard COMPLETE semantics (MASTER.md): COMPLETE is derived, never declared.
 *
 * - A phase exit gate is PASS only when EVERY step in the phase is VERIFIED
 *   (or explicitly WAIVED by an authorized human with recorded rationale).
 * - UNKNOWN is not PASS. SKIPPED is not PASS.
 * - A phase may not begin until the previous phase gate has produced real
 *   evidence (enforced by the caller walking phases in numeric order).
 */
export interface CavPhaseGateResult {
  phase: CavPhase;
  state: CavGateStatus;
  blockers: string[];
  verifiedSteps: number;
  totalSteps: number;
  waivers: string[];
}

/** The first non-verified step in a phase (numeric order), if any. */
export function firstNonVerifiedStep(steps: CavStep[], isVerified: (id: string) => boolean): CavStep | null {
  for (const s of steps) if (!isVerified(s.id)) return s;
  return null;
}

export function evaluatePhaseGate(
  phase: CavPhase,
  ledger: CavEvidenceLedger,
  opts?: { waive?: (id: string) => boolean },
): CavPhaseGateResult {
  const blockers: string[] = [];
  const waivers: string[] = [];
  let verified = 0;
  for (const step of phase.steps) {
    const status = ledger.latestStatus(step.id);
    if (status === "VERIFIED") {
      verified++;
      continue;
    }
    if (opts?.waive?.(step.id)) {
      waivers.push(step.id);
      continue;
    }
    blockers.push(`${step.id} is ${status ?? "UNKNOWN"} (not VERIFIED)`);
  }
  const state: CavGateStatus = blockers.length === 0 ? "PASS" : "FAIL";
  return { phase, state, blockers, verifiedSteps: verified, totalSteps: phase.steps.length, waivers };
}
