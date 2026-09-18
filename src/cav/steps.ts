import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CavPhase, CavStep } from "./types.ts";

/** Phase id -> canonical phase name (from MASTER.md). */
export const PHASE_NAMES: Record<string, string> = {
  "00": "Root of Trust",
  "01": "Change Classification",
  "02": "Deterministic Test Execution",
  "03": "Real Stack Lifecycle",
  "04": "Browser Instrumentation",
  "05": "Acceptance Contracts",
  "06": "UI Interaction Verification",
  "07": "Visual Regression",
  "08": "Accessibility and UX Mechanics",
  "09": "Sabotage Suite",
  "10": "Independent Review",
  "11": "Vision Review Advisory",
  "12": "Defect Ledger and Repair Loop",
  "13": "Exploratory UI Agent",
  "14": "Spec Reconciliation",
  "15": "Model Routing",
  "16": "Concurrency and Isolation",
  "17": "Pi-Web Integration",
  "18": "Dogfood Pi Engineering",
  "19": "Pilot AIMS",
  "20": "Pilot InferWeave",
  "21": "Pilot WeaveForge",
  "22": "Autonomous Overnight Operation",
  "23": "Hardening and Release",
};

/** Atomic step type within a phase by step number. */
export function stepKind(stepNum: string): CavStep["kind"] {
  switch (stepNum) {
    case "01":
      return "define";
    case "02":
      return "implement";
    case "03":
      return "test";
    case "04":
      return "sabotage";
    case "05":
      return "gate";
    default:
      return "define";
  }
}

const STEP_RE = /^CAV-(\d{2})-(\d{2})\.md$/;

/**
 * Build the full ordered CAV step registry from the spec files on disk. Steps
 * are sorted numerically by (phase, step). This is the single source of the
 * 120-step ordering used by the phase gate.
 */
export function loadCavSteps(stepsDir: string): CavStep[] {
  let files: string[];
  try {
    files = readdirSync(stepsDir);
  } catch {
    return [];
  }
  const steps: CavStep[] = [];
  for (const f of files) {
    const m = STEP_RE.exec(f);
    if (!m) continue;
    const phase = m[1]!;
    const step = m[2]!;
    const id = `CAV-${phase}-${step}`;
    const objective = readObjective(join(stepsDir, f));
    steps.push({
      id,
      phase,
      phaseName: PHASE_NAMES[phase] ?? phase,
      step,
      objective,
      spec: `docs/specs/cav/steps/${f}`,
      kind: stepKind(step),
    });
  }
  steps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return steps;
}

/** Extract the `# Title` line as the short objective. */
function readObjective(file: string): string {
  try {
    const first = readFileSync(file, "utf-8").split("\n").find((l) => l.startsWith("# "));
    return first ? first.slice(2).trim() : "";
  } catch {
    return "";
  }
}

/** Group ordered steps into phases, in numeric phase order. */
export function groupPhases(steps: CavStep[]): CavPhase[] {
  const byPhase = new Map<string, CavStep[]>();
  for (const s of steps) {
    if (!byPhase.has(s.phase)) byPhase.set(s.phase, []);
    byPhase.get(s.phase)!.push(s);
  }
  const phases: CavPhase[] = [];
  for (const [id, phaseSteps] of byPhase) {
    phases.push({
      id,
      name: PHASE_NAMES[id] ?? id,
      steps: phaseSteps,
      state: "UNKNOWN",
      blockers: [],
    });
  }
  return phases;
}

/** The next step not yet VERIFIED/WAIVED, in numeric order. */
export function nextUnverifiedStep(
  steps: CavStep[],
  isVerified: (id: string) => boolean,
): { step: CavStep; index: number } | null {
  for (let i = 0; i < steps.length; i++) {
    if (!isVerified(steps[i]!.id)) return { step: steps[i]!, index: i };
  }
  return null;
}
