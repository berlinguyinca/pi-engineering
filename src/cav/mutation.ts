/**
 * CAV-23 Mutation Testing, Anti-Bypass, Metrics and CAV 1.0 release gate.
 *
 * - Mutation testing: apply a mutant to a target function and assert the
 *   verifier/test DETECTS it (the mutant is killed). A surviving mutant means
 *   the verifier is weak.
 * - Anti-bypass: assert the protected-artifact guard FAILS CLOSED when a
 *   mutation bypasses a protected acceptance/golden artifact.
 * - Metrics: derive verified/total/blocked counts and coverage from the ledger.
 */
import type { CavEvidenceLedger } from "./evidence.ts";

export interface Mutant {
  id: string;
  description: string;
  /** Apply the mutant to produce a changed function; returns the mutant fn. */
  apply: () => (...args: never[]) => boolean;
  /** The mutant is KILLED when this predicate throws / returns false on the mutant. */
  killedBy: (mutantFn: (...args: never[]) => boolean) => boolean;
}

export interface MutationResult {
  mutantId: string;
  killed: boolean;
  survived: boolean;
}

export interface MutationSuiteResult {
  mutants: MutationResult[];
  killed: number;
  survived: number;
  total: number;
  /** All mutants killed => healthy mutation score. */
  passed: boolean;
}

/**
 * Run a mutation suite: every mutant must be killed (detected) by the verifier.
 * A surviving mutant is a real finding — the verifier must be strengthened.
 */
export function runMutationSuite(mutants: Mutant[]): MutationSuiteResult {
  const results: MutationResult[] = mutants.map((m) => {
    const mutantFn = m.apply();
    let killed = false;
    try {
      killed = m.killedBy(mutantFn);
    } catch {
      killed = true; // throw = detection
    }
    return { mutantId: m.id, killed, survived: !killed };
  });
  return {
    mutants: results,
    killed: results.filter((r) => r.killed).length,
    survived: results.filter((r) => r.survived).length,
    total: results.length,
    passed: results.every((r) => r.killed),
  };
}

export interface AntiBypassResult {
  blocked: boolean;
  blockers: string[];
}

/**
 * Anti-bypass: a mutation that would let an implementation silently pass
 * (bypass the guard) must FAIL CLOSED. `checkBypass` returns blocked=true when
 * the bypass is detected; a bypass that goes undetected is a critical finding.
 */
export function checkBypass(
  bypassAttempted: boolean,
  guardDetectedBypass: (attempted: boolean) => boolean,
): AntiBypassResult {
  if (!bypassAttempted) return { blocked: false, blockers: [] };
  const detected = guardDetectedBypass(bypassAttempted);
  return {
    blocked: detected,
    blockers: detected
      ? ["protected-artifact bypass attempt was blocked (fail closed)"]
      : ["CRITICAL: protected-artifact bypass went undetected"],
  };
}

export interface CavMetrics {
  totalSteps: number;
  verified: number;
  tested: number;
  blocked: number;
  unknown: number;
  verifiedRatio: number;
  phasePct: number;
}

/**
 * Derive CAV metrics from the evidence ledger. Used for the CAV 1.0 release
 * report; the release gate refuses if any step is BLOCKED/UNKNOWN without a
 * recorded rationale.
 */
export function deriveCavMetrics(
  steps: Array<{ id: string }>,
  ledger: CavEvidenceLedger,
  isBlocked: (id: string) => boolean,
): CavMetrics {
  let verified = 0;
  let tested = 0;
  let blocked = 0;
  let unknown = 0;
  for (const s of steps) {
    const status = ledger.latestStatus(s.id);
    if (status === "VERIFIED") verified++;
    else if (status === "TESTED") tested++;
    else if (isBlocked(s.id)) blocked++;
    else unknown++;
  }
  const totalSteps = steps.length;
  return {
    totalSteps,
    verified,
    tested,
    blocked,
    unknown,
    verifiedRatio: totalSteps ? verified / totalSteps : 0,
    phasePct: totalSteps ? Math.round((verified / totalSteps) * 100) : 0,
  };
}
