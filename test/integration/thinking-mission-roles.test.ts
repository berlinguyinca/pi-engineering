/**
 * Mission roles send thinking OFF on the wire, through the real worker entry
 * point (PiWorkerExecutor.run) against a local HTTP server that behaves like
 * the InferWeave node: any top-level request field outside its allowlist is a
 * 400 "unsupported request field". `reasoning_effort` is NOT on the allowlist
 * unless the test grants it (a model with compat.supportsReasoningEffort).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { streamSimple as openAiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { runWithInferenceInvocation } from "../../src/inference/inferenceContext.ts";
import {
  acceptsThinkingOff,
  resolveThinkingOffConfig,
  streamWithThinkingPolicy,
} from "../../src/request/thinkingPolicy.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const ALLOWED = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "store",
  "max_tokens",
  "max_completion_tokens",
  "tools",
  "tool_choice",
  "temperature",
  "chat_template_kwargs",
]);

const WORKER_RESULT = {
  status: "completed",
  summary: "done",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};
const REVIEW_RESULT = {
  verdict: "approve",
  summary: "ok",
  findings: [],
  missing_tests: [],
  spec_gaps: [],
  acceptance_results: [{ acceptance_id: "AC-1", status: "passed", detail: "checked" }],
};

function frame(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

interface Gateway {
  url: string;
  bodies: Array<Record<string, unknown>>;
  rejected: string[];
  close: () => void;
}

async function gateway(allowReasoningEffort = false): Promise<Gateway> {
  const bodies: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      const unknown = Object.keys(body).filter(
        (k) => !ALLOWED.has(k) && !(allowReasoningEffort && k === "reasoning_effort"),
      );
      if (unknown.length > 0) {
        rejected.push(unknown.join(","));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: `unsupported request field: ${unknown[0]}`, code: "invalid_request" } }),
        );
        return;
      }
      const tools =
        (body.tools as Array<{ function: { name: string } }> | undefined)?.map((t) => t.function.name) ?? [];
      const resultTool = tools.includes("review_result") ? "review_result" : "worker_result";
      const args = resultTool === "review_result" ? REVIEW_RESULT : WORKER_RESULT;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (tools.includes(resultTool)) {
        res.write(
          frame(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_0",
                  type: "function",
                  function: { name: resultTool, arguments: JSON.stringify(args) },
                },
              ],
            },
            null,
          ),
        );
        res.write(frame({}, "tool_calls"));
      } else {
        res.write(frame({ role: "assistant", content: "ok" }, null));
        res.write(frame({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    rejected,
    close: () => server.close(),
  };
}

async function withExecutor(
  gw: Gateway,
  compat: Record<string, unknown> | undefined,
  body: (executor: PiWorkerExecutor, cwd: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thinking-mission-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        beast: {
          baseUrl: gw.url,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "probe-model", contextWindow: 262_144, maxTokens: 32_768, ...(compat ? { compat } : {}) }],
        },
      },
    }),
  );
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    thinkingPolicy: resolveThinkingOffConfig({}),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MODEL = { provider: "beast", id: "probe-model" };

for (const role of ["implementer", "reviewer", "fixer", "debugger"]) {
  test(`${role}: PiWorkerExecutor.run sends chat_template_kwargs only, accepted by a strict node`, async () => {
    const gw = await gateway();
    const notices: string[] = [];
    const restore = setTelemetrySink((n) => notices.push(n.text));
    try {
      await withExecutor(gw, undefined, async (executor, cwd) => {
        const run = await executor.run({
          role: role as never,
          task: "t\nAcceptance criterion AC-1: it works",
          tools: [],
          cwd,
          ...(role === "reviewer" ? { resultTool: "review_result" as const } : {}),
          modelOverride: MODEL,
        });
        assert.notEqual(run.result.status, "failed", run.result.summary);
      });
      assert.ok(gw.bodies.length >= 1);
      assert.deepEqual(gw.rejected, [], "the strict node saw no unsupported field");
      for (const body of gw.bodies) {
        assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
        assert.equal(body.reasoning_effort, undefined);
        assert.equal(body.max_completion_tokens ?? body.max_tokens, 32_768);
      }
      assert.ok(notices.some((t) => t.includes("thinking: off (mission role)")));
    } finally {
      restore();
      gw.close();
    }
  });
}

test("a model with compat.supportsReasoningEffort also gets reasoning_effort none", async () => {
  const gw = await gateway(true);
  try {
    await withExecutor(gw, { supportsReasoningEffort: true }, async (executor, cwd) => {
      await executor.run({ role: "implementer", task: "t", tools: [], cwd, modelOverride: MODEL });
    });
    assert.deepEqual(gw.rejected, []);
    assert.equal(gw.bodies[0]?.reasoning_effort, "none");
    assert.deepEqual(gw.bodies[0]?.chat_template_kwargs, { enable_thinking: false });
  } finally {
    gw.close();
  }
});

test("a compaction summary call made under a worker invocation is thinking-off too", async () => {
  const gw = await gateway();
  try {
    await withExecutor(gw, undefined, async (executor) => {
      const runtime = await executor.getModelRuntime();
      const model = runtime.getModel("beast", "probe-model");
      assert.ok(model, "model registered");
      const streamFn = (m: unknown, c: unknown, o: unknown) => runtime.streamSimple(m as never, c as never, o as never);
      await runWithInferenceInvocation({ role: "implementer" }, () =>
        generateSummary(
          [{ role: "user", content: [{ type: "text", text: "summarize" }], timestamp: 1 }] as never,
          model as never,
          16_384,
          "k",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          streamFn as never,
        ),
      ).catch(() => undefined);
    });
    assert.ok(gw.bodies.length >= 1);
    assert.deepEqual(gw.rejected, []);
    assert.deepEqual(gw.bodies[0]?.chat_template_kwargs, { enable_thinking: false });
  } finally {
    gw.close();
  }
});

test("planner via PiWorkerExecutor.run keeps thinking", async () => {
  const gw = await gateway();
  try {
    await withExecutor(gw, undefined, async (executor, cwd) => {
      await executor.run({ role: "planner", task: "t", tools: [], cwd, modelOverride: MODEL });
    });
    assert.ok(gw.bodies.length >= 1);
    for (const body of gw.bodies) {
      assert.equal(body.chat_template_kwargs, undefined);
      assert.equal(body.reasoning_effort, undefined);
    }
  } finally {
    gw.close();
  }
});

test("interactive: no invocation context at all, thinking is not forced off", async () => {
  const gw = await gateway();
  try {
    const stream = streamWithThinkingPolicy(openAiStreamSimple as never, resolveThinkingOffConfig({}));
    const model = {
      id: "probe-model",
      name: "probe",
      api: "openai-completions",
      provider: "beast",
      baseUrl: gw.url,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 32_768,
    };
    await (stream as never as (m: unknown, c: unknown, o: unknown) => { result: () => Promise<unknown> })(
      model,
      { systemPrompt: "You are Pi.", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "k" },
    ).result();
    assert.equal(gw.bodies.length, 1);
    assert.equal(gw.bodies[0]?.chat_template_kwargs, undefined);
    assert.equal(gw.bodies[0]?.reasoning_effort, undefined);
  } finally {
    gw.close();
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
