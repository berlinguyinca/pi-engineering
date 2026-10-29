import assert from "node:assert/strict";
import { test } from "node:test";
import { delegationAdvice } from "../../src/execution/delegation.ts";
import type { AutoInvokeDecision } from "../../src/orchestration/autoInvoke.ts";

const engineering: AutoInvokeDecision = { invoke: true, workflow: "engineering", confidence: 0.9, reason: "x" };
const chat: AutoInvokeDecision = { invoke: false, workflow: "conversation", confidence: 0, reason: "short" };

test("direct and adaptive stay silent for engineering prompts", () => {
  for (const p of ["direct", "adaptive"] as const) assert.equal(delegationAdvice(p, engineering).advise, false, p);
});

test("team advises delegation for engineering prompts, never for chat", () => {
  const advice = delegationAdvice("team", engineering);
  assert.equal(advice.advise, true);
  assert.match(advice.message ?? "", /handoff/);
  assert.match(advice.message ?? "", /verification/);
  assert.doesNotMatch(advice.message ?? "", /call the `mission` tool/);
  assert.equal(delegationAdvice("team", chat).advise, false);
});
