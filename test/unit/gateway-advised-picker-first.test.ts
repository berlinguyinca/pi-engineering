/**
 * The advised picker at the FIRST refusal.
 *
 * An IW-ACT-RETRY-ALTERNATE refusal with no stand-in used to be waited out by
 * the pump (up to 15 minutes) before the picker could appear at the settle
 * boundary. Now, when an operator can be asked, the pump abandons the hold at
 * once and the settle boundary goes straight to the picker. Everything here
 * runs through the REAL pump, coordinator and AdvisedModelSwitch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import { PICKER_TIMEOUT_MS } from "../../src/gateway/advisedPicker.ts";
import { AdvisedModelSwitch } from "../../src/gateway/advisedSwitch.ts";
import {
  type FallbackContext,
  FallbackCoordinator,
  applyChosenModel,
  applyPendingFallback,
  canOfferPicker,
} from "../../src/gateway/fallbackLifecycle.ts";
import { SettleRecovery } from "../../src/gateway/settleRecovery.ts";
import { advisesAlternateModel } from "../../src/gateway/signals.ts";
import { pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";

type M = Model<any>;
const model = (id: string, contextWindow: number, input: string[] = ["text"]): M =>
  ({ id, provider: "metabolomics", api: "openai-completions", contextWindow, maxTokens: 4_096, input }) as M;
const SOURCE = () => model("qwen3.8-27b", 262_144);
const TINY = () => model("tiny-8k", 8_192);
const BIG = () => model("deepseek-v4-flash", 1_048_576);

const ADVISED_429 =
  '429: {"message":"Try another eligible deployment after the declared delay.","type":"inferweave_backpressure","code":"capacity_unavailable","reason":"capacity_unavailable","retryable":true,"replay_safe":true,"request_state":"not_started","action":"retry_alternate","action_code":"IW-ACT-RETRY-ALTERNATE","retry_after_ms":20000,"scope":"model","model_intent":"qwen3.8-27b"}';

type Ev = { type: string; [k: string]: unknown };
type Res = { stopReason: string; errorMessage?: string };

function scripted(attempts: Ev[][]) {
  let opened = 0;
  const open = () => {
    const events = attempts[Math.min(opened, attempts.length - 1)] ?? [];
    opened++;
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    const result = (terminal?.message ?? terminal?.error ?? { stopReason: "stop" }) as Res;
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: async () => result,
    };
  };
  return {
    open,
    get opened() {
      return opened;
    },
  };
}
function sink() {
  let ended: Res | undefined;
  return {
    push: (_e: Ev) => {},
    end: (r?: Res) => {
      ended = r;
    },
    get ended() {
      return ended;
    },
  };
}
const refused = (): Ev[] => [{ type: "error", error: { stopReason: "error", errorMessage: ADVISED_429 } }];
const served = (): Ev[] => [
  { type: "text_delta", text: "ok" },
  { type: "done", message: { stopReason: "stop" } },
];

/** One real coordinator wired to the pump the way extensions/index.ts wires it. */
function pumpOnce(c: FallbackCoordinator, attempts: Ev[][]) {
  const s = scripted(attempts);
  const out = sink();
  const held: number[] = [];
  const outcome = pumpWithGatewayRetry(s.open, out, {
    hold: async (signal) => {
      held.push(signal.retryAfterMs);
    },
    onHold: (info) =>
      c.onGatewayHold({
        modelId: "qwen3.8-27b",
        provider: "metabolomics",
        source: info.signal.source,
        accountWide: false,
        advisesAlternate: advisesAlternateModel(info.signal),
        retryAfterMs: info.signal.retryAfterMs,
      }),
    abandonForAlternate: () => c.willAbandonOnAdvice && c.hasPending,
  });
  return { s, out, held, outcome };
}

function ui(
  select?: (options: string[]) => Promise<string | undefined>,
  hasUI = true,
  models: M[] = [SOURCE(), TINY()],
) {
  const c: FallbackContext = {
    model: SOURCE(),
    modelRegistry: { getAvailable: () => models },
    getContextUsage: () => ({ tokens: 20_000 }),
    hasUI,
    ui: {
      notify: () => {},
      ...(select ? { select: (_t: string, options: string[]) => select(options) } : {}),
    },
  };
  return c;
}

function switcher(c: FallbackCoordinator, opts: { timeoutMs?: number } = {}) {
  const set: string[] = [];
  const owed: Array<{ delayMs: number; attempt: number }> = [];
  const deps = {
    setModel: (m: M) => {
      set.push(m.id);
      return true;
    },
  };
  const h = new AdvisedModelSwitch({
    claimPending: () => c.claimPending(),
    apply: (ctx, pending) => applyPendingFallback(deps, ctx, pending),
    applyChosen: (ctx, m, pending) => applyChosenModel(deps, ctx, pending, m),
    oweWait: (_ctx, delayMs, attempt) => owed.push({ delayMs, attempt }),
    noteKeepWaiting: () => c.noteKeepWaiting(),
    noteOperatorDeclined: () => c.noteOperatorDeclined(),
    onSettled: () => c.endEpisode(),
    pickerTimeoutMs: opts.timeoutMs ?? 1_000,
  });
  return { h, set, owed };
}

const settleEvent = (errorMessage: string) =>
  ({
    outcome: "error",
    entries: [],
    context: {
      contextEntries: [
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hi" }] },
        {
          sourceEntry: { id: "a1" },
          messages: [{ role: "assistant", stopReason: "error", errorMessage, content: [] }],
        },
      ],
    },
  }) as never;

const advisedCoordinator = (opts: { picker: boolean; standIn?: boolean }) => {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.noteStandIn(opts.standIn === true);
  c.notePickerAvailable(opts.picker);
  return c;
};

test("the picker timeout is bounded in seconds", () => {
  assert.ok(PICKER_TIMEOUT_MS <= 60_000 && PICKER_TIMEOUT_MS >= 10_000, `${PICKER_TIMEOUT_MS}`);
});

test("canOfferPicker: needs hasUI and a select", () => {
  assert.equal(canOfferPicker(ui(async () => undefined)), true);
  assert.equal(canOfferPicker(ui(async () => undefined, false)), false);
  assert.equal(canOfferPicker(ui(undefined)), false);
});

test("pump: picker armed, no stand-in: the FIRST refusal is abandoned without any hold", async () => {
  const c = advisedCoordinator({ picker: true });
  const { s, held, outcome, out } = pumpOnce(c, [refused(), served()]);
  const r = await outcome;
  assert.equal(r.attempts, 1);
  assert.equal(r.holds, 0);
  assert.equal(s.opened, 1);
  assert.deepEqual(held, [], "no wait of any length was taken");
  assert.equal(r.settled, "error");
  assert.equal(c.hasPending, true);
  assert.equal(c.snapshot().pickerFirst, true);
  assert.match(out.ended?.errorMessage ?? "", /gateway advises an alternate model/);
});

test("pump: headless (picker not armed), no stand-in: the hold is waited out as before", async () => {
  const c = advisedCoordinator({ picker: false });
  const { s, held, outcome } = pumpOnce(c, [refused(), served()]);
  const r = await outcome;
  assert.equal(r.holds, 1);
  assert.equal(s.opened, 2);
  assert.deepEqual(held, [20_000]);
  assert.equal(c.hasPending, false);
});

test("pump: a stand-in on record still wins: abandoned, armed for the automatic switch, not the picker", async () => {
  const c = advisedCoordinator({ picker: true, standIn: true });
  const { held, outcome } = pumpOnce(c, [refused(), served()]);
  const r = await outcome;
  assert.equal(r.holds, 0);
  assert.deepEqual(held, []);
  assert.equal(c.snapshot().pickerFirst, undefined);

  const t = switcher(c);
  let asked = 0;
  const res = await t.h.onBeforeSettle(
    settleEvent(
      "no capacity on this deployment; gateway advises an alternate model — switching automatically if one fits, else switch with /model",
    ),
    ui(
      async (o) => {
        asked++;
        return o[0];
      },
      true,
      [SOURCE(), BIG()],
    ),
  );
  assert.equal(res?.continue, true);
  assert.equal(asked, 0, "automatic switch: no prompt");
  assert.equal(t.set.length, 1);
});

test("end to end: refusal -> picker at once -> operator picks -> switched, nothing waited", async () => {
  const c = advisedCoordinator({ picker: true });
  const { held, outcome, out } = pumpOnce(c, [refused()]);
  await outcome;
  const t = switcher(c);
  const asked: string[][] = [];
  const res = await t.h.onBeforeSettle(
    settleEvent(out.ended?.errorMessage ?? ""),
    ui(async (o) => {
      asked.push(o);
      return o.find((x) => x.startsWith("tiny-8k"));
    }),
  );
  assert.equal(asked.length, 1);
  assert.deepEqual(t.set, ["tiny-8k"]);
  assert.equal(res?.continue, true);
  assert.deepEqual(held, []);
  assert.deepEqual(t.owed, [], "no stay-wait before the prompt");
});

test("keep waiting: the next refusal in the same episode is waited out normally; a settled episode may prompt again", async () => {
  const c = advisedCoordinator({ picker: true });
  const first = pumpOnce(c, [refused()]);
  await first.outcome;
  const t = switcher(c);
  const keep = ui(async (o) => o.find((x) => x.startsWith("Keep waiting")));
  const res = await t.h.onBeforeSettle(settleEvent(first.out.ended?.errorMessage ?? ""), keep);
  assert.equal(res?.continue, true);
  assert.deepEqual(t.owed, [{ delayMs: 20_000, attempt: 1 }]);
  assert.equal(c.willAbandonOnAdvice, false);

  const second = pumpOnce(c, [refused(), served()]);
  const r = await second.outcome;
  assert.equal(r.holds, 1, "waited normally this time");
  assert.deepEqual(second.held, [20_000]);
  assert.equal(r.settled, "ok");
  assert.equal(c.hasPending, false);

  // The run settles: the flag is plain data and resets; a later turn may prompt.
  t.h.register({
    on: (name: string, fn: (e: never, c: never) => unknown) =>
      name === "agent_settled" && fn(undefined as never, undefined as never),
  });
  assert.equal(c.willAbandonOnAdvice, true);
  const third = pumpOnce(c, [refused(), served()]);
  assert.equal((await third.outcome).holds, 0);
});

test("timeout is keep waiting, not cancel: the turn continues on the current model with the normal hold", async () => {
  const c = advisedCoordinator({ picker: true });
  const p = pumpOnce(c, [refused()]);
  await p.outcome;
  const t = switcher(c, { timeoutMs: 20 });
  const res = await t.h.onBeforeSettle(
    settleEvent(p.out.ended?.errorMessage ?? ""),
    ui(() => new Promise(() => {})),
  );
  assert.equal(res?.continue, true);
  assert.deepEqual(t.owed, [{ delayMs: 20_000, attempt: 1 }]);
  assert.equal(c.willAbandonOnAdvice, false, "no re-prompt this episode");
  assert.deepEqual(t.set, []);
});

test("cancel: the turn ends with the advice, and settle recovery does not resume it", async () => {
  const c = advisedCoordinator({ picker: true });
  const p = pumpOnce(c, [refused()]);
  await p.outcome;
  const t = switcher(c);
  const message = p.out.ended?.errorMessage ?? "";
  const res = await t.h.onBeforeSettle(
    settleEvent(message),
    ui(async (o) => o.find((x) => x.startsWith("Cancel"))),
  );
  assert.equal(res, undefined, "no continue: the turn ends");
  assert.match(message, /switch with \/model/, "ends carrying the advice");
  assert.deepEqual(t.owed, []);

  const recoveryOwed: number[] = [];
  const recovery = new SettleRecovery({
    owe: (_c, delayMs) => recoveryOwed.push(delayMs),
    isPaced: () => true,
    hasPendingWait: () => false,
    operatorDeclined: () => c.takeOperatorDeclined(),
  });
  const after = recovery.onBeforeSettle(settleEvent(message) as never, { model: SOURCE() } as never);
  assert.equal(after, undefined);
  assert.deepEqual(recoveryOwed, [], "Cancel is final");
});

test("picker-first falls back to an owed wait when the UI is gone by settle time", async () => {
  const c = advisedCoordinator({ picker: true });
  const p = pumpOnce(c, [refused()]);
  await p.outcome;
  const t = switcher(c);
  const res = await t.h.onBeforeSettle(settleEvent(p.out.ended?.errorMessage ?? ""), ui(undefined, false));
  assert.equal(res?.continue, true);
  assert.deepEqual(t.owed, [{ delayMs: 20_000, attempt: 1 }]);
});

test("a model switch or turn start clears keep waiting; a non-advised refusal never arms the picker", async () => {
  const c = advisedCoordinator({ picker: true });
  c.noteKeepWaiting();
  assert.equal(c.willAbandonOnAdvice, false);
  c.onSwitched("qwen3.8-27b");
  assert.equal(c.willAbandonOnAdvice, true);
  c.noteKeepWaiting();
  c.onModelSelect();
  assert.equal(c.willAbandonOnAdvice, true);
  c.noteKeepWaiting();
  c.onTurnStart();
  assert.equal(c.willAbandonOnAdvice, true);

  const s = scripted([
    [{ type: "error", error: { stopReason: "error", errorMessage: "503 no worker for model" } }],
    served(),
  ]);
  let asked = 0;
  const r = await pumpWithGatewayRetry(s.open, sink(), {
    hold: async () => {},
    abandonForAlternate: () => {
      asked++;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.equal(r.holds, 1);
  assert.equal(BIG().id, "deepseek-v4-flash");
});
