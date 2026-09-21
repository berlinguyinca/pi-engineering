/**
 * Runtime-neutral canary (herdr spec 15, Phase G).
 *
 * Drives the Planner → Engineer A → Engineer B (fan-out) → Tester → Reviewer
 * workflow through the AgentRuntime seam, composing it with the request planner
 * (spec 06). Uses deterministic fake worker executors so the canary runs without
 * external InferWeave / Herdr services; a real live canary against those
 * services is separately documented as externally blocked.
 *
 * Proves the seam holds for the workflow shape: isolated worker ids, structured
 * bounded results, artifact-first refs, fan-out/synthesis, and a review pass.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { planRequest } from "../../src/request/RequestPlanner.ts";
import type { AgentRuntime } from "../../src/runtime/AgentRuntime.ts";
import type { RuntimeId } from "../../src/runtime/AgentRuntime.ts";
import { LegacyAgentRuntime } from "../../src/runtime/LegacyAgentRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

function makeRuntime(): AgentRuntime {
  const fake = new FakeWorkerExecutor(
    {
      planner: async () => ({ status: "completed", summary: "plan: split into engineers", evidence_refs: [] }),
      implementer: async (req) => ({
        status: "completed",
        summary: `implemented ${req.task}`,
        evidence_refs: req.task.includes("A") ? ["artifact://diff/a"] : ["artifact://diff/b"],
      }),
      "test-generator": async () => ({
        status: "completed",
        summary: "tests pass",
        evidence_refs: ["artifact://test/log"],
      }),
      reviewer: async () => ({
        status: "completed",
        summary: "approve",
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: {},
      }),
    },
    async () => ({
      status: "completed",
      summary: "ok",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    }),
  );
  return new LegacyAgentRuntime({ worker: fake, maxContextTokens: 128_000 });
}

async function runWorker(
  rt: AgentRuntime,
  role: string,
  objective: string,
): Promise<{ id: RuntimeId; summary: string; artifactRefs: string[] }> {
  const rid = await rt.create({ role, objective, isolation: "none" });
  await rt.sendTask(rid, objective);
  const w = await rt.waitFor(rid, 5_000);
  assert.equal(w.status, "COMPLETED");
  return { id: rid, summary: w.result!.summary, artifactRefs: w.result!.artifactRefs ?? [] };
}

test("canary: Planner → Engineer A/B → Tester → Reviewer works through the AgentRuntime seam", async () => {
  const rt = makeRuntime();

  // Planner
  const plan = await runWorker(rt, "planner", "split migration into A and B");
  assert.ok(plan.summary.includes("split"));

  // Fan-out: Engineer A + Engineer B in parallel (two implementer workers,
  // each with its own isolated runtime id)
  const [a, b] = await Promise.all([
    runWorker(rt, "implementer", "implement feature A"),
    runWorker(rt, "implementer", "implement feature B"),
  ]);
  assert.notEqual(a.id, b.id, "each worker gets an isolated runtime id");
  assert.ok(a.artifactRefs.length >= 1);
  assert.ok(b.artifactRefs.length >= 1);

  // Synthesis (integration) — a single worker that consumes both artifact refs
  const synth = await runWorker(rt, "test-generator", "integrate A and B; run tests");
  assert.ok(synth.summary.includes("pass"));

  // Review
  const review = await runWorker(rt, "reviewer", `review ${a.artifactRefs.join(",")} and ${b.artifactRefs.join(",")}`);
  assert.ok(review.summary.length > 0);

  // All workers visible and bounded outputs available
  const all = await rt.list();
  const roles = all.map((x) => x.role).sort();
  assert.deepEqual(roles, ["implementer", "implementer", "planner", "reviewer", "test-generator"]);
  for (const w of all) {
    const out = await rt.boundedOutput(w.id, 1000);
    assert.ok(out.length > 0);
    assert.ok(out.length <= 1000 + 1, "bounded output is bounded");
  }
});

test("canary: request planner shapes the fan-out so no single request is oversized", () => {
  const refs = Array.from({ length: 24 }, (_, i) => ({ id: `spec${i}`, title: `s${i}`, content: "y".repeat(40_000) }));
  const plan = planRequest({ objective: "migrate runtime", references: refs, maxRequestBytes: 4_000_000 });
  assert.equal(plan.fits, true);
  assert.ok(plan.artifactRefs.length > 0);
  assert.ok(plan.plannedBytes <= plan.byteBudget);
});
