/** T06 — optional task authority + model provenance on `AgentAction`: pure helpers, additive fields. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeModelProvenance, describeTaskProvenance, isKnownTaskProvenance } from "../../src/aps/types.ts";
import type { AgentAction } from "../../src/aps/types.ts";

const HASH = `sha256:${"0a1b2c3d4e5f6789".repeat(4)}`; // sha256: + 64 lowercase hex
const hex = (c: string, n = 64) => `sha256:${c.repeat(n)}`;

/** Every unattributable shape: unknown state, reason matching `want`, never narrowed as known. */
const checkUnknown = (authority: unknown, taskId: unknown, want: RegExp) => {
  const p = describeTaskProvenance({ authority, taskId });
  assert.equal(p.state, "unknown", JSON.stringify([String(authority), taskId]));
  assert.match(p.state === "unknown" ? p.reason : "", want);
  assert.equal(isKnownTaskProvenance(p), false);
};

test("a well-formed authority hash + trimmed task id is known and carries both", () => {
  const known = { state: "known" as const, authority: HASH, taskId: "t-42" };
  assert.deepEqual(describeTaskProvenance({ authority: HASH, taskId: "  t-42  " }), known);
  assert.equal(isKnownTaskProvenance(known), true);
});

test("absent, malformed or non-string authority and a blank task id are unknown, each reason naming the failure", () => {
  const missing = { state: "unknown" as const, reason: "missing authority hash" };
  assert.deepEqual(describeTaskProvenance({ taskId: "t" }), missing);
  assert.deepEqual(describeTaskProvenance({ authority: null, taskId: "t" }), missing);
  assert.deepEqual(describeTaskProvenance({ authority: "", taskId: "t" }), missing);
  for (const a of ["sha256:abc", hex("A"), hex("0", 63), 42, { h: HASH }, true]) checkUnknown(a, "t", /malformed/);
  for (const t of ["", "   ", undefined, 7]) checkUnknown(HASH, t, /task id/);
  assert.equal(isKnownTaskProvenance(undefined), false);
});

test("model provenance reads quantization from the id; every absent or non-string part is null", () => {
  const q = { provider: "openrouter", model: "qwen3.8-max_next-quant-int8", quantization: "int8" };
  assert.deepEqual(describeModelProvenance({ provider: " openrouter ", modelId: "qwen3.8-max_next-quant-int8" }), q);
  assert.equal(describeModelProvenance({ modelId: "qwen3.8-flash_next" }).quantization, null);
  const none = { provider: null, model: null, quantization: null };
  assert.deepEqual(describeModelProvenance({}), none);
  assert.deepEqual(describeModelProvenance({ provider: 7, modelId: { id: "x" } }), none);
});

test("an action built with only the pre-existing required fields still typechecks, provenance absent", () => {
  const legacy: AgentAction = {
    role: "implementer",
    iteration: 0,
    tool: "read",
    normalizedArguments: {},
    toolResultSummary: "ok",
    contentFingerprint: HASH,
    phase: "execute",
    sessionId: "s-1",
    runId: "r-1",
    workItemId: null,
  };
  assert.equal(legacy.taskProvenance, undefined); // absent, not `unknown`: nothing recorded it (T06 wires no producer)
  assert.equal(legacy.modelProvenance, undefined);
  assert.equal(isKnownTaskProvenance(legacy.taskProvenance), false);
});
