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
import { AdvisedModelSwitch, MAX_PICKER_TIMEOUTS } from "../../src/gateway/advisedSwitch.ts";
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

const hang = () => new Promise<string | undefined>(() => {});

async function refuseThenSettle(
  c: FallbackCoordinator,
  t: ReturnType<typeof switcher>,
  answer: () => Promise<string | undefined>,
  options?: string[][],
) {
  const p = pumpOnce(c, [refused()]);
  const r = await p.outcome;
  const res = await t.h.onBeforeSettle(
    settleEvent(p.out.ended?.errorMessage ?? ""),
    ui(async (o) => {
      options?.push(o);
      return answer();
    }),
  );
  return { r, res };
}

test("timeout takes the owed wait once and replays, but does NOT suppress the picker", async () => {
  const c = advisedCoordinator({ picker: true });
  const t = switcher(c, { timeoutMs: 20 });
  const { res } = await refuseThenSettle(c, t, hang);
  assert.equal(res?.continue, true);
  assert.deepEqual(t.owed, [{ delayMs: 20_000, attempt: 1 }]);
  assert.equal(c.willAbandonOnAdvice, true, "the next refusal prompts again");
  assert.deepEqual(t.set, []);
});

test("timeout then the next refusal offers the picker again; an explicit keep waiting does not", async () => {
  const c = advisedCoordinator({ picker: true });
  const t = switcher(c, { timeoutMs: 20 });
  const shown: string[][] = [];
  await refuseThenSettle(c, t, hang, shown);
  assert.equal(shown.length, 1);
  const again = await refuseThenSettle(c, t, async () => undefined, shown);
  assert.equal(again.r.holds, 0, "abandoned for the picker again");
  assert.equal(shown.length, 2);

  const c2 = advisedCoordinator({ picker: true });
  const t2 = switcher(c2);
  const shown2: string[][] = [];
  await refuseThenSettle(c2, t2, async () => shown2[0]?.find((x) => x.startsWith("Keep waiting")), shown2);
  const next = await pumpOnce(c2, [refused(), served()]).outcome;
  assert.equal(next.holds, 1, "waited, no picker");
  assert.equal(shown2.length, 1);
});

test("timeout with no oweWait seam still ends the turn", async () => {
  const c = advisedCoordinator({ picker: true });
  const p = pumpOnce(c, [refused()]);
  await p.outcome;
  const h = new AdvisedModelSwitch({
    claimPending: () => c.claimPending(),
    apply: async () => ({ switched: false }),
    applyChosen: async () => ({ switched: false }),
    pickerTimeoutMs: 20,
  });
  assert.equal(await h.onBeforeSettle(settleEvent(p.out.ended?.errorMessage ?? ""), ui(hang)), undefined);
});

test("repeated timeouts are bounded: the picker is shown at most MAX_PICKER_TIMEOUTS times, then the episode waits", async () => {
  assert.ok(MAX_PICKER_TIMEOUTS <= 3, "an unattended session must give up quickly");
  const c = advisedCoordinator({ picker: true });
  const t = switcher(c, { timeoutMs: 2 });
  let shown = 0;
  const countingHang = () => {
    shown++;
    return hang();
  };
  for (let i = 0; i < MAX_PICKER_TIMEOUTS - 1; i++) {
    await refuseThenSettle(c, t, countingHang);
    assert.equal(c.willAbandonOnAdvice, true, `timeout ${i + 1} still prompts next time`);
  }
  await refuseThenSettle(c, t, countingHang);
  assert.equal(shown, MAX_PICKER_TIMEOUTS, "shown exactly MAX times");
  assert.equal(c.willAbandonOnAdvice, false, "the bound is spent: wait normally under the pump's budgets");
  // A settled run starts over.
  t.h.register({
    on: (name: string, fn: (e: never, c: never) => unknown) =>
      name === "agent_settled" && fn(undefined as never, undefined as never),
  });
  assert.equal(c.willAbandonOnAdvice, true);
});

test("an unfinished side-effecting tool: picker-first neither prompts nor replays", async () => {
  const c = advisedCoordinator({ picker: true });
  c.noteToolStarted("bash", "c1");
  const p = pumpOnce(c, [refused()]);
  await p.outcome;
  assert.equal(c.pickerAbandonBlockedByTool, true);
  const t = switcher(c);
  let asked = 0;
  const res = await t.h.onBeforeSettle(
    settleEvent(p.out.ended?.errorMessage ?? ""),
    ui(async () => {
      asked++;
      return undefined;
    }),
  );
  assert.equal(asked, 0);
  assert.equal(res, undefined);
  assert.deepEqual(t.owed, []);
});

test("UI gone by settle with an unsafe unfinished tool: no replay; with a read-only tool: replay", async () => {
  for (const [tool, replays] of [
    ["bash", false],
    ["read", true],
  ] as const) {
    const c = advisedCoordinator({ picker: true });
    const p = pumpOnce(c, [refused()]);
    await p.outcome;
    c.noteToolStarted(tool, "c1");
    const t = switcher(c);
    const res = await t.h.onBeforeSettle(settleEvent(p.out.ended?.errorMessage ?? ""), ui(undefined, false));
    assert.equal(res?.continue === true, replays, tool);
    assert.equal(t.owed.length, replays ? 1 : 0, tool);
  }
});

test("an already-pending fallback becomes picker-first when the stand-in is gone and the pump abandons", () => {
  const c = advisedCoordinator({ picker: true, standIn: true });
  const hold = { modelId: "qwen3.8-27b", provider: "metabolomics", source: "body" as const, advisesAlternate: true };
  c.onGatewayHold(hold);
  assert.equal(c.snapshot().pickerFirst, undefined);
  c.noteStandIn(false);
  c.onGatewayHold(hold);
  assert.equal(c.snapshot().pickerFirst, true);
});

test("session reset clears the picker boolean", () => {
  const c = advisedCoordinator({ picker: true });
  c.onSessionShutdown();
  assert.equal(c.willAbandonOnAdvice, false);
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
  assert.equal(
    c.willAbandonOnAdvice,
    false,
    "reset drops the stale picker boolean; the lifecycle callback re-notes it",
  );
  c.notePickerAvailable(true);
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
