/**
 * Integration tests for the fault-tolerant inference & InferWeave-aware
 * recovery stack (fault-tolerance spec §30–35).
 *
 * These run the EXISTING unified resilient layer end-to-end with a mocked
 * transport (no network): metadata capture → failure classifier → retry
 * policy → model health penalties → RoleRouter fallback → recovery ladder →
 * mission capacity wait. The six required scenarios:
 *
 *   (a) interrupted stream        → same-model retry, mission continues
 *   (b) no workers                → capability-based fallback (qwen → deepseek)
 *   (c) gateway saturation 429    → honour Retry-After, same model, no fallback
 *   (d) model activating          → honour retry_after_ms, no premature fallback
 *   (e) all models unavailable    → WAITING_FOR_INFERENCE_CAPACITY + auto-resume
 *   (f) executed tool + disconnect → idempotent retry, no re-executed edit
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DiscoveryContext, ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import {
  type ResilientRawResult,
  type ResilientTransport,
  createResilientInference,
} from "../../src/inference/resilientInference.ts";
import type { InferenceTelemetryEvent } from "../../src/inference/telemetry.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import type { ModelRecord } from "../../src/lifecycle/types.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";

// ─── Test doubles ────────────────────────────────────────────────────────────

function rec(
  input: Partial<Parameters<typeof normalizeModelRecord>[0]> & { provider: string; id: string },
): ModelRecord {
  return normalizeModelRecord({
    source: "test",
    toolCall: true,
    contextWindow: 200_000,
    input: ["text"],
    output: ["text"],
    priceInput: 1,
    priceOutput: 2,
    ...input,
  });
}

const QWEN: ModelRef = { provider: "inferweave", id: "qwen3.8-27b" };
const DEEPSEEK: ModelRef = { provider: "inferweave", id: "deepseek-v4.1-flash" };

class CountingSource implements ModelSource {
  readonly name = "counting";
  discovers = 0;
  private readonly records: ModelRecord[];
  constructor(records: ModelRecord[]) {
    this.records = records;
  }
  async discover(): Promise<ModelRecord[]> {
    this.discovers += 1;
    return this.records;
  }
}

interface Harness {
  run: ReturnType<typeof createResilientInference>["run"];
  sleeps: number[];
  statuses: string[];
  requests: unknown[];
  modelsSent: ModelRef[];
  telemetry: InferenceTelemetryEvent[];
  source: CountingSource;
  registry: ModelCapabilityRegistry;
  health: ReturnType<typeof createResilientInference>["healthRegistry"];
  actions: ReturnType<typeof createResilientInference>["actionTracker"];
  parks: Array<{ missionId?: string; workerId?: string; role: string; reason: string; untilMs: number }>;
}

async function buildHarness(opts: {
  records?: ModelRecord[];
  send: (info: { model: ModelRef; request: unknown; attempt: number; calls: number }) =>
    | Promise<ResilientRawResult>
    | ResilientRawResult;
  config?: Record<string, unknown>;
  capacityAvailable?: () => boolean;
  probeIntervalMs?: number;
}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-eng-resilient-"));
  const source = new CountingSource(
    opts.records ?? [
      rec({ ...QWEN, provider: QWEN.provider, id: QWEN.id }),
      rec({ provider: DEEPSEEK.provider, id: DEEPSEEK.id }),
    ],
  );
  const registry = await ModelCapabilityRegistry.open({
    sources: [source],
    context: { cwd, agentDir: cwd } satisfies DiscoveryContext,
  });
  await registry.refresh();
  const router = new RoleRouter({ registry, policy: structuredClone(DEFAULT_POLICY) });

  let t = Date.now();
  const sleeps: number[] = [];
  const statuses: string[] = [];
  const requests: unknown[] = [];
  const modelsSent: ModelRef[] = [];
  const telemetry: InferenceTelemetryEvent[] = [];
  const parks: Harness["parks"] = [];
  let calls = 0;
  const capacity = opts.capacityAvailable ?? (() => false);

  const transport: ResilientTransport = {
    send: async ({ model, request, attempt }) => {
      calls += 1;
      requests.push(request);
      modelsSent.push(model);
      return opts.send({ model, request, attempt, calls });
    },
  };

  const inst = createResilientInference({
    transport,
    env: {},
    registry,
    router,
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    random: () => 0,
    config: opts.config as never,
    status: (line) => statuses.push(line),
    probeIntervalMs: opts.probeIntervalMs,
    scheduler: {
      park: (info) => parks.push(info),
      isCapacityAvailable: () => capacity(),
    },
  });
  inst.telemetryBus.on((e) => telemetry.push(e));
  const harness: Harness = {
    run: (input) => inst.run(input),
    sleeps,
    statuses,
    requests,
    modelsSent,
    telemetry,
    source,
    registry,
    health: inst.healthRegistry,
    actions: inst.actionTracker,
    parks,
  };
  void cwd;
  return harness;
}

const PLANNER_ENVELOPE = {
  role: "planner",
  requiredCapabilities: ["tool_calling", "long_context"],
};

function eventsNamed(h: Harness, name: string): InferenceTelemetryEvent[] {
  return h.telemetry.filter((e) => e.name === name);
}

// ─── (a) Interrupted stream: same-model retry, mission continues (§30) ─────

describe("(a) interrupted stream → same-model retry → mission continues", () => {
  it("retries the SAME model after an SSE stream ends without finish_reason; request 2 succeeds", async () => {
    const h = await buildHarness({
      send: ({ attempt }) => {
        if (attempt === 1) {
          // Tokens flowed, then the stream died without finish_reason.
          return {
            ok: false,
            error: new Error("Stream ended without finish_reason"),
            provider: "inferweave",
            streamState: { finished: false, outputCommitted: true, partialChars: 412 },
          };
        }
        return { ok: true, output: "complete answer", provider: "inferweave" };
      },
    });

    const result = await h.run({
      request: { messages: [{ role: "user", content: "do the work" }] },
      role: "planner",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
      missionId: "MSN-test",
      workerId: "W-a",
    });

    assert.equal(result.ok, true, "the mission continues — NOT failed");
    assert.equal(result.ladder.attempts, 2, "exactly one retry");
    assert.equal(result.ladder.fallbackModel, undefined, "same model: no fallback on a stream cut");
    assert.equal(modelKey(result.ladder.model ?? QWEN), modelKey(QWEN));
    // Same-model retry waited ~30s (jitter fixed at 0 for determinism).
    assert.deepEqual(h.sleeps, [30_000], "the wait occurred before the retry");
    // Partial generation is recorded as incomplete, never as output.
    assert.equal(result.ladder.incompleteGenerations, 1);
    const incomplete = eventsNamed(h, "inference.stream.incomplete");
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]?.data.kind, "incomplete_generation");
    // User-visible status is concise, no stack trace.
    assert.ok(
      h.statuses.some((s) => s.startsWith("stream interrupted · retrying in 30s")),
      `status lines: ${JSON.stringify(h.statuses)}`,
    );
    // The partial text never re-enters the retried request as completed output.
    assert.equal(
      (h.requests[1] as Record<string, unknown>).pi_retry_evidence,
      undefined,
      "no actions executed → no evidence injected",
    );
    assert.ok(h.telemetry.some((e) => e.name === "inference.retry.succeeded"));
  });

  it("does NOT bubble an interrupted stream out of the invocation (worker stays alive through the wait)", async () => {
    const h = await buildHarness({
      send: ({ attempt }) =>
        attempt <= 3
          ? { ok: false, error: new Error("socket hang up"), streamState: { finished: false, outputCommitted: false } }
          : { ok: true, output: "done" },
    });
    const result = await h.run({ request: {}, role: "implementer", model: QWEN, requiredEnvelope: PLANNER_ENVELOPE });
    assert.equal(result.ok, true);
    assert.equal(result.ladder.attempts, 4);
    // 30s → 60s → 120s ladder (jitter 0).
    assert.deepEqual(h.sleeps, [30_000, 60_000, 120_000]);
  });
});

// ─── (b) no workers → capability-based fallback (§31) ───────────────────────

describe("(b) no_workers → qwen temporarily penalized, catalog refreshed, DeepSeek selected", () => {
  it("falls back to the comparable model when the original has no workers", async () => {
    const h = await buildHarness({
      send: ({ model }) => {
        if (modelKey(model) === modelKey(QWEN)) {
          return {
            ok: false,
            status: 503,
            provider: "inferweave",
            body: { reason: "no_workers", model: "qwen3.8-27b" },
          };
        }
        return { ok: true, output: "served by deepseek", provider: "inferweave", resolvedModel: undefined };
      },
    });

    const result = await h.run({
      request: { messages: [] },
      role: "planner",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
      missionId: "MSN-b",
      workerId: "W-b",
    });

    assert.equal(result.ok, true, "the worker continues on the fallback");
    assert.equal(modelKey(result.ladder.fallbackModel ?? ({} as ModelRef)), modelKey(DEEPSEEK), "DeepSeek selected");
    assert.equal(modelKey(result.ladder.model ?? QWEN), modelKey(DEEPSEEK));
    // qwen is temporarily penalized (never permanently pinned out).
    assert.equal(h.health.isPenalized(QWEN), true, "qwen3.8-27b temporarily penalized");
    assert.equal(h.health.isPenalized(DEEPSEEK), false, "the model that served is eligible again");
    // The catalog was refreshed before selecting (no_workers → fresh InferWeave state).
    assert.ok(h.source.discovers >= 2, `catalog refreshed (discovers=${h.source.discovers})`);
    assert.ok(eventsNamed(h, "inference.catalog.refreshed").length >= 1);
    // Concise fallback line: "qwen3.8-27b → deepseek-v4.1-flash / continuing".
    assert.ok(
      h.statuses.some((s) => s.includes("qwen3.8-27b → deepseek-v4.1-flash / continuing")),
      `status: ${JSON.stringify(h.statuses)}`,
    );
    const classified = eventsNamed(h, "inference.failure.classified")[0];
    assert.equal(classified?.data.failure_class, "no_workers");
  });

  it("never selects a fallback that misses a hard envelope requirement", async () => {
    // deepseek record lacks long_context → the envelope (planner) must reject it.
    const h = await buildHarness({
      records: [
        rec({ provider: QWEN.provider, id: QWEN.id }),
        rec({ provider: DEEPSEEK.provider, id: DEEPSEEK.id, contextWindow: 64_000 }),
      ],
      send: ({ model }) =>
        modelKey(model) === modelKey(QWEN)
          ? { ok: false, status: 503, body: { reason: "no_workers" } }
          : { ok: true, output: "no" },
    });
    const result = await h.run({
      request: {},
      role: "planner",
      model: QWEN,
      requiredEnvelope: { role: "planner", requiredCapabilities: ["tool_calling"], minimumContextTokens: 128_000 },
    });
    // No eligible fallback: the mission WAITS for capacity, it does not fail
    // and it does not downgrade below the recorded envelope.
    assert.equal(result.ok, false);
    assert.equal(result.ladder.waitingForCapacity, true, "waits for capacity instead of failing");
    assert.ok(h.parks.length >= 1, "mission parked durably");
  });
});

// ─── (c) gateway saturation: 429 queue_timeout → wait, same model, NO fallback (§32)

describe("(c) 429 reason=queue_timeout Retry-After=120 → wait >= 120s, same model retained", () => {
  it("honours the server wait exactly and never model-switches on a queue timeout", async () => {
    const h = await buildHarness({
      send: ({ attempt }) => {
        if (attempt === 1) {
          return {
            ok: false,
            status: 429,
            provider: "inferweave",
            headers: { "Retry-After": "120" },
            body: { reason: "queue_timeout", retry_after_ms: 120_000 },
          };
        }
        return { ok: true, output: "served after the wait", provider: "inferweave" };
      },
    });

    const result = await h.run({
      request: { messages: [] },
      role: "implementer",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ladder.fallbackModel, undefined, "NO fallback on gateway saturation");
    assert.equal(modelKey(result.ladder.model ?? QWEN), modelKey(QWEN), "same model retained");
    assert.ok(h.sleeps.length >= 1, "the wait occurred");
    assert.ok((h.sleeps[0] ?? 0) >= 120_000, `wait >= 120s (slept ${h.sleeps[0] ?? "-"})`);
    const classified = eventsNamed(h, "inference.failure.classified")[0];
    assert.equal(classified?.data.failure_class, "queue_saturated");
    // A 429 queue wait must NOT penalize the model as unselectable.
    assert.equal(h.health.isPenalized(QWEN), false);
  });
});

// ─── (d) model activating → honour retry_after_ms, no premature fallback (§33)

describe("(d) model_activating retry_after_ms=90000 → wait >= 90s, no premature fallback", () => {
  it("waits out activation and serves the same model when it activates in time", async () => {
    const h = await buildHarness({
      send: ({ attempt }) => {
        if (attempt === 1) {
          return {
            ok: false,
            status: 503,
            provider: "inferweave",
            body: { reason: "model_activating", retry_after_ms: 90_000 },
          };
        }
        return { ok: true, output: "activated", provider: "inferweave" };
      },
    });

    const result = await h.run({
      request: {},
      role: "implementer",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ladder.fallbackModel, undefined, "no premature fallback");
    assert.equal(modelKey(result.ladder.model ?? QWEN), modelKey(QWEN));
    assert.ok((h.sleeps[0] ?? 0) >= 90_000, `wait >= 90s (slept ${h.sleeps[0] ?? "-"})`);
    const classified = eventsNamed(h, "inference.failure.classified")[0];
    assert.equal(classified?.data.failure_class, "model_activating");
  });

  it("falls back only after activation exceeds the configured threshold", async () => {
    const h = await buildHarness({
      config: { activationFallbackAfterMs: 60_000 },
      send: ({ model, attempt }) => {
        if (modelKey(model) === modelKey(QWEN)) {
          return { ok: false, status: 503, body: { reason: "model_activating", retry_after_ms: 90_000 } };
        }
        void attempt;
        return { ok: true, output: "served by fallback", provider: "inferweave" };
      },
    });

    const result = await h.run({
      request: {},
      role: "implementer",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
    });

    assert.equal(result.ok, true);
    assert.equal(
      modelKey(result.ladder.fallbackModel ?? ({} as ModelRef)),
      modelKey(DEEPSEEK),
      "fallback only after the activation threshold",
    );
    // Three 90s activation waits were honoured before the 10m→60s budget elapsed:
    // 90s waits on attempts 1 and 2, then the budget (elapsed >= 60s) forces the fallback.
    assert.ok(h.sleeps.length >= 2, "server timing was honoured before the fallback");
    assert.ok(
      h.sleeps.every((s) => s >= 90_000),
      "server-provided waits were never shortened",
    );
  });
});

// ─── (e) all models unavailable → WAITING_FOR_INFERENCE_CAPACITY + auto-resume (§34)

describe("(e) all models unavailable → durable capacity wait, scheduler continues, auto-resume", () => {
  it("parks the mission durably, keeps probing, and resumes the SAME request when capacity appears", async () => {
    let probes = 0;
    const h = await buildHarness({
      probeIntervalMs: 1_000,
      // The scheduler probes capacity on its cadence; capacity returns after
      // the 3rd probe (the EXISTING long-transient-outage machinery resumes).
      capacityAvailable: () => {
        probes += 1;
        return probes >= 3;
      },
      send: ({ calls }) => {
        if (calls <= 2) {
          // Both registry models refuse: no workers anywhere.
          return { ok: false, status: 503, provider: "inferweave", body: { reason: "no_workers" } };
        }
        return { ok: true, output: "resumed and served", provider: "inferweave" };
      },
    });

    const result = await h.run({
      request: { messages: [] },
      role: "planner",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
      missionId: "MSN-e",
      workerId: "W-e",
    });

    assert.equal(result.ok, true, "the mission auto-resumed and completed — it NEVER failed");
    assert.notEqual(result.ladder.waitingForCapacity, true, "final state is resumed, not parked");
    assert.ok(h.parks.length >= 1, "mission parked in WAITING_FOR_INFERENCE_CAPACITY");
    assert.equal(h.parks[0]?.missionId, "MSN-e");
    assert.equal(h.parks[0]?.role, "planner");
    assert.ok(eventsNamed(h, "inference.mission.waiting_capacity").length >= 1, "waiting telemetry emitted");
    assert.ok(eventsNamed(h, "inference.mission.resumed").length >= 1, "auto-resume telemetry emitted");
    assert.ok(probes >= 3, `scheduler kept probing (probes=${probes})`);
    assert.ok(
      h.sleeps.some((s) => s === 1_000),
      "scheduler probed at the injected cadence",
    );
    // No manual restart: the SAME logical request completed after the wait.
    assert.equal(result.ladder.attempts, 3);
  });
});

// ─── (f) executed tool before disconnect → idempotent retry (§35) ──────────

describe("(f) edit executed, then stream disconnects → retry does NOT re-execute the edit", () => {
  it("injects concise idempotency evidence into the retried request and records the partial generation", async () => {
    const h = await buildHarness({
      send: ({ attempt }) => {
        if (attempt === 1) {
          return {
            ok: false,
            error: new Error("ECONNRESET"),
            provider: "inferweave",
            streamState: { finished: false, outputCommitted: true, partialChars: 900 },
          };
        }
        return { ok: true, output: "finished from current state", provider: "inferweave" };
      },
    });

    // The harness records the tool call that ALREADY EXECUTED before the cut.
    h.actions.record({ id: "call_edit_1", kind: "edit", summary: "applied edit to src/foo.ts" });
    // Recording the same invocation id again is a no-op (idempotent).
    h.actions.record({ id: "call_edit_1", kind: "edit", summary: "applied edit to src/foo.ts" });
    assert.equal(h.actions.list().length, 1, "the executed action is tracked exactly once");

    const result = await h.run({
      request: { messages: [{ role: "user", content: "edit foo.ts" }], model: modelKey(QWEN) },
      role: "implementer",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
      missionId: "MSN-f",
      workerId: "W-f",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ladder.attempts, 2);
    assert.equal(result.ladder.incompleteGenerations, 1, "partial generation recorded as incomplete_generation");

    const retried = h.requests[1] as Record<string, unknown>;
    const evidence = typeof retried.pi_retry_evidence === "string" ? retried.pi_retry_evidence : "";
    assert.ok(evidence.includes("call_edit_1"), "evidence names the invocation id");
    assert.ok(evidence.includes("applied edit to src/foo.ts"), "evidence names what executed");
    assert.ok(/MUST NOT be repeated/i.test(evidence), "evidence forbids re-execution");
    // The first attempt carried no evidence (nothing had executed yet).
    assert.equal((h.requests[0] as Record<string, unknown>).pi_retry_evidence, undefined);
  });

  it("the retried request is the SAME logical request (mission state preserved)", async () => {
    const h = await buildHarness({
      send: ({ attempt }) =>
        attempt === 1
          ? {
              ok: false,
              error: new Error("connection reset by peer"),
              streamState: { finished: false, outputCommitted: true },
            }
          : { ok: true, output: "ok" },
    });
    const original = { messages: [{ role: "user", content: "keep this" }], mission: "MSN-f2" };
    const result = await h.run({
      request: { ...original },
      role: "implementer",
      model: QWEN,
      requiredEnvelope: PLANNER_ENVELOPE,
    });
    assert.equal(result.ok, true);
    const retried = h.requests[1] as Record<string, unknown>;
    assert.deepEqual(retried.messages, original.messages, "request payload travels untouched");
    assert.equal(retried.mission, "MSN-f2");
  });
});
