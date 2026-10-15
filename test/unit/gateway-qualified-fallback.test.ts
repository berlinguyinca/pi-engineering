/**
 * Issue #158: fallback only to QUALIFIED models, with a cool-down so a model is
 * not re-selected immediately, Retry-After honored with jitter, an explicit
 * bounded BLOCKED decision when nothing qualifies, and no replay of a started
 * side-effecting tool call. The quality floor is never lowered.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import { AdvisedModelSwitch } from "../../src/gateway/advisedSwitch.ts";
import {
  DEFAULT_RETRY_AFTER_MS,
  type FallbackCandidate,
  MAX_BLOCKED_WAIT_MS,
  chooseFallbackModel,
  cooldownUntilFor,
  isQualified,
  jitteredRetryAfterMs,
} from "../../src/gateway/fallback.ts";
import {
  type FallbackApplyDeps,
  type FallbackContext,
  FallbackCoordinator,
  applyPendingFallback,
} from "../../src/gateway/fallbackLifecycle.ts";
import { ALTERNATE_MODEL_ADVICE } from "../../src/gateway/signals.ts";
import { ModelHealthProvider } from "../../src/models/health.ts";

const NOW = 1_000_000;

function cand(id: string, extra: Partial<FallbackCandidate> = {}): FallbackCandidate {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow: 262_144,
    maxTokens: 16_384,
    reasoning: false,
    input: ["text"],
    ...extra,
  };
}

const CURRENT = cand("current-model", { capabilities: ["coding", "tool_use"], tools: true });
const GOOD = cand("good-model", { capabilities: ["coding", "tool_use", "extra"], tools: true });

const choose = (over: Partial<Parameters<typeof chooseFallbackModel>[0]> = {}) =>
  chooseFallbackModel({
    current: CURRENT,
    available: [CURRENT, GOOD],
    usedTokens: 10_000,
    nowMs: NOW,
    random: () => 0,
    ...over,
  });

// --- qualification ------------------------------------------------------------

test("qualified: a candidate without `tools` is never chosen for a tool-using request", () => {
  const noTools = cand("no-tools", { capabilities: ["coding", "tool_use"] });
  const decision = choose({ available: [CURRENT, noTools], need: { tools: true } });
  assert.equal(decision.action, "blocked");
  assert.equal(isQualified(noTools, { tools: true }), false);
  assert.equal(isQualified(cand("explicit-false", { tools: false }), { tools: true }), false);
  assert.equal(isQualified(cand("yes", { tools: true }), { tools: true }), true);
  assert.equal(isQualified(noTools, {}), true, "no tool use, no tool requirement");
});

test("qualified: every required capability must be advertised; unknown capabilities do not qualify", () => {
  assert.equal(isQualified(cand("a", { capabilities: ["coding"] }), { capabilities: ["coding", "vision"] }), false);
  assert.equal(isQualified(cand("a"), { capabilities: ["coding"] }), false);
  assert.equal(isQualified(cand("a", { capabilities: ["coding", "vision"] }), { capabilities: ["coding"] }), true);
});

test("quality floor: the current model's capabilities are the minimum, and `need` can only raise it", () => {
  const weaker = cand("weaker", { capabilities: ["coding"], tools: true });
  assert.equal(choose({ available: [CURRENT, weaker] }).action, "blocked", "drops tool_use the current model has");
  const decision = choose({ available: [CURRENT, GOOD, weaker], need: { capabilities: [] } });
  assert.equal(decision.action, "switch");
  assert.equal(decision.action === "switch" && decision.model.id, "good-model");
  const needsVision = choose({ available: [CURRENT, GOOD], need: { capabilities: ["vision"] } });
  assert.equal(needsVision.action, "blocked");
});

test("qualified: aliases and the default-excluded model are never chosen", () => {
  const alias = cand("route", { capabilities: ["coding", "tool_use"], tools: true, alias: true });
  const excluded = cand("deepseek-v4.1-flash", { capabilities: ["coding", "tool_use"], tools: true });
  assert.equal(choose({ available: [CURRENT, alias, excluded] }).action, "blocked");
  const allowed = choose({ available: [CURRENT, excluded], exclude: [] });
  assert.equal(allowed.action, "switch");
});

// --- cool-down / hysteresis ---------------------------------------------------

test("hysteresis: a model whose cooldownUntil is later than nowMs is skipped, and eligible again at the boundary", () => {
  const cooling = { "good-model": NOW + 1 };
  assert.equal(choose({ cooldownUntil: cooling }).action, "blocked");
  assert.equal(choose({ cooldownUntil: { "good-model": NOW } }).action, "switch");
  assert.equal(choose({ cooldownUntil: { "good-model": NOW - 5 } }).action, "switch");
  const other = cand("other-good", { capabilities: ["coding", "tool_use"], tools: true, contextWindow: 131_072 });
  const decision = choose({ available: [CURRENT, GOOD, other], cooldownUntil: cooling });
  assert.equal(decision.action === "switch" && decision.model.id, "other-good");
});

test("hysteresis: a model just left is not re-selected on the next decision", () => {
  const first = choose({ available: [CURRENT, GOOD] });
  assert.equal(first.action === "switch" && first.model.id, "good-model");
  // The session moved to good-model; current-model is the one just left.
  const cooldown = { "current-model": cooldownUntilFor(NOW, 60_000, () => 0) };
  const back = chooseFallbackModel({
    current: GOOD,
    available: [CURRENT, GOOD],
    usedTokens: 10_000,
    nowMs: NOW + 1_000,
    cooldownUntil: cooldown,
  });
  assert.equal(back.action, "blocked", "no ping-pong back to the model that was just left");
});

// --- BLOCKED bounds / Retry-After ---------------------------------------------

test("blocked: zero qualified candidates give a finite, bounded wait and a reason", () => {
  const decision = choose({ available: [CURRENT], need: { tools: true } });
  assert.equal(decision.action, "stay", "no other model at all is the pre-existing stay");
  const blocked = choose({ available: [CURRENT, cand("x")], need: { tools: true } });
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") return;
  assert.ok(Number.isFinite(blocked.maxWaitMs));
  assert.ok(blocked.maxWaitMs > 0 && blocked.maxWaitMs <= MAX_BLOCKED_WAIT_MS);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= blocked.maxWaitMs);
  assert.match(blocked.reason, /no qualified model/);
});

test("blocked: the wait is never longer than 300000 ms whatever the caller asks", () => {
  const blocked = choose({
    available: [CURRENT, cand("x")],
    need: { tools: true },
    maxWaitMs: 10 * 60_000,
    retryAfterMs: 3_600_000,
  });
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") return;
  assert.equal(MAX_BLOCKED_WAIT_MS, 300_000);
  assert.equal(blocked.maxWaitMs, 300_000);
  assert.ok(blocked.retryAfterMs <= 300_000);
  const small = choose({
    available: [CURRENT, cand("x")],
    need: { tools: true },
    maxWaitMs: 2_000,
    retryAfterMs: 30_000,
  });
  assert.equal(small.action === "blocked" && small.retryAfterMs, 2_000);
});

test("Retry-After is honored with jitter and bounded", () => {
  assert.equal(
    jitteredRetryAfterMs(10_000, () => 0),
    10_000,
    "never earlier than the gateway asked",
  );
  assert.equal(
    jitteredRetryAfterMs(10_000, () => 1),
    12_500,
  );
  const samples = new Set([0, 0.25, 0.5, 0.75, 1].map((r) => jitteredRetryAfterMs(10_000, () => r)));
  assert.ok(samples.size > 1, "jitter actually spreads retries");
  assert.equal(
    jitteredRetryAfterMs(undefined, () => 0),
    DEFAULT_RETRY_AFTER_MS,
  );
  assert.equal(
    jitteredRetryAfterMs(290_000, () => 1, 300_000),
    300_000,
    "capped at the maximum wait",
  );
  assert.equal(
    jitteredRetryAfterMs(-5, () => 0),
    DEFAULT_RETRY_AFTER_MS,
    "a nonsense value is not honored",
  );
  assert.equal(
    cooldownUntilFor(NOW, 10_000, () => 0),
    NOW + 10_000,
  );
});

test("existing refusals stay put: unknown context is a stay, not a blocked", () => {
  assert.equal(choose({ usedTokens: null }).action, "stay");
});

// --- lifecycle: replay safety, BLOCKED surfaced, cool-down carried -------------

type M = Model<any>;
function model(id: string, extra: Record<string, unknown> = {}): M {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow: 262_144,
    maxTokens: 16_384,
    reasoning: false,
    input: ["text"],
    ...extra,
  } as M;
}

function session(current: M, available: M[], notes: string[] = []): FallbackContext {
  return {
    model: current,
    modelRegistry: { getAvailable: () => available },
    getContextUsage: () => ({ tokens: 10_000 }),
    ui: { notify: (m) => void notes.push(m) },
  };
}

function health(entries: Record<string, { capabilities?: string[]; tools?: boolean }>): FallbackApplyDeps["healthFor"] {
  return () => ({ get: (id: string) => entries[id] ?? {} }) as unknown as ModelHealthProvider;
}

const A = () => model("model-a");
const B = () => model("model-b");
const TOOLS_OK = { capabilities: ["coding", "tool_use"], tools: true };

test("lifecycle: a started non-replay-safe tool call prevents the switch; setModel is never called", async () => {
  const coordinator = new FallbackCoordinator({ enabled: true, afterHolds: 1 });
  coordinator.noteToolStarted("bash", "c1");
  coordinator.onGatewayHold({ modelId: "model-a", provider: "metabolomics" });
  const pending = coordinator.claimPending();
  assert.ok(pending);
  assert.equal(pending.toolExecutionStarted, true);
  assert.equal(pending.replaySafe, false);
  const switched: string[] = [];
  const notes: string[] = [];
  const result = await applyPendingFallback(
    { setModel: (m) => switched.push(m.id) > 0, healthFor: health({ "model-a": TOOLS_OK, "model-b": TOOLS_OK }) },
    session(A(), [A(), B()], notes),
    pending,
  );
  assert.equal(result.switched, false);
  assert.equal(result.skipped, "tool-started-not-replay-safe");
  assert.deepEqual(switched, []);
  assert.match(notes.join("\n"), /tool call/);
});

test("lifecycle: read-only tools are replay safe; a new turn clears the flag", async () => {
  const coordinator = new FallbackCoordinator({ enabled: true, afterHolds: 1 });
  coordinator.noteToolStarted("read", "c1");
  coordinator.noteToolStarted("grep", "c2");
  coordinator.onGatewayHold({ modelId: "model-a" });
  const pending = coordinator.claimPending();
  assert.ok(pending);
  assert.equal(pending.toolExecutionStarted, true);
  assert.equal(pending.replaySafe, true);
  const switched: string[] = [];
  const result = await applyPendingFallback(
    {
      setModel: (m) => switched.push(m.id) > 0,
      healthFor: health({ "model-a": TOOLS_OK, "model-b": TOOLS_OK }),
    },
    session(A(), [A(), B()]),
    pending,
  );
  assert.equal(result.switched, true);
  assert.deepEqual(switched, ["model-b"]);

  coordinator.noteToolStarted("edit", "c3");
  coordinator.onTurnStart();
  coordinator.onGatewayHold({ modelId: "model-a" });
  const fresh = coordinator.claimPending();
  assert.equal(fresh?.toolExecutionStarted, undefined);
});

test("lifecycle: an unfinished side-effecting tool makes the switch unsafe until its outcome is recorded", () => {
  const coordinator = new FallbackCoordinator({ enabled: true, afterHolds: 1 });
  coordinator.noteToolStarted("write", "c1");
  coordinator.noteToolStarted("read", "c2");
  coordinator.onGatewayHold({ modelId: "model-a" });
  assert.equal(coordinator.snapshot().replaySafe, false);
  coordinator.noteToolEnded("c1");
  assert.equal(coordinator.snapshot().replaySafe, true, "only the read-only call is still unfinished");
  coordinator.noteToolEnded("c2");
  const done = coordinator.claimPending();
  assert.equal(done?.toolExecutionStarted, undefined, "every call has a recorded result: nothing to run twice");
});

test("lifecycle: no qualified model surfaces an explicit BLOCKED with bounded waits, and nothing is switched", async () => {
  const notes: string[] = [];
  const switched: string[] = [];
  const result = await applyPendingFallback(
    {
      setModel: (m) => switched.push(m.id) > 0,
      // model-b has no tool support but the current model does: the floor is not lowered.
      healthFor: health({ "model-a": TOOLS_OK, "model-b": { capabilities: ["coding"], tools: false } }),
    },
    session(A(), [A(), B()], notes),
    { consecutiveHolds: 3, retryAfterMs: 20_000 },
  );
  assert.equal(result.switched, false);
  assert.equal(result.skipped, "blocked");
  assert.ok(result.blocked);
  assert.ok(result.blocked.maxWaitMs > 0 && result.blocked.maxWaitMs <= MAX_BLOCKED_WAIT_MS);
  assert.ok(result.blocked.retryAfterMs >= 20_000 && result.blocked.retryAfterMs <= result.blocked.maxWaitMs);
  assert.deepEqual(switched, []);
  assert.match(notes.join("\n"), /no qualified model/);
});

test("lifecycle: a qualified stand-in is still used when its health reading proves the floor", async () => {
  const switched: string[] = [];
  const result = await applyPendingFallback(
    {
      setModel: (m) => switched.push(m.id) > 0,
      healthFor: health({ "model-a": TOOLS_OK, "model-b": TOOLS_OK }),
    },
    session(A(), [A(), B()]),
    { consecutiveHolds: 3 },
  );
  assert.equal(result.switched, true);
  assert.deepEqual(switched, ["model-b"]);
});

test("lifecycle: a model in cool-down is not re-selected; the coordinator records the one it left", async () => {
  let now = 5_000_000;
  const coordinator = new FallbackCoordinator({
    enabled: true,
    afterHolds: 1,
    now: () => now,
    switchedFromTtlMs: 60_000,
  });
  coordinator.onSwitched("model-a");
  coordinator.onGatewayHold({ modelId: "model-b" });
  const pending = coordinator.claimPending();
  assert.ok(pending);
  assert.deepEqual(pending.cooldownUntil, { "model-a": now + 60_000 });
  const switched: string[] = [];
  const blocked = await applyPendingFallback(
    {
      now: () => now,
      setModel: (m) => switched.push(m.id) > 0,
      healthFor: health({ "model-a": TOOLS_OK, "model-b": TOOLS_OK }),
    },
    session(B(), [A(), B()]),
    { ...pending, excludeIds: undefined },
  );
  assert.equal(blocked.switched, false, "model-a is cooling down");
  assert.equal(blocked.skipped, "blocked");
  now += 60_001;
  const later = await applyPendingFallback(
    {
      now: () => now,
      setModel: (m) => switched.push(m.id) > 0,
      healthFor: health({ "model-a": TOOLS_OK, "model-b": TOOLS_OK }),
    },
    session(B(), [A(), B()]),
    { ...pending, excludeIds: undefined },
  );
  assert.equal(later.switched, true);
  assert.deepEqual(switched, ["model-a"]);
});

// --- the production health feed ------------------------------------------------

test("health: capabilities, tools and route status from the gateway catalogue reach the fallback candidates", async () => {
  const provider = new ModelHealthProvider({
    baseUrl: "http://gateway.test/v1",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "model-a", ctx_per_request: 262144, x_capabilities: ["coding", "tool_use"], x_tools: true, slots: 2 },
            { id: "model-b", ctx_per_request: 262144, x_capabilities: ["coding"], x_tools: false, slots: 4 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  await provider.refresh();
  assert.deepEqual(provider.get("model-a").capabilities, ["coding", "tool_use"]);
  assert.equal(provider.get("model-a").tools, true);
  assert.equal(provider.get("model-b").tools, false);
  const result = await applyPendingFallback(
    { setModel: () => true, healthFor: () => provider },
    session(A(), [A(), B()]),
    { consecutiveHolds: 3 },
  );
  assert.equal(result.skipped, "blocked", "model-b has slots but not the current model's tool support");
});

// --- the real advised-switch path: settle handler -> coordinator -> applyPendingFallback ----

const failedAdvised = () => ({
  role: "assistant",
  stopReason: "error",
  errorMessage: `429 capacity_unavailable — ${ALTERNATE_MODEL_ADVICE}`,
  content: [],
});

const settleEvent = () =>
  ({
    outcome: "error",
    entries: [],
    context: {
      contextEntries: [
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hi" }] },
        { sourceEntry: { id: "a1" }, messages: [failedAdvised()] },
      ],
    },
  }) as never;

/** The extension's wiring, with the real coordinator and the real applyPendingFallback. */
function advisedPath(opts: { entries: Record<string, { capabilities?: string[]; tools?: boolean }>; available: M[] }) {
  const coordinator = new FallbackCoordinator({ advisedSwitch: true });
  coordinator.noteStandIn(true);
  const switched: string[] = [];
  const owed: number[] = [];
  const notes: string[] = [];
  const ctx = session(A(), opts.available, notes);
  const handler = new AdvisedModelSwitch({
    claimPending: () => coordinator.claimPending(),
    apply: (c, pending) =>
      applyPendingFallback(
        { setModel: (m) => switched.push(m.id) > 0, healthFor: health(opts.entries), random: () => 0 },
        c,
        pending,
      ),
    oweWait: (_c, delayMs) => void owed.push(delayMs),
  });
  const hold = () =>
    coordinator.onGatewayHold({
      modelId: "model-a",
      provider: "metabolomics",
      advisesAlternate: true,
      retryAfterMs: 20_000,
    });
  return { coordinator, handler, hold, ctx, switched, owed, notes };
}

test("advised path: a qualified stand-in takes the turn", async () => {
  const p = advisedPath({ entries: { "model-a": TOOLS_OK, "model-b": TOOLS_OK }, available: [A(), B()] });
  p.hold();
  const result = await p.handler.onBeforeSettle(settleEvent(), p.ctx);
  assert.equal(result?.continue, true);
  assert.deepEqual(p.switched, ["model-b"]);
});

test("advised path: an unqualified stand-in is refused and the bounded Retry-After is owed instead", async () => {
  const p = advisedPath({
    entries: { "model-a": TOOLS_OK, "model-b": { capabilities: ["coding"], tools: false } },
    available: [A(), B()],
  });
  p.hold();
  const result = await p.handler.onBeforeSettle(settleEvent(), p.ctx);
  assert.equal(result?.continue, true, "the turn continues on the current model after the wait");
  assert.deepEqual(p.switched, []);
  assert.deepEqual(p.owed, [20_000], "the declared 20 s, jitter-free here, within MAX_BLOCKED_WAIT_MS");
  assert.ok((p.owed[0] ?? 0) <= MAX_BLOCKED_WAIT_MS);
});

test("advised path: a started side-effecting tool call is not handed to a stand-in", async () => {
  const p = advisedPath({ entries: { "model-a": TOOLS_OK, "model-b": TOOLS_OK }, available: [A(), B()] });
  p.coordinator.noteToolStarted("bash", "call-1");
  p.hold();
  await p.handler.onBeforeSettle(settleEvent(), p.ctx);
  assert.deepEqual(p.switched, [], "no model switch while a bash call has no recorded outcome");
  assert.match(p.notes.join("\n"), /not replay-safe/);
  // Once the call has its outcome the same situation switches.
  p.coordinator.noteToolEnded("call-1");
  p.hold();
  await p.handler.onBeforeSettle(settleEvent(), p.ctx);
  assert.deepEqual(p.switched, ["model-b"]);
});
