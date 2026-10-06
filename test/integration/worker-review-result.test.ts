/**
 * A reviewer that delivers its verdict through `review_result` has completed.
 *
 * Found while reproducing the owner's model-switch report end to end: the REAL
 * PiWorkerExecutor captured a reviewer's `review_result` as structured output
 * but only counted a run as successful when a `worker_result` arrived — a tool
 * reviewers are never given. Every real review therefore settled as "Worker
 * returned no worker_result" and the mission blocked at the review gate.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const REVIEW = {
  verdict: "approve",
  summary: "the change is correct",
  findings: [],
  missing_tests: [],
  spec_gaps: [],
  acceptance_results: [{ acceptance_id: "AC-1", status: "passed", detail: "checked" }],
};

test("a reviewer run that calls review_result completes with its structured verdict", async () => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-review",
          object: "chat.completion.chunk",
          created: 0,
          model: "review-model",
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
              function: { name: "review_result", arguments: JSON.stringify(REVIEW) },
            },
          ],
        }),
      );
      res.write(frame({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "pi-review-result-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        gw: {
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "review-model", contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    }),
  );
  try {
    const executor = new PiWorkerExecutor({
      agentDir: dir,
      aps: false,
      gatewayConfig: resolveGatewayConfig({ enabled: true, maxRetries: 2, jitterMs: 0 }),
      admission: new AdmissionController({ maxConcurrency: 2, jitterMs: 0 }),
      transientSleep: async () => {},
      transientRand: () => 0,
    });
    const run = await executor.run({
      role: "reviewer",
      task: "review\nAcceptance criterion AC-1: add returns the sum",
      tools: [],
      cwd: dir,
      resultTool: "review_result",
      modelOverride: { provider: "gw", id: "review-model" },
    });
    assert.equal(run.result.status, "completed", run.result.summary);
    const structured = run.structured as { verdict?: string; acceptanceResults?: unknown[] } | undefined;
    assert.equal(structured?.verdict, "approve");
    assert.equal(structured?.acceptanceResults?.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
