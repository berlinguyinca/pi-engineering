/**
 * Performance evidence (spec §15.10, backlog B-107).
 *
 * Runs a measured workload, captures timing, and compares against a baseline
 * with a tolerance. Produces a PerformanceEvidence record the roadmap can bind
 * to a commit. Pure comparison logic is exported for unit testing; the harness
 * is injected so tests use fake timings.
 */
export interface Timing {
  label: string;
  /** Duration in ms. */
  durationMs: number;
  /** Optional metric, e.g. context tokens used. */
  metric?: number;
}

export interface Baseline {
  label: string;
  /** Reference duration in ms. */
  durationMs: number;
  /** Allowed relative regression, e.g. 0.2 = 20% slower before failing. */
  tolerance?: number;
}

export interface PerformanceEvidence {
  label: string;
  timings: Timing[];
  regressions: Array<{ label: string; actualMs: number; baselineMs: number; overBy: number }>;
  pass: boolean;
}

export interface PerfHarness {
  /** Run the workload once and return its timing. */
  run(label: string): Promise<Timing>;
}

/**
 * Compare an actual timing against a baseline. Regression when the actual
 * exceeds baseline * (1 + tolerance).
 */
export function compareTiming(label: string, actualMs: number, baseline: Baseline): { overBy: number } | null {
  const tol = baseline.tolerance ?? 0.2;
  const limit = baseline.durationMs * (1 + tol);
  if (actualMs > limit) return { overBy: (actualMs - baseline.durationMs) / baseline.durationMs };
  return null;
}

/** Run each workload and compare to baselines. Fails on any regression. */
export async function measurePerformance(
  workloads: Array<{ label: string; baseline: Baseline }>,
  harness: PerfHarness,
): Promise<PerformanceEvidence> {
  const regressions: PerformanceEvidence["regressions"] = [];
  const timings: Timing[] = [];
  for (const w of workloads) {
    const t = await harness.run(w.label);
    timings.push(t);
    const reg = compareTiming(w.label, t.durationMs, w.baseline);
    if (reg)
      regressions.push({
        label: w.label,
        actualMs: t.durationMs,
        baselineMs: w.baseline.durationMs,
        overBy: reg.overBy,
      });
  }
  return { label: "performance", timings, regressions, pass: regressions.length === 0 };
}
