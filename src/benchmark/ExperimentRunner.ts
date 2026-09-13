/**
 * A/B Experiment runner — paired native-vs-Blackhole benchmark.
 *
 * Runs a battery of workloads under both conditions, captures raw metrics
 * (retained as JSONL), and computes derived summaries. The default workload
 * simulator is deterministic and model-free, modeling the observable effect of
 * session memory: with Blackhole enabled, repeated tasks recall prior context
 * (raising recall rate and cutting context tokens), while native runs recompute
 * context from scratch.
 *
 * Raw data is preserved exactly (no aggregation loss) for later re-analysis.
 */

import { type Condition, type ConditionSummary, type RunMetrics, summarize } from "./Metrics.ts";

export interface Workload {
  id: string;
  kind: string;
  /** Base complexity: drives context/tokens/time. */
  complexity: number;
  /** How many times this task repeats (exercises session recall). */
  repeats: number;
}

export interface ExperimentOptions {
  workloads?: Workload[];
  /** Deterministic seed for reproducibility. */
  seed?: number;
  /** Override the simulator (e.g. to feed real worker telemetry). */
  simulate?: (w: Workload, condition: Condition, run: number, rng: () => number) => RunMetrics;
  now?: () => number;
}

export interface ExperimentResult {
  runs: RunMetrics[];
  summaries: Record<Condition, ConditionSummary>;
  rawJsonl: string;
  rawCsv: string;
}

const DEFAULT_WORKLOADS: Workload[] = [
  { id: "short-a", kind: "short", complexity: 10, repeats: 3 },
  { id: "medium-a", kind: "medium", complexity: 30, repeats: 2 },
  { id: "long-a", kind: "long", complexity: 60, repeats: 2 },
  { id: "repeated-a", kind: "repeated", complexity: 40, repeats: 4 },
];

/** Deterministic PRNG (mulberry32) so plots are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultSimulate(w: Workload, condition: Condition, run: number, rng: () => number): RunMetrics {
  const noise = 0.85 + rng() * 0.3;
  const complexity = w.complexity * (w.kind === "repeated" && run > 0 ? 0.5 + 0.2 * run : 1);
  const baseTokens = complexity * 120 * noise;
  // Blackhole: repeated runs recall prior context, reducing fresh context.
  const recallHits = condition === "blackhole" && run > 0 ? Math.round(2 + run * 1.5) : 0;
  const recallMisses = condition === "blackhole" ? Math.max(0, 1 - run) : 0;
  const contextFactor = condition === "blackhole" ? Math.max(0.4, 1 - run * 0.18) : 1;
  return {
    taskId: w.id,
    kind: w.kind,
    condition,
    durationMs: (complexity * 45 + (condition === "blackhole" ? -complexity * 3 : 0)) * noise,
    inputTokens: Math.round(baseTokens * (condition === "blackhole" ? contextFactor : 1)),
    outputTokens: Math.round(complexity * 20 * noise),
    contextTokens: Math.round(baseTokens * (condition === "blackhole" ? contextFactor : 1)),
    toolCalls: Math.max(1, Math.round((complexity / 12) * (condition === "blackhole" ? 0.9 : 1) * noise)),
    turns: Math.max(1, Math.round((complexity / 20) * (condition === "blackhole" ? 0.95 : 1))),
    quality: Math.min(1, 0.86 + (condition === "blackhole" ? 0.06 : 0) * Math.min(1, run)),
    recallHits,
    recallMisses,
    entries: condition === "blackhole" ? run + 1 : 0,
    compactions: condition === "blackhole" && run > 3 ? Math.floor(run / 3) : 0,
  };
}

export async function runExperiment(opts: ExperimentOptions = {}): Promise<ExperimentResult> {
  const rng = mulberry32(opts.seed ?? 42);
  const simulate = opts.simulate ?? defaultSimulate;
  const workloads = opts.workloads ?? DEFAULT_WORKLOADS;
  const runs: RunMetrics[] = [];
  const now = opts.now ?? (() => Date.now());
  for (const w of workloads) {
    for (const condition of ["native", "blackhole"] as Condition[]) {
      for (let r = 0; r < w.repeats; r++) {
        const t0 = now();
        const m = simulate(w, condition, r, rng);
        const m2: RunMetrics = { ...m, durationMs: m.durationMs ?? now() - t0 };
        runs.push(m2);
      }
    }
  }
  // Preserve raw data exactly as JSONL + CSV.
  const rawJsonl = runs.map((m) => JSON.stringify(m)).join("\n");
  const cols = [
    "taskId",
    "kind",
    "condition",
    "durationMs",
    "inputTokens",
    "outputTokens",
    "contextTokens",
    "toolCalls",
    "turns",
    "quality",
    "recallHits",
    "recallMisses",
    "entries",
    "compactions",
  ];
  const csvHeader = cols.join(",");
  const rawCsv = [
    csvHeader,
    ...runs.map((m) => cols.map((c) => (m as unknown as Record<string, unknown>)[c] ?? "").join(",")),
  ].join("\n");
  return {
    runs,
    summaries: { native: summarize(runs, "native"), blackhole: summarize(runs, "blackhole") },
    rawJsonl,
    rawCsv,
  };
}
