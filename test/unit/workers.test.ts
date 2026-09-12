import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { workerResultTool } from "../../src/workers/workerResultTool.ts";
import { buildSystemPrompt, WORKER_KICKOFF } from "../../src/workers/prompts.ts";

test("fake executor returns a bounded structured result for a role", async () => {
  const worker = new FakeWorkerExecutor({
    scout: () => ({ status: "completed", summary: "scanned repo", claims: [], details: {}, evidence_refs: [], new_hypotheses: [], proposed_tasks: [] }),
  });
  const run = await worker.run({ role: "scout", task: "scan", tools: ["read"], cwd: "/tmp", context: "" });
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.summary, "scanned repo");
  assert.ok(run.usage && run.usage.model === "fake");
});

test("fake executor reports unhandled roles as failed", async () => {
  const worker = new FakeWorkerExecutor({});
  const run = await worker.run({ role: "reviewer", task: "r", tools: [], cwd: "/tmp", context: "" });
  assert.equal(run.result.status, "failed");
  assert.match(run.result.summary, /No fake handler/);
});

test("worker_result tool returns terminating structured details", async () => {
  const execute = workerResultTool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ terminate: boolean; details: unknown }>;
  const res = await execute(
    "call-1",
    {
      status: "completed",
      summary: "done",
      claims: [{ claim: "x", evidence: "test-run://1" }],
      evidence_refs: ["test-run://1"],
      new_hypotheses: [],
      proposed_tasks: [],
    },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(res.terminate, true);
  const details = res.details as { status: string; summary: string };
  assert.equal(details.status, "completed");
  assert.equal(details.summary, "done");
});

test("role prompts are compact and instruct bounded output", () => {
  const prompt = buildSystemPrompt("reviewer", "review the diff");
  assert.ok(prompt.length < 2500, `prompt should stay compact, was ${prompt.length}`);
  assert.ok(prompt.includes("worker_result"));
  assert.match(WORKER_KICKOFF, /worker_result/);
});
