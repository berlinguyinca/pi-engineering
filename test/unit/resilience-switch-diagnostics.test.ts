/**
 * The switch diagnostics are reachable, not decorative.
 *
 * `resolveInferenceResilienceConfig` records a switch it could not read, but a
 * recorded note nobody renders leaves an operator exactly where the old parser
 * left them: believing `PI_INFERENCE_STREAM_RETRY_ENABLED=diable` disabled
 * something. This file drives the two entry points that resolve the config —
 * `wireResilientModelRuntime`, which is how production arms a worker runtime
 * (`src/workers/PiWorkerExecutor.ts`), and `ResilientInference`, the library
 * entry point — and asserts the note reaches a status sink.
 *
 * It is also the first test to construct `ResilientInference` at all: only
 * `transport` is required, so the class has been untestable by omission rather
 * than by difficulty.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeUnparseableSwitches, resolveInferenceResilienceConfig } from "../../src/inference/resilienceConfig.ts";
import {
  ResilientInference,
  type ResilientRawResult,
  type ResilientTransport,
} from "../../src/inference/resilientInference.ts";
import { wireResilientModelRuntime } from "../../src/inference/resilientInstall.ts";
import { isResilientRuntime } from "../../src/inference/resilientStream.ts";

/** A transport that never gets called — these tests are about construction. */
function transport(): ResilientTransport {
  return {
    send: async (): Promise<ResilientRawResult> => {
      throw new Error("the transport must not be reached by a construction test");
    },
  };
}

function lines(): { sink: (line: string) => void; collected: string[] } {
  const collected: string[] = [];
  return { sink: (line) => collected.push(line), collected };
}

describe("describeUnparseableSwitches: the note becomes an operator-facing line", () => {
  it("names the switch and the value that could not be read", () => {
    const cfg = resolveInferenceResilienceConfig({ PI_INFERENCE_STREAM_RETRY_ENABLED: "diable" });
    const out = describeUnparseableSwitches(cfg);
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(out[0] ?? "", /PI_INFERENCE_STREAM_RETRY_ENABLED=diable/);
    assert.doesNotMatch(out[0] ?? "", /stack|at .*\.ts:\d+/, "a status line, not a stack trace");
  });

  it("says nothing when every switch could be read", () => {
    assert.deepEqual(
      describeUnparseableSwitches(
        resolveInferenceResilienceConfig({
          PI_INFERENCE_RESILIENCE_ENABLED: "1",
          PI_INFERENCE_STREAM_RETRY_ENABLED: "off",
        }),
      ),
      [],
    );
    assert.deepEqual(describeUnparseableSwitches(resolveInferenceResilienceConfig({})), []);
  });
});

describe("ResilientInference reports the switches it could not read", () => {
  it("is constructible with nothing but a transport, and reports a mistyped arm", () => {
    const { sink, collected } = lines();
    const inference = new ResilientInference({
      transport: transport(),
      env: { PI_INFERENCE_RESILIENCE_ENABLED: "ture" },
      status: sink,
    });
    assert.ok(inference instanceof ResilientInference);
    assert.equal(collected.length, 1, JSON.stringify(collected));
    assert.match(collected[0] ?? "", /PI_INFERENCE_RESILIENCE_ENABLED=ture/);
    assert.match(collected[0] ?? "", /default is in force/, "the operator is told the value did not arm anything");
  });

  it("reports several switches, and stays silent for readable ones", () => {
    const noisy = lines();
    new ResilientInference({
      transport: transport(),
      env: { PI_INFERENCE_MODEL_FALLBACK: "maybe", PI_INFERENCE_CIRCUIT_FAILURES: "lots" },
      status: noisy.sink,
    });
    assert.deepEqual(
      noisy.collected.map((l) => (l.match(/PI_[A-Z_]+/) ?? [""])[0]).sort(),
      ["PI_INFERENCE_MODEL_FALLBACK"],
      "only boolean switches are read as on/off, so only those are reported",
    );

    const quiet = lines();
    new ResilientInference({
      transport: transport(),
      env: {
        PI_INFERENCE_RESILIENCE_ENABLED: "on",
        PI_INFERENCE_MODEL_FALLBACK: "false",
        PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY: "off",
        PI_INFERENCE_STREAM_RETRY_ENABLED: "0",
      },
      status: quiet.sink,
    });
    assert.deepEqual(quiet.collected, []);
  });

  it("constructs without a status sink", () => {
    assert.ok(
      new ResilientInference({ transport: transport(), env: { PI_INFERENCE_MODEL_FALLBACK: "ture" } }) instanceof
        ResilientInference,
    );
  });
});

describe("production arming reports the switch it could not read", () => {
  function stubRuntime() {
    return { streamSimple: () => undefined } as never;
  }

  it("says so when the typo left the whole layer unarmed", () => {
    const { sink, collected } = lines();
    const result = wireResilientModelRuntime(stubRuntime(), {
      env: { PI_INFERENCE_RESILIENCE_ENABLED: "ture" },
      status: sink,
    });
    assert.equal(result, "disabled", "a typo does not arm the layer");
    assert.equal(collected.length, 1, JSON.stringify(collected));
    assert.match(collected[0] ?? "", /PI_INFERENCE_RESILIENCE_ENABLED=ture/);
  });

  it("reports a mistyped sub-switch while still arming the layer", () => {
    const { sink, collected } = lines();
    const runtime = stubRuntime();
    const result = wireResilientModelRuntime(runtime, {
      env: { PI_INFERENCE_RESILIENCE_ENABLED: "1", PI_INFERENCE_STREAM_RETRY_ENABLED: "diable" },
      status: sink,
    });
    assert.equal(result, "installed");
    assert.ok(isResilientRuntime(runtime));
    assert.equal(collected.length, 1, JSON.stringify(collected));
    assert.match(collected[0] ?? "", /PI_INFERENCE_STREAM_RETRY_ENABLED=diable/);
  });

  it("says nothing on a readable environment", () => {
    const { sink, collected } = lines();
    const result = wireResilientModelRuntime(stubRuntime(), {
      env: { PI_INFERENCE_RESILIENCE_ENABLED: "1", PI_INFERENCE_STREAM_RETRY_ENABLED: "off" },
      status: sink,
    });
    assert.equal(result, "installed");
    assert.deepEqual(collected, []);
  });

  it("reports on a re-arm too, and survives having no status sink", () => {
    const runtime = stubRuntime();
    assert.equal(wireResilientModelRuntime(runtime, { env: { PI_INFERENCE_RESILIENCE_ENABLED: "1" } }), "installed");
    const { sink, collected } = lines();
    assert.equal(
      wireResilientModelRuntime(runtime, {
        env: { PI_INFERENCE_RESILIENCE_ENABLED: "1", PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS: "yess" },
        status: sink,
      }),
      "already-installed",
    );
    assert.equal(collected.length, 1, JSON.stringify(collected));
  });
});
