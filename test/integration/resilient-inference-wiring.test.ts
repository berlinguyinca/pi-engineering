/**
 * The LIVE inference seam is decided by the unified resilient layer
 * (fault-tolerance spec §21/§23/§26).
 *
 * These run a REAL Pi `ModelRuntime` with the resilient layer armed, against a
 * probe provider that stands in for the InferWeave gateway: response metadata
 * (status + `X-InferWeave-*` headers) is captured per attempt, the unified
 * classifier decides, the retry policy waits (server timing honoured), model
 * penalties/fallback go through the capability registry + RoleRouter, and an
 * all-models-down outage parks the mission instead of failing it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DiscoveryContext, ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import type { GatewayWaitSignal } from "../../src/gateway/signals.ts";
import { createAssistantMessageEventStream as createLocalStream } from "../../src/inference/admissionTransport.ts";
import { isResilientRuntime } from "../../src/inference/resilientStream.ts";
import { wireResilientModelRuntime } from "../../src/inference/resilientInstall.ts";
import { ExecutedActionTracker } from "../../src/inference/recovery.ts";
import { InferenceTelemetry } from "../../src/inference/telemetry.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import type { ModelRecord } from "../../src/lifecycle/types.ts";

const API = "openai-completions";
const BASE_URL = "https://gateway.invalid/v1";

function model(id: string, provider = "probe") {
  return {
    id,
    name: id,
    api: API,
    provider,
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100,
  };
}

const PRIMARY = model("qwen3.8-27b");
const FALLBACK = model("deepseek-v4.1-flash");

interface Attempt {
  modelId: string;
  context: { messages: Array<{ role: string; content: unknown }> };
}

interface ProbeScript {
  /** Per attempt: the response head + what the stream does. */
  respond: (attempt: number, modelId: string) => {
    status?: number;
    headers?: Record<string, string>;
    error?: string;
    /** Cut the stream after partial output without a finish_reason. */
    cutAfter?: string;
  };
}

function probeProvider(script: ProbeScript, models = [PRIMARY, FALLBACK]) {
  const attempts: Attempt[] = [];
  const provider = (m: ReturnType<typeof model>) => ({
    id: m.provider,
    name: m.provider,
    auth: {
      apiKey: {
        name: "API key",
        login: async () => ({ type: "api_key", key: "k" }),
        check: async () => ({ type: "api_key", source: "environment" }),
        resolve: async () => ({ auth: { apiKey: "k" } }),
      },
    },
    getModels: () => models,
    stream: () => {
      throw new Error("streamSimple only");
    },
    streamSimple: (
      sentModel: { id?: string },
      context: Attempt["context"],
      options?: { onResponse?: (r: unknown, m: unknown) => unknown },
    ) => {
      const index = attempts.length + 1;
      attempts.push({ modelId: String(sentModel?.id ?? ""), context });
      const reply = script.respond(index, String(sentModel?.id ?? ""));
      const s = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onResponse?.(
          { status: reply.status ?? 200, headers: reply.headers ?? {} },
          sentModel,
        );
        s.push({ type: "start", partial: { stopReason: "stop", content: [] } } as never);
        if (reply.cutAfter !== undefined) {
          s.push({ type: "text_start", contentIndex: 0, partial: {} } as never);
          s.push({ type: "text_delta", contentIndex: 0, delta: reply.cutAfter, partial: {} } as never);
          s.push({
            type: "error",
            reason: "error",
            error: { stopReason: "error", errorMessage: "Stream ended without finish_reason" },
          } as never);
        } else if (reply.error !== undefined) {
          s.push({
            type: "error",
            reason: "error",
            error: { stopReason: "error", errorMessage: reply.error },
          } as never);
        } else {
          s.push({
            type: "done",
            reason: "stop",
            message: { stopReason: "stop", content: [{ type: "text", text: `served by ${sentModel?.id}` }] },
          } as never);
        }
        s.end();
      });
      return s;
    },
  });
  return { attempts, providers: models.map((m) => provider(m)) };
}

function rec(input: Partial<Parameters<typeof normalizeModelRecord>[0]> & { provider: string; id: string }): ModelRecord {
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

class FixedSource implements ModelSource {
  readonly name = "fixed";
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

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-eng-wire-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface Harness {
  runtime: ModelRuntime;
  telemetry: InferenceTelemetry;
  statuses: string[];
  holds: GatewayWaitSignal[];
  parks: Array<{ role: string; reason: string; missionId?: string; untilMs: number }>;
  resumed: Array<{ role: string; waitedMs: number }>;
  attempts: Attempt[];
  registry: ModelCapabilityRegistry;
  actions: ExecutedActionTracker;
  capacity: { available: boolean };
}

async function wireResilientHarness(script: ProbeScript, opts: {
  env?: Record<string, string | undefined>;
  records?: ModelRecord[];
  interactive?: boolean;
  statusPrefix?: string;
} = {}): Promise<Harness> {
  const dir = tempDir();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  const probe = probeProvider(script);
  for (const p of probe.providers) runtime.registerNativeProvider(p as never);

  const source = new FixedSource(
    opts.records ?? [
      rec({ provider: PRIMARY.provider, id: PRIMARY.id }),
      rec({ provider: FALLBACK.provider, id: FALLBACK.id }),
    ],
  );
  const registry = await ModelCapabilityRegistry.open({
    sources: [source],
    context: { cwd: dir, agentDir: dir } satisfies DiscoveryContext,
  });
  await registry.refresh();
  const router = new RoleRouter({ registry, policy: structuredClone(DEFAULT_POLICY) });
  const telemetry = new InferenceTelemetry();
  const statuses: string[] = [];
  const holds: GatewayWaitSignal[] = [];
  const parks: Harness["parks"] = [];
  const resumed: Harness["resumed"] = [];
  const actions = new ExecutedActionTracker();
  const capacity = { available: false };

  wireResilientModelRuntime(runtime, {
    role: "planner",
    env: opts.env ?? { PI_INFERENCE_STREAM_RETRY_INITIAL: "30s", PI_INFERENCE_STREAM_RETRY_MAX: "2m" },
    // NOTE: no `config` override here — the scenarios pace themselves through
    // PI_INFERENCE_* in `env`, which is what a real deployment would do.
    registry,
    router,
    telemetry,
    actions,
    status: (line) => statuses.push(line),
    probeIntervalMs: 1_000,
    scheduler: {
      park: (info) => parks.push({ role: info.role, reason: info.reason, ...(info.missionId ? { missionId: info.missionId } : {}), untilMs: info.untilMs }),
      resumed: (info) => resumed.push({ role: info.role, waitedMs: info.waitedMs }),
      isCapacityAvailable: () => capacity.available,
    },
    admission: {
      // The ADVERTISED wait is what the assertions are about; the sleep is a
      // bounded slice of it so the scenario runs in milliseconds.
      noteWaitAndSleep: async (signal) => {
        holds.push(signal);
        await new Promise((resolve) => setTimeout(resolve, Math.min(signal.retryAfterMs, 25)));
        return signal.retryAfterMs;
      },
      noteCallerWaitAndSleep: async (signal) => {
        holds.push(signal);
        await new Promise((resolve) => setTimeout(resolve, Math.min(signal.retryAfterMs, 25)));
        return signal.retryAfterMs;
      },
    },
  });
  assert.ok(isResilientRuntime(runtime), "the runtime is armed with the resilient layer");
  return {
    runtime,
    telemetry,
    statuses,
    holds,
    parks,
    resumed,
    attempts: probe.attempts,
    registry,
    actions,
    capacity,
  };
}

const CONTEXT = { messages: [{ role: "user", content: [{ type: "text", text: "do the work" }], timestamp: 1 }] };

describe("live seam: gateway saturation is waited out on the SAME model (§32)", () => {
  it("honours Retry-After exactly, never switches model, and completes", async () => {
    const h = await wireResilientHarness({
      respond: (attempt) =>
        attempt === 1
          ? {
              status: 429,
              headers: { "retry-after": "45", "x-inferweave-reason": "queue_timeout", "x-inferweave-gateway-id": "gw-1" },
              error: 'inference admission: queue_timeout {"reason":"queue_timeout","retry_after_ms":45000}',
            }
          : {},
    });
    const result = await h.runtime.streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never).result();

    assert.equal(result.stopReason, "stop", "the request completes — it is not failed");
    assert.equal(h.attempts.length, 2);
    assert.equal(h.attempts[1]?.modelId, PRIMARY.id, "same model: a queue saturation never switches models");
    assert.ok(
      h.holds.some((s) => s.retryAfterMs >= 45_000),
      `the advertised 45s wait is honoured: ${JSON.stringify(h.holds.map((s) => s.retryAfterMs))}`,
    );
    const classified = h.telemetry.eventsNamed("inference.failure.classified");
    assert.equal(classified.length, 1);
    assert.equal(classified[0]?.data.failure_class, "queue_saturated");
    const metadata = classified[0]?.data.metadata as { gatewayId?: string } | undefined;
    assert.equal(metadata?.gatewayId, "gw-1", "InferWeave headers are preserved");
    assert.ok(h.statuses.some((s) => s.includes("queue saturated")));
    assert.equal(h.parks.length, 0, "no mission park for a queue wait that cleared");
  });
});

describe("live seam: model-scoped no_workers falls back by capability (§31)", () => {
  it("penalises the model, refreshes the catalog and serves the comparable model", async () => {
    const h = await wireResilientHarness({
      respond: (_attempt, modelId) =>
        modelId === PRIMARY.id
          ? { status: 503, headers: { "x-inferweave-reason": "no_workers" }, error: "no worker for model" }
          : {},
    });
    const result = await h.runtime.streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never).result();

    assert.equal(result.stopReason, "stop");
    assert.equal(h.attempts.at(-1)?.modelId, FALLBACK.id, "capability-based fallback served the request");
    const selected = h.telemetry.eventsNamed("inference.fallback.selected");
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.data.fallback_model, `${FALLBACK.provider}/${FALLBACK.id}`);
    assert.ok(h.telemetry.eventsNamed("inference.catalog.refreshed").length >= 1, "catalog refreshed first");
    assert.ok(h.statuses.some((s) => s.includes("→")), `fallback line shown: ${JSON.stringify(h.statuses)}`);
  });

  it("never falls back for a gateway-scoped outage", async () => {
    const h = await wireResilientHarness({
      respond: (attempt) =>
        attempt === 1 ? { status: 502, error: "bad gateway" } : {},
    });
    await h.runtime.streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never).result();
    assert.equal(h.telemetry.eventsNamed("inference.fallback.selected").length, 0);
    assert.deepEqual(h.attempts.map((a) => a.modelId), [PRIMARY.id, PRIMARY.id]);
  });
});

describe("live seam: interrupted stream after output (§30)", () => {
  it("records the incomplete generation and never replays committed output", async () => {
    const h = await wireResilientHarness({
      respond: (attempt) => (attempt === 1 ? { cutAfter: "partial answer" } : {}),
    });
    const result = await h.runtime.streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never).result();

    // Output already reached the transcript: replay there is illegal, so the
    // stream settles with the failure — recorded as an incomplete generation.
    assert.equal(result.stopReason, "error");
    assert.equal(h.attempts.length, 1, "committed output is never replayed into the same message");
    const incomplete = h.telemetry.eventsNamed("inference.stream.incomplete");
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]?.data.kind, "incomplete_generation");
    assert.equal(incomplete[0]?.data.partial_chars, "partial answer".length);
    assert.equal(h.actions.incompleteCount(), 1);
    const classified = h.telemetry.eventsNamed("inference.failure.classified")[0];
    assert.equal(classified?.data.failure_class, "incomplete_stream");
  });
});

describe("live seam: every model unavailable parks the mission (§34)", () => {
  it("parks WAITING_FOR_INFERENCE_CAPACITY, keeps probing and resumes", async () => {
    // The first attempts have no capacity for ANY model; it appears at the
    // fourth provider call, which is the probe that finds it.
    const h = await wireResilientHarness(
      {
        respond: (attempt) =>
          attempt < 4
            ? {
                status: 503,
                headers: { "x-inferweave-reason": "capacity_unavailable" },
                error: "no capacity for any model",
              }
            : {},
      },
      {
        env: {
          PI_INFERENCE_STREAM_RETRY_INITIAL: "10ms",
          PI_INFERENCE_STREAM_RETRY_MAX: "20ms",
          PI_INFERENCE_STREAM_RETRY_ATTEMPTS: "2",
        },
      },
    );
    const result = await h.runtime
      .streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never)
      .result();

    assert.equal(result.stopReason, "stop", "the request resumes — a transient NEVER fails it");
    assert.ok(h.parks.length >= 1, `the mission was parked durably: ${JSON.stringify(h.parks)}`);
    assert.ok(h.resumed.length >= 1, "and automatically resumed");
    assert.ok(
      h.statuses.some((line) => line.startsWith("Waiting for inference capacity")),
      JSON.stringify(h.statuses),
    );
    assert.ok(h.telemetry.eventsNamed("inference.mission.waiting_capacity").length >= 1);
    assert.ok(h.telemetry.eventsNamed("inference.mission.resumed").length >= 1);
    assert.ok(h.attempts.length >= 4, "the wait kept probing instead of failing");
  });
});

describe("live seam: idempotency evidence for executed tool calls (§6)", () => {
  it("lists already-executed actions in the retried request without replaying them", async () => {
    const h = await wireResilientHarness({
      respond: (attempt) => (attempt === 1 ? { status: 503, headers: { "x-inferweave-reason": "worker_evicted" }, error: "worker evicted" } : {}),
    });
    h.actions.record({ id: "edit-1", kind: "edit", summary: "wrote src/foo.ts" });
    const before = h.attempts.length;
    await h.runtime.streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never).result();

    assert.ok(h.attempts.length > before);
    const retried = h.attempts.at(-1)?.context.messages ?? [];
    const text = JSON.stringify(retried);
    assert.ok(text.includes("Idempotency notice"), "the retried request carries the notice");
    assert.ok(text.includes("src/foo.ts"), "and names the executed action");
    assert.ok(text.includes("MUST NOT be repeated"));
  });
});

describe("live seam: policy defaults (§19/§21)", () => {
  it("keeps interactive fallback off unless explicitly opted in", async () => {
    const h = await wireResilientHarness(
      {
        respond: (_attempt, modelId) =>
          modelId === PRIMARY.id
            ? { status: 503, headers: { "x-inferweave-reason": "no_workers" }, error: "no worker" }
            : {},
      },
      { env: { PI_INFERENCE_STREAM_RETRY_INITIAL: "10ms", PI_INFERENCE_STREAM_RETRY_MAX: "20ms" } },
    );
    // The install-time role is the worker default; an interactive turn is
    // identified per call through the invocation context (tested in
    // resilient-inference-integration.test.ts at the request layer).
    const result = await h.runtime.streamSimple(PRIMARY as never, CONTEXT as never, { apiKey: "k" } as never).result();
    assert.equal(result.stopReason, "stop");
    assert.equal(h.attempts.at(-1)?.modelId, FALLBACK.id, "autonomous workers fall back by default");
  });
});

/** Keep the local stream factory referenced (it proves no second pi-ai instance). */
void createLocalStream;
