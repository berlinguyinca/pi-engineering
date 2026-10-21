/**
 * Unit C1 (#350): the interactive `model_select` path prefers a bounded
 * session handoff over native compaction.
 *
 * AC: a model switch where the handoff takes priority emits exactly ONE
 * handoff entry (transition context "handoff") and ZERO `ctx.compact()`
 * calls; `selective_compaction` stays reachable as the fallback when the
 * handoff cannot be built or fits nowhere.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type SessionSwitchDecision,
  type SessionSwitchEffects,
  applySessionSwitchDecision,
  buildSessionHandoff,
  decideSessionSwitch,
  messageText,
  sessionBranchMessages,
} from "../../src/plannerWorker/sessionHandoff.ts";

// ── buildSessionHandoff ─────────────────────────────────────────────────────

const sessionMessages = [
  { role: "user", text: "Add a /health endpoint to the gateway" },
  { role: "assistant", text: "I will add the endpoint in src/gateway/routes.ts." },
  { role: "user", text: "Now also add metrics for it" },
];

describe("buildSessionHandoff", () => {
  it("builds a committed context handoff from the latest user ask", () => {
    const result = buildSessionHandoff({ sessionId: "sess-42", messages: sessionMessages });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.state, "committed");
    assert.equal(result.artifact.kind, "planner_to_worker");
    assert.equal(result.artifact.mission_id, "session:sess-42");
    // The LATEST user message is the mission summary / objective.
    assert.equal(result.artifact.mission_summary, "Now also add metrics for it");
    assert.equal(result.artifact.objective, "Now also add metrics for it");
    assert.deepEqual(result.artifact.architectural_context, ["I will add the endpoint in src/gateway/routes.ts."]);
    assert.equal(result.artifact.from_role, "planner");
    assert.equal(result.artifact.to_role, "implementer");
    assert.ok(result.tokenEstimate > 0);
    assert.equal(result.tokenEstimate, result.artifact.token_estimate);
    assert.ok(result.rendered.length > 0);
  });

  it("bounds the summary to the handoff clip cap", () => {
    const huge = "x".repeat(10_000);
    const result = buildSessionHandoff({ sessionId: "s", messages: [{ role: "user", text: huge }] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // clip() keeps 1500 chars plus a truncation marker (≤ 40 extra).
    assert.ok(
      result.artifact.mission_summary.length <= 1_540,
      `summary must be bounded, got ${result.artifact.mission_summary.length}`,
    );
    assert.match(result.artifact.mission_summary, /\[truncated 8500 chars\]/);
  });

  it("fails when there is no user message to hand off", () => {
    const result = buildSessionHandoff({ sessionId: "s", messages: [{ role: "assistant", text: "hello" }] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /no user message/);
  });

  it("fails on an empty session", () => {
    assert.equal(buildSessionHandoff({ sessionId: "s", messages: [] }).ok, false);
  });
});

// ── decideSessionSwitch ─────────────────────────────────────────────────────

describe("decideSessionSwitch", () => {
  it("passes through when the context fits directly", () => {
    const decision = decideSessionSwitch({
      next: { id: "big-model", provider: "p", contextWindow: 200_000 },
      contextTokens: 50_000,
      sessionId: "s",
      messages: sessionMessages,
    });
    assert.deepEqual(decision, { action: "direct" });
  });

  it("prefers the handoff when the context does not fit but the handoff does", () => {
    const decision = decideSessionSwitch({
      next: { id: "small-window", provider: "p", contextWindow: 200_000 },
      contextTokens: 197_000, // 197_000 + 4_096 reserve > 200_000 → does not fit
      sessionId: "s",
      messages: sessionMessages,
    });
    assert.equal(decision.action, "handoff");
    if (decision.action !== "handoff") return;
    assert.equal(decision.artifact.kind, "planner_to_worker");
    assert.ok(decision.tokenEstimate + 4_096 <= 200_000, "handoff + reserve must fit the window");
  });

  it("falls back to compaction when no handoff can be built (no user message)", () => {
    const decision = decideSessionSwitch({
      next: { id: "small-window", provider: "p", contextWindow: 200_000 },
      contextTokens: 197_000,
      sessionId: "s",
      messages: [{ role: "assistant", text: "only assistant text" }],
    });
    assert.equal(decision.action, "compact");
  });

  it("falls back to compaction when the handoff itself does not fit", () => {
    const huge = "y".repeat(90_000); // ~22.5k tokens of handoff > 20k window - reserve
    const decision = decideSessionSwitch({
      next: { id: "small-window", provider: "p", contextWindow: 20_000 },
      contextTokens: 50_000,
      sessionId: "s",
      messages: [{ role: "user", text: huge }],
    });
    assert.equal(decision.action, "compact");
  });

  it("rejects when neither the handoff nor compaction is possible", () => {
    // window 1_000 < reserve*2 → compaction is not viable; handoff (≥ reserve)
    // cannot fit either.
    const decision = decideSessionSwitch({
      next: { id: "tiny", provider: "p", contextWindow: 1_000 },
      contextTokens: 5_000,
      sessionId: "s",
      messages: sessionMessages,
    });
    assert.equal(decision.action, "reject");
    if (decision.action !== "reject") return;
    assert.ok(decision.reasons.length > 0);
  });

  it("treats unknown context size as 0 (fits directly)", () => {
    const decision = decideSessionSwitch({
      next: { id: "m", provider: "p", contextWindow: 100_000 },
      contextTokens: null,
      sessionId: "s",
      messages: sessionMessages,
    });
    assert.deepEqual(decision, { action: "direct" });
  });
});

// ── applySessionSwitchDecision: the AC — one handoff entry, zero compact ────

function countingEffects(): SessionSwitchEffects & {
  contexts: string[];
  persists: number;
  compacts: number;
  notifications: Array<{ message: string; level: string }>;
} {
  const e: SessionSwitchEffects & {
    contexts: string[];
    persists: number;
    compacts: number;
    notifications: Array<{ message: string; level: string }>;
  } = {
    contexts: [],
    persists: 0,
    compacts: 0,
    notifications: [],
    recordContext: (context) => {
      e.contexts.push(context);
    },
    persist: async () => {
      e.persists += 1;
    },
    notify: (message, level) => {
      e.notifications.push({ message, level });
    },
    compact: () => {
      e.compacts += 1;
    },
  };
  return e;
}

describe("applySessionSwitchDecision", () => {
  it("handoff path: exactly one handoff entry, exactly one persist, ZERO compact calls", async () => {
    const built = buildSessionHandoff({ sessionId: "s", messages: sessionMessages });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const decision: SessionSwitchDecision = {
      action: "handoff",
      artifact: built.artifact,
      rendered: built.rendered,
      tokenEstimate: built.tokenEstimate,
      reason: "handoff fits",
    };
    const e = countingEffects();
    await applySessionSwitchDecision(decision, "p/small-window", e);
    assert.deepEqual(e.contexts, ["handoff"], "exactly one transition entry, context=handoff");
    assert.equal(e.persists, 1);
    assert.equal(e.compacts, 0, "the handoff path must never compact");
    assert.equal(e.notifications.length, 1);
    assert.equal(e.notifications[0]!.level, "info");
    assert.match(e.notifications[0]!.message, /via handoff/);
  });

  it("compact path: the fallback reaches compact exactly once", async () => {
    const e = countingEffects();
    await applySessionSwitchDecision({ action: "compact", reason: "no handoff" }, "p/small-window", e);
    assert.deepEqual(e.contexts, ["compact"]);
    assert.equal(e.compacts, 1);
    assert.equal(e.persists, 0);
  });

  it("reject path: error notification, no compact, no persist", async () => {
    const e = countingEffects();
    await applySessionSwitchDecision({ action: "reject", reasons: ["no fit"] }, "p/tiny", e);
    assert.deepEqual(e.contexts, ["direct"]);
    assert.equal(e.compacts, 0);
    assert.equal(e.persists, 0);
    assert.equal(e.notifications[0]!.level, "error");
  });

  it("direct path: only the transition entry", async () => {
    const e = countingEffects();
    await applySessionSwitchDecision({ action: "direct" }, "p/big", e);
    assert.deepEqual(e.contexts, ["direct"]);
    assert.equal(e.compacts, 0);
    assert.equal(e.persists, 0);
    assert.equal(e.notifications.length, 0);
  });
});

// ── session branch extraction ───────────────────────────────────────────────

describe("sessionBranchMessages / messageText", () => {
  it("keeps only user/assistant message entries and extracts text", () => {
    const sm = {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "do the thing" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "ok" },
              { type: "image", data: "xx" },
            ],
          },
        },
        { type: "message", message: { role: "toolResult", content: "tool noise" } },
        { type: "compaction", summary: "should be skipped" },
        { type: "model_change", provider: "p", modelId: "m" },
        { type: "message", message: { role: "assistant", content: null } },
      ],
    };
    const messages = sessionBranchMessages(sm);
    assert.deepEqual(messages, [
      { role: "user", text: "do the thing" },
      { role: "assistant", text: "ok" },
      { role: "assistant", text: "" }, // null content → empty text (skipped later by the builder)
    ]);
  });

  it("messageText handles strings, block arrays, and junk", () => {
    assert.equal(messageText("plain"), "plain");
    assert.equal(
      messageText([
        { type: "text", text: "a" },
        { type: "toolCall", name: "bash" },
        { type: "text", text: "b" },
      ]),
      "a\nb",
    );
    assert.equal(messageText(null), "");
    assert.equal(messageText(42), "");
  });
});
