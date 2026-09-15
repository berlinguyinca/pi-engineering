/**
 * Choosing a stand-in model, which is mostly about refusing to.
 *
 * The failure this guards against is subtle: falling back from a large-context
 * model to a small one does not degrade the session, it ends it. A 400k-token
 * conversation moved to a 262k model overflows on the very next request, so the
 * "fix" for a survivable 503 is a hard error. Every rule here is a reason not
 * to switch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FallbackCandidate, chooseFallbackModel } from "../../src/gateway/fallback.ts";

function model(id: string, contextWindow: number, over: Partial<FallbackCandidate> = {}): FallbackCandidate {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow,
    maxTokens: 16_384,
    reasoning: false,
    input: ["text"],
    ...over,
  };
}

// The operator's actual catalogue.
const FLASH = model("deepseek-v4-flash", 1_048_576);
const QWEN_27B = model("qwen3.8-27b", 262_144);
const QWEN_NEXT = model("qwen3.8-flash-next", 262_144);
const QWEN_Q4 = model("qwen3.8-27b-q4-250k", 131_072);
const CATALOGUE = [FLASH, QWEN_27B, QWEN_NEXT, QWEN_Q4];

test("fallback: a session that outgrew every alternative stays put", () => {
  // 400k tokens on the 1M model. Every other model in the catalogue tops out
  // at 262k — switching would overflow before the first token came back.
  const decision = chooseFallbackModel({ current: FLASH, available: CATALOGUE, usedTokens: 400_000 });

  assert.equal(decision.action, "stay");
  assert.match(decision.reason, /can hold 400000 context tokens/);
});

test("fallback: an unknown context size is decisive, not an invitation to guess", () => {
  // Pi reports null right after compaction. The session might be tiny — or the
  // 400k case above. Switching on a guess turns a wait into a failed turn.
  const decision = chooseFallbackModel({ current: FLASH, available: CATALOGUE, usedTokens: null });

  assert.equal(decision.action, "stay");
  assert.match(decision.reason, /unknown/);
});

test("fallback: a small session moves to the model with the most head-room", () => {
  const decision = chooseFallbackModel({ current: FLASH, available: CATALOGUE, usedTokens: 20_000 });

  assert.equal(decision.action, "switch");
  // Both 262k models fit; the tie breaks deterministically rather than flapping.
  assert.equal(decision.action === "switch" ? decision.model.contextWindow : 0, 262_144);
});

test("fallback: the current model is never its own replacement", () => {
  const decision = chooseFallbackModel({ current: FLASH, available: CATALOGUE, usedTokens: 1_000 });
  assert.notEqual(decision.action === "switch" ? decision.model.id : "", FLASH.id);
});

test("fallback: the candidate's own output budget counts against its window", () => {
  // 120k used against a 131k window looks like it fits until the 16k response
  // and head-room are added. Ignoring those is how a fallback "succeeds" and
  // then fails on the reply.
  const decision = chooseFallbackModel({
    current: FLASH,
    available: [FLASH, QWEN_Q4],
    usedTokens: 120_000,
  });

  assert.equal(decision.action, "stay", "131072 < 120000 + 16384 + 8192");
});

test("fallback: head-room is configurable but still enforced", () => {
  const tight = chooseFallbackModel({
    current: FLASH,
    available: [FLASH, QWEN_Q4],
    usedTokens: 114_000,
    headroomTokens: 0,
  });
  assert.equal(tight.action, "switch", "131072 >= 114000 + 16384");

  const padded = chooseFallbackModel({
    current: FLASH,
    available: [FLASH, QWEN_Q4],
    usedTokens: 114_000,
    headroomTokens: 8_192,
  });
  assert.equal(padded.action, "stay", "131072 < 114000 + 16384 + 8192");
});

test("fallback: a switch never silently drops image support", () => {
  const multimodal = model("vision-1m", 1_048_576, { input: ["text", "image"] });
  const textOnly = model("text-262k", 262_144, { input: ["text"] });

  const decision = chooseFallbackModel({
    current: multimodal,
    available: [multimodal, textOnly],
    usedTokens: 10_000,
  });

  assert.equal(decision.action, "stay");
  assert.match(decision.reason, /drop support for text\/image/);
});

test("fallback: a text-only session may move to a multimodal model", () => {
  const textOnly = model("text-1m", 1_048_576, { input: ["text"] });
  const multimodal = model("vision-262k", 262_144, { input: ["text", "image"] });

  const decision = chooseFallbackModel({
    current: textOnly,
    available: [textOnly, multimodal],
    usedTokens: 10_000,
  });

  assert.equal(decision.action, "switch", "gaining a capability is not losing one");
});

test("fallback: with equal windows, reasoning parity breaks the tie", () => {
  const current = model("reasoner-1m", 1_048_576, { reasoning: true });
  const plain = model("a-plain", 262_144, { reasoning: false });
  const thinker = model("z-thinker", 262_144, { reasoning: true });

  const decision = chooseFallbackModel({
    current,
    available: [current, plain, thinker],
    usedTokens: 10_000,
  });

  assert.equal(decision.action === "switch" ? decision.model.id : "", "z-thinker", "id order alone would pick a-plain");
});

test("fallback: an empty catalogue is a stay, not a crash", () => {
  assert.equal(chooseFallbackModel({ current: FLASH, available: [], usedTokens: 1 }).action, "stay");
  assert.equal(chooseFallbackModel({ current: FLASH, available: [FLASH], usedTokens: 1 }).action, "stay");
});

test("fallback: the decision is stable across repeated calls", () => {
  // A flapping choice would switch models every turn under sustained pressure.
  const first = chooseFallbackModel({ current: FLASH, available: CATALOGUE, usedTokens: 20_000 });
  for (let i = 0; i < 5; i++) {
    const again = chooseFallbackModel({ current: FLASH, available: [...CATALOGUE].reverse(), usedTokens: 20_000 });
    assert.equal(
      again.action === "switch" ? again.model.id : "",
      first.action === "switch" ? first.model.id : "",
      "catalogue order must not change the answer",
    );
  }
});
