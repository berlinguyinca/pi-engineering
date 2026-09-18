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

export interface NoFalseCompleteCheck {
  safe: boolean;
  blockers: string[];
}

/**
 * CAV-22 guard: a phase may NOT be reported COMPLETE unless every step is
 * VERIFIED with PASSING evidence. UNKNOWN / SKIPPED / BLOCKED / failed evidence
 * all refuse COMPLETE. This is the anti-false-COMPLETE contract: completion is
 * derived from evidence, never declared by prose.
 */
export function guardNoFalseComplete(
  phase: CavPhase,
  ledger: CavEvidenceLedger,
  opts?: { waive?: (id: string) => boolean },
): NoFalseCompleteCheck {
  const blockers: string[] = [];
  for (const step of phase.steps) {
    const status = ledger.latestStatus(step.id);
    const latest = ledger.latestEvidence(step.id);
    if (opts?.waive?.(step.id)) continue;
    if (status !== "VERIFIED") blockers.push(`${step.id} not VERIFIED (${status ?? "UNKNOWN"})`);
    else if (!latest || latest.exit_code !== 0) blockers.push(`${step.id} VERIFIED but no passing evidence`);
  }
  return { safe: blockers.length === 0, blockers };
}
