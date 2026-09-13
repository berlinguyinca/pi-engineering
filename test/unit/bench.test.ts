import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BenchmarkMetrics,
  autonomyRatio,
  evaluateBenchmark,
  runBenchmark,
  tokensPerTask,
} from "../../src/bench/Benchmark.ts";

const good: BenchmarkMetrics = { tasksCompleted: 10, tasksAttempted: 10, durationMs: 1000, contextTokens: 20_000 };

test("bench: autonomyRatio and tokensPerTask", () => {
  assert.equal(autonomyRatio(good), 1);
  assert.equal(tokensPerTask(good), 2000);
  assert.equal(tokensPerTask({ ...good, tasksCompleted: 0 }), Number.POSITIVE_INFINITY);
});

test("bench: evaluateBenchmark passes a good run", () => {
  const v = evaluateBenchmark(good, { minAutonomy: 0.9, maxTokensPerTask: 5000 });
  assert.equal(v.pass, true);
  assert.equal(v.failures.length, 0);
});

test("bench: evaluateBenchmark fails on low autonomy", () => {
  const low: BenchmarkMetrics = { tasksCompleted: 5, tasksAttempted: 10, durationMs: 1000, contextTokens: 10_000 };
  const v = evaluateBenchmark(low, { minAutonomy: 0.9, maxTokensPerTask: 5000 });
  assert.equal(v.pass, false);
  assert.match(v.failures.join(","), /autonomy/);
});

test("bench: evaluateBenchmark fails on high tokens/task", () => {
  const wasteful: BenchmarkMetrics = { tasksCompleted: 2, tasksAttempted: 2, durationMs: 1000, contextTokens: 100_000 };
  const v = evaluateBenchmark(wasteful, { minAutonomy: 0.5, maxTokensPerTask: 5000 });
  assert.equal(v.pass, false);
  assert.match(v.failures.join(","), /tokens\/task/);
});

test("bench: runBenchmark wires workload to baseline", async () => {
  const v = await runBenchmark({ run: async () => good }, { minAutonomy: 0.8, maxTokensPerTask: 5000 });
  assert.equal(v.pass, true);
  assert.equal(v.metrics.tasksCompleted, 10);
});
