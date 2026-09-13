/**
 * Engineering benchmark suite (spec §14 Phase G, backlog B-102).
 *
 * Runs a defined workload (the vertical slice / a feature task) and records
 * objective metrics — autonomy (completed without intervention), context
 * efficiency (tokens per task), and throughput — then compares them against a
 * stored baseline. A regression beyond tolerance fails the benchmark, which
 * turns the roadmap into an enforceable release gate (§14).
 *
 * The workload runner is injected so tests use fakes; the production runner
 * exercises the real vertical slice (scout -> implement -> verify).
 */
export interface BenchmarkMetrics {
  /** Tasks completed to done without human intervention. */
  tasksCompleted: number;
  /** Total tasks attempted. */
  tasksAttempted: number;
  /** Wall-clock for the whole run, ms. */
  durationMs: number;
  /** Total context tokens consumed. */
  contextTokens: number;
}

export interface BenchmarkBaseline {
  /** Minimum acceptable autonomy ratio (completed/attempted). */
  minAutonomy: number;
  /** Maximum acceptable tokens per completed task. */
  maxTokensPerTask: number;
}

export interface BenchmarkWorkload {
  run(): Promise<BenchmarkMetrics>;
}

export interface BenchmarkVerdict {
  metrics: BenchmarkMetrics;
  autonomy: number;
  tokensPerTask: number;
  pass: boolean;
  failures: string[];
}

export function tokensPerTask(m: BenchmarkMetrics): number {
  return m.tasksCompleted > 0 ? m.contextTokens / m.tasksCompleted : Infinity;
}

export function autonomyRatio(m: BenchmarkMetrics): number {
  return m.tasksAttempted > 0 ? m.tasksCompleted / m.tasksAttempted : 0;
}

/** Compare metrics against a baseline and produce a pass/fail verdict. */
export function evaluateBenchmark(metrics: BenchmarkMetrics, baseline: BenchmarkBaseline): BenchmarkVerdict {
  const autonomy = autonomyRatio(metrics);
  const tpt = tokensPerTask(metrics);
  const failures: string[] = [];
  if (autonomy < baseline.minAutonomy) failures.push(`autonomy ${autonomy.toFixed(3)} < ${baseline.minAutonomy}`);
  if (Number.isFinite(tpt) && tpt > baseline.maxTokensPerTask)
    failures.push(`tokens/task ${tpt.toFixed(0)} > ${baseline.maxTokensPerTask}`);
  return { metrics, autonomy, tokensPerTask: tpt, pass: failures.length === 0, failures };
}

/**
 * Run a benchmark workload and evaluate it against a baseline. The returned
 * verdict is the evidence a release gate can require.
 */
export async function runBenchmark(
  workload: BenchmarkWorkload,
  baseline: BenchmarkBaseline,
): Promise<BenchmarkVerdict> {
  const metrics = await workload.run();
  return evaluateBenchmark(metrics, baseline);
}
