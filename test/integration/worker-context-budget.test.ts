/**
 * Context budget from the routed model (issue #180), through the REAL worker
 * executor against a local scripted OpenAI-compatible HTTP server.
 *
 *  1. the budget is min(role budget, 0.7 x routed contextWindow) and is recorded;
 *  2. a worker session compacts at 60% of that budget, summary thinking off;
 *  3. a "context length exceeded" 400 compacts once, retries once, then fails
 *     with a structured context_overflow that recovery answers with a split;
 *  4. an unknown window leaves the role budget alone, with a warning.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROLE_BUDGETS } from "../../src/core/types.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { FailureClassifier, RecoveryPlanner } from "../../src/orchestration/recovery.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const SUMMARY_OPENING = "You are a context summarization assistant.";

interface Seen {
  summarization: boolean;
  body: Record<string, unknown>;
}

type Reply = (res: ServerResponse, seen: Seen, index: number) => void;

function frame(delta: Record<string, unknown>, finish: string | null, usage?: number): string {
  const chunk = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" };
  const main = `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return usage === undefined
    ? main
    : `${main}data: ${JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: usage, completion_tokens: 5, total_tokens: usage + 5 } })}\n\n`;
}

function toolCall(name: string, args: Record<string, unknown>, usage = 1000): Reply {
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      frame(
        {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_0", type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        null,
      ),
    );
    res.write(frame({}, "tool_calls", usage));
    res.end("data: [DONE]\n\n");
  };
}

function text(content: string, usage = 1000): Reply {
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ role: "assistant", content }, null));
    res.write(frame({}, "stop", usage));
    res.end("data: [DONE]\n\n");
  };
}

const overflow: Reply = (res) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 32768 tokens. However, your messages resulted in 40000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    }),
  );
};

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

async function withServer(
  contextWindow: number,
  script: (seen: Seen, index: number) => Reply,
  body: (executor: PiWorkerExecutor, cwd: string, seen: Seen[]) => Promise<void>,
): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const parsed = JSON.parse(raw || "{}") as { messages?: Array<{ role: string; content: unknown }> };
      const system = parsed.messages?.find((m) => m.role === "system" || m.role === "developer");
      const sys = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
      const entry: Seen = { summarization: sys.includes(SUMMARY_OPENING), body: parsed as Record<string, unknown> };
      seen.push(entry);
      script(entry, seen.length - 1)(res, entry, seen.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-ctx-budget-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "m", maxTokens: 4096, contextWindow }],
        },
      },
    }),
  );
  writeFileSync(join(dir, "note.txt"), "hello\n");
  // Long files, so a transcript holds more than the kept recent window.
  for (const name of ["big1.txt", "big2.txt"])
    writeFileSync(join(dir, name), `${"lorem ipsum dolor sit amet\n".repeat(1500)}`);
  const executor = new PiWorkerExecutor({
    agentDir: dir,
    aps: false,
    gatewayConfig: resolveGatewayConfig({ enabled: false }),
    transientSleep: async () => {},
    transientRand: () => 0,
  });
  try {
    await body(executor, dir, seen);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return seen;
}

const route = { provider: "probe", id: "m" };
const budgetOf = (run: { result: { details?: Record<string, unknown> } }) =>
  run.result.details?.context_budget as { tokens: number; roleTokens: number; limitedBy: string } | undefined;

test("budget: implementer on a 32k model gets min(role, 22937); reviewer is no longer 64k", async () => {
  await withServer(
    32_768,
    () => toolCall("worker_result", WORKER_RESULT),
    async (executor, cwd) => {
      const run = await executor.run({ role: "implementer", task: "t", tools: [], cwd, modelOverride: route });
      assert.equal(run.result.status, "completed", JSON.stringify(run.result));
      const budget = budgetOf(run);
      assert.equal(budget?.tokens, Math.floor(0.7 * 32_768));
      assert.equal(budget?.tokens, 22_937);
      assert.equal(budget?.roleTokens, ROLE_BUDGETS.implementer.hardMaxTokens);
      assert.equal(budget?.limitedBy, "model");
    },
  );
  await withServer(
    32_768,
    () => toolCall("review_result", REVIEW_RESULT),
    async (executor, cwd) => {
      const run = await executor.run({
        role: "reviewer",
        task: "t",
        tools: [],
        cwd,
        modelOverride: route,
        resultTool: "review_result",
        maxContextTokens: 64_000,
      });
      assert.equal(run.result.status, "completed", run.result.summary);
      assert.equal(budgetOf(run)?.tokens, 22_937);
    },
  );
});

test("budget: a big window leaves the role budget in force", async () => {
  await withServer(
    262_144,
    () => toolCall("worker_result", WORKER_RESULT),
    async (executor, cwd) => {
      const run = await executor.run({ role: "implementer", task: "t", tools: [], cwd, modelOverride: route });
      assert.equal(budgetOf(run)?.tokens, ROLE_BUDGETS.implementer.hardMaxTokens);
      assert.equal(budgetOf(run)?.limitedBy, "role");
    },
  );
});

test("compaction: a worker session compacts at 60% of the budget with a thinking-off summary", async () => {
  // Budget 22937 -> trigger 13762. The second turn reports 15000 prompt tokens.
  const seen = await withServer(
    32_768,
    (entry, index) =>
      entry.summarization
        ? text("## Goal\nkeep going\n## Progress\nread the files", 1200)
        : index === 0
          ? toolCall("read", { path: "big1.txt" }, 8000)
          : index === 1
            ? toolCall("read", { path: "big2.txt" }, 15_000)
            : toolCall("worker_result", WORKER_RESULT, 2000),
    async (executor, cwd) => {
      const run = await executor.run({ role: "implementer", task: "t", tools: ["read"], cwd, modelOverride: route });
      assert.equal(run.result.status, "completed", run.result.summary);
    },
  );
  const summaries = seen.filter((s) => s.summarization);
  assert.ok(summaries.length >= 1, `a compaction summary was requested (${seen.length} requests)`);
  assert.deepEqual(summaries[0]?.body.chat_template_kwargs, { enable_thinking: false });
});

test("compaction: stays quiet below 60% of the budget", async () => {
  const seen = await withServer(
    32_768,
    (_entry, index) =>
      index === 0
        ? toolCall("read", { path: "note.txt" }, 8000)
        : index === 1
          ? toolCall("read", { path: "note.txt" }, 12_000)
          : toolCall("worker_result", WORKER_RESULT, 2000),
    async (executor, cwd) => {
      const run = await executor.run({ role: "implementer", task: "t", tools: ["read"], cwd, modelOverride: route });
      assert.equal(run.result.status, "completed", run.result.summary);
    },
  );
  assert.equal(seen.filter((s) => s.summarization).length, 0);
});

test("overflow: a context-length 400 compacts once, retries once, then fails with context_overflow", async () => {
  const seen = await withServer(
    32_768,
    (entry) => (entry.summarization ? text("## Goal\nx") : overflow),
    async (executor, cwd) => {
      const run = await executor.run({ role: "implementer", task: "t", tools: [], cwd, modelOverride: route });
      assert.equal(run.result.status, "failed");
      assert.equal(run.result.error, "context_overflow");
      assert.equal(run.error, "context_overflow");
      assert.match(run.result.summary, /^context_overflow:/);
      assert.equal(run.result.details?.context_overflow, true);

      // Recovery treats it as a task that cannot fit: split, never replay.
      const classification = new FailureClassifier().classify({
        missionId: "MSN-ctx",
        taskId: "TSK-ctx",
        executionId: "EXE-ctx",
        summary: run.result.summary,
      });
      assert.equal(classification.category, "TASK_BUDGET_EXHAUSTED");
      assert.equal(RecoveryPlanner.defaultAction(classification.category), "CHECKPOINT_SPLIT_AND_REPLACE");
    },
  );
  const turns = seen.filter((s) => !s.summarization).length;
  assert.equal(turns, 2, `one attempt and one retry after compaction, not an endless loop (${turns})`);
});

test("overflow: llama.cpp 'exceeds the available context size' is not retried forever either", async () => {
  const seen = await withServer(
    32_768,
    () => (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: 400,
            message: "the request exceeds the available context size (32768 tokens)",
            type: "exceed_context_size_error",
          },
        }),
      );
    },
    async (executor, cwd) => {
      const run = await executor.run({ role: "implementer", task: "t", tools: [], cwd, modelOverride: route });
      assert.equal(run.result.error, "context_overflow");
    },
  );
  assert.equal(seen.filter((s) => !s.summarization).length, 2);
});

test("unknown window: only the role budget applies, with a warning", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  try {
    await withServer(
      32_768,
      () => toolCall("worker_result", WORKER_RESULT),
      async (executor, cwd) => {
        // A model object that carries no context window (Pi fills 128000 for a
        // models.json entry that omits it, so this is the only way to see "unknown").
        const registered = (await executor.runtime()).getModel(route.provider, route.id);
        assert.ok(registered);
        const bare = new PiWorkerExecutor({
          agentDir: cwd,
          model: { ...registered, contextWindow: undefined as unknown as number },
          aps: false,
          gatewayConfig: resolveGatewayConfig({ enabled: false }),
        });
        const run = await bare.run({ role: "implementer", task: "t", tools: [], cwd });
        assert.equal(run.result.status, "completed", run.result.summary);
        const budget = budgetOf(run);
        assert.equal(budget?.tokens, ROLE_BUDGETS.implementer.hardMaxTokens);
        assert.equal(budget?.limitedBy, "role");
      },
    );
  } finally {
    uninstall();
  }
  assert.ok(
    notices.some((t) => /context window .*unknown/.test(t)),
    JSON.stringify(notices),
  );
});
