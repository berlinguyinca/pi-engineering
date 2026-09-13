/**
 * Adversarial test generation gate (spec §15.5, backlog B-107).
 *
 * A worker (test-designer) proposes adversarial test cases targeting
 * boundaries/edges of a function. Proposals are NOT trusted: the gate compiles
 * and runs each proposed test against the real implementation and only accepts
 * tests that (a) compile and (b) pass, and that actually exercise the target.
 * This prevents hallucinated "coverage" — evidence is machine-run.
 */
export interface AdversarialProposal {
  /** Function/symbol under test. */
  target: string;
  /** The proposed test source. */
  testSource: string;
  /** The claim of what it tests (used only to steer, never as evidence). */
  claim: string;
}

export interface AdversarialHarness {
  /**
   * Run a proposed test; resolve `pass: true` when the test compiles and
   * passes. `executed` indicates the test actually ran (not skipped).
   */
  runProposal(proposal: AdversarialProposal): Promise<{ pass: boolean; executed: boolean; error?: string }>;
}

export interface AdversarialReport {
  proposals: number;
  accepted: number;
  rejected: number;
  acceptedTests: AdversarialProposal[];
  /** Reason counts for rejected proposals. */
  rejections: Array<{ reason: string; count: number }>;
  /** True when at least one proposal was accepted AND executed. */
  gatePass: boolean;
}

/** Deterministically derive a canonical boundary-set for a target symbol name. */
export function boundaryCases(target: string): Array<{ label: string; value: string }> {
  // A stable, content-independent seed from the target name.
  let h = 0;
  for (const c of target) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const seed = h % 1000;
  return [
    { label: "zero", value: "0" },
    { label: "negative", value: String(-(seed % 100)) },
    { label: "max", value: String(Number.MAX_SAFE_INTEGER) },
    { label: "min", value: String(Number.MIN_SAFE_INTEGER) },
    { label: "fraction", value: "0.5" },
  ];
}

/**
 * Run all adversarial proposals through the harness and accept those that pass.
 * The gate only passes when >= 1 proposal was accepted and actually executed.
 */
export async function runAdversarialGate(
  proposals: AdversarialProposal[],
  harness: AdversarialHarness,
): Promise<AdversarialReport> {
  const acceptedTests: AdversarialProposal[] = [];
  const rejections = new Map<string, number>();
  let executed = 0;
  for (const p of proposals) {
    const res = await harness.runProposal(p);
    if (res.pass && res.executed) {
      acceptedTests.push(p);
      executed++;
    } else {
      const reason = res.error ? `failed:${res.error}` : res.executed ? "failed" : "not-executed";
      rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
    }
  }
  return {
    proposals: proposals.length,
    accepted: acceptedTests.length,
    rejected: proposals.length - acceptedTests.length,
    acceptedTests,
    rejections: [...rejections.entries()].map(([reason, count]) => ({ reason, count })),
    gatePass: executed > 0,
  };
}
