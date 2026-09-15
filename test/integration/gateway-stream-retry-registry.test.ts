/**
 * The wrapper against a REAL Pi model registry.
 *
 * The unit tests drive fakes, and fakes accept whatever config they are handed.
 * The live path does not: `registerProvider` runs `validateExtensionProvider`
 * and then `composeModelProvider`, which eagerly builds the model list and
 * composes auth, throwing `no authentication method configured` or a model
 * validation error for a config that looked perfectly reasonable. A throw there
 * is swallowed as `"failed"` and leaves the operator exactly where they
 * started — a saturated gateway killing the turn after three attempts — with
 * every unit test still green.
 *
 * So this exercises `ModelRuntime.streamSimple`, the entry point Pi's own agent
 * loop calls (pi-coding-agent core/sdk.js:194), and asserts the 503 is waited
 * out rather than surfaced.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";

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

/** A native provider whose transport we script, standing in for the gateway. */
function probeProvider(script: Array<{ error?: string }>) {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
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
        throw new Error("the agent loop uses streamSimple; stream must not be reached");
      },
      streamSimple: () => {
        const step = script[Math.min(calls, script.length - 1)];
        calls++;
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (step?.error) {
            s.push({
              type: "error",
              reason: "error",
              error: { stopReason: "error", errorMessage: step.error },
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
    },
  };
}

async function withRegistry(
  script: Array<{ error?: string }>,
  run: (args: {
    registry: ModelRegistry;
    runtime: ModelRuntime;
    calls: () => number;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-registry-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const probe = probeProvider(script);
    runtime.registerNativeProvider(probe.provider as never);
    resetGatewayStreamRetry();
    await run({ registry: new ModelRegistry(runtime), runtime, calls: probe.calls });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function install(registry: ModelRegistry, holds: number[]) {
  return installGatewayStreamRetry(
    registry as never,
    { provider: "probe", api: API },
    {
      createStream: () => createAssistantMessageEventStream() as never,
      hold: async (waitSignal) => {
        holds.push(waitSignal.retryAfterMs);
      },
      errorMessage: (_m, error) => ({
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
      signalOf: (options) => (options as { signal?: AbortSignal } | undefined)?.signal,
    },
  );
}

test("registry: composing a provider with our streamSimple actually succeeds", async () => {
  await withRegistry([{}], async ({ registry }) => {
    const holds: number[] = [];
    // `validateExtensionProvider` + `composeModelProvider` run here. A config
    // they reject would silently degrade to Pi's 3-attempt behaviour.
    assert.equal(install(registry, holds), "installed");
    assert.ok(
      registry.getAll().some((m) => m.id === MODEL.id),
      "registering a streamSimple must not drop the provider's models",
    );
  });
});

test("registry: a 503 through ModelRuntime.streamSimple is waited out, not surfaced", async () => {
  await withRegistry([{ error: "503 no worker for model" }, {}], async ({ registry, runtime, calls }) => {
    const holds: number[] = [];
    assert.equal(install(registry, holds), "installed");

    // The exact call Pi's agent loop makes.
    const result = await runtime.streamSimple(MODEL as never, { messages: [] } as never, { apiKey: "k" }).result();

    assert.equal(calls(), 2, "the real transport was reached twice — the 503 was retried, and nothing recursed");
    assert.deepEqual(holds, [5_000], "one wait honoured");
    assert.equal(result.stopReason, "stop", "the turn survives instead of dying after three attempts");
    assert.equal(result.errorMessage, undefined);
  });
});

test("registry: saturation far past Pi's three-attempt budget still recovers", async () => {
  const script = [...Array.from({ length: 12 }, () => ({ error: "503 no worker for model" })), {}];
  await withRegistry(script, async ({ registry, runtime, calls }) => {
    const holds: number[] = [];
    install(registry, holds);
    const result = await runtime.streamSimple(MODEL as never, { messages: [] } as never, { apiKey: "k" }).result();

    assert.equal(calls(), 13);
    assert.equal(holds.length, 12, "Pi would have given up at 3");
    assert.equal(result.stopReason, "stop");
  });
});

test("registry: a non-gateway failure is still reported immediately", async () => {
  await withRegistry([{ error: "401 invalid api key" }, {}], async ({ registry, runtime, calls }) => {
    const holds: number[] = [];
    install(registry, holds);
    const result = await runtime.streamSimple(MODEL as never, { messages: [] } as never, { apiKey: "k" }).result();

    assert.equal(calls(), 1, "waiting cannot fix a bad key");
    assert.equal(holds.length, 0);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /invalid api key/);
  });
});

test("registry: wrapping a BUILT-IN provider keeps its whole catalogue", async () => {
  // The common case, and a different code path from the native one above: a
  // built-in survives `registerProvider`'s two-argument form, so it is wrapped
  // through the extension-config branch. `registerProvider` REPLACES a
  // provider's extension config, which is why the installer carries any
  // existing one forward.
  const dir = mkdtempSync(join(tmpdir(), "gateway-builtin-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const before = registry.getAll().filter((m) => m.provider === "anthropic");
    assert.ok(before.length > 0, "fixture requires the built-in anthropic catalogue");
    assert.equal(
      registry.getRegisteredNativeProvider("anthropic"),
      undefined,
      "a built-in is not a native extension provider — that distinction picks the install path",
    );

    resetGatewayStreamRetry();
    const outcome = installGatewayStreamRetry(
      registry as never,
      { provider: "anthropic", api: before[0]?.api ?? "anthropic-messages" },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async () => {},
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
      },
    );

    assert.equal(outcome, "installed");
    assert.equal(
      registry.getAll().filter((m) => m.provider === "anthropic").length,
      before.length,
      "every model must survive the wrap",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
