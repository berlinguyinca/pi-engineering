/**
 * Silent stream truncation through the REAL worker executor: a local
 * OpenAI-compatible HTTP server, pi-ai's own openai-completions provider, and
 * PiWorkerExecutor's retry layers.
 *
 * A gateway that closes the SSE stream before any `finish_reason` makes pi-ai
 * report "Stream ended without finish_reason" as an assistant-message error —
 * nothing is thrown. The executor must hand that to the transient layer for a
 * fresh-session retry, unless the session already delivered its terminating
 * result.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

type Reply = (res: ServerResponse) => void;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const body = {
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function sse(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(f);
  res.end("data: [DONE]\n\n");
}

/** A stream that ends with no finish_reason: the gateway's silent cut. */
const truncated: Reply = (res) => sse(res, [chunk({ role: "assistant", content: "" })]);

function toolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>): Reply {
  return (res) =>
    sse(res, [
      chunk({
        role: "assistant",
        tool_calls: calls.map((c, index) => ({
          index,
          id: `call_${index}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }),
      chunk({}, "tool_calls"),
    ]);
}

const WORKER_RESULT = {
  status: "completed",
  summary: "done after a fresh session",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

const REVIEW_RESULT = {
  verdict: "approve",
  summary: "no blocking defect",
  findings: [],
  missing_tests: [],
  spec_gaps: [],
};

async function withProbe(replies: Reply[], body: (executor: PiWorkerExecutor, cwd: string) => Promise<void>) {
  const requests: number[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      requests.push(requests.length);
      const reply = replies[requests.length - 1];
      if (reply) reply(res);
      else res.writeHead(500).end("unexpected extra request");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-truncation-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "probe-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  writeFileSync(join(dir, "note.txt"), "hello\n");
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return requests.length;
}

test("worker: a stream cut before any finish_reason is retried in a fresh session", async () => {
  const requests = await withProbe(
    [truncated, toolCalls([{ name: "worker_result", args: WORKER_RESULT }])],
    async (executor, cwd) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.result.summary, WORKER_RESULT.summary);
      assert.equal(executor.transientTelemetry.exhausted, 0);
    },
  );
  assert.equal(requests, 2, "one truncated attempt, one fresh retry");
});

test("reviewer: a cut AFTER review_result was delivered does not re-run the review", async () => {
  // review_result arrives alongside a non-terminating tool, so the loop takes
  // one more turn — and that turn is cut. The verdict was already delivered, so
  // a fresh-session retry would throw it away and pay for the review twice.
  const requests = await withProbe(
    [
      toolCalls([
        { name: "review_result", args: REVIEW_RESULT },
        { name: "read", args: { path: "note.txt" } },
      ]),
      truncated,
    ],
    async (executor, cwd) => {
      await executor.run({
        role: "reviewer",
        task: "review",
        tools: ["read"],
        cwd,
        resultTool: "review_result",
        modelOverride: { provider: "probe", id: "probe-model" },
      });
    },
  );
  assert.equal(requests, 2, "the delivered verdict must not be thrown away and re-run in a fresh session");
});

test("worker: a cut AFTER a tool ran is not replayed — the task already has side effects", async () => {
  // Replaying from a fresh session would re-run every tool (bash included)
  // under a brand-new wall-clock budget. Fail with a distinct, non-transient
  // marker instead so the cause is visible and no infra retry kicks in.
  const requests = await withProbe(
    [toolCalls([{ name: "read", args: { path: "note.txt" } }]), truncated],
    async (executor, cwd) => {
      const run = await executor.run({
        role: "implementer",
        task: "t",
        tools: ["read"],
        cwd,
        modelOverride: { provider: "probe", id: "probe-model" },
      });
      assert.equal(run.result.status, "failed");
      assert.equal(run.error, "truncated_after_progress");
      assert.match(run.result.summary, /Stream ended without finish_reason/);
    },
  );
  assert.equal(requests, 2, "no fresh-session replay after a tool ran");
});
