import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTEXT_THRESHOLDS } from "../../src/context/thresholds.ts";
import {
  type EffectObservation,
  type HandoffFallbackInput,
  decideHandoffFallback,
  reconcileSideEffects,
} from "../../src/runtime/host/handoffRecovery.ts";
import type { HandoffSideEffect } from "../../src/runtime/host/handoffResume.ts";

function effect(id: string, kind: HandoffSideEffect["kind"], committed: boolean): HandoffSideEffect {
  return { id, kind, committed };
}

test("handoff recovery: committed effect -> skip_replay ignoring 'absent'", () => {
  const result = reconcileSideEffects([effect("push-1", "push", true)], { "push-1": "absent" });
  assert.deepEqual(result.verdicts, [{ id: "push-1", verdict: "skip_replay", reason: "already committed" }]);
  assert.equal(result.replaySafe, true);
});

test("handoff recovery: uncommitted push present -> skip_replay", () => {
  const result = reconcileSideEffects([effect("push-1", "push", false)], { "push-1": "present" });
  assert.deepEqual(result.verdicts, [{ id: "push-1", verdict: "skip_replay", reason: "observed present externally" }]);
  assert.equal(result.replaySafe, true);
});

test("handoff recovery: uncommitted comment absent -> replay", () => {
  const result = reconcileSideEffects([effect("comment-1", "comment", false)], { "comment-1": "absent" });
  assert.deepEqual(result.verdicts, [{ id: "comment-1", verdict: "replay", reason: "observed absent" }]);
  assert.equal(result.replaySafe, true);
});

test("handoff recovery: uncommitted merge absent -> manual with replaySafe false", () => {
  const result = reconcileSideEffects([effect("merge-1", "merge", false)], { "merge-1": "absent" });
  assert.deepEqual(result.verdicts, [{ id: "merge-1", verdict: "manual", reason: "merge never auto-replayed" }]);
  assert.equal(result.replaySafe, false);
});

test("handoff recovery: missing observation -> manual 'observation unavailable'", () => {
  const result = reconcileSideEffects([effect("push-1", "push", false)], {});
  assert.deepEqual(result.verdicts, [{ id: "push-1", verdict: "manual", reason: "observation unavailable" }]);
  assert.equal(result.replaySafe, false);
});

test("handoff recovery: mixed list keeps order and one manual makes replaySafe false", () => {
  const effects: HandoffSideEffect[] = [
    effect("push-1", "push", true),
    effect("comment-1", "comment", false),
    effect("merge-1", "merge", false),
    effect("pr-1", "pr_create", false),
  ];
  const observed: Record<string, EffectObservation> = {
    "comment-1": "absent",
    "merge-1": "absent",
    "pr-1": "present",
  };
  const result = reconcileSideEffects(effects, observed);
  assert.deepEqual(result.verdicts, [
    { id: "push-1", verdict: "skip_replay", reason: "already committed" },
    { id: "comment-1", verdict: "replay", reason: "observed absent" },
    { id: "merge-1", verdict: "manual", reason: "merge never auto-replayed" },
    { id: "pr-1", verdict: "skip_replay", reason: "observed present externally" },
  ]);
  assert.equal(result.replaySafe, false);
});

test("handoff recovery: empty list -> { verdicts: [], replaySafe: true }", () => {
  const result = reconcileSideEffects([], {});
  assert.deepEqual(result, { verdicts: [], replaySafe: true });
});

test("handoff recovery: 'resume' -> none", () => {
  const result = decideHandoffFallback({ resumeDecision: "resume", resumeReasons: [], contextUtilization: 0.9 });
  assert.deepEqual(result, { fallback: "none", reason: "resume allowed" });
});

test("handoff recovery: reasons containing 'uncommitted side effect push-1' with utilization 0.9 -> fresh_restart 'unreconciled side effects'", () => {
  const result = decideHandoffFallback({
    resumeDecision: "refuse",
    resumeReasons: ["uncommitted side effect push-1", "handoff record missing"],
    contextUtilization: 0.9,
  });
  assert.deepEqual(result, { fallback: "fresh_restart", reason: "unreconciled side effects" });
});

test("handoff recovery: 'restart_fresh' at the soft level (0.70) -> selective_compaction (boundary)", () => {
  const result = decideHandoffFallback({
    resumeDecision: "restart_fresh",
    resumeReasons: ["no checkpoint"],
    contextUtilization: 0.7,
  });
  assert.deepEqual(result, { fallback: "selective_compaction", reason: "context pressure after failed handoff" });
});

test("handoff recovery: 'refuse' just under the soft level and at null -> fresh_restart", () => {
  const below = decideHandoffFallback({
    resumeDecision: "refuse",
    resumeReasons: ["handoff record missing"],
    contextUtilization: 0.69,
  });
  assert.deepEqual(below, { fallback: "fresh_restart", reason: "handoff failed without context pressure" });

  const atNull = decideHandoffFallback({
    resumeDecision: "refuse",
    resumeReasons: ["handoff record missing"],
    contextUtilization: null,
  });
  assert.deepEqual(atNull, { fallback: "fresh_restart", reason: "handoff failed without context pressure" });
});

test("handoff recovery: inputs not mutated (Object.freeze inputs + deep-equal snapshot)", () => {
  const effects = Object.freeze([
    Object.freeze(effect("push-1", "push", false)),
    Object.freeze(effect("merge-1", "merge", false)),
  ] as readonly HandoffSideEffect[]);
  const observed = Object.freeze({ "push-1": "absent" } as Readonly<Record<string, EffectObservation>>);
  const effectsSnapshot = JSON.stringify(effects);
  const observedSnapshot = JSON.stringify(observed);

  reconcileSideEffects(effects, observed);
  assert.equal(JSON.stringify(effects), effectsSnapshot);
  assert.equal(JSON.stringify(observed), observedSnapshot);

  const fallbackInput = Object.freeze({
    resumeDecision: "restart_fresh",
    resumeReasons: Object.freeze(["no checkpoint"]),
    contextUtilization: 0.8,
  } as HandoffFallbackInput);
  const fallbackSnapshot = JSON.stringify(fallbackInput);

  decideHandoffFallback(fallbackInput);
  assert.equal(JSON.stringify(fallbackInput), fallbackSnapshot);
});

test("handoff recovery: the pressure level comes from the configured threshold, not a literal", () => {
  const input = { resumeDecision: "refuse" as const, resumeReasons: ["no checkpoint"], contextUtilization: 0.6 };
  assert.equal(decideHandoffFallback(input).fallback, "fresh_restart");
  assert.equal(decideHandoffFallback({ ...input, pressureThreshold: 0.5 }).fallback, "selective_compaction");
  assert.equal(
    decideHandoffFallback({ ...input, contextUtilization: DEFAULT_CONTEXT_THRESHOLDS.soft }).fallback,
    "selective_compaction",
    "the default is the soft level of the one threshold triple",
  );
});
