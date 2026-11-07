// R07: opt-in bounded recovery for one enrolled class, always behind the existing transient.ts retry owner.
import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import { it } from "node:test";
import type { TransientErrorCategory } from "../../src/guard/transient.ts";
import { type EndpointCircuitSnapshot, evaluateEndpointCircuit } from "../../src/inference/endpointCircuit.ts";
import { evaluateRetryBudget } from "../../src/inference/retryBudget.ts";
import type { ToolAction } from "../../src/inference/recoverySafety.ts";
import { RESILIENT_STREAM_CLASS, RESILIENT_STREAM_FLAG, RESILIENT_STREAM_MAX_ATTEMPTS, type ResilientStreamDecision, type ResilientStreamInput, decideResilientStream, resilientStreamEnabled } from "../../src/inference/resilientStreamOptin.ts";

const NOW = 1_000_000; const ON = { PI_RESILIENT_STREAM: "1" }; const ENROLLED = RESILIENT_STREAM_CLASS as TransientErrorCategory; const OFF_ENVS = [{}, { PI_RESILIENT_STREAM: "0" }, { PI_RESILIENT_STREAM: "yes" }, { PI_RESILIENT_STREAM: "" }];
const input = (over: Partial<ResilientStreamInput> = {}): ResilientStreamInput => ({ env: ON, ownerGranted: false, category: ENROLLED, attempt: 1, maxAttempts: 5, elapsedMs: 0, baseBackoffMs: 100, nowMs: NOW, ...over });
const snap = (over: Partial<EndpointCircuitSnapshot> = {}): EndpointCircuitSnapshot => ({ state: "closed", endpointId: "ep", consecutiveFailures: 3, openedAtMs: null, probeInFlight: false, observedAtMs: 0, ...over });
const cooling = snap({ state: "open", openedAtMs: NOW - 1 }); const probeTaken = snap({ state: "open", openedAtMs: NOW - 60_000, probeInFlight: true }); const probeFree = snap({ state: "open", openedAtMs: NOW - 10_000_000 }); const closed = snap({ consecutiveFailures: 0 });
const gate = (s: EndpointCircuitSnapshot, cooldownMs: number) => evaluateEndpointCircuit({ snapshot: s, nowMs: NOW, threshold: Math.max(1, s.consecutiveFailures), cooldownMs }).allowAttempt; const slim = (d: ResilientStreamDecision) => ({ retry: d.retry, waitMs: d.waitMs, reason: d.reason });
const TABLE: ResilientStreamInput[] = [input(), input({ ownerGranted: true }), input({ attempt: 1, maxAttempts: 1 }), input({ attempt: 9, maxAttempts: 9 }), input({ circuit: closed }), input({ circuit: cooling }), input({ circuit: probeTaken }), input({ circuit: probeFree }), input({ action: { name: "bash", writes: true } }), input({ action: { name: "mystery_tool" } }), input({ action: { name: "read" } }), input({ mode: "bootstrap" }), input({ ownerGranted: true, category: "rate_limited" as TransientErrorCategory, circuit: cooling, action: { name: "bash", writes: true } })];
it("flag off is doing nothing, for every input including one the owner already granted", () => {
  assert.ok(TABLE.length >= 12, "the table must cover at least 12 inputs");
  for (const env of OFF_ENVS) for (const given of TABLE) { const d = decideResilientStream({ ...given, env });
    assert.deepEqual({ retry: d.retry, waitMs: d.waitMs, reason: d.reason }, { retry: false, waitMs: null, reason: "flag_off" }, `${String(env[RESILIENT_STREAM_FLAG])}/${given.category}/${given.attempt}`);
    assert.deepEqual(d.log, { flag: RESILIENT_STREAM_FLAG, enabled: false, class: given.category, attempt: given.attempt, cap: d.cap, ownerGranted: given.ownerGranted, reason: "flag_off", waitMs: null }, "an off decision is still a full record, and never cancels or adds"); }
  for (const value of ["1", "true", " TRUE "]) assert.equal(resilientStreamEnabled({ PI_RESILIENT_STREAM: value }), true, value); for (const env of [...OFF_ENVS, { PI_RESILIENT_STREAM: "TRUE." }, { PI_RESILIENT_STREAM: "2" }]) assert.equal(resilientStreamEnabled(env), false, JSON.stringify(env));
});
it("flag on is bounded: the cap holds, R03's wait survives, bootstrap is never granted", () => {
  const d = decideResilientStream(input({ maxAttempts: 10 })); const r3 = evaluateRetryBudget({ maxAttempts: 2, attempt: 1, elapsedMs: 0, baseBackoffMs: 100 });
  assert.deepEqual({ retry: d.retry, reason: d.reason, cap: d.cap, waitMs: d.waitMs }, { retry: true, reason: "granted", cap: 2, waitMs: r3.action === "retry" ? r3.waitMs : -1 }, "maxAttempts 10 caps at 2 and waits exactly what R03 said");
  for (const over of [{ attempt: 2 }, { maxAttempts: 1 }, { maxAttempts: 0 }, { attempt: 3, maxAttempts: 9 }]) assert.deepEqual(slim(decideResilientStream(input(over))), { retry: false, waitMs: null, reason: "cap_reached" }, JSON.stringify(over));
  for (const maxAttempts of [0, 1, 2, 3, 10, 50]) assert.equal(decideResilientStream(input({ maxAttempts })).cap, Math.min(maxAttempts, RESILIENT_STREAM_MAX_ATTEMPTS), `cap for ${maxAttempts}`);
  for (const over of [{ mode: "bootstrap" as const }, { attempt: 0 }, { baseBackoffMs: Number.NaN }, { elapsedMs: -1 }]) assert.deepEqual(slim(decideResilientStream(input(over))), { retry: false, waitMs: null, reason: "budget_exhausted" }, JSON.stringify(over));
});
it("the owner's grant is never answered with a second grant", () => {
  const replayables: (ToolAction | undefined)[] = [undefined, { name: "read" }, { name: "read", idempotencyKey: "k" }]; const circuits: (EndpointCircuitSnapshot | undefined)[] = [undefined, closed, probeFree];
  for (const action of replayables) for (const circuit of circuits) { assert.equal(gate(circuit ?? closed, 60_000), true, "every combination under test is gate-permitted");
    const owned = slim(decideResilientStream(input({ ownerGranted: true, action, circuit }))); const free = slim(decideResilientStream(input({ ownerGranted: false, action, circuit })));
    assert.deepEqual(owned, { retry: false, waitMs: null, reason: "owner_granted" }, `transient.ts already retries ${String(action?.name ?? "no-action")}/${String(circuit?.state ?? "no-circuit")}`);
    assert.deepEqual(free, { retry: true, waitMs: 100, reason: "granted" }, "the same input without the owner's grant does retry"); }
});
it("only the enrolled class is integrated", () => {
  for (const category of ["rate_limited", "network_interruption", "server_error", "timeout", ""] as TransientErrorCategory[]) { const d = decideResilientStream(input({ category }));
    assert.deepEqual(slim(d), { retry: false, waitMs: null, reason: "class_not_enrolled" }, category); assert.equal(decideResilientStream(input({ category, ownerGranted: true })).reason, "class_not_enrolled", "the class gate precedes the owner gate"); }
  assert.equal(decideResilientStream(input({ category: ENROLLED })).reason, "granted", "incomplete_stream is the one class that proceeds");
});
it("replay safety and the circuit outrank the flag", () => {
  for (const action of [{ name: "bash", writes: true }, { name: "mystery_tool" }] as ToolAction[]) { const d = decideResilientStream(input({ action }));
    assert.deepEqual(slim(d), { retry: false, waitMs: null, reason: "not_replayable" }, action.name); assert.equal(d.log.reason, "not_replayable", action.name); }
  for (const circuit of [cooling, probeTaken]) for (const cooldownMs of [1_000, 60_000, 600_000]) { assert.equal(gate(circuit, cooldownMs), false, `${circuit.probeInFlight ? "probe taken" : "cooldown pending"} at ${cooldownMs}`);
    const d = decideResilientStream(input({ circuit })); assert.deepEqual(slim(d), { retry: false, waitMs: null, reason: "circuit_denied" });
    assert.deepEqual(d.log, { flag: RESILIENT_STREAM_FLAG, enabled: true, class: ENROLLED, attempt: 1, cap: 2, ownerGranted: false, reason: "circuit_denied", waitMs: null }, "the record names the same denial"); }
  assert.equal(decideResilientStream(input({ action: { name: "bash", writes: true }, circuit: cooling })).reason, "not_replayable", "replay safety is asked before the gate");
});
it("logging is data, and the module executes nothing", () => {
  for (const given of [input(), input({ ownerGranted: true }), input({ env: {}, attempt: 2 })] as ResilientStreamInput[]) { const d = decideResilientStream(given);
    assert.deepEqual(d.log, { flag: RESILIENT_STREAM_FLAG, enabled: d.reason !== "flag_off", class: given.category, attempt: given.attempt, cap: d.cap, ownerGranted: given.ownerGranted, reason: d.reason, waitMs: d.waitMs }, d.reason);
    assert.equal(d.retry, d.reason === "granted", "retry is true only for granted"); }
  const source = readFileSync(new URL("../../src/inference/resilientStreamOptin.ts", import.meta.url), "utf8");
  for (const forbidden of ["writeFile", "appendFile", "console.", "setTimeout", "Math.random", "Date.now", "fetch"]) assert.ok(!source.includes(forbidden), `resilientStreamOptin.ts must not contain ${forbidden}`);
  assert.equal([...source.matchAll(/process\.env/gu)].length, 1, "one process.env: the parameter default"); assert.deepEqual([...source.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1]!), ["../guard/transient.ts", "./endpointCircuit.ts", "./retryBudget.ts", "./recoverySafety.ts"], "types from the owner, decisions from R03/R04/R05");
});
