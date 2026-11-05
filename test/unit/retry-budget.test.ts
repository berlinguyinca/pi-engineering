// R03: the per-incident retry budget is a pure decision function — backoff from retryDelay.ts, incident key from retryTrace's failure_id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { exponentialBackoffMs } from "../../src/inference/retryDelay.ts";
import { type RetryBudgetInput, evaluateRetryBudget } from "../../src/inference/retryBudget.ts";

const budget = (over: Partial<RetryBudgetInput> = {}): RetryBudgetInput => ({ maxAttempts: 3, attempt: 2, elapsedMs: 1000, baseBackoffMs: 500, ...over });

it("an exhausted budget stops, and an attempt beyond the ceiling is not a retry", () => {
  assert.deepEqual(evaluateRetryBudget(budget({ maxAttempts: 3, attempt: 3 })), { action: "stop", reason: "attempts_exhausted" });
  assert.deepEqual(evaluateRetryBudget(budget({ maxAttempts: 3, attempt: 4 })), { action: "stop", reason: "attempts_exhausted" });
});

it("zero budget never retries, and bootstrap mode stops before validation", () => {
  assert.deepEqual(evaluateRetryBudget(budget({ maxAttempts: 1, attempt: 1 })), { action: "stop", reason: "attempts_exhausted" });
  assert.deepEqual(evaluateRetryBudget(budget({ maxAttempts: 8, attempt: 1, deadlineMs: 600_000, mode: "bootstrap" })), { action: "stop", reason: "bootstrap_mode" });
  assert.deepEqual(evaluateRetryBudget(budget({ maxAttempts: 0, attempt: 0, elapsedMs: -1, baseBackoffMs: Number.NaN, mode: "bootstrap" })), { action: "stop", reason: "bootstrap_mode" }, "mode precedes validation");
});

it("elapsed time and the deadline are honoured", () => {
  assert.deepEqual(evaluateRetryBudget(budget({ elapsedMs: 5000, deadlineMs: 5000 })), { action: "stop", reason: "deadline_exceeded" });
  assert.deepEqual(evaluateRetryBudget(budget({ attempt: 1, elapsedMs: 4999, deadlineMs: 5000 })), { action: "stop", reason: "backoff_exceeds_deadline" });
  assert.deepEqual(evaluateRetryBudget(budget({ attempt: 1, elapsedMs: 4999, deadlineMs: 60_000 })), { action: "retry", waitMs: 500, attempt: 1 });
});

it("backoff bounds come from retryDelay, not a local formula, and a larger server wait dominates", () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const same = { maxAttempts: 9, attempt, elapsedMs: 0, baseBackoffMs: 500, maxBackoffMs: 4000 };
    assert.deepEqual(evaluateRetryBudget(budget(same)), { action: "retry", waitMs: exponentialBackoffMs(attempt, 500, 4000), attempt }, `attempt ${attempt} must reuse exponentialBackoffMs`);
    assert.deepEqual(evaluateRetryBudget(budget({ ...same, retryAfterMs: 9000 })), { action: "retry", waitMs: 9000, attempt }, `attempt ${attempt}: retryAfterMs dominates maxBackoffMs`);
  }
});

it("the same input is the same decision, and the module reads no clock, RNG, environment or timer", () => {
  const mixed: RetryBudgetInput[] = [budget(), budget({ maxAttempts: 1, attempt: 1 }), budget({ mode: "bootstrap" }), budget({ maxAttempts: 0 }), budget({ attempt: 1, elapsedMs: 900, deadlineMs: 1000, retryAfterMs: 250 }), budget({ maxAttempts: 9, attempt: 6, maxBackoffMs: 4000 })];
  const decisions = () => Array.from({ length: 1000 }, (_, i) => JSON.stringify(evaluateRetryBudget(mixed[i % mixed.length]!))).sort();
  assert.deepEqual(evaluateRetryBudget(mixed[4]!), evaluateRetryBudget(mixed[4]!));
  assert.deepEqual(decisions(), decisions(), "1000 calls over mixed inputs, unchanged when repeated");
  const source = readFileSync(new URL("../../src/inference/retryBudget.ts", import.meta.url), "utf8");
  for (const forbidden of ["Date.now", "Math.random", "process.env", "setTimeout", 'from "../']) assert.ok(!source.includes(forbidden), `retryBudget.ts must not contain ${forbidden}`);
  assert.deepEqual([...source.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1]!), ["./retryDelay.ts"], "retryDelay.ts is the only import");
});

it("invalid budgets are refused, never guessed", () => {
  const invalid = [budget({ maxAttempts: 0 }), budget({ attempt: 0 }), budget({ elapsedMs: -1 }), budget({ baseBackoffMs: Number.NaN })];
  for (const input of invalid) { assert.deepEqual(evaluateRetryBudget(input), { action: "stop", reason: "invalid_budget" }, JSON.stringify(input)); assert.equal(evaluateRetryBudget(input).action, "stop", `no retry from ${JSON.stringify(input)}`); }
});
