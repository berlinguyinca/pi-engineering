import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewResultTool } from "../../src/lifecycle/reviewResultTool.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { buildCompactedWorkerPrompt } from "../../src/workers/PiWorkerExecutor.ts";
import { WORKER_KICKOFF, buildSystemPrompt } from "../../src/workers/prompts.ts";
import { workerResultTool } from "../../src/workers/workerResultTool.ts";

test("fake executor returns a bounded structured result for a role", async () => {
  const worker = new FakeWorkerExecutor({
    scout: () => ({
      status: "completed",
      summary: "scanned repo",
      claims: [],
      details: {},
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
    }),
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

test("compaction truncates ordinary context but preserves the complete durable recovery block", () => {
  const longHash = `sha256:${"a".repeat(64)}`;
  const prompt = buildCompactedWorkerPrompt(
    {
      role: "implementer",
      task: "resume exact work",
      tools: [],
      cwd: "/tmp/candidate",
      context: "ordinary ".repeat(200),
      recovery: {
        recoveryDecisionId: "RCV-durable",
        expectedReplacementFingerprint: longHash,
        originalTaskId: "TSK-original",
        originalExecutionId: "EXE-original",
        supersessionId: "SUP-exact",
        missionId: "MSN-exact",
        repoId: "repo-exact",
        missionGeneration: 7,
        candidateGeneration: 8,
        fencingToken: 9,
        resumptionGeneration: 10,
        checkpointId: "CHK-exact",
        candidateSha: "candidate-exact",
        sourceBranch: "branch-exact",
        sourceWorktree: "/tmp/source-exact",
        committedPaths: ["src/committed.ts"],
        formerlyDirtyPaths: ["src/dirty.ts"],
        completedDeliverables: ["durable-deliverable"],
        artifactRefs: ["artifact://durable"],
        artifactHashes: [longHash],
      },
    },
    "recover now",
  );

  assert.match(prompt, /ordinary ordinary/);
  assert.match(prompt, /\[truncated\]/);
  assert.match(prompt, /Verified durable checkpoint recovery context \(immutable\)/);
  assert.match(prompt, /artifact:\/\/durable/);
  assert.match(prompt, new RegExp(longHash));
  assert.match(prompt, /sourceWorktree=\/tmp\/source-exact/);
});

test("review_result tool is a terminating tool with a machine-checkable verdict", async () => {
  assert.equal(reviewResultTool.name, "review_result");
  const schema = reviewResultTool.parameters as { properties?: Record<string, unknown> };
  const verdict = schema.properties?.verdict as { anyOf?: Array<{ const?: string }> } | undefined;
  const allowed = (verdict?.anyOf ?? []).map((v) => v.const).filter(Boolean);
  assert.ok(allowed.includes("approve") && allowed.includes("request_changes"));
  assert.ok((schema.properties as Record<string, unknown>).findings, "findings array expected");
});

test("worker_result enforces bounded output even for a chatty worker (review MED #6)", async () => {
  const execute = workerResultTool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ terminate: boolean; details: unknown }>;
  const huge = "x".repeat(50_000);
  const res = await execute(
    "call-big",
    {
      status: "completed",
      summary: huge,
      claims: Array.from({ length: 100 }, (_, i) => ({ claim: huge, evidence: "agent-claim" })),
      evidence_refs: Array.from({ length: 100 }, () => huge),
      new_hypotheses: [],
      proposed_tasks: [],
    },
    undefined,
    undefined,
    undefined,
  );
  const d = res.details as { summary: string; claims: unknown[]; evidence_refs: string[] };
  // Bounded (not the raw 50k) — the truncation marker adds a few chars past the
  // 4000 cap, so assert far below the input, not exactly at the cap.
  assert.ok(d.summary.length < 5000, `summary must be bounded, was ${d.summary.length}`);
  assert.ok(d.claims.length <= 20, "claims array must be capped");
  assert.ok((d.claims[0] as { claim: string }).claim.length < 5000, "each claim must be capped");
  assert.ok(d.evidence_refs.length <= 20, "evidence_refs must be capped");
  assert.equal(res.terminate, true);
});
