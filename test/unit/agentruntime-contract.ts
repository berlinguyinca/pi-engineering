/**
 * Shared AgentRuntime contract assertions (herdr spec 02/03/15).
 *
 * Both the legacy runtime and the Herdr runtime must satisfy these. Imported by
 * the per-runtime test files. This file is not a test itself (no `.test.ts`).
 */

import assert from "node:assert/strict";
import type { AgentOperation, AgentRuntime } from "../../src/runtime/AgentRuntime.ts";

export async function runAgentRuntimeContract(rt: AgentRuntime): Promise<void> {
  // capabilities advertised; context ceiling is discovered, not fixed at 260k.
  assert.ok(["legacy", "herdr"].includes(rt.capabilities.name));
  const ops: AgentOperation[] = [
    "create",
    "start",
    "sendTask",
    "get",
    "list",
    "boundedOutput",
    "waitFor",
    "interrupt",
    "terminate",
    "resume",
    "health",
  ];
  for (const op of ops) {
    assert.ok(rt.capabilities.operations.includes(op), `missing operation ${op}`);
  }

  // opaque runtime id
  const rid = await rt.create({
    role: "implementer",
    objective: "add a health endpoint",
    capabilities: ["coding"],
    isolation: "none",
    duration: "ephemeral",
    contextPolicy: { maxTokens: 128_000, maxRequestBytes: 4_000_000, headroomRatio: 0.85 },
    permissions: ["repo_search", "bash"],
  });
  assert.equal(typeof rid, "string");
  assert.ok(rid.length > 0);

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
  assert.ok(w.result!.summary.length < 200, "summary must be concise");

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
  assert.equal(typeof h.ok, "boolean");

  // resume/reconcile classification
  const rec = await rt.resumeOrReconcile(rid);
  assert.ok(["COMPLETED", "RECOVERING", "READY", "LOST"].includes(rec.status));

  // terminate idempotent
  assert.equal(await rt.terminate(rid), true);
  assert.equal((await rt.get(rid))?.status, "TERMINATED");
  assert.equal(await rt.terminate(rid), true);
}
