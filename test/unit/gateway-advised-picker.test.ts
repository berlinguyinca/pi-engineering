/**
 * The interactive model picker offered when the gateway advises an alternate
 * model and NO automatic stand-in fits (src/gateway/advisedPicker.ts and the
 * picker path of AdvisedModelSwitch.onBeforeSettle).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import { type PickerEntry, buildPickerEntries, runModelPicker } from "../../src/gateway/advisedPicker.ts";
import { AdvisedModelSwitch, DEFAULT_STAY_WAIT_MS, MAX_STAY_CONTINUES } from "../../src/gateway/advisedSwitch.ts";
import {
  type FallbackContext,
  FallbackCoordinator,
  type PendingFallback,
  applyChosenModel,
  applyPendingFallback,
} from "../../src/gateway/fallbackLifecycle.ts";
import { ALTERNATE_MODEL_ADVICE } from "../../src/gateway/signals.ts";

type M = Model<any>;

function model(id: string, contextWindow: number, input: string[] = ["text"], maxTokens = 4_096): M {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow,
    maxTokens,
    reasoning: false,
    input,
  } as M;
}
const SOURCE = () => model("qwen3.8-27b", 262_144, ["text", "image"]);
const BIG = () => model("deepseek-v4-flash", 1_048_576, ["text", "image"]);
const TINY = () => model("tiny-8k", 8_192, ["text", "image"]);
const TEXT_ONLY = () => model("text-only", 500_000, ["text"]);

const labels = (entries: PickerEntry[]) => entries.map((e) => e.label);

// ─── Pure option builder ────────────────────────────────────────────────────

test("picker options: source and excluded models are left out; wait and cancel trail", () => {
  const entries = buildPickerEntries({
    source: SOURCE(),
    available: [SOURCE(), BIG(), TINY(), model("excluded", 400_000, ["text", "image"])],
    excludeIds: ["excluded"],
    usedTokens: 20_000,
    waitMs: 20_000,
  });
  const text = labels(entries).join("\n");
  assert.doesNotMatch(text, /qwen3\.8-27b ·/, "the failed model is not a choice");
  assert.doesNotMatch(text, /excluded/);
  assert.equal(entries.length, 4, "two models + wait + cancel");
  assert.equal(entries.at(-2)?.choice.kind, "keep-waiting");
  assert.match(entries.at(-2)?.label ?? "", /Keep waiting on qwen3\.8-27b \(retry in 20s\)/);
  assert.equal(entries.at(-1)?.choice.kind, "cancel");
  assert.match(entries.at(-1)?.label ?? "", /Cancel \(end the turn\)/);
});

test("picker options: fitting models come first; non-fitting stay selectable and are marked with the reason", () => {
  const entries = buildPickerEntries({
    source: SOURCE(),
    available: [TINY(), TEXT_ONLY(), BIG()],
    usedTokens: 50_000,
    waitMs: 1_000,
  });
  const models = entries.filter((e) => e.choice.kind === "model");
  assert.deepEqual(
    models.map((e) => (e.choice.kind === "model" ? e.choice.model.id : "")),
    ["deepseek-v4-flash", "text-only", "tiny-8k"],
  );
  assert.doesNotMatch(models[0]?.label ?? "", /⚠/, "a fitting model carries no warning");
  assert.match(models[0]?.label ?? "", /1\.0M/, "context window shown");
  assert.match(models[0]?.label ?? "", /text\+image/, "modalities shown");
  assert.match(models[1]?.label ?? "", /⚠ no image input/);
  assert.match(models[2]?.label ?? "", /⚠ context 8k < 62k needed/);
});

test("picker options: gateway health and slots are shown, and an unhealthy model is marked and sorted last", () => {
  const readings = new Map([
    ["deepseek-v4-flash", { state: "warm", slots: 9 }],
    ["text-only-b", { state: "cold" }],
  ]);
  const entries = buildPickerEntries({
    source: SOURCE(),
    available: [model("text-only-b", 500_000, ["text", "image"]), BIG()],
    usedTokens: 1_000,
    waitMs: 1_000,
    health: { get: (id: string) => readings.get(id) ?? {} },
  });
  assert.match(entries[0]?.label ?? "", /deepseek-v4-flash .*warm, 9 slots/);
  assert.match(entries[1]?.label ?? "", /text-only-b .*⚠ cold/);
});

test("picker options: unknown context use does not mark the context; default wait is used for 0/NaN", () => {
  const entries = buildPickerEntries({
    source: SOURCE(),
    available: [TINY()],
    usedTokens: undefined,
    waitMs: Number.NaN,
  });
  assert.doesNotMatch(entries[0]?.label ?? "", /⚠/);
  assert.match(labels(entries).join("\n"), new RegExp(`retry in ${DEFAULT_STAY_WAIT_MS / 1000}s`));
});

test("picker options: duplicate ids on different providers are disambiguated", () => {
  const a = model("same", 300_000, ["text", "image"]);
  const b = { ...model("same", 300_000, ["text", "image"]), provider: "other" } as M;
  const entries = buildPickerEntries({ source: SOURCE(), available: [a, b], usedTokens: 0, waitMs: 1_000 });
  const l = labels(entries).filter((x) => x.includes("same"));
  assert.equal(new Set(l).size, 2);
});

// ─── Picker outcomes ────────────────────────────────────────────────────────

function entriesFor() {
  return buildPickerEntries({ source: SOURCE(), available: [BIG(), TINY()], usedTokens: 1_000, waitMs: 5_000 });
}

test("runModelPicker: a model label is picked", async () => {
  const entries = entriesFor();
  const outcome = await runModelPicker(async (_t, options) => options[0], entries, { title: "t", timeoutMs: 1_000 });
  assert.equal(outcome.kind, "picked");
  if (outcome.kind === "picked") assert.equal(outcome.model.id, "deepseek-v4-flash");
});

test("runModelPicker: keep waiting carries the delay; cancel and dismissal are cancelled", async () => {
  const entries = entriesFor();
  const wait = await runModelPicker(async (_t, o) => o.find((x) => x.startsWith("Keep waiting")), entries, {
    title: "t",
    timeoutMs: 1_000,
  });
  assert.deepEqual(wait, { kind: "keep-waiting", delayMs: 5_000 });
  const cancel = await runModelPicker(async (_t, o) => o.find((x) => x.startsWith("Cancel")), entries, {
    title: "t",
    timeoutMs: 1_000,
  });
  assert.equal(cancel.kind, "cancelled");
  const dismissed = await runModelPicker(async () => undefined, entries, { title: "t", timeoutMs: 1_000 });
  assert.equal(dismissed.kind, "cancelled");
  const unknown = await runModelPicker(async () => "not an option", entries, { title: "t", timeoutMs: 1_000 });
  assert.equal(unknown.kind, "cancelled");
});

test("runModelPicker: a picker that never answers times out and aborts the dialog", async () => {
  let aborted = false;
  const outcome = await runModelPicker(
    (_t, _o, opts) =>
      new Promise<string | undefined>(() => {
        opts?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
      }),
    entriesFor(),
    { title: "t", timeoutMs: 20 },
  );
  assert.deepEqual(outcome, { kind: "cancelled", reason: "timeout" });
  assert.equal(aborted, true);
});

test("runModelPicker: an external abort cancels; a throwing UI cancels", async () => {
  const ac = new AbortController();
  const p = runModelPicker(() => new Promise<string | undefined>(() => {}), entriesFor(), {
    title: "t",
    timeoutMs: 10_000,
    signal: ac.signal,
  });
  ac.abort();
  assert.equal((await p).kind, "cancelled");
  const thrown = await runModelPicker(
    async () => {
      throw new Error("ui gone");
    },
    entriesFor(),
    { title: "t", timeoutMs: 1_000 },
  );
  assert.equal(thrown.kind, "cancelled");
});

// ─── applyChosenModel ───────────────────────────────────────────────────────

function ctxFor(opts: {
  select?: FallbackContext["ui"] extends infer U ? U : never;
  hasUI?: boolean;
  used?: number;
  models?: M[];
}) {
  const notes: string[] = [];
  const c: FallbackContext & { notes: string[] } = {
    notes,
    model: SOURCE(),
    modelRegistry: { getAvailable: () => opts.models ?? [SOURCE(), TINY()] },
    getContextUsage: () => ({ tokens: opts.used ?? 20_000 }),
    ...(opts.hasUI === undefined ? {} : { hasUI: opts.hasUI }),
    ui: { notify: (m: string) => notes.push(m), ...(opts.select ?? {}) },
  };
  return c;
}

test("applyChosenModel: sets the chosen model and announces it", async () => {
  const set: string[] = [];
  const c = ctxFor({});
  const r = await applyChosenModel(
    {
      setModel: (m) => {
        set.push(m.id);
        return true;
      },
    },
    c,
    { consecutiveHolds: 1 },
    TINY(),
  );
  assert.deepEqual(set, ["tiny-8k"]);
  assert.equal(r.switched, true);
  assert.equal(r.targetId, "tiny-8k");
  assert.match(c.notes.join("\n"), /Switched to tiny-8k/);
});

test("applyChosenModel: refuses (with a notify) when a non-replay-safe tool already started", async () => {
  const set: string[] = [];
  const c = ctxFor({});
  const pending: PendingFallback = { consecutiveHolds: 1, toolExecutionStarted: true, replaySafe: false };
  const r = await applyChosenModel(
    {
      setModel: (m) => {
        set.push(m.id);
        return true;
      },
    },
    c,
    pending,
    TINY(),
  );
  assert.equal(r.switched, false);
  assert.equal(r.skipped, "tool-started-not-replay-safe");
  assert.deepEqual(set, []);
  assert.match(c.notes.join("\n"), /not replay-safe/);
  const safe = await applyChosenModel({ setModel: () => true }, c, { ...pending, replaySafe: true }, TINY());
  assert.equal(safe.switched, true, "replay-safe tools may move");
});

test("applyChosenModel: a declined setModel is not a switch", async () => {
  const r = await applyChosenModel({ setModel: () => false }, ctxFor({}), { consecutiveHolds: 1 }, TINY());
  assert.deepEqual(r, { switched: false, skipped: "set-model-declined" });
});

// ─── AdvisedModelSwitch end to end ──────────────────────────────────────────

const failedAdvised = () => ({
  role: "assistant",
  stopReason: "error",
  errorMessage: `429: capacity — ${ALTERNATE_MODEL_ADVICE}`,
  content: [] as unknown[],
});
const settleEvent = (message: unknown = failedAdvised()) =>
  ({
    outcome: "error",
    entries: [{ type: "custom", customType: "other-handler" }],
    context: {
      contextEntries: [
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hi" }] },
        { sourceEntry: { id: "a1" }, messages: [message] },
      ],
    },
  }) as never;
const REPLAY = {
  entries: [
    { type: "custom", customType: "other-handler" },
    { type: "context_edit", targetId: "a1", replacement: null },
  ],
  continue: true,
};

interface Harness {
  c: FallbackCoordinator;
  h: AdvisedModelSwitch;
  set: string[];
  owed: Array<{ delayMs: number; attempt: number }>;
  asked: Array<{ title: string; options: string[] }>;
}

/** Real coordinator + real applyPendingFallback; `answer` plays the human. */
function harness(opts: {
  answer?: (options: string[]) => string | undefined;
  hang?: boolean;
  owe?: boolean;
  chosen?: boolean;
  timeoutMs?: number;
}): Harness & { ctx: (o?: Parameters<typeof ctxFor>[0]) => FallbackContext } {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  const set: string[] = [];
  const owed: Harness["owed"] = [];
  const asked: Harness["asked"] = [];
  const deps = {
    setModel: (m: M) => {
      set.push(m.id);
      return true;
    },
  };
  const h = new AdvisedModelSwitch({
    claimPending: () => c.claimPending(),
    apply: (ctx, pending) => applyPendingFallback(deps, ctx, pending),
    ...(opts.chosen === false ? {} : { applyChosen: (ctx, m, pending) => applyChosenModel(deps, ctx, pending, m) }),
    ...(opts.owe ? { oweWait: (_c, delayMs, attempt) => owed.push({ delayMs, attempt }) } : {}),
    pickerTimeoutMs: opts.timeoutMs ?? 1_000,
  });
  const ctx = (o: Parameters<typeof ctxFor>[0] = {}) =>
    ctxFor({
      hasUI: true,
      ...o,
      select: {
        select: (title: string, options: string[]) => {
          asked.push({ title, options });
          return opts.hang ? new Promise<string | undefined>(() => {}) : Promise.resolve(opts.answer?.(options));
        },
      } as never,
    });
  return { c, h, set, owed, asked, ctx };
}
const arm = (c: FallbackCoordinator) => {
  c.noteStandIn(true);
  c.onGatewayHold({
    modelId: "qwen3.8-27b",
    provider: "metabolomics",
    source: "body",
    accountWide: false,
    advisesAlternate: true,
    retryAfterMs: 20_000,
  });
};

test("settle picker: no stand-in fits, user picks a marked model: setModel, same replay shape, telemetry picked", async () => {
  const t = harness({ answer: (o) => o.find((x) => x.startsWith("tiny-8k")) });
  arm(t.c);
  const result = await t.h.onBeforeSettle(settleEvent(), t.ctx());
  assert.deepEqual(result, REPLAY);
  assert.deepEqual(t.set, ["tiny-8k"]);
  assert.equal(t.asked.length, 1);
  assert.ok(t.asked[0]?.options.some((o) => o.startsWith("tiny-8k") && o.includes("⚠ context")));
  assert.ok(!t.asked[0]?.options.some((o) => o.startsWith("qwen3.8-27b ·")), "source not listed");
  assert.ok(t.asked[0]?.options.some((o) => o.startsWith("Keep waiting") === false && o.startsWith("Cancel")));
});

test("settle picker: cancel, dismissal and timeout end the turn exactly as before", async () => {
  for (const t of [
    harness({ answer: (o) => o.find((x) => x.startsWith("Cancel")) }),
    harness({ answer: () => undefined }),
    harness({ hang: true, timeoutMs: 20 }),
  ]) {
    arm(t.c);
    assert.equal(await t.h.onBeforeSettle(settleEvent(), t.ctx()), undefined);
    assert.deepEqual(t.set, []);
  }
});

test("settle picker: keep waiting owes the declared delay and replays", async () => {
  const t = harness({ owe: true, answer: (o) => o.find((x) => x.startsWith("Keep waiting")) });
  // Exhaust the automatic stays first, then the picker is offered.
  for (let i = 1; i <= MAX_STAY_CONTINUES; i++) {
    arm(t.c);
    const r = await t.h.onBeforeSettle(settleEvent(), t.ctx({ hasUI: false }));
    assert.deepEqual(r, REPLAY);
  }
  arm(t.c);
  const r = await t.h.onBeforeSettle(settleEvent(), t.ctx());
  assert.deepEqual(r, REPLAY);
  assert.deepEqual(t.owed.at(-1), { delayMs: 20_000, attempt: MAX_STAY_CONTINUES + 1 });
  assert.equal(t.asked.length, 1);
});

test("settle picker: headless (no hasUI, or no select) behaves exactly as today", async () => {
  const headless = harness({ answer: (o) => o[0] });
  arm(headless.c);
  assert.equal(await headless.h.onBeforeSettle(settleEvent(), headless.ctx({ hasUI: false })), undefined);
  assert.equal(headless.asked.length, 0);
  assert.deepEqual(headless.set, []);

  const noSelect = harness({});
  arm(noSelect.c);
  const bare = ctxFor({ hasUI: true });
  assert.equal(await noSelect.h.onBeforeSettle(settleEvent(), bare), undefined);
  assert.deepEqual(noSelect.set, []);
});

test("settle picker: not offered without applyChosen, after visible output, or without the advice", async () => {
  const none = harness({ chosen: false, answer: (o) => o[0] });
  arm(none.c);
  assert.equal(await none.h.onBeforeSettle(settleEvent(), none.ctx()), undefined);
  assert.equal(none.asked.length, 0);

  const t = harness({ answer: (o) => o[0] });
  arm(t.c);
  assert.equal(
    await t.h.onBeforeSettle(
      settleEvent({ ...failedAdvised(), content: [{ type: "text", text: "partial" }] }),
      t.ctx(),
    ),
    undefined,
  );
  assert.equal(
    await t.h.onBeforeSettle(settleEvent({ ...failedAdvised(), errorMessage: "503 no worker" }), t.ctx()),
    undefined,
  );
  assert.equal(t.asked.length, 0);
});

test("settle picker: a pick refused for a started non-replay-safe tool ends the turn with the refusal notified", async () => {
  const t = harness({ answer: (o) => o.find((x) => x.startsWith("tiny-8k")) });
  arm(t.c);
  t.c.noteToolStarted("bash", "c1");
  const c = t.ctx();
  assert.equal(await t.h.onBeforeSettle(settleEvent(), c), undefined);
  assert.deepEqual(t.set, []);
  assert.match((c as FallbackContext & { notes: string[] }).notes.join("\n"), /not replay-safe/);
});

test("settle picker: a successful pick resets the stay counter", async () => {
  const t = harness({ owe: true, answer: (o) => o.find((x) => x.startsWith("tiny-8k")) });
  for (let i = 1; i <= MAX_STAY_CONTINUES; i++) {
    arm(t.c);
    await t.h.onBeforeSettle(settleEvent(), t.ctx({ hasUI: false }));
  }
  arm(t.c);
  assert.deepEqual(await t.h.onBeforeSettle(settleEvent(), t.ctx()), REPLAY, "picker pick");
  // After the pick the automatic stays are available again (counter reset), not the picker.
  arm(t.c);
  const r = await t.h.onBeforeSettle(settleEvent(), t.ctx());
  assert.deepEqual(r, REPLAY);
  assert.equal(t.asked.length, 1, "the second failure waited automatically instead of asking");
});
