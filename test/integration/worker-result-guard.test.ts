/**
 * worker_result guard, in-session nudge and wall-clock wrap-up through the REAL
 * worker executor: a local scripted OpenAI-compatible HTTP server, pi-ai's own
 * openai-completions provider, and a real git worktree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

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

const text =
  (content: string): Reply =>
  (res) =>
    sse(res, [chunk({ role: "assistant", content }), chunk({}, "stop")]);

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

const result = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  summary: "done",
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
  ...over,
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

const COMMIT = "echo x > a.txt && git add a.txt && git -c user.email=t@t -c user.name=t commit -qm change";

async function withProbe(
  replies: Reply[],
  body: (ctx: {
    executor: PiWorkerExecutor;
    cwd: string;
    base: string;
    bodies: string[];
    req: (over?: Partial<WorkerRequest>) => WorkerRequest;
  }) => Promise<void>,
) {
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      bodies.push(data);
      const reply = replies[bodies.length - 1];
      if (reply) reply(res);
      else res.writeHead(500).end("unexpected extra request");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-wresult-"));
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
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "note.txt"), "hello\n");
  git(repo, "add", "note.txt");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body({
      executor,
      cwd: repo,
      base,
      bodies,
      req: (over = {}) => ({
        role: "implementer",
        task: "t",
        tools: ["bash"],
        cwd: repo,
        baseRef: base,
        isolatedWorktree: true,
        modelOverride: { provider: "probe", id: "probe-model" },
        ...over,
      }),
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("implementer: completed with no changes vs base is rejected and the session continues", async () => {
  await withProbe(
    [
      toolCalls([{ name: "worker_result", args: result() }]),
      toolCalls([{ name: "bash", args: { command: COMMIT } }]),
      toolCalls([{ name: "worker_result", args: result({ summary: "real work" }) }]),
    ],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(req());
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.result.summary, "real work");
      assert.equal(bodies.length, 3, "one session, three turns");
      assert.match(bodies[1]!, /no changes vs base: commit your work or report blocked\/partial with a reason/);
    },
  );
});

test("implementer: blocked or partial with a reason is accepted without changes", async () => {
  await withProbe(
    [toolCalls([{ name: "worker_result", args: result({ status: "blocked", summary: "cannot build offline" }) }])],
    async ({ executor, req }) => {
      const run = await executor.run(req());
      assert.equal(run.result.status, "blocked");
      assert.equal(run.result.summary, "cannot build offline");
    },
  );
  await withProbe(
    [
      toolCalls([
        {
          name: "worker_result",
          args: result({ status: "partial", summary: "out of time", details: { done: ["a"], remaining: ["b"] } }),
        },
      ]),
    ],
    async ({ executor, req }) => {
      const run = await executor.run(req());
      assert.equal(run.result.status, "blocked");
      assert.deepEqual(run.result.details, { done: ["a"], remaining: ["b"], partial: true });
    },
  );
});

test("a non-mutating role is not subject to the no-change guard", async () => {
  await withProbe([toolCalls([{ name: "worker_result", args: result() }])], async ({ executor, req, bodies }) => {
    const run = await executor.run(req({ role: "scout", isolatedWorktree: false }));
    assert.equal(run.result.status, "completed");
    assert.equal(bodies.length, 1);
  });
});

test("a session that ends without worker_result gets one nudge in the same session", async () => {
  await withProbe(
    [text("I am finished."), toolCalls([{ name: "worker_result", args: result({ summary: "after nudge" }) }])],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(req({ role: "scout", isolatedWorktree: false }));
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(run.result.summary, "after nudge");
      assert.equal(bodies.length, 2);
      assert.match(bodies[1]!, /Call worker_result now with your status, summary and committed changes\./);
      assert.match(bodies[1]!, /I am finished\./, "the same session: the first turn is still in the history");
    },
  );
});

test("an ignored nudge settles as the existing no-result failure after exactly one nudge", async () => {
  await withProbe([text("done"), text("really done")], async ({ executor, req, bodies }) => {
    const run = await executor.run(req({ role: "scout", isolatedWorktree: false }));
    assert.equal(run.result.status, "failed");
    assert.equal(run.error, "no-result");
    assert.equal(bodies.length, 2, "one original turn and one nudge, no fresh attempt");
  });
});

test("a wall-clock budget injects one wrap-up turn at ~75% and a partial result is recorded", async () => {
  await withProbe(
    [
      toolCalls([{ name: "bash", args: { command: "sleep 1.2" } }]),
      toolCalls([
        {
          name: "worker_result",
          args: result({ status: "partial", summary: "ran out of time", details: { done: ["a"], remaining: ["b"] } }),
        },
      ]),
    ],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(
        req({ role: "scout", isolatedWorktree: false, wallClock: { startedAt: Date.now(), budgetMs: 1500 } }),
      );
      assert.equal(run.result.status, "blocked");
      assert.deepEqual(run.result.details, { done: ["a"], remaining: ["b"], partial: true });
      assert.equal(bodies.length, 2);
      assert.match(bodies[1]!, /You are near the time budget\. Commit what is coherent now, then call worker_result/);
      assert.equal(bodies.filter((b) => b.includes("You are near the time budget.")).length, 1, "injected once");
    },
  );
});

test("without a wall-clock budget nothing is injected", async () => {
  await withProbe(
    [
      toolCalls([{ name: "bash", args: { command: "sleep 1.2" } }]),
      toolCalls([{ name: "worker_result", args: result() }]),
    ],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(req({ role: "scout", isolatedWorktree: false }));
      assert.equal(run.result.status, "completed");
      assert.equal(
        bodies.some((b) => b.includes("time budget")),
        false,
      );
    },
  );
});

test("a budgeted worker sees elapsed and remaining time in bash results every N tool calls", async () => {
  await withProbe(
    [
      toolCalls([{ name: "bash", args: { command: "true" } }]),
      toolCalls([{ name: "bash", args: { command: "true" } }]),
      toolCalls([{ name: "worker_result", args: result() }]),
    ],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(
        req({
          role: "scout",
          isolatedWorktree: false,
          wallClock: { startedAt: Date.now(), budgetMs: 3_600_000 },
          budgetNoticeEveryToolCalls: 2,
        }),
      );
      assert.equal(run.result.status, "completed");
      assert.equal(/Time budget: /.test(bodies[1]!), false, "not yet at the interval");
      assert.match(bodies[2]!, /Time budget: .* elapsed, .* remaining/);
    },
  );
});
