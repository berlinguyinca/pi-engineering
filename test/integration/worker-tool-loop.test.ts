/**
 * Cross-turn repeated-tool-call guard through the REAL worker executor: a local scripted OpenAI-compatible HTTP server, pi-ai's own
 * openai-completions provider, and a real git worktree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerRequest } from "../../src/workers/WorkerExecutor.ts";

type Reply = (res: ServerResponse) => void;

/** A clock the test drives by hand: timers fire only when it advances. */
class ManualClock {
  t = 0;
  timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    (handle as { live: boolean }).live = false;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const timer of this.timers) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.fn();
      }
    }
  }
}

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
  limit: number | undefined,
  body: (ctx: {
    executor: PiWorkerExecutor;
    clock: ManualClock;
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
  const clock = new ManualClock();
  const executor = new PiWorkerExecutor({
    clock,
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
    ...(limit ? { toolLoopLimit: limit } : {}),
  });
  try {
    await body({
      executor,
      clock,
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

const bash = (command: string): Reply => toolCalls([{ name: "bash", args: { command } }]);
const done: Reply = toolCalls([{ name: "worker_result", args: result({ summary: "finished" }) }]);
const scout = (req: (over?: Partial<WorkerRequest>) => WorkerRequest, over: Partial<WorkerRequest> = {}) =>
  req({ role: "scout", isolatedWorktree: false, ...over });

test("4 identical bash calls: the worker fails with tool-loop at the 3rd, no 4th request", async () => {
  await withProbe(
    [bash("echo same"), bash("echo same"), bash("echo   same"), bash("echo same"), done],
    undefined,
    async ({ executor, req, bodies }) => {
      const run = await executor.run(scout(req));
      assert.equal(run.result.status, "failed");
      assert.equal(run.result.error, "tool-loop");
      assert.equal(run.error, "tool-loop");
      assert.equal(bodies.length, 3, "stopped at the third identical call");
      assert.match(run.result.summary, /3 consecutive identical bash calls/);
      assert.match(run.result.summary, /echo +same/);
      assert.deepEqual(run.result.details.tool_loop, {
        tool: "bash",
        count: 3,
        limit: 3,
        last_args: JSON.stringify({ command: "echo   same" }),
      });
    },
  );
});

test("the limit is configurable", async () => {
  await withProbe(
    [bash("echo same"), bash("echo same"), bash("echo same"), done],
    2,
    async ({ executor, req, bodies }) => {
      const run = await executor.run(scout(req));
      assert.equal(run.result.error, "tool-loop");
      assert.equal(bodies.length, 2);
    },
  );
});

test("polling: the same command with changing output is not a loop", async () => {
  const poll = "echo x >> cnt.txt; wc -l < cnt.txt";
  await withProbe([bash(poll), bash(poll), bash(poll), bash(poll), bash(poll), done], 3, async ({ executor, req }) => {
    const run = await executor.run(scout(req));
    assert.equal(run.result.status, "completed", run.result.summary);
  });
});

test("the same command re-run after an edit each time is not a loop", async () => {
  const write = (n: number): Reply => toolCalls([{ name: "write", args: { path: `f${n}.txt`, content: `v${n}` } }]);
  await withProbe(
    [bash("echo ok"), write(1), bash("echo ok"), write(2), bash("echo ok"), write(3), bash("echo ok"), done],
    3,
    async ({ executor, req }) => {
      const run = await executor.run(scout(req, { tools: ["bash", "write"] }));
      assert.equal(run.result.status, "completed", run.result.summary);
    },
  );
});

test("the evidence case: a heredoc script that differs only in its scratch file name, with identical output", async () => {
  const script = (n: string) => `cat > ${n}.mjs <<'EOF'\nconsole.log("A");\nEOF\nnode ${n}.mjs`;
  await withProbe(
    [bash(script("pa")), bash(script("pb")), bash(script("pc")), bash(script("pd")), done],
    3,
    async ({ executor, req, bodies }) => {
      const run = await executor.run(scout(req));
      assert.equal(run.result.error, "tool-loop", run.result.summary);
      assert.equal(bodies.length, 3);
    },
  );
});

test("scratch scripts with different output are real work, not a loop", async () => {
  const script = (n: string) => `cat > ${n}.mjs <<'EOF'\nconsole.log("${n}");\nEOF\nnode ${n}.mjs`;
  await withProbe([bash(script("pa")), bash(script("pb")), bash(script("pc")), done], 3, async ({ executor, req }) => {
    const run = await executor.run(scout(req));
    assert.equal(run.result.status, "completed", run.result.summary);
  });
});
