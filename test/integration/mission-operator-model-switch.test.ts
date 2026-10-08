/**
 * A mission follows the operator's model switch (owner report):
 *
 *   "[mission MSN-…] Model response received 0%
 *    Warning: gateway busy — waiting 5s · queue deadline exceeded · glm5.3-flash…
 *    After changing the model, we are still using the old model in the mission
 *    and so can't continue and finish the work"
 *
 * A real PiWorkerExecutor talks over real HTTP to a local gateway that answers
 * the role-pinned model with InferWeave's `queue_deadline_exceeded` refusal
 * (429, CAPACITY_EXHAUSTED, IW-ACT-RETRY-ALTERNATE) and serves the other model.
 * Routing is a real RoleRouter whose policy pins the implementer onto the
 * exhausted model; the mission lives in a real MissionStore on disk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RoleRouterAdapter } from "../../src/capability/adapter.ts";
import type { ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { type ModelRecord, type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";
import {
  type PinTransition,
  adoptOperatorModelPin,
  onOperatorModelSelect,
  resetSessionModelChoice,
} from "../../src/runtime/operatorModelPin.ts";
import { type TelemetryNotice, setTelemetrySink } from "../../src/telemetry/sink.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerActivity } from "../../src/workers/WorkerExecutor.ts";

/** A private scratch directory (never the shared system temp dir itself). */
const SCRATCH = mkdtempSync(join(tmpdir(), "operator-pin-ctx-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const GLM: ModelRef = { provider: "gw", id: "glm5.3-flash-modality-vision-quant-q6_k_xl" };
const DEEPSEEK: ModelRef = { provider: "gw", id: "deepseek_v4-flash-modality-text-quant-mxfp4" };

const WORKER_RESULT = {
  status: "completed",
  summary: "hang fix propagated",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

/** InferWeave adaptive.rs: a per-model queue deadline on a serving model. */
function queueDeadline(res: ServerResponse, model: string, retryAfterMs = 20): void {
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": "0",
    "x-inferweave-error-code": "CAPACITY_EXHAUSTED",
  });
  res.end(
    JSON.stringify({
      error: {
        type: "inferweave_backpressure",
        message: `Timed out waiting for capacity for model ${model} (queue_deadline_exceeded); please retry your request.`,
        code: "queue_deadline_exceeded",
        reason: "queue_deadline_exceeded",
        retryable: true,
        replay_safe: true,
        request_state: "not_started",
        action: "retry_alternate",
        action_code: "IW-ACT-RETRY-ALTERNATE",
        scope: "model",
        retry_after_ms: retryAfterMs,
        model_intent: model,
        x_availability: "CAPACITY_EXHAUSTED",
        x_fallback_candidates: [],
      },
    }),
  );
}

function workerResult(res: ServerResponse, model: string): void {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-switch",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    frame({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_0",
          type: "function",
          function: { name: "worker_result", arguments: JSON.stringify(WORKER_RESULT) },
        },
      ],
    }),
  );
  res.write(frame({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

class InventorySource implements ModelSource {
  readonly name = "test-inventory";
  private readonly records: ModelRecord[];
  constructor(records: ModelRecord[]) {
    this.records = records;
  }
  async discover(): Promise<ModelRecord[]> {
    return this.records;
  }
}

/** engineering.yaml-style role pins: every routed role on GLM. */
async function rolePinnedRouter(): Promise<Pick<RoleRouterAdapter, "route" | "select">> {
  const records = [GLM, DEEPSEEK].map((m) =>
    normalizeModelRecord({ ...m, source: "test", toolCall: true, contextWindow: 262_144 }),
  );
  const registry = await ModelCapabilityRegistry.open({
    sources: [new InventorySource(records)],
    context: { cwd: SCRATCH, agentDir: SCRATCH },
  });
  await registry.refresh();
  const policy = structuredClone(DEFAULT_POLICY);
  policy.routing.roles.implementer = { ...(policy.routing.roles.implementer ?? {}), model: modelKey(GLM) };
  const router = new RoleRouter({ registry, policy });
  return {
    select: (role, query) => router.select({ ...(query ?? {}), role }),
    route: async (role, query) => {
      const selected = (await router.select({ ...(query ?? {}), role })).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
    },
  };
}

interface Harness {
  requests: string[];
  notices: TelemetryNotice[];
  transitions: PinTransition[];
  activity: WorkerActivity[];
  store: MissionStore;
  backend: JsonlEventStore;
  missionId: string;
  sessionId: string;
  runImplementer: () => ReturnType<ReturnType<typeof realBackends>["agent"]["runAgent"]>;
}

async function withMission(
  opts: { onRequest: (model: string, count: number, h: Harness) => "deadline" | "serve"; retryAfterMs?: number },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-operator-switch-"));
  const perModel = new Map<string, number>();
  let harness!: Harness;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const model = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string }).model);
      harness.requests.push(model);
      const count = (perModel.get(model) ?? 0) + 1;
      perModel.set(model, count);
      if (opts.onRequest(model, count, harness) === "deadline") queueDeadline(res, model, opts.retryAfterMs);
      else workerResult(res, model);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        gw: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [GLM, DEEPSEEK].map((m) => ({ id: m.id, contextWindow: 262_144, maxTokens: 4096 })),
        },
      },
    }),
  );
  const notices: TelemetryNotice[] = [];
  const uninstall = setTelemetrySink((notice) => notices.push(notice));
  const backend = await JsonlEventStore.open(join(dir, "events.jsonl"));
  const store = MissionStore.open(backend);
  const sessionId = `S-${Math.random().toString(36).slice(2)}`;
  resetSessionModelChoice(sessionId, GLM);
  const missionId = store.createMission({
    title: "Propagate the committed fabric-agent hang fix",
    goal: "Propagate the committed fabric-agent hang fix",
    user_request: "Propagate the committed fabric-agent hang fix",
    repository: dir,
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering",
    parent_session_id: sessionId,
  }).mission_id;
  const transitions: PinTransition[] = [];
  const currentOperatorPin = (id: string) =>
    adoptOperatorModelPin({ store, missionId: id, sessionId, onTransition: (t) => transitions.push(t) });
  const unavailable = new UnavailableModels();
  const worker = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    // A small interactive hold budget: only the mission's unbounded wait and
    // the operator's switch decide how this ends.
    gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 2, jitterMs: 0 }),
    admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: { readContentByUri: async () => undefined } as never,
    git: null,
    cwd: dir,
    routeModel: createRouteModel({ router: await rolePinnedRouter(), unavailable, operatorPin: currentOperatorPin }),
    currentOperatorPin,
    onModelUnavailable: (model, context) => unavailable.mark(model, context, { confirmed: true }),
    onModelServed: (model) => unavailable.clear(model),
    isModelUnavailable: (model) => unavailable.has(model),
  });
  const activity: WorkerActivity[] = [];
  harness = {
    requests: [],
    notices,
    transitions,
    activity,
    store,
    backend,
    missionId,
    sessionId,
    runImplementer: () =>
      backends.agent.runAgent({
        role: "implementer",
        objective: "Propagate the committed fabric-agent hang fix",
        missionId,
        taskId: "TSK-1",
        signal: new AbortController().signal,
        onActivity: (event) => activity.push(event),
      }),
  };
  try {
    await body(harness);
  } finally {
    uninstall();
    await store.flush();
    backend.close();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a /model switch moves a mission worker waiting on an exhausted role-pinned model at the next boundary", async () => {
  await withMission(
    {
      onRequest: (model, count, h) => {
        if (model !== GLM.id) return "serve";
        // The operator, seeing the wait, switches with /model.
        if (count === 2) onOperatorModelSelect(h.sessionId, { model: DEEPSEEK, source: "set" });
        return "deadline";
      },
    },
    async (h) => {
      const outcome = await h.runImplementer();
      assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
      assert.deepEqual(
        h.requests,
        [GLM.id, GLM.id, DEEPSEEK.id],
        "no further request on the old model after the switch",
      );
      assert.equal(outcome.model?.id, DEEPSEEK.id);
      assert.match(
        outcome.summary ?? "",
        /operator switched models — implementer moves from gw\/glm\S* to gw\/deepseek/,
      );

      // Persisted on the mission, so a restart keeps it.
      await h.store.flush();
      assert.equal(MissionStore.open(h.backend).getMission(h.missionId)?.operator_model_pin?.id, DEEPSEEK.id);
      assert.deepEqual(
        h.transitions.map((t) => [t.from, t.to, t.reason]),
        [[null, modelKey(DEEPSEEK), "operator pin"]],
      );

      // The wait said what was wrong and how to get out of it.
      assert.ok(
        h.notices.some((n) =>
          /model gw\/glm\S* is out of capacity \(queue_deadline_exceeded\); the mission keeps waiting — switch with \/model/.test(
            n.text,
          ),
        ),
        JSON.stringify(h.notices.map((n) => n.text)),
      );
    },
  );
});

test("a mission keeps waiting on an exhausted operator-pinned model instead of giving up", async () => {
  const REFUSALS = 6; // three times the hold budget the alternate-model advice would allow
  await withMission(
    { onRequest: (model, count) => (model === GLM.id && count <= REFUSALS ? "deadline" : "serve") },
    async (h) => {
      // The session started on DeepSeek; the operator explicitly chose GLM.
      resetSessionModelChoice(h.sessionId, DEEPSEEK);
      assert.equal(onOperatorModelSelect(h.sessionId, { model: GLM, source: "set" }).action, "pinned");
      const outcome = await h.runImplementer();
      assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
      assert.equal(h.requests.filter((m) => m === GLM.id).length, REFUSALS + 1);
      assert.ok(
        h.requests.every((m) => m === GLM.id),
        "the operator's choice is not abandoned for capacity",
      );
    },
  );
});

test("a /model switch ends a long capacity hold at once instead of after the gateway's whole wait", async () => {
  // The gateway asks the worker to stay away for 60 s; the operator switches
  // right after the first refusal. The mission must not sit out the minute.
  await withMission(
    {
      retryAfterMs: 60_000,
      onRequest: (model, _count, h) => {
        if (model !== GLM.id) return "serve";
        setTimeout(() => onOperatorModelSelect(h.sessionId, { model: DEEPSEEK, source: "set" }), 50);
        return "deadline";
      },
    },
    async (h) => {
      const started = Date.now();
      const outcome = await h.runImplementer();
      assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
      assert.deepEqual(h.requests, [GLM.id, DEEPSEEK.id]);
      assert.ok(Date.now() - started < 15_000, `the switch landed after ${Date.now() - started} ms`);
    },
  );
});
