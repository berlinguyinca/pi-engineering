/**
 * worker_result guard, in-session nudge and wall-clock wrap-up through the REAL
 * worker executor: a local scripted OpenAI-compatible HTTP server, pi-ai's own
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
      assert.deepEqual(
        { done: run.result.details.done, remaining: run.result.details.remaining, partial: run.result.details.partial },
        { done: ["a"], remaining: ["b"], partial: true },
      );
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
  let clockRef: ManualClock | undefined;
  await withProbe(
    [
      (res) => {
        clockRef!.advance(800); // 80% of the 1000ms budget passes during this turn
        toolCalls([{ name: "bash", args: { command: "true" } }])(res);
      },
      toolCalls([
        {
          name: "worker_result",
          args: result({ status: "partial", summary: "ran out of time", details: { done: ["a"], remaining: ["b"] } }),
        },
      ]),
    ],
    async ({ executor, clock, req, bodies }) => {
      clockRef = clock;
      const run = await executor.run(
        req({ role: "scout", isolatedWorktree: false, wallClock: { startedAt: clock.now(), budgetMs: 1000 } }),
      );
      assert.equal(run.result.status, "blocked");
      assert.deepEqual(
        { done: run.result.details.done, remaining: run.result.details.remaining, partial: run.result.details.partial },
        { done: ["a"], remaining: ["b"], partial: true },
      );
      assert.equal(bodies.length, 2);
      assert.match(bodies[1]!, /You are near the time budget\. Commit what is coherent now, then call worker_result/);
      assert.equal(bodies.filter((b) => b.includes("You are near the time budget.")).length, 1);
    },
  );
});

test("before 75% of the budget nothing is injected", async () => {
  let clockRef: ManualClock | undefined;
  await withProbe(
    [
      (res) => {
        clockRef!.advance(700);
        toolCalls([{ name: "bash", args: { command: "true" } }])(res);
      },
      toolCalls([{ name: "worker_result", args: result() }]),
    ],
    async ({ executor, clock, req, bodies }) => {
      clockRef = clock;
      await executor.run(
        req({ role: "scout", isolatedWorktree: false, wallClock: { startedAt: clock.now(), budgetMs: 1000 } }),
      );
      assert.equal(
        bodies.some((b) => b.includes("time budget")),
        false,
      );
    },
  );
});

test("without a budget and without an explicit timeoutMs nothing is ever injected", async () => {
  let clockRef: ManualClock | undefined;
  await withProbe(
    [
      (res) => {
        clockRef!.advance(10 * 3_600_000);
        toolCalls([{ name: "bash", args: { command: "true" } }])(res);
      },
      toolCalls([{ name: "worker_result", args: result() }]),
    ],
    async ({ executor, clock, req, bodies }) => {
      clockRef = clock;
      assert.equal((await executor.run(req({ role: "scout", isolatedWorktree: false }))).result.status, "completed");
      assert.equal(clock.timers.length, 0, "no wrap-up timer was even armed");
      assert.equal(
        bodies.some((b) => /time budget|quiet/.test(b)),
        false,
      );
    },
  );
});

test("an explicit standalone timeoutMs injects the silence wrap-up at 75% of it", async () => {
  let clockRef: ManualClock | undefined;
  await withProbe(
    [
      (res) => {
        clockRef!.advance(800);
        toolCalls([{ name: "bash", args: { command: "true" } }])(res);
      },
      toolCalls([{ name: "worker_result", args: result({ status: "partial", summary: "quiet" }) }]),
    ],
    async ({ executor, clock, req, bodies }) => {
      clockRef = clock;
      const run = await executor.run(req({ role: "scout", isolatedWorktree: false, timeoutMs: 1000 }));
      assert.equal(run.result.status, "blocked");
      assert.match(bodies[1]!, /quiet for most of the inactivity limit/);
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
          wallClock: { startedAt: 0, budgetMs: 3_600_000 },
          budgetNoticeEveryToolCalls: 2,
        }),
      );
      assert.equal(run.result.status, "completed");
      assert.equal(/Time budget: /.test(bodies[1]!), false, "not yet at the interval");
      assert.match(bodies[2]!, /Time budget: .* elapsed, .* remaining/);
    },
  );
});

test("guard: a tracked modification with no commit counts as a change", async () => {
  await withProbe(
    [
      toolCalls([{ name: "bash", args: { command: "echo more >> note.txt" } }]),
      toolCalls([{ name: "worker_result", args: result({ summary: "dirty ok" }) }]),
    ],
    async ({ executor, req }) => {
      const run = await executor.run(req());
      assert.equal(run.result.status, "completed");
      assert.equal(run.result.summary, "dirty ok");
    },
  );
});

test("guard: untracked files alone are not changes", async () => {
  await withProbe(
    [
      toolCalls([{ name: "bash", args: { command: "echo junk > scratch.txt" } }]),
      toolCalls([{ name: "worker_result", args: result() }]),
      toolCalls([{ name: "worker_result", args: result({ status: "blocked", summary: "nothing to commit" }) }]),
    ],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(req());
      assert.equal(run.result.status, "blocked");
      assert.match(bodies[2]!, /no changes vs base/);
    },
  );
});

test("guard: an unreadable base rejects completion but accepts a blocked report", async () => {
  await withProbe(
    [
      toolCalls([{ name: "worker_result", args: result() }]),
      toolCalls([{ name: "worker_result", args: result({ status: "blocked" }) }]),
    ],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(req({ baseRef: "0000000000000000000000000000000000000000" }));
      assert.equal(run.result.status, "blocked");
      assert.match(bodies[1]!, /cannot verify worktree changes/);
    },
  );
});

test("repair worker: no change on a seeded tip is caught; a commit is not", async () => {
  const seedAndRun = async (workerReplies: Reply[], status: string) => {
    await withProbe(workerReplies, async ({ executor, cwd, req, bodies }) => {
      // The worker forked from a seeded tip that is already ahead of the mission base.
      git(cwd, "commit", "--allow-empty", "-qm", "seeded tip");
      const seeded = git(cwd, "rev-parse", "HEAD");
      const run = await executor.run(req({ baseRef: seeded }));
      assert.equal(bodies.length, 2);
      assert.equal(run.result.status, status);
    });
  };
  await seedAndRun(
    [
      toolCalls([{ name: "worker_result", args: result() }]),
      toolCalls([{ name: "worker_result", args: result({ status: "blocked", summary: "no change needed" }) }]),
    ],
    "blocked",
  );
  await seedAndRun(
    [toolCalls([{ name: "bash", args: { command: COMMIT } }]), toolCalls([{ name: "worker_result", args: result() }])],
    "completed",
  );
});

test("reviewer: a session that ends without review_result gets one review nudge", async () => {
  const review = {
    verdict: "approve",
    summary: "ok",
    findings: [],
    missing_tests: [],
    spec_gaps: [],
    acceptance_results: [],
  };
  await withProbe(
    [text("looks fine"), toolCalls([{ name: "review_result", args: review }])],
    async ({ executor, req, bodies }) => {
      const run = await executor.run(
        req({ role: "reviewer", isolatedWorktree: false, resultTool: "review_result", tools: [] }),
      );
      assert.equal(run.error, undefined, run.result.summary);
      assert.equal(bodies.length, 2);
      assert.match(bodies[1]!, /Call review_result now with your verdict, summary and findings\./);
    },
  );
});

test("no nudge after an owner abort or a timeout", async () => {
  for (const reason of [undefined, new DOMException("late", "TimeoutError")]) {
    await withProbe([text("never asked")], async ({ executor, req, bodies }) => {
      const ac = new AbortController();
      ac.abort(reason);
      const run = await executor.run(req({ role: "scout", isolatedWorktree: false, signal: ac.signal }));
      assert.equal(run.result.status, "failed");
      assert.equal(bodies.length, 0, "no request, so no nudge");
      assert.equal(run.error, reason ? "timeout" : "no-result");
    });
  }
});

for (const scenario of ["empty commit", "reverted commit", "invalid base"] as const) {
  test(`implementer: ${scenario} cannot substantiate completed`, async () => {
    await withProbe(
      [
        toolCalls([{ name: "worker_result", args: result() }]),
        toolCalls([{ name: "worker_result", args: result({ status: "blocked", summary: "no verified diff" }) }]),
      ],
      async ({ executor, req, cwd, bodies }) => {
        if (scenario === "empty commit") git(cwd, "commit", "--allow-empty", "-qm", "empty");
        if (scenario === "reverted commit") {
          writeFileSync(join(cwd, "note.txt"), "changed\n");
          git(cwd, "commit", "-qam", "change");
          git(cwd, "revert", "--no-edit", "HEAD");
        }
        const run = await executor.run(req(scenario === "invalid base" ? { baseRef: "missing-base" } : {}));
        assert.equal(run.result.status, "blocked");
        assert.equal(bodies.length, 2);
        assert.match(bodies[1]!, scenario === "invalid base" ? /cannot verify worktree changes/ : /no changes vs base/);
      },
    );
  });
}

for (const tolerantFileTools of [false, true]) {
  test(`isolated file mutations stay in the assigned worktree (tolerant=${tolerantFileTools})`, async () => {
    const replies: Reply[] = [];
    await withProbe(replies, async ({ executor, req, cwd, bodies }) => {
      const outside = join(cwd, "..", "outside.txt");
      writeFileSync(outside, "original\n");
      symlinkSync(join(cwd, ".."), join(cwd, "escape"));
      symlinkSync(outside, join(cwd, "linked.txt"));
      for (const path of [
        outside,
        "../outside.txt",
        "escape/outside.txt",
        "linked.txt",
        `file://${outside}`,
        `@${outside}`,
      ]) {
        replies.push(toolCalls([{ name: "write", args: { path, content: "wrong\n" } }]));
        replies.push(toolCalls([{ name: "edit", args: { path, edits: [{ oldText: "original", newText: "wrong" }] } }]));
      }
      replies.push(toolCalls([{ name: "write", args: { path: "escape/new-dir/new.txt", content: "wrong\n" } }]));
      const rejectedMutations = replies.length;
      replies.push(toolCalls([{ name: "read", args: { path: outside } }]));
      replies.push(toolCalls([{ name: "write", args: { path: "new-dir/local.txt", content: "local\n" } }]));
      replies.push(toolCalls([{ name: "worker_result", args: result() }]));
      const run = await executor.run(req({ tools: ["read", "write", "edit"], tolerantFileTools, baseRef: undefined }));
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(readFileSync(outside, "utf8"), "original\n");
      assert.equal(readFileSync(join(cwd, "new-dir/local.txt"), "utf8"), "local\n");
      assert.equal(existsSync(join(cwd, "..", "new-dir")), false);
      assert.match(bodies[rejectedMutations]!, /outside assigned worktree/);
      assert.match(bodies[rejectedMutations + 1]!, /original/);
    });
  });
}

for (const scenario of [
  "primary checkout",
  "unrelated clone",
  "changed branch",
  "assigned worktree",
  "detached worktree",
] as const) {
  test(`worker assignment: ${scenario} is checked before inference`, async () => {
    await withProbe(
      [toolCalls([{ name: "worker_result", args: result({ status: "blocked", summary: "nothing to change" }) }])],
      async ({ executor, req, cwd, bodies }) => {
        const assignedPath = join(cwd, "..", "assigned");
        const branch = "assigned-worker";
        git(cwd, "worktree", "add", "-qb", branch, assignedPath);
        let workerCwd = assignedPath;
        if (scenario === "primary checkout") workerCwd = cwd;
        if (scenario === "unrelated clone") {
          workerCwd = join(cwd, "..", "clone");
          git(cwd, "clone", "-q", cwd, workerCwd);
        }
        if (scenario === "changed branch") git(assignedPath, "branch", "-m", "unexpected-branch");
        if (scenario === "detached worktree") git(assignedPath, "checkout", "--detach", "-q");
        const run = await executor.run(
          req({
            cwd: workerCwd,
            assignedWorktree: {
              path: scenario === "unrelated clone" ? workerCwd : assignedPath,
              repositoryRoot: cwd,
              ...(scenario === "detached worktree" ? {} : { branch }),
            },
          }),
        );
        if (scenario === "assigned worktree" || scenario === "detached worktree") {
          assert.equal(run.result.status, "blocked", run.result.summary);
          assert.equal(bodies.length, 1);
        } else {
          assert.equal(run.result.status, "failed", run.result.summary);
          assert.equal(run.error, "worktree-mismatch");
          assert.equal(bodies.length, 0, "assignment failure must precede any inference request");
        }
      },
    );
  });
}
