/**
 * APS Phase 5 — escalation: bounded, deterministic escalation decisions,
 * distinct-model selection, and escalation events/prompts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEscalationEvent,
  buildEscalationPrompt,
  selectEscalationModel,
  shouldEscalate,
} from "../../src/aps/escalation.ts";

test("shouldEscalate is true within budget after the prevention threshold", () => {
  assert.equal(shouldEscalate(1, 0), true);
  assert.equal(shouldEscalate(2, 0), true);
});

test("shouldEscalate is false when disabled", () => {
  assert.equal(shouldEscalate(5, 0, { enabled: false }), false);
});

test("shouldEscalate is false below the prevention threshold", () => {
  assert.equal(shouldEscalate(0, 0), false);
  assert.equal(shouldEscalate(1, 0, { escalateAfterPreventions: 2 }), false);
});

test("shouldEscalate is false once the per-run budget is exhausted", () => {
  assert.equal(shouldEscalate(3, 1), false); // default maxEscalationsPerRun=1
  assert.equal(shouldEscalate(3, 2, { maxEscalationsPerRun: 2 }), false);
});

test("selectEscalationModel picks a distinct model and never the current", () => {
  const target = selectEscalationModel("m1", [{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
  assert.equal(target?.id, "m2");
});

test("selectEscalationModel prefers the pinned escalation model", () => {
  const target = selectEscalationModel("m1", [{ id: "m1" }, { id: "m2" }, { id: "m3" }], "m3");
  assert.equal(target?.id, "m3");
});

test("selectEscalationModel returns null when no distinct model exists", () => {
  assert.equal(selectEscalationModel("m1", [{ id: "m1" }]), null);
  assert.equal(selectEscalationModel("m1", []), null);
});

test("selectEscalationModel ignores a pinned model equal to the current one", () => {
  const target = selectEscalationModel("m1", [{ id: "m1" }, { id: "m2" }], "m1");
  assert.equal(target?.id, "m2");
});

test("buildEscalationPrompt names the reason and demands a fresh decisive approach", () => {
  const p = buildEscalationPrompt("loop_prevented_after_recovery");
  assert.match(p, /escalation model/);
  assert.match(p, /loop_prevented_after_recovery/);
  assert.match(p, /different, decisive/);
});

test("buildEscalationEvent flags human escalation when no model target", () => {
  const e = buildEscalationEvent({
    sessionId: "s",
    runId: "r",
    workItemId: "WI-1",
    role: "implementer",
    fromModel: "m1",
    toModel: null,
    reason: "loop_prevented_after_recovery",
    attempt: 1,
  });
  assert.equal(e.type, "agent.escalation");
  assert.equal(e.escalatedToHuman, true);
  assert.equal(e.humanReviewRequested, true);
  assert.equal(e.toModel, null);
});

test("buildEscalationEvent records a model escalation target", () => {
  const e = buildEscalationEvent({
    sessionId: "s",
    runId: "r",
    workItemId: "WI-1",
    role: "implementer",
    fromModel: "m1",
    toModel: "m2",
    reason: "loop_prevented_after_recovery",
    attempt: 1,
  });
  assert.equal(e.toModel, "m2");
  assert.equal(e.escalatedToHuman, false);
});
