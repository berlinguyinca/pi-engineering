/**
 * Mission implementers through the REAL PiWorkerExecutor and a local
 * OpenAI-compatible HTTP server: the model is offered Pi's file tools (with a
 * line-numbered `read` and a whitespace-tolerant `edit`), is NOT offered
 * `checkpoint_progress`, and the prompt no longer mentions it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { IMPLEMENTER_TOOLS } from "../../src/orchestration/realBackends.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

type Call = { name: string; args: Record<string, unknown> };

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCalls(res: ServerResponse, calls: Call[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    chunk({
      role: "assistant",
      tool_calls: calls.map((c, index) => ({
        index,
        id: `call_${index}_${c.name}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }),
  );
  res.write(chunk({}, "tool_calls"));
  res.end("data: [DONE]\n\n");
}

const WORKER_RESULT = {
  status: "completed",
  summary: "edited",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
};

test("mission implementer: numbered read, tolerant edit, no checkpoint_progress", async () => {
  const bodies: string[] = [];
  const script: Call[][] = [
    [{ name: "read", args: { path: "mod.ts" } }],
    [
      {
        name: "edit",
        args: {
          path: "mod.ts",
          edits: [
            { oldText: "  if (ready) {\n    go();\n  }", newText: "  if (ready) {\n    go();\n    done();\n  }" },
          ],
        },
      },
    ],
    [{ name: "worker_result", args: WORKER_RESULT }],
  ];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      const next = script[bodies.length - 1];
      if (next) toolCalls(res, next);
      else res.writeHead(500).end("unexpected extra request");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-mission-tools-"));
  try {
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
    writeFileSync(join(dir, "mod.ts"), "function f() {\n    if (ready) {   \n        go();\n    }\n}\n");
    const executor = new PiWorkerExecutor({
      agentDir: dir,
      aps: false,
      gatewayConfig: resolveGatewayConfig({ enabled: false }),
      transientSleep: async () => {},
      transientRand: () => 0,
    });
    const run = await executor.run({
      role: "implementer",
      task: "add done() after go()",
      tools: [...IMPLEMENTER_TOOLS],
      tolerantFileTools: true,
      cwd: dir,
      deliverables: ["add done"],
      isolatedWorktree: true,
      modelOverride: { provider: "probe", id: "probe-model" },
    });
    assert.equal(run.result.status, "completed", run.result.summary);

    // The whitespace-only miss was applied, keeping the file's indentation.
    assert.equal(
      readFileSync(join(dir, "mod.ts"), "utf8"),
      "function f() {\n    if (ready) {\n        go();\n        done();\n    }\n}\n",
    );

    // The read result the model saw carried line numbers.
    assert.match(bodies[1] ?? "", /1\\tfunction f\(\) \{\\n2\\t {4}if \(ready\)/);

    // Offered tools: the file tools and search; never ledger/artifact/checkpoint tools.
    const first = JSON.parse(bodies[0] ?? "{}") as {
      tools?: Array<{ function: { name: string } }>;
      messages: Array<{ content: unknown }>;
    };
    const offered = (first.tools ?? []).map((t) => t.function.name).sort();
    for (const name of ["read", "edit", "write", "bash", "worker_result"]) {
      assert.ok(offered.includes(name), `${name} offered: ${offered.join(",")}`);
    }
    for (const name of ["checkpoint_progress", "ledger_read", "ledger_claim", "artifact_read"]) {
      assert.ok(!offered.includes(name), `${name} must not be offered`);
    }
    assert.ok(!bodies[0]?.includes("checkpoint_progress"), "the prompt must not mention checkpoint_progress");
    assert.match(bodies[0] ?? "", /uncommitted work is harvested automatically/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
