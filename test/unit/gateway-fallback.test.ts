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
import { type FallbackCandidate, chooseFallbackModel, isHealthy } from "../../src/gateway/fallback.ts";

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

// Model ids from a real gateway, with context sizes chosen to exercise the
// decision table. NOTE these are not that gateway's live numbers: it reports
// 262,144 for deepseek-v4-flash, not 1,048,576. The local config said 1,048,576
// and was wrong, which is what /refresh-models exists to fix — see
// test/unit/models-catalog.test.ts for the real values.
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

// ─── Gateway-reported readiness ─────────────────────────────────────────────

test("fallback: readiness outranks head-room", () => {
  // We are falling back because one model had no workers. Moving to another
  // that also has none buys nothing, however much context it could hold.
  const big = model("big-idle", 262_144, { slots: 0 });
  const smaller = model("smaller-warm", 131_072, { slots: 4, state: "warm" });

  const decision = chooseFallbackModel({
    current: FLASH,
    available: [FLASH, big, smaller],
    usedTokens: 10_000,
  });

  assert.equal(decision.action === "switch" ? decision.model.id : "", "smaller-warm");
});

test("fallback: a cold model loses to a warm one of equal size", () => {
  const cold = model("a-cold", 262_144, { state: "cold" });
  const warm = model("z-warm", 262_144, { state: "warm" });

  const decision = chooseFallbackModel({ current: FLASH, available: [FLASH, cold, warm], usedTokens: 10_000 });
  assert.equal(decision.action === "switch" ? decision.model.id : "", "z-warm", "id order alone would pick a-cold");
});

test("fallback: unhealthy is a ranking, not a veto", () => {
  // Health is a snapshot seconds old. Refusing the only model that fits because
  // it was cold at the last poll trades a usable option for a longer wait.
  const onlyOption = model("cold-but-only", 262_144, { slots: 0, state: "cold" });

  const decision = chooseFallbackModel({ current: FLASH, available: [FLASH, onlyOption], usedTokens: 10_000 });
  assert.equal(decision.action, "switch");
  assert.equal(decision.action === "switch" ? decision.model.id : "", "cold-but-only");
});

test("fallback: unknown health is treated as usable", () => {
  // Most catalogues report nothing. Absence of data must not look like bad news.
  const unknown = model("no-health-data", 262_144);
  assert.equal(isHealthy(unknown), true);

  const decision = chooseFallbackModel({ current: FLASH, available: [FLASH, unknown], usedTokens: 10_000 });
  assert.equal(decision.action, "switch");
});

test("fallback: readiness never overrides the context check", () => {
  // A warm model with slots to spare is still the wrong answer if the session
  // does not fit in it.
  const warmButSmall = model("warm-small", 131_072, { slots: 9, state: "warm" });

  const decision = chooseFallbackModel({ current: FLASH, available: [FLASH, warmButSmall], usedTokens: 200_000 });
  assert.equal(decision.action, "stay", "capacity is not a substitute for fitting");
});

test("fallback: the reason names the readiness that drove the choice", () => {
  const warm = model("warm-one", 262_144, { slots: 4, state: "warm" });
  const decision = chooseFallbackModel({ current: FLASH, available: [FLASH, warm], usedTokens: 10_000 });
  assert.match(decision.reason, /4 slot\(s\) free/);
});

test("fallback: among equals, the model with more spare capacity wins", () => {
  // Live data from the gateway: several 262k models differing only in free
  // slots. Alphabetical order is a worse tie-break than "least likely to
  // refuse".
  const busy = model("a-busy", 262_144, { slots: 1, state: "warm" });
  const roomy = model("z-roomy", 262_144, { slots: 9, state: "warm" });

  const decision = chooseFallbackModel({ current: FLASH, available: [FLASH, busy, roomy], usedTokens: 20_000 });
  assert.equal(decision.action === "switch" ? decision.model.id : "", "z-roomy");
});

test("fallback: head-room still outranks spare capacity", () => {
  // Running out of context costs a whole second fallback; a busy model costs a
  // wait. So the bigger window wins even with fewer slots.
  const bigButBusy = model("big-busy", 262_144, { slots: 1, state: "warm" });
  const smallButFree = model("small-free", 131_072, { slots: 9, state: "warm" });

  const decision = chooseFallbackModel({
    current: FLASH,
    available: [FLASH, bigButBusy, smallButFree],
    usedTokens: 20_000,
  });
  assert.equal(decision.action === "switch" ? decision.model.id : "", "big-busy");
});
