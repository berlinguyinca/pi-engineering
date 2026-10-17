import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

/**
 * P4 provenance: a COMPLETED run must name the model that actually served it,
 * so the orchestrator's `ranOn(run)` resolves and `/mission-status` shows the
 * serving model instead of `model: null` (FINDING-cRh1qh). Failure paths already
 * attach `details.model`; the success path did not.
 */

function frame(delta: Record<string, unknown>, finish: string | null): string {
  const chunk = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" };
  return `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const WORKER_RESULT = {
  status: "completed",
  summary: "done",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

const workerResultReply = (res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    frame(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_0",
            type: "function",
            function: { name: "worker_result", arguments: JSON.stringify(WORKER_RESULT) },
          },
        ],
      },
      null,
    ),
  );
  res.write(frame({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
};

async function withExecutor(body: (executor: PiWorkerExecutor, cwd: string) => Promise<void>): Promise<void> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => workerResultReply(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-model-prov-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "m", maxTokens: 4096, contextWindow: 32_768 }],
        },
      },
    }),
  );
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
}

test("a completed run names the in-session default model in details.model", async () => {
  await withExecutor(async (executor, cwd) => {
    // No modelOverride: the executor resolves its construction/available default
    // (probe/m) — the unrouted, in-session case from FINDING-cRh1qh.
    const run = await executor.run({ role: "implementer", task: "t", tools: [], cwd });
    assert.equal(run.result.status, "completed", JSON.stringify(run.result));
    assert.deepEqual(run.result.details?.model, { provider: "probe", id: "m" });
  });
});

test("a completed run names the routed model (modelOverride) in details.model", async () => {
  await withExecutor(async (executor, cwd) => {
    const run = await executor.run({
      role: "implementer",
      task: "t",
      tools: [],
      cwd,
      modelOverride: { provider: "probe", id: "m" },
    });
    assert.equal(run.result.status, "completed", JSON.stringify(run.result));
    // The serving model equals the route, so ranOn and the route agree.
    assert.deepEqual(run.result.details?.model, { provider: "probe", id: "m" });
  });
});
