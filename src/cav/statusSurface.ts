import { evaluatePhaseGate } from "./completion.ts";
/**
 * CAV-17 Pi-Web Integration: expose status, evidence, defects, screenshots,
 * traces and worker activity as a machine-readable data surface.
 *
 * This is pi-engineering-OWNED adapter surface that an external pi-web consumes.
 * It does NOT implement or replace pi-web — it exposes the CAV state (steps,
 * evidence, defects, artifacts) as JSON that pi-web can render. This keeps the
 * integration dependency boundary correct.
 */
import type { CavEvidenceLedger } from "./evidence.ts";
import { groupPhases } from "./steps.ts";
import type { CavStep } from "./types.ts";

export interface CavStatusSurface {
  total_steps: number;
  verified_steps: number;
  phases: Array<{
    id: string;
    name: string;
    state: string;
    verified: number;
    total: number;
    blockers: string[];
  }>;
  evidence: Array<{
    requirement_id: string;
    status: string;
    role: string;
    gate: string;
    exit_code: number;
    command: string;
    git_sha: string;
  }>;
}

/**
 * Build the machine-readable CAV status surface for external consumers.
 * Includes per-step evidence so pi-web can render status, evidence and defects.
 */
export function buildCavSurface(steps: CavStep[], ledger: CavEvidenceLedger): CavStatusSurface {
  const phases = groupPhases(steps);
  const verified = steps.filter((s) => ledger.latestStatus(s.id) === "VERIFIED").length;
  return {
    total_steps: steps.length,
    verified_steps: verified,
    phases: phases.map((p) => {
      const gate = evaluatePhaseGate(p, ledger);
      return {
        id: p.id,
        name: p.name,
        state: gate.state,
        verified: gate.verifiedSteps,
        total: p.steps.length,
        blockers: gate.blockers,
      };
    }),
    evidence: ledger
      .all()
      .map((e) => ({
        requirement_id: e.requirement_id,
        status: e.status,
        role: e.role,
        gate: e.gate_type,
        exit_code: e.exit_code,
        command: e.command,
        git_sha: e.git_sha,
      }))
      .slice(-200),
  };
}
