/**
 * The automatic model fallback is off unless the operator opts in.
 *
 * The unit tests pin the coordinator's own default and the config parser, but
 * neither catches the extension dropping the `enabled` argument or the
 * coordinator's default being flipped. So this loads the real extension,
 * drives model-scoped outage holds through the installed provider wrapper
 * against a real Pi model registry, and then fires `before_agent_start` — the
 * one place a pending fallback is applied.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/index.ts";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { setSharedAdmissionController } from "../../src/gateway/config.ts";
import { FALLBACK_AFTER_HOLDS } from "../../src/gateway/fallbackLifecycle.ts";
import { resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";

const API = "anthropic-messages";

const MODEL = {
  id: "probe-model",
  name: "Probe",
  api: API,
  provider: "probe",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

/** A native provider that refuses with a model-scoped 503 `refusals` times, then answers. */
function probeProvider(refusals: number) {
  let calls = 0;
  return {
    id: "probe",
    name: "Probe",
    auth: {
      apiKey: {
        name: "API key",
        login: async () => ({ type: "api_key", key: "k" }),
        check: async () => ({ type: "api_key", source: "environment" }),
        resolve: async () => ({ auth: { apiKey: "k" } }),
      },
    },
    getModels: () => [MODEL],
    stream: () => {
      throw new Error("the agent loop uses streamSimple");
    },
    streamSimple: () => {
      const refuse = calls++ < refusals;
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (refuse) {
          s.push({
            type: "error",
            reason: "error",
            error: { stopReason: "error", errorMessage: "503 no worker for model" },
          } as never);
        } else {
          s.push({
            type: "done",
            reason: "stop",
            message: { stopReason: "stop", content: [{ type: "text", text: "ok" }] },
          } as never);
        }
      });
      return s;
    },
  };
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/**
 * Run one outage long enough to arm a fallback, then start the next turn.
 * Returns the `[gateway-fallback]` log lines and the `pi.setModel` calls.
 */
async function outageThenNextTurn(envValue: string | undefined): Promise<{ logs: string[]; setModels: unknown[] }> {
  const prevEnv = process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
  if (envValue === undefined) delete process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
  else process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED = envValue;
  const dir = mkdtempSync(join(tmpdir(), "fallback-gate-"));
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[gateway-fallback]")) logs.push(line);
    else originalError(...args);
  };
  try {
    // Re-resolves the shared config from the env just set; waits cost nothing.
    setSharedAdmissionController(
      new AdmissionController({
        maxConcurrency: 4,
        reservedSlots: 1,
        maxWaitMs: Number.POSITIVE_INFINITY,
        jitterMs: 0,
        sleep: async () => {},
      }),
    );
    resetGatewayStreamRetry();

    const handlers = new Map<string, Handler[]>();
    const setModels: unknown[] = [];
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
      setModel: async (m: unknown) => {
        setModels.push(m);
        return false;
      },
      events: { on: () => {}, emit: () => {} },
    });

    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(probeProvider(FALLBACK_AFTER_HOLDS + 1) as never);
    const registry = new ModelRegistry(runtime);

    const ctx = {
      model: MODEL,
      modelRegistry: registry,
      cwd: process.cwd(),
      mode: "print",
      ui: {
        notify: () => {},
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
      },
      getContextUsage: () => ({ tokens: 10 }),
      isIdle: () => true,
    };
    // Only the gateway handlers: pick them by what they do, not by position.
    const pick = (event: string, body: string): Handler => {
      const h = (handlers.get(event) ?? []).find((f) => f.toString().includes(body));
      assert.ok(h, `a ${event} handler calling ${body} is registered`);
      return h;
    };
    await pick("session_start", "installStreamRetry")({ type: "session_start" }, ctx);

    const result = await runtime.streamSimple(MODEL as never, { messages: [] } as never, { apiKey: "k" }).result();
    assert.equal(result.stopReason, "stop", "the outage was waited out");

    await pick("before_agent_start", "applyPendingFallbackWithFreshCtx")({ type: "before_agent_start" }, ctx);
    return { logs, setModels };
  } finally {
    console.error = originalError;
    setSharedAdmissionController(undefined);
    resetGatewayStreamRetry();
    if (prevEnv === undefined) delete process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
    else process.env.PI_GATEWAY_MODEL_FALLBACK_ENABLED = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wiring: by default a model's outage never arms or applies a model switch", async () => {
  for (const value of [undefined, "false", "typo"]) {
    const { logs, setModels } = await outageThenNextTurn(value);
    assert.deepEqual(logs, [], `no fallback was considered (env=${value})`);
    assert.deepEqual(setModels, [], `pi.setModel was never called (env=${value})`);
  }
});

test("wiring: with PI_GATEWAY_MODEL_FALLBACK_ENABLED=true the same outage is considered for a switch", async () => {
  const { logs } = await outageThenNextTurn("true");
  // One served model, so the decision is to stay — but it was reached, which
  // only happens when the extension armed the coordinator.
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(logs[0]!, /\[gateway-fallback\] stay/);
});
