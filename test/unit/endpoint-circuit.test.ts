// R04: the endpoint circuit is a pure gate over immutable snapshots — no clock, no RNG, no transport.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import {
  ENDPOINT_CIRCUIT_MAX_KEYS,
  type EndpointCircuitDecision,
  type EndpointCircuitInput,
  type EndpointCircuitSnapshot,
  evaluateEndpointCircuit,
  noteEndpointKey,
} from "../../src/inference/endpointCircuit.ts";
const snap = (over: Partial<EndpointCircuitSnapshot> = {}): EndpointCircuitSnapshot => ({
  state: "closed",
  endpointId: "ep",
  consecutiveFailures: 0,
  openedAtMs: null,
  probeInFlight: false,
  observedAtMs: 0,
  ...over,
});
const gate = (over: Partial<EndpointCircuitInput> = {}): EndpointCircuitInput => ({
  snapshot: snap(),
  nowMs: 1000,
  threshold: 3,
  cooldownMs: 1000,
  ...over,
});
const rows = (d: EndpointCircuitDecision): readonly (string | number | boolean | null)[] => [
  d.state,
  d.snapshot.consecutiveFailures,
  d.snapshot.openedAtMs,
  d.snapshot.probeInFlight,
  d.allowAttempt,
  d.probe,
  d.reason,
];

it("repeated 404s open the circuit and a further failure keeps it open", () => {
  const a = evaluateEndpointCircuit(gate({ failure: "model_not_found", nowMs: 100 }));
  const b = evaluateEndpointCircuit(gate({ snapshot: a.snapshot, failure: "model_not_found", nowMs: 200 }));
  const c = evaluateEndpointCircuit(gate({ snapshot: b.snapshot, failure: "model_not_found", nowMs: 300 }));
  const d = evaluateEndpointCircuit(gate({ snapshot: c.snapshot, failure: "model_not_found", nowMs: 500 }));
  assert.deepEqual(
    [rows(a), rows(b)],
    [
      ["closed", 1, null, false, true, false, "closed"],
      ["closed", 2, null, false, true, false, "closed"],
    ],
  );
  assert.deepEqual(
    [rows(c), rows(d)],
    [
      ["open", 3, 300, false, false, false, "opening"],
      ["open", 3, 300, false, false, false, "opened"],
    ],
  );
});
it("the cooldown gates exactly one probe and rejects the second", () => {
  const cooling = evaluateEndpointCircuit(
    gate({ snapshot: snap({ state: "open", consecutiveFailures: 3, openedAtMs: 1000 }), nowMs: 1999 }),
  );
  const probe = evaluateEndpointCircuit(
    gate({ snapshot: snap({ state: "open", consecutiveFailures: 3, openedAtMs: 1000 }), nowMs: 2000 }),
  );
  const second = evaluateEndpointCircuit(gate({ snapshot: probe.snapshot, nowMs: 2001 }));
  assert.deepEqual(
    [rows(cooling), rows(probe), rows(second)],
    [
      ["open", 3, 1000, false, false, false, "cooldown_pending"],
      ["half_open", 3, 1000, true, true, true, "probe_allowed"],
      ["half_open", 3, 1000, true, false, false, "probe_in_flight"],
    ],
  );
});
it("a probe closes on success and reopens on failure", () => {
  const half = snap({ state: "half_open", consecutiveFailures: 3, openedAtMs: 1000, probeInFlight: true });
  const win = evaluateEndpointCircuit(gate({ snapshot: half, success: true, nowMs: 2000 }));
  const lose = evaluateEndpointCircuit(gate({ snapshot: half, failure: "upstream_failure", nowMs: 3000 }));
  assert.deepEqual(
    [rows(win), rows(lose)],
    [
      ["closed", 0, null, false, true, false, "probe_success"],
      ["open", 3, 3000, false, false, false, "probe_failure"],
    ],
  );
  assert.deepEqual(rows(evaluateEndpointCircuit(gate({ snapshot: lose.snapshot, nowMs: 3999 }))), [
    "open",
    3,
    3000,
    false,
    false,
    false,
    "cooldown_pending",
  ]);
});
it("every failure class opens the circuit and success while closed clears the streak", () => {
  for (const failure of ["model_not_found", "upstream_failure", "unhealthy_response"] as const) {
    const first = evaluateEndpointCircuit({ snapshot: snap(), nowMs: 10, threshold: 2, cooldownMs: 60, failure });
    const second = evaluateEndpointCircuit({
      snapshot: first.snapshot,
      nowMs: 20,
      threshold: 2,
      cooldownMs: 60,
      failure,
    });
    const clear = evaluateEndpointCircuit({
      snapshot: snap({ consecutiveFailures: 1 }),
      nowMs: 30,
      threshold: 2,
      cooldownMs: 60,
      success: true,
    });
    assert.deepEqual(
      [rows(first), rows(second), rows(clear)],
      [
        ["closed", 1, null, false, true, false, "closed"],
        ["open", 2, 20, false, false, false, "opening"],
        ["closed", 0, null, false, true, false, "closed"],
      ],
      failure,
    );
  }
});
it("tracked keys stay bounded and inputs are never mutated", () => {
  let keys: string[] = [];
  for (let i = 0; i < 70; i += 1) keys = noteEndpointKey(keys, `ep-${i}`);
  const next = noteEndpointKey(keys, "ep-70");
  assert.deepEqual(
    [keys.length, keys[0], keys.at(-1), next.length, next[0], next.includes("ep-5")],
    [ENDPOINT_CIRCUIT_MAX_KEYS, "ep-6", "ep-69", ENDPOINT_CIRCUIT_MAX_KEYS, "ep-7", false],
  );
  assert.notEqual(next, keys, "a new array every call");
  assert.deepEqual(noteEndpointKey(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
  const input = gate({ snapshot: snap({ consecutiveFailures: 1 }), failure: "model_not_found", nowMs: 3000 });
  const frozen = structuredClone(input.snapshot);
  const decision = evaluateEndpointCircuit(input);
  assert.deepEqual(input.snapshot, frozen);
  assert.notEqual(decision.snapshot, input.snapshot);
});
it("invalid input fails closed and the module reads no clock or RNG", () => {
  const broken = { ...snap(), state: "halfopen" } as unknown as EndpointCircuitSnapshot;
  for (const input of [
    gate({ nowMs: Number.NaN }),
    gate({ threshold: 0 }),
    gate({ cooldownMs: -1 }),
    gate({ snapshot: broken }),
  ]) {
    const decision = evaluateEndpointCircuit(input);
    assert.deepEqual(
      [decision.reason, decision.allowAttempt, decision.probe],
      ["invalid_input", false, false],
      JSON.stringify(input),
    );
    assert.equal(decision.snapshot, input.snapshot, "returned unchanged");
  }
  const source = readFileSync(new URL("../../src/inference/endpointCircuit.ts", import.meta.url), "utf8");
  for (const forbidden of ["Date.now", "Math.random", "process.env", "setTimeout", "fetch", "import "])
    assert.ok(!source.includes(forbidden), `endpointCircuit.ts must not contain ${forbidden}`);
});
