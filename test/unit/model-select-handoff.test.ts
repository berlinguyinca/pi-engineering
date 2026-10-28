import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SessionSwitchEffects,
  type SessionSwitchInput,
  applySessionSwitchDecision,
  decideSessionSwitch,
} from "../../src/plannerWorker/sessionHandoff.ts";

/**
 * #350 (C1) — an interactive model switch used to pay for `ctx.compact()` every
 * time the incoming model's window was smaller than the live context. A handoff
 * artifact carries the session across instead: the next model receives what the
 * session decided, not a lossy summary produced for the OLD model's budget.
 *
 * The contract these tests hold:
 * - a handoff-preferred switch emits exactly ONE transition entry and ZERO
 *   `ctx.compact()` calls;
 * - `selective_compaction` stays reachable as the last-resort fallback;
 * - a switch that fits needs neither.
 */

function recorder(): SessionSwitchEffects & { calls: string[]; contexts: string[]; notices: string[] } {
  const calls: string[] = [];
  const contexts: string[] = [];
  const notices: string[] = [];
  return {
    calls,
    contexts,
    notices,
    recordContext: (context) => contexts.push(context),
    transfer: () => calls.push("transfer"),
    persist: async () => {
      calls.push("persist");
    },
    notify: (message) => notices.push(message),
    compact: () => calls.push("compact"),
  };
}

/** A context far too large for the incoming model's window. */
function oversized(next: SessionSwitchInput["next"]): SessionSwitchInput {
  return {
    next,
    contextTokens: 180_000,
    sessionId: "session-1",
    messages: [
      { role: "user", text: "Make the mission strip show why each mission needs attention." },
      { role: "assistant", text: "I derived attention from counters and timestamps, then wired the strip." },
    ],
  };
}

/** A switch that needs no compaction transfers through a handoff. */
test("a model switch crosses context by handoff, not by compaction", async () => {
  const decision = decideSessionSwitch(oversized({ id: "small-model", contextWindow: 32_000 }));
  assert.equal(decision.action, "handoff", "the handoff is preferred over the legacy compact plan");

  const effects = recorder();
  await applySessionSwitchDecision(decision, "small-model", effects);

  assert.deepEqual(effects.calls, ["transfer", "persist"], "one handoff transfer, persisted once");
  assert.deepEqual(effects.contexts, ["handoff"], "exactly one transition entry");
  assert.ok(!effects.calls.includes("compact"), "ctx.compact() is never called on the handoff path");
  assert.match(effects.notices.join(" "), /no compaction/, "the operator is told compaction was avoided");
});

/**
 * Regression: when a handoff cannot be built, the switch must still cross the
 * boundary. `selective_compaction` is the documented last resort, and deleting it
 * would turn an unbuildable handoff into a refused switch.
 */
test("selective_compaction still fires when a handoff cannot be built", async () => {
  const input = oversized({ id: "small-model", contextWindow: 32_000 });
  // No user turn at all: buildSessionHandoff fails with "no user message to hand off".
  const decision = decideSessionSwitch({ ...input, messages: [{ role: "assistant", text: "carry on" }] });
  assert.equal(decision.action, "compact", "the fallback plan is reached, not a rejection");

  const effects = recorder();
  await applySessionSwitchDecision(decision, "small-model", effects);

  assert.deepEqual(effects.contexts, ["compact"]);
  assert.deepEqual(effects.calls, ["compact"], "compaction is the only effect on the fallback path");
  assert.match(effects.notices.join(" "), /only after compaction/, "the operator is told what it will cost");
});

/** A switch that fits needs neither a handoff nor compaction. */
test("a switch that fits directly does neither", async () => {
  const decision = decideSessionSwitch({
    ...oversized({ id: "big-model", contextWindow: 1_000_000 }),
    contextTokens: 1_000,
  });
  assert.equal(decision.action, "direct");

  const effects = recorder();
  await applySessionSwitchDecision(decision, "big-model", effects);

  assert.deepEqual(effects.calls, []);
  assert.deepEqual(effects.contexts, ["direct"]);
});

/**
 * Documents current behaviour for an unknown context size: it is read as zero, so
 * the switch is planned as a direct fit. That is optimistic — a session whose size
 * the host could not measure may cross into a window that cannot hold it, with no
 * handoff prepared. Recorded as a follow-up rather than changed here: #350 is gated
 * on a human live-run, and silently changing fit arithmetic inside a gated issue
 * would move the thing being verified.
 */
test("an unknown context size is currently read as fitting directly", () => {
  const decision = decideSessionSwitch({
    ...oversized({ id: "small-model", contextWindow: 32_000 }),
    contextTokens: null,
  });

  assert.equal(decision.action, "direct");
});
