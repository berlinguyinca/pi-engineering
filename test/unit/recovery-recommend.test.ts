// R06: read-only recovery recommendation — composes budget (R03), circuit (R04) and replay safety (R05), and never acts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import {
  PERMANENT_CLASSES,
  RECOVERY_CIRCUIT_COOLDOWN_MS,
  type RecoveryRecommendInput,
  recommendRecovery,
} from "../../src/incidents/recoveryRecommend.ts";
import { type EndpointCircuitSnapshot, evaluateEndpointCircuit } from "../../src/inference/endpointCircuit.ts";
import type { InferenceFailureClass } from "../../src/inference/failureClassifier.ts";
import { type ToolAction, classifyReplaySafety } from "../../src/inference/recoverySafety.ts";
import type { RetryBudgetInput } from "../../src/inference/retryBudget.ts";
const NOW = 1_000_000;
const CLASSES: readonly InferenceFailureClass[] = [
  "incomplete_stream",
  "rate_limited",
  "queue_saturated",
  "capacity_unavailable",
  "model_activating",
  "model_unavailable",
  "no_workers",
  "worker_evicted",
  "worker_restarting",
  "gateway_unavailable",
  "network_interruption",
  "routing_stale",
  "model_not_found",
  "context_overflow",
  "request_too_large",
  "authentication",
  "authorization",
  "quota",
  "billing",
  "invalid_request",
  "unknown",
];
const budget = (over: Partial<RetryBudgetInput> = {}): RetryBudgetInput => ({
  maxAttempts: 5,
  attempt: 1,
  elapsedMs: 0,
  baseBackoffMs: 100,
  ...over,
});
const base = (over: Partial<RecoveryRecommendInput> = {}): RecoveryRecommendInput => ({
  failure: { class: "network_interruption" },
  budget: budget(),
  nowMs: NOW,
  ...over,
});
const snap = (over: Partial<EndpointCircuitSnapshot> = {}): EndpointCircuitSnapshot => ({
  state: "closed",
  endpointId: "ep",
  consecutiveFailures: 0,
  openedAtMs: null,
  probeInFlight: false,
  observedAtMs: 0,
  ...over,
});
const allows = (s: EndpointCircuitSnapshot): boolean =>
  evaluateEndpointCircuit({
    snapshot: s,
    nowMs: NOW,
    threshold: Math.max(1, s.consecutiveFailures),
    cooldownMs: RECOVERY_CIRCUIT_COOLDOWN_MS,
  }).allowAttempt;
const opened = (over: Partial<EndpointCircuitSnapshot> = {}) =>
  snap({ state: "open", consecutiveFailures: 3, ...over });
const cooling = opened({ openedAtMs: NOW - 1 });
const probeTaken = opened({ openedAtMs: NOW - RECOVERY_CIRCUIT_COOLDOWN_MS, probeInFlight: true });
const probeFree = opened({ openedAtMs: NOW - RECOVERY_CIRCUIT_COOLDOWN_MS });
const stopped = (reason: string, source: string) => ({ recommendation: "stop", reason, waitMs: null, source });
const hold = (waitMs: number, reason = "server_wait") => ({
  recommendation: "hold",
  reason,
  waitMs,
  source: "retryBudget",
});
const failover = { recommendation: "failover", reason: "circuit_open", waitMs: null, source: "endpointCircuit" };
const review = { recommendation: "review", reason: "not_replayable", waitMs: null, source: "recoverySafety" };
const retried = { recommendation: "retry", reason: "within_budget", waitMs: 100, source: "retryBudget" };
it("404 does not endlessly retry", () => {
  assert.deepEqual([...PERMANENT_CLASSES].sort(), [
    "authentication",
    "authorization",
    "billing",
    "invalid_request",
    "model_not_found",
    "request_too_large",
  ]);
  const grant = budget({ maxAttempts: 5, attempt: 1 });
  const permanent = stopped("permanent_class", "class");
  for (const cls of PERMANENT_CLASSES) {
    assert.deepEqual(recommendRecovery(base({ failure: { class: cls }, budget: grant })), permanent, cls);
    assert.deepEqual(
      recommendRecovery(base({ failure: { class: cls }, budget: grant, circuit: snap(), switchAvailable: true })),
      permanent,
      `${cls}: a healthy circuit plus a switch grant nothing`,
    );
  }
});
it("429 honours the server wait", () => {
  assert.deepEqual(
    recommendRecovery(base({ failure: { class: "rate_limited", retryAfterMs: 45_000 } })),
    hold(45_000),
    "the server wait beats a 100 ms local backoff",
  );
  assert.deepEqual(
    recommendRecovery(
      base({ failure: { class: "rate_limited", retryAfterMs: 5 }, budget: budget({ maxAttempts: 9, attempt: 8 }) }),
    ),
    hold(12_800),
    "a larger local backoff is never clamped down",
  );
  assert.deepEqual(
    recommendRecovery(
      base({
        failure: { class: "rate_limited", retryAfterMs: 45_000 },
        budget: budget({ maxAttempts: 2, attempt: 2 }),
      }),
    ),
    stopped("budget_exhausted", "retryBudget"),
    "the server never grants an attempt R03 refuses",
  );
  assert.deepEqual(
    recommendRecovery(base({ failure: { class: "model_activating" } })),
    hold(100, "within_budget"),
    "no advertised wait still holds, never retries immediately",
  );
});
it("unknown stops", () => {
  assert.deepEqual(recommendRecovery(base({ failure: { class: "unknown" } })), stopped("unclassified", "class"));
  const invalid = stopped("invalid_input", "input");
  for (const input of [
    base({ failure: { class: "not_a_real_class" as InferenceFailureClass } }),
    base({ failure: { class: "toString" as InferenceFailureClass } }),
    base({ failure: undefined }),
    base({ nowMs: Number.NaN }),
    base({ nowMs: Number.POSITIVE_INFINITY }),
  ])
    assert.deepEqual(recommendRecovery(input), invalid, JSON.stringify(input));
});
it("the circuit decides whether the same endpoint may be attempted", () => {
  assert.deepEqual([allows(cooling), allows(probeTaken), allows(probeFree)], [false, false, true]);
  for (const circuit of [cooling, probeTaken])
    assert.deepEqual(
      recommendRecovery(base({ circuit, switchAvailable: true })),
      failover,
      `${circuit.probeInFlight ? "cooldown elapsed" : "cooldown pending"} with a switch`,
    );
  assert.deepEqual(
    recommendRecovery(base({ circuit: cooling, switchAvailable: false })),
    stopped("circuit_open", "endpointCircuit"),
    "blocked inside the cooldown",
  );
  assert.deepEqual(
    recommendRecovery(base({ circuit: probeTaken, switchAvailable: false })),
    stopped("no_probe_slot", "endpointCircuit"),
    "a spent probe slot is named, never answered with a retry",
  );
  assert.deepEqual(
    recommendRecovery(base({ circuit: probeFree })),
    retried,
    "the one granted probe stays the caller's attempt",
  );
});
it("a non-replayable action goes to review, never to automatic retry", () => {
  for (const action of [{ name: "bash", writes: true }, { name: "mystery_tool" }] as ToolAction[])
    assert.deepEqual(recommendRecovery(base({ action })), review, action.name);
  assert.deepEqual(
    recommendRecovery(base({ action: { name: "read" } })),
    retried,
    "a provably read-only action falls through to the budget",
  );
  assert.deepEqual(
    recommendRecovery(
      base({ action: { name: "edit", external: true }, budget: budget({ maxAttempts: 2, attempt: 2 }) }),
    ),
    review,
    "review is named before the budget stops",
  );
  assert.deepEqual(
    recommendRecovery(base({ action: { name: "bash", writes: true }, circuit: cooling, switchAvailable: true })),
    failover,
    "a blocked endpoint outranks the review",
  );
});
it("recommendations hold over the class table, and the module reads no clock, RNG, env, timer or file", () => {
  const actions: (ToolAction | undefined)[] = [undefined, { name: "bash", writes: true }, { name: "read" }];
  let evaluated = 0;
  for (const cls of CLASSES)
    for (const circuit of [snap(), cooling])
      for (const switchAvailable of [true, false])
        for (const action of actions)
          for (const given of [budget(), undefined]) {
            const result = recommendRecovery(
              base({ failure: { class: cls, retryAfterMs: 1_000 }, circuit, switchAvailable, action, budget: given }),
            );
            const label = `${cls}/${switchAvailable}/${action?.name}/${given === undefined ? "no-budget" : "budget"}`;
            evaluated += 1;
            if (result.recommendation === "retry")
              assert.ok(
                allows(circuit) && given !== undefined,
                `${label}: retry needs a permitted endpoint and a grant`,
              );
            if (PERMANENT_CLASSES.has(cls)) assert.deepEqual(result, stopped("permanent_class", "class"), label);
            if (action !== undefined && classifyReplaySafety(action).replayAllowed === false)
              assert.notEqual(result.recommendation, "retry", label);
            if (result.waitMs !== null)
              assert.ok(
                (result.recommendation === "retry" || result.recommendation === "hold") &&
                  Number.isFinite(result.waitMs),
                label,
              );
          }
  assert.equal(evaluated, CLASSES.length * 2 * 2 * actions.length * 2);
  assert.equal(evaluated, 504, "21 classes x circuit x switch x action x budget");
  const text = readFileSync(new URL("../../src/incidents/recoveryRecommend.ts", import.meta.url), "utf8");
  const imports = text.split("\n").filter((line) => line.startsWith("import"));
  assert.equal(imports.length, 4, "only the four permitted siblings");
  for (const line of imports)
    assert.match(
      line,
      /from "\.\.\/inference\/(failureClassifier|retryBudget|endpointCircuit|recoverySafety)\.ts"/u,
      line,
    );
  for (const forbidden of [
    "Date.now",
    "Math.random",
    "process.env",
    "setTimeout",
    "setInterval",
    "fetch",
    "writeFile",
    "appendFile",
    "console.",
  ])
    assert.ok(!text.includes(forbidden), `recoveryRecommend.ts must not contain ${forbidden}`);
  assert.deepEqual(recommendRecovery(base()), recommendRecovery(base()), "the same input gives the same answer");
});
