/**
 * Issue #159: gateway saturation fault injection against a REAL local HTTP
 * server, through the real extension: provider stream -> gateway pump ->
 * FallbackCoordinator -> agent_before_settle (AdvisedModelSwitch) ->
 * applyPendingFallback -> ModelHealthProvider reading the server's /models.
 *
 * The primary model answers every chat request with 503, Retry-After and
 * x_fallback_candidates. Every scenario asserts that the server actually saw
 * the fault request, so a test cannot pass because the fault never fired.
 * Wall time per scenario is bounded well under 30 s (retry delays are 200 ms).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/index.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { setSharedAdmissionController } from "../../src/gateway/config.ts";
import { MAX_BLOCKED_WAIT_MS } from "../../src/gateway/fallback.ts";
import { resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";
import { type TelemetryNotice, setTelemetrySink } from "../../src/telemetry/sink.ts";

const PRIMARY = "sat-primary";
const STANDIN = "good-standin";
const WEAK = "weak-standin";
const API = "openai-completions";

// --- the fake gateway ----------------------------------------------------------

interface Seen {
  model: string;
  hasTools: boolean;
  status: number;
}

interface FakeGateway {
  url: string;
  requests: Seen[];
  models: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Catalogue rows in the shape the gateway advertises (x_capabilities, x_tools, ctx_per_request). */
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  ctx_per_request: 262_144,
  x_state: "warm",
  slots: 4,
  x_capabilities: ["coding", "tool_use"],
  x_tools: true,
  ...extra,
});

async function startFakeGateway(models: Array<Record<string, unknown>>, saturated: string): Promise<FakeGateway> {
  const requests: Seen[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && (req.url ?? "").endsWith("/v1/models"))
      return json(200, { object: "list", data: models });
    if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; tools?: unknown[] };
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (body.model === saturated) {
        requests.push({ model: body.model, hasTools, status: 503 });
        return json(
          503,
          {
            error: {
              code: "capacity_unavailable",
              message: "Try another eligible deployment after the declared delay.",
              type: "inferweave_backpressure",
              retryable: true,
              replay_safe: true,
              request_state: "not_started",
              action: "retry_alternate",
              action_code: "IW-ACT-RETRY-ALTERNATE",
              retry_after_ms: 200,
              scope: "model",
              x_availability: "CAPACITY_EXHAUSTED",
              x_fallback_candidates: models.filter((m) => m.id !== saturated),
            },
          },
          { "Retry-After": "1" },
        );
      }
      requests.push({ model: body.model, hasTools, status: 200 });
      return json(200, {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: body.model,
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: `served by ${body.model}` } },
        ],
      });
    }
    return json(404, { error: { message: "not found" } });
  };
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    models,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// --- the real extension, with a provider that talks HTTP to the fake gateway ----

type Handler = (event: unknown, ctx: unknown) => unknown;

function modelOf(id: string, baseUrl: string) {
  return {
    id,
    name: id,
    api: API,
    provider: "metabolomics",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 16_384,
  };
}

function httpProvider(models: ReturnType<typeof modelOf>[], withTools: boolean) {
  return {
    id: "metabolomics",
    name: "Metabolomics",
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
      throw new Error("the agent loop uses streamSimple");
    },
    streamSimple: (model: { id: string; baseUrl: string }) => {
      const s = createAssistantMessageEventStream();
      void (async () => {
        const res = await fetch(`${model.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: "user", content: "hi" }],
            ...(withTools ? { tools: [{ type: "function", function: { name: "bash" } }] } : {}),
          }),
        });
        const text = await res.text();
        if (!res.ok) {
          s.push({
            type: "error",
            reason: "error",
            error: { role: "assistant", content: [], stopReason: "error", errorMessage: `${res.status}: ${text}` },
          } as never);
          return;
        }
        const content = (JSON.parse(text) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message
          .content;
        s.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: content }],
            model: model.id,
          },
        } as never);
      })();
      return s;
    },
  };
}

interface Scenario {
  gateway: FakeGateway;
  notes: string[];
  /** Telemetry the runtime emitted (advised-switch decisions). */
  telemetry: TelemetryNotice[];
  setModels: string[];
  /** One agent request on `modelId` through the real wrapper; resolves with the assistant message. */
  request(modelId: string): Promise<{ stopReason: string; errorMessage?: string; content?: Array<{ text?: string }> }>;
  fire(event: string, body: string, payload: unknown): Promise<unknown>;
  /** The settle boundary of a turn that ended in `failed`. */
  settle(failed: unknown): Promise<{ continue?: boolean } | undefined>;
  beforeAgentStart(): Promise<void>;
}

async function withScenario(
  opts: { models: Array<Record<string, unknown>>; withTools?: boolean },
  run: (s: Scenario) => Promise<void>,
): Promise<void> {
  const prevFallback = process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
  // The default configuration: the hold-count fallback is OFF; the gateway-advised switch is on by default.
  delete process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "gateway-saturation-"));
  const gateway = await startFakeGateway(opts.models, PRIMARY);
  const cleanups: Array<() => void> = [];
  try {
    setSharedAdmissionController(
      new AdmissionController({
        maxConcurrency: 4,
        reservedSlots: 1,
        maxWaitMs: 30_000,
        jitterMs: 0,
        sleep: async () => {},
      }),
    );
    resetGatewayStreamRetry();
    const handlers = new Map<string, Handler[]>();
    const setModels: string[] = [];
    (extension as unknown as (pi: unknown) => void)({
      on: (name: string, handler: Handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand: () => {},
      registerTool: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerEntryRenderer: () => {},
      setModel: async (m: { id: string }) => {
        setModels.push(m.id);
        return true;
      },
      events: { on: () => {}, emit: () => {} },
    });
    const all = opts.models.map((m) => modelOf(String(m.id), gateway.url));
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(httpProvider(all, opts.withTools === true) as never);
    await runtime.refresh();
    const registry = new ModelRegistry(runtime);
    const notes: string[] = [];
    const telemetry: TelemetryNotice[] = [];
    const restoreSink = setTelemetrySink((n) => void telemetry.push(n));
    cleanups.push(restoreSink);
    assert.deepEqual(
      registry
        .getAvailable()
        .map((m) => m.id)
        .sort(),
      opts.models.map((m) => String(m.id)).sort(),
      "every catalogue model is available to the session",
    );
    const ctx = {
      model: all.find((m) => m.id === PRIMARY),
      modelRegistry: registry,
      cwd: process.cwd(),
      mode: "print",
      ui: {
        notify: (message: string) => void notes.push(message),
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
      },
      getContextUsage: () => ({ tokens: 1_000 }),
      isIdle: () => true,
    };
    const pick = (event: string, body: string): Handler => {
      const h = (handlers.get(event) ?? []).find((f) => f.toString().includes(body));
      assert.ok(h, `a ${event} handler calling ${body} is registered`);
      return h;
    };
    await pick("session_start", "installStreamRetry")({ type: "session_start" }, ctx);
    const scenario: Scenario = {
      gateway,
      notes,
      telemetry,
      setModels,
      request: async (modelId) => {
        const model = all.find((m) => m.id === modelId);
        return (await runtime
          .streamSimple(model as never, { messages: [] } as never, { apiKey: "k" })
          .result()) as never;
      },
      fire: (event, body, payload) => Promise.resolve(pick(event, body)(payload, ctx)),
      settle: async (failed) => {
        // Every agent_before_settle handler runs, as in Pi; the advised switch is one of them.
        const event = {
          outcome: "error",
          entries: [],
          context: {
            contextEntries: [
              { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hi" }] },
              { sourceEntry: { id: "a1" }, messages: [failed] },
            ],
          },
        };
        let verdict: { continue?: boolean } | undefined;
        for (const handler of handlers.get("agent_before_settle") ?? []) {
          verdict = ((await handler(event, ctx)) as { continue?: boolean } | undefined) ?? verdict;
        }
        return verdict;
      },
      beforeAgentStart: async () => {
        await pick("before_agent_start", "applyPendingFallbackWithFreshCtx")({ type: "before_agent_start" }, ctx);
      },
    };
    await run(scenario);
  } finally {
    for (const undo of cleanups) undo();
    await gateway.close();
    setSharedAdmissionController(undefined);
    resetGatewayStreamRetry();
    if (prevFallback === undefined) delete process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
    else process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED = prevFallback;
    rmSync(dir, { recursive: true, force: true });
  }
}

const faultFired = (g: FakeGateway) => g.requests.filter((r) => r.model === PRIMARY && r.status === 503);

test("saturated primary: the advised fallback completes on a qualified model other than the saturated one, in under 30 s", async () => {
  const started = Date.now();
  await withScenario({ models: [row(PRIMARY, { slots: 0 }), row(STANDIN)] }, async (s) => {
    await s.beforeAgentStart(); // records that a stand-in exists
    const failed = await s.request(PRIMARY);
    assert.equal(failed.stopReason, "error");
    assert.ok(faultFired(s.gateway).length >= 1, "the server saw the 503 fault request");
    const verdict = await s.settle(failed);
    assert.equal(verdict?.continue, true, "the turn continues");
    assert.deepEqual(s.setModels, [STANDIN], "switched to the qualified model, not the saturated one");
    const served = await s.request(STANDIN);
    assert.equal(served.stopReason, "stop");
    assert.match(served.content?.[0]?.text ?? "", new RegExp(`served by ${STANDIN}`));
    assert.ok(s.gateway.requests.some((r) => r.model === STANDIN && r.status === 200));
  });
  assert.ok(Date.now() - started < 30_000, "bounded wall time");
});

test("saturated primary, only unqualified candidates: BLOCKED with a bounded wait, nothing is switched to", async () => {
  const started = Date.now();
  await withScenario(
    // The only other model advertises no tool support and fewer capabilities than the primary.
    { models: [row(PRIMARY, { slots: 0 }), row(WEAK, { x_tools: false, x_capabilities: ["coding"] })] },
    async (s) => {
      await s.beforeAgentStart();
      const failed = await s.request(PRIMARY);
      assert.ok(faultFired(s.gateway).length >= 1, "the server saw the 503 fault request");
      await s.settle(failed);
      assert.deepEqual(s.setModels, [], "no switch to an unqualified model");
      const blocked = s.notes.find((n) => /no qualified model/.test(n));
      assert.ok(blocked, `an explicit BLOCKED notice reached the operator: ${s.notes.join(" | ")}`);
      const bound = Number(blocked.match(/waiting at most (\d+) ms/)?.[1]);
      assert.ok(Number.isFinite(bound) && bound > 0 && bound <= MAX_BLOCKED_WAIT_MS, `bounded wait, got ${bound}`);
      assert.equal(
        s.gateway.requests.filter((r) => r.model === WEAK).length,
        0,
        "the unqualified model was never sent a request",
      );
      assert.ok(
        s.telemetry.some((t) => t.key === "advised-model-switch:wait"),
        "the bounded wait was taken instead",
      );
      assert.ok(!s.telemetry.some((t) => t.key === "advised-model-switch:continue"));
    },
  );
  assert.ok(Date.now() - started < 30_000, "bounded wall time");
});

test("saturated primary with a started tool call: no model switch and 0 replayed tool requests", async () => {
  await withScenario({ models: [row(PRIMARY, { slots: 0 }), row(STANDIN)], withTools: true }, async (s) => {
    await s.beforeAgentStart();
    // A side-effecting tool call started in this turn and has no recorded outcome.
    await s.fire("tool_execution_start", "noteToolStarted", {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call-1",
    });
    const failed = await s.request(PRIMARY);
    assert.ok(faultFired(s.gateway).length >= 1, "the server saw the 503 fault request");
    await s.settle(failed);
    assert.deepEqual(s.setModels, [], "the session was not moved to another model");
    assert.match(s.notes.join("\n"), /not replay-safe/);
    const toolRequests = s.gateway.requests.filter((r) => r.hasTools);
    assert.equal(toolRequests.length, 1, "only the original tool request exists");
    assert.equal(
      toolRequests.filter((r) => r.model !== PRIMARY).length,
      0,
      "0 tool requests were replayed to another model",
    );
  });
});

test("control: the same saturation with the tool call finished does switch, so the refusal above is the replay guard and nothing else", async () => {
  await withScenario({ models: [row(PRIMARY, { slots: 0 }), row(STANDIN)], withTools: true }, async (s) => {
    await s.beforeAgentStart();
    await s.fire("tool_execution_start", "noteToolStarted", {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call-1",
    });
    await s.fire("tool_execution_end", "noteToolEnded", {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-1",
    });
    const failed = await s.request(PRIMARY);
    assert.ok(faultFired(s.gateway).length >= 1, "the server saw the 503 fault request");
    const verdict = await s.settle(failed);
    assert.equal(verdict?.continue, true);
    assert.deepEqual(s.setModels, [STANDIN]);
  });
});
