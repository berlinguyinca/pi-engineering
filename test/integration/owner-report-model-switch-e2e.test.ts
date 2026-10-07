/**
 * The owner's report, end to end through the live extension:
 *
 *   mission MSN-… "Model response received 0%"
 *   Warning: gateway busy — waiting 5s · queue deadline exceeded · glm5.3-flash…
 *   "After changing the model, we are still using the old model in the mission"
 *
 * The extension's own `mission` tool runs a mission on the REAL runtime with a
 * REAL PiWorkerExecutor. Inference goes over HTTP to a local gateway that keeps
 * answering the engineering.yaml-pinned implementer model with 429
 * queue_timeout ("queue deadline exceeded"). The operator switches model
 * (Pi `model_select`); the mission's next dispatch goes to the new model, which
 * fixes the code, the reviewer approves, and the mission completes.
 *
 * Everything lives in temp dirs: a temp Pi agent dir (models.json,
 * engineering.yaml), a temp git repository, temp runtime state.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);
const GLM = "glm5.3-flash-modality-vision-quant-q6_k_xl";
const DEEPSEEK = "deepseek_v4-flash-modality-text-quant-mxfp4";
const QWEN = "qwen3.8-27b";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
}

function sse(res: ServerResponse, model: string, toolName: string, args: unknown): void {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
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
          id: `call_${Math.random().toString(36).slice(2)}`,
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(args) },
        },
      ],
    }),
  );
  res.write(frame({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? "").join("\n")
      : "";

test("owner report: a /model switch moves the out-of-capacity mission and it completes", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-e2e-"));
  const fixture = await makeFixtureRepo();
  const requests: string[] = [];
  let onSecondGlm: (() => void) | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ChatBody;
      requests.push(body.model);
      if (body.model === GLM) {
        if (requests.filter((m) => m === GLM).length === 2) onSecondGlm?.();
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "inference_admission",
              reason: "queue_timeout",
              message: "queue deadline exceeded",
              retry_after_ms: 20,
              scope: "model",
            },
          }),
        );
        return;
      }
      const last = body.messages.at(-1);
      if (body.model === QWEN) {
        const task = body.messages.map((m) => text(m.content)).join("\n");
        sse(res, QWEN, "review_result", {
          verdict: "approve",
          summary: "add now returns the sum; tests pass",
          findings: [],
          missing_tests: [],
          spec_gaps: [],
          acceptance_results: [...task.matchAll(/Acceptance criterion ([^:\s]+):/g)].map((m) => ({
            acceptance_id: m[1],
            status: "passed",
            detail: "verified against the candidate",
          })),
        });
        return;
      }
      // DeepSeek implements: one shell edit, then the structured result.
      if (last?.role !== "tool") {
        sse(res, DEEPSEEK, "bash", {
          command: "printf 'export function add(a, b) {\\n  return a + b;\\n}\\n' > src/add.js",
        });
        return;
      }
      sse(res, DEEPSEEK, "worker_result", {
        status: "completed",
        summary: "add returns the sum",
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const modelEntry = (id: string) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        gw: { baseUrl, api: "openai-completions", apiKey: "k", models: [GLM, DEEPSEEK, QWEN].map(modelEntry) },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "engineering.yaml"),
    `routing:\n  roles:\n    implementer:\n      model: gw/${GLM}\n    reviewer:\n      model: gw/${QWEN}\n`,
  );
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const glmModel = { provider: "gw", id: GLM, api: "openai-completions", contextWindow: 262_144, input: ["text"] };
  const deepseekModel = { ...glmModel, id: DEEPSEEK };
  const ctx = {
    cwd: fixture.root,
    mode: "tui",
    hasUI: false,
    signal: undefined,
    model: glmModel,
    modelRegistry: undefined,
    getContextUsage: () => undefined,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notices.push(message),
      custom: () => ({ close: () => {} }),
      setFooter: () => {},
      onTerminalInput: () => () => {},
    },
  };
  const fire = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) {
      try {
        await handler(event, ctx);
      } catch {
        // Handlers unrelated to this scenario may need a fuller Pi context.
      }
    }
  };
  try {
    const extension = (await import("../../extensions/index.ts")).default;
    (extension as unknown as (api: unknown) => void)({
      on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: () => {},
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerEntryRenderer: () => {},
      registerProvider: () => {},
      setModel: async () => true,
      events: { on: () => {}, emit: () => {} },
    });
    await fire("session_start", { type: "session_start", reason: "startup" });
    // The operator, watching "queue deadline exceeded", switches with /model.
    onSecondGlm = () => {
      void fire("model_select", { type: "model_select", model: deepseekModel, previousModel: glmModel, source: "set" });
    };

    const result = await tools
      .get("mission")!
      .execute(
        "call-1",
        { request: "Fix add so it returns the sum of its arguments", mutate: true },
        undefined,
        undefined,
        ctx,
      );
    const report = result.content.map((part) => part.text).join("\n");

    assert.ok(requests.includes(GLM), "the mission first waited on the role-pinned, out-of-capacity model");
    const firstDeepseek = requests.indexOf(DEEPSEEK);
    assert.ok(firstDeepseek > 0, `the next dispatch went to the new model: ${requests.join(", ")}`);
    assert.ok(
      requests.slice(firstDeepseek).every((model) => model !== GLM),
      `no request on the old model after the switch: ${requests.join(", ")}`,
    );
    assert.ok(
      notices.some((n) => /operator pin/.test(n)),
      notices.join("\n"),
    );
    assert.match(report, /Completed: all gates passed/, report);
    assert.equal(result.details.status, "COMPLETE");
    assert.match(await readFile(join(fixture.root, "src", "add.js"), "utf8"), /return a \+ b/);
    await exec("node", ["--test"], { cwd: fixture.root });
  } finally {
    await fire("session_shutdown", { type: "session_shutdown" });
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    server.closeAllConnections();
    server.close();
    await fixture.cleanup();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
