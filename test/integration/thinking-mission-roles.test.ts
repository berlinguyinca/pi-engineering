/**
 * Mission roles send thinking OFF on the wire, on every local gateway route.
 *
 * A real local HTTP server receives the request body pi-ai's real
 * openai-completions transport sends through the worker's guarded runtime. The
 * output allowance is 32,768 (well above the low-budget threshold), so only the
 * mission-role policy can switch thinking off.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { streamSimple as openAiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { runWithInferenceInvocation } from "../../src/inference/inferenceContext.ts";
import { acceptsThinkingOff, resolveThinkingOffConfig } from "../../src/request/thinkingPolicy.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

async function gateway(): Promise<{ server: Server; url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        id: "c",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      };
      const last = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

function model(url: string, provider = "beast") {
  return {
    id: "qwen3.8-27b-q4",
    name: "probe",
    api: "openai-completions",
    provider,
    baseUrl: url,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
  };
}

async function send(
  m: ReturnType<typeof model>,
  invocation: { role: string; interactive?: boolean } | undefined,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thinking-mission-"));
  try {
    const executor = new PiWorkerExecutor({ agentDir: dir, thinkingPolicy: resolveThinkingOffConfig({}) });
    const runtime = await executor.getModelRuntime();
    runtime.registerNativeProvider({
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
      getModels: () => [m],
      stream: () => {
        throw new Error("streamSimple only");
      },
      streamSimple: openAiStreamSimple,
    } as never);
    const call = () =>
      runtime
        .streamSimple(
          m as never,
          { systemPrompt: "You are a worker.", messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
          { apiKey: "k" } as never,
        )
        .result();
    await (invocation ? runWithInferenceInvocation(invocation, call) : call());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const role of ["implementer", "reviewer", "debugger", "test-designer"]) {
  test(`mission role ${role}: thinking off on the wire with maxTokens 32768`, async () => {
    const gw = await gateway();
    const notices: string[] = [];
    const restore = setTelemetrySink((n) => notices.push(n.text));
    try {
      await send(model(gw.url), { role });
      assert.equal(gw.bodies.length, 1);
      assert.equal(gw.bodies[0]?.reasoning_effort, "none");
      assert.deepEqual(gw.bodies[0]?.chat_template_kwargs, { enable_thinking: false });
      assert.ok(
        notices.some((t) => t.includes("thinking: off (mission role)")),
        notices.join("|"),
      );
    } finally {
      restore?.();
      gw.server.close();
    }
  });
}

test("planner keeps thinking; interactive requests are unchanged", async () => {
  const gw = await gateway();
  try {
    await send(model(gw.url), { role: "planner" });
    await send(model(gw.url), { role: "implementer", interactive: true });
    assert.equal(gw.bodies.length, 2);
    for (const body of gw.bodies) {
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.chat_template_kwargs, undefined);
    }
  } finally {
    gw.server.close();
  }
});

test("hosts: beast, bender, 127.0.0.1 (any port), localhost, llm.metabolomics.us are covered; env overrides", () => {
  const config = resolveThinkingOffConfig({});
  const at = (provider: string, baseUrl: string) => ({ api: "openai-completions", provider, baseUrl });
  assert.ok(acceptsThinkingOff(at("beast", "http://example.invalid/v1"), config));
  assert.ok(acceptsThinkingOff(at("bender", "http://example.invalid/v1"), config));
  assert.ok(acceptsThinkingOff(at("x", "http://127.0.0.1:18081/v1"), config));
  assert.ok(acceptsThinkingOff(at("x", "http://localhost:8081/v1"), config));
  assert.ok(acceptsThinkingOff(at("x", "https://llm.metabolomics.us/v1"), config));
  assert.ok(acceptsThinkingOff(at("metabolomics", "https://other.invalid/v1"), config));
  assert.equal(acceptsThinkingOff(at("openai", "https://api.openai.com/v1"), config), false);

  const custom = resolveThinkingOffConfig({ PI_THINKING_OFF_HOSTS: "gw.example:8443, other.example" });
  assert.ok(acceptsThinkingOff(at("x", "https://gw.example:8443/v1"), custom));
  assert.ok(acceptsThinkingOff(at("x", "https://other.example/v1"), custom));
  assert.equal(acceptsThinkingOff(at("x", "http://127.0.0.1:18081/v1"), custom), false);
});
