/**
 * Degeneration guard through the REAL worker executor and pi-ai's own
 * openai-completions provider against a local HTTP server.
 *
 * First trip: a short corrective user turn is injected into the SAME session
 * (the request carries the original kickoff, the aborted turn and the steer).
 * Second trip: the run restarts in a fresh session. Reviewer sessions do not
 * receive the Tool Transition Rule.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { GUARD_STEER_PROMPT, TOOL_TRANSITION_RULE } from "../../src/guard/RecoveryController.ts";
import { DEFAULT_GUARD_CONFIG } from "../../src/guard/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

type Reply = (res: ServerResponse) => void;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function sse(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(f);
  res.end("data: [DONE]\n\n");
}

/** Varied prose well above a 50-token narration budget, with no tool call. */
const narrate: Reply = (res) =>
  sse(res, [
    chunk({ role: "assistant", content: "" }),
    ...Array.from({ length: 12 }, (_, i) =>
      chunk({
        content: `Consideration number ${i} concerns module ${i * 7} and its unrelated neighbours in the tree. `,
      }),
    ),
    chunk({}, "stop"),
  ]);

const finish: Reply = (res) =>
  sse(res, [
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_0",
          type: "function",
          function: {
            name: "worker_result",
            arguments: JSON.stringify({
              status: "completed",
              summary: "done",
              claims: [],
              evidence_refs: [],
              new_hypotheses: [],
              proposed_tasks: [],
            }),
          },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);

type Body = { messages: Array<{ role: string; content: unknown }> };

async function withProbe(
  replies: Reply[],
  body: (executor: PiWorkerExecutor, cwd: string) => Promise<void>,
): Promise<Body[]> {
  const bodies: Body[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Body);
      const reply = replies[bodies.length - 1];
      if (reply) reply(res);
      else res.writeHead(500).end("unexpected extra request");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-steer-"));
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
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    guardConfig: { ...DEFAULT_GUARD_CONFIG, maxNarrationTokensBeforeAction: 50, repeatedSentenceThreshold: 100 },
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return bodies;
}

const text = (message: { content: unknown }): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const userTurns = (b: Body | undefined): string[] => (b?.messages ?? []).filter((m) => m.role === "user").map(text);

const request = (cwd: string) => ({
  role: "implementer" as const,
  task: "t",
  tools: [],
  cwd,
  modelOverride: { provider: "probe", id: "probe-model" },
});

test("guard: the first trip steers in the same session instead of restarting", async () => {
  const bodies = await withProbe([narrate, finish], async (executor, cwd) => {
    const run = await executor.run(request(cwd));
    assert.equal(run.result.status, "completed", run.result.summary);
  });
  assert.equal(bodies.length, 2);
  const [first = [], second = []] = bodies.map(userTurns);
  assert.equal(first.length, 1);
  assert.equal(second.length, 2, "same session: the kickoff is still in history, plus one corrective turn");
  assert.equal(second[0], first[0]);
  assert.ok(second[1]);
  assert.match(second[1] ?? "", new RegExp(GUARD_STEER_PROMPT.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("guard: the second trip restarts in a fresh session", async () => {
  const bodies = await withProbe([narrate, narrate, finish], async (executor, cwd) => {
    const run = await executor.run(request(cwd));
    assert.equal(run.result.status, "completed", run.result.summary);
  });
  assert.equal(bodies.length, 3);
  assert.equal(userTurns(bodies[1]).length, 2, "first trip steered in-session");
  assert.equal(userTurns(bodies[2]).length, 1, "second trip started a fresh session with no steer turn");
  assert.ok(!userTurns(bodies[2]).some((t) => t.includes(GUARD_STEER_PROMPT.slice(0, 30))));
});

test("reviewer prompt does not carry the Tool Transition Rule; implementer prompt does", async () => {
  const bodies = await withProbe([finish, finish], async (executor, cwd) => {
    await executor.run({ ...request(cwd), role: "reviewer" });
    await executor.run(request(cwd));
  });
  const system = (b: Body | undefined): string =>
    (b?.messages ?? [])
      .filter((m) => m.role === "system")
      .map(text)
      .join("\n");
  assert.ok(!system(bodies[0]).includes("Tool Transition Rule"), "reviewer");
  assert.ok(system(bodies[1]).includes(TOOL_TRANSITION_RULE.slice(0, 40)), "implementer");
});
