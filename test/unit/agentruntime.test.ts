/**
 * AgentRuntime contract tests — LEGACY runtime (herdr spec 02/03/15).
 *
 * The same contract assertions in `agentruntime-contract.ts` are run against
 * BOTH the legacy runtime (here) and the Herdr runtime
 * (`test/unit/herdr-runtime.test.ts`). A deterministic FakeWorkerExecutor backs
 * the legacy adapter so no model endpoint is required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRuntime } from "../../src/runtime/AgentRuntime.ts";
import { LegacyAgentRuntime } from "../../src/runtime/LegacyAgentRuntime.ts";
import { createAgentRuntime } from "../../src/runtime/index.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { runAgentRuntimeContract } from "./agentruntime-contract.ts";

function makeRuntime(maxContextTokens?: number): AgentRuntime {
  const fake = new FakeWorkerExecutor(
    {
      implementer: async (req) => ({
        status: "completed",
        summary: `implemented ${req.task}`,
        evidence_refs: ["artifact://diff/impl"],
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

test("AgentRuntime contract: legacy runtime passes all contract assertions", async () => {
  await runAgentRuntimeContract(makeRuntime(128_000));
});

test("createAgentRuntime resolves the legacy runtime by default and via selector", async () => {
  const fake = new FakeWorkerExecutor({});
  const rt = await createAgentRuntime({ worker: fake });
  assert.equal(rt.capabilities.name, "legacy");
  const viaSelector = await createAgentRuntime({ runtime: "legacy", worker: fake });
  assert.equal(viaSelector.capabilities.name, "legacy");
});

test("createAgentRuntime fails safe when no worker is supplied", async () => {
  await assert.rejects(() => createAgentRuntime({}), /requires a worker executor/);
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
