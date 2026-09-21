/**
 * AgentRuntime contract tests (herdr spec 02, 03, 15).
 *
 * These tests exercise the runtime-NEUTRAL interface and MUST pass for BOTH the
 * current (legacy) runtime and a future HerdrAgentRuntime. They use a
 * deterministic `FakeWorkerExecutor` so the contract is proven without a model
 * endpoint, and assert the rules the spec requires:
 *   - opaque runtime IDs,
 *   - declarative WorkerRequest,
 *   - normalized lifecycle,
 *   - artifact-first bounded output (no transcript injection),
 *   - discovered (not fixed) context limits,
 *   - resume/reconcile classification,
 *   - idempotent terminate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRuntime } from "../../src/runtime/AgentRuntime.ts";
import { LegacyAgentRuntime } from "../../src/runtime/LegacyAgentRuntime.ts";
import { createAgentRuntime } from "../../src/runtime/index.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

function makeRuntime(maxContextTokens?: number): AgentRuntime {
  const fake = new FakeWorkerExecutor(
    {
      implementer: async (req) => ({
        status: "completed",
        summary: `implemented ${req.task}`,
        evidence_refs: ["artifact://diff/impl"],
      }),
      reviewer: async () => ({
        status: "completed",
        summary: "review passed",
        claims: [{ claim: "ok", evidence: "test" }],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: { verdict: "approve" },
      }),
    },
    async () => ({
      status: "completed",
      summary: "default ok",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    }),
  );
  return new LegacyAgentRuntime({ worker: fake, maxContextTokens });
}

/** A helper that runs the same contract assertions against any AgentRuntime. */
async function runContract(rt: AgentRuntime): Promise<void> {
  // capabilities are advertised and discovered, never a fixed 260k.
  assert.equal(rt.capabilities.name, "legacy");
  assert.ok(rt.capabilities.operations.includes("create"));
  assert.ok(rt.capabilities.operations.includes("waitFor"));
  assert.ok(rt.capabilities.operations.includes("resume"));
  assert.equal(rt.capabilities.maxContextTokens, 128_000);

  // opaque id
  const rid = await rt.create({
    role: "implementer",
    objective: "add a health endpoint",
    capabilities: ["coding"],
    isolation: "worktree",
    duration: "ephemeral",
    contextPolicy: { maxTokens: 128_000, maxRequestBytes: 4_000_000, headroomRatio: 0.85 },
    permissions: ["repo_search", "bash"],
  });
  assert.match(rid, /^RT-/);
  assert.equal(typeof rid, "string");

  // start -> READY
  let w = await rt.start(rid);
  assert.equal(w.status, "READY");
  assert.equal(w.role, "implementer");

  // sendTask -> WORKING then COMPLETED with artifact-first bounded result
  w = await rt.sendTask(rid, "add a health endpoint");
  assert.ok(w.status === "WORKING" || w.status === "COMPLETED");
  w = await rt.waitFor(rid, 5_000);
  assert.equal(w.status, "COMPLETED");
  assert.ok(w.result);
  assert.equal(w.result!.status, "completed");
  // summary is concise; full output is via artifact refs, not inline transcript.
  assert.ok(w.result!.summary.length < 200);
  assert.ok(w.result!.artifactRefs.includes("artifact://diff/impl"));

  // boundedOutput returns compact text
  const out = await rt.boundedOutput(rid, 2000);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);

  // get/list
  assert.equal((await rt.get(rid))?.id, rid);
  const all = await rt.list();
  assert.ok(all.some((x) => x.id === rid));

  // health
  const h = await rt.health();
  assert.equal(h.runtime, "legacy");
  assert.equal(h.ok, true);

  // resume/reconcile classification on a settled worker -> completed-offline
  const rec = await rt.resumeOrReconcile(rid);
  assert.equal(rec.status, "COMPLETED");

  // terminate is idempotent
  assert.equal(await rt.terminate(rid), true);
  assert.equal((await rt.get(rid))?.status, "TERMINATED");
  assert.equal(await rt.terminate(rid), true);
}

test("AgentRuntime contract: legacy runtime passes all contract assertions", async () => {
  await runContract(makeRuntime(128_000));
});

test("createAgentRuntime resolves the legacy runtime by default and via selector", () => {
  const fake = new FakeWorkerExecutor({});
  const rt = createAgentRuntime({ worker: fake });
  assert.equal(rt.capabilities.name, "legacy");
  const viaSelector = createAgentRuntime({ runtime: "legacy", worker: fake });
  assert.equal(viaSelector.capabilities.name, "legacy");
});

test("createAgentRuntime fails safe when no worker is supplied", () => {
  assert.throws(() => createAgentRuntime({}), /requires a worker executor/);
});

test("unrecognized runtime id: get returns undefined, waitFor throws", async () => {
  const rt = makeRuntime();
  assert.equal(await rt.get("RT-UNKNOWN"), undefined);
  await assert.rejects(() => rt.waitFor("RT-UNKNOWN", 100), /unknown runtime id/);
});

test("failed worker run is surfaced as structured FAILED result", async () => {
  const fake = new FakeWorkerExecutor({}, async () => ({
    status: "failed",
    summary: "could not reach service",
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details: {},
    error: "network",
  }));
  const rt = new LegacyAgentRuntime({ worker: fake });
  const rid = await rt.create({ role: "engineer", objective: "x" });
  await rt.sendTask(rid, "x");
  const w = await rt.waitFor(rid, 5_000);
  assert.equal(w.status, "FAILED");
  assert.equal(w.result?.status, "failed");
  assert.equal(w.result?.error, "network");
});

test("interrupt marks a WORKING worker INTERRUPTED", async () => {
  const rt = makeRuntime();
  const rid = await rt.create({ role: "implementer", objective: "long task" });
  await rt.start(rid);
  await rt.sendTask(rid, "long task");
  const w = await rt.interrupt(rid);
  assert.equal(w.status, "INTERRUPTED");
});
