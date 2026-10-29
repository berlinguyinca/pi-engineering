/**
 * `node_updating`: the gateway refuses a request while the only node serving
 * the model restarts for a deployment.
 *
 * The console answers HTTP 503 with `Retry-After: 30` and the envelope below:
 * the capacity refusal's replay guidance (retryable, replay_safe, not_started,
 * retry_alternate, scope model) with its own message and a 30 s delay. Pi must
 * treat it as a retryable admission refusal in every shape it arrives in — the
 * full envelope, the code flattened by the SDK, the classifier's body reason —
 * and say what is happening in the gateway's own words.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAdmissionEvent } from "../../src/gateway/admissionNotice.ts";
import { AfterOutputRetry } from "../../src/gateway/afterOutputRetry.ts";
import { FallbackCoordinator } from "../../src/gateway/fallbackLifecycle.ts";
import { recoverableFailure } from "../../src/gateway/settleRecovery.ts";
import {
  ALTERNATE_MODEL_ADVICE,
  ALTERNATE_MODEL_SWITCHING,
  DEFAULT_WAIT_MS,
  type GatewayWaitSignal,
  advisesAlternateModel,
  flattenedInferWeaveRefusalCode,
  isFlattenedInferWeaveRefusal,
  parseGatewayWait,
} from "../../src/gateway/signals.ts";
import { ALTERNATE_MODEL_MAX_ELAPSED_MS, pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";
import { classifyError } from "../../src/guard/transient.ts";
import {
  DEFAULT_ADMISSION_REASON_POLICY,
  isAutomaticReplayAllowed,
  parseAdmissionPayload,
} from "../../src/inference/admissionContract.ts";
import { classifyInferenceFailure } from "../../src/inference/failureClassifier.ts";
import { metadataFromResponse } from "../../src/inference/inferweaveMetadata.ts";
import { resolveRetryDelay } from "../../src/inference/retryDelay.ts";
import { decideAvailability, parseAvailabilityError } from "../../src/plannerWorker/gateway.ts";

const NOTICE = "updating node, please retry in 30 s";

/** The console's reply body, byte for byte as `writeRefusal` encodes it. */
const ENVELOPE = {
  error: {
    message: NOTICE,
    type: "inferweave_backpressure",
    code: "node_updating",
    reason: "node_updating",
    retryable: true,
    replay_safe: true,
    request_state: "not_started",
    action: "retry_alternate",
    action_code: "IW-ACT-RETRY-ALTERNATE",
    retry_after_ms: 30000,
    scope: "model",
    model_intent: "m",
    request_id: "req-1",
  },
};
const HEADERS = { "retry-after": "30" };
const TEXT = `503: ${JSON.stringify(ENVELOPE)}`;

interface Ev {
  type: string;
  text?: string;
  message?: Res;
  error?: Res;
}
interface Res {
  stopReason?: string;
  errorMessage?: string;
}

function scripted(attempts: Ev[][]) {
  let opened = 0;
  const open = () => {
    const events = attempts[Math.min(opened++, attempts.length - 1)] ?? [];
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: async (): Promise<Res> => terminal?.message ?? terminal?.error ?? {},
    };
  };
  return { open, opened: () => opened };
}

/** Run one turn through the gateway pump; return what it held for and pushed. */
async function pump(attempts: Ev[][]) {
  const script = scripted(attempts);
  const pushed: Ev[] = [];
  const holds: GatewayWaitSignal[] = [];
  let ended: Res | undefined;
  await pumpWithGatewayRetry(
    script.open,
    {
      push: (e: Ev) => pushed.push(e),
      end: (r?: Res) => {
        ended = r;
      },
    },
    {
      hold: async (signal) => {
        holds.push(signal);
      },
    },
  );
  return { pushed, holds, ended, opened: script.opened() };
}

const refused: Ev[] = [{ type: "error", error: { stopReason: "error", errorMessage: TEXT } }];
const answered: Ev[] = [
  { type: "start" },
  { type: "text_delta", text: "ok" },
  { type: "done", message: { stopReason: "stop" } },
];

test("node_updating is retried", async () => {
  // The refusal vocabulary: the flattened code alone is a retryable refusal.
  for (const text of [
    "node_updating",
    "Error: 503: node_updating",
    `Node m is updating (node_updating); please retry your request.`,
  ]) {
    assert.equal(flattenedInferWeaveRefusalCode(text), "node_updating", text);
    assert.equal(isFlattenedInferWeaveRefusal(text), true, text);
    const signal = parseGatewayWait({ text });
    assert.equal(signal?.retryable, true, text);
    assert.equal(signal?.reason, "node_updating", text);
    assert.equal(signal?.scope, "model", text);
    assert.equal(classifyError(new Error(text)).retryable, true, text);
  }

  // The full envelope: the explicit replay contract allows the replay.
  const info = parseAdmissionPayload(ENVELOPE);
  assert.ok(info);
  assert.equal(info.reason, "node_updating");
  assert.equal(isAutomaticReplayAllowed(info, false), true);
  assert.equal(isAutomaticReplayAllowed(info, true), false, "never after output reached the transcript");
  const envelopeSignal = parseGatewayWait({ text: TEXT, headers: HEADERS });
  assert.equal(envelopeSignal?.retryable, true);
  assert.equal(envelopeSignal?.reason, "node_updating");

  // The reason taxonomy: retried like capacity_unavailable, then routing decides.
  assert.deepEqual(DEFAULT_ADMISSION_REASON_POLICY.node_updating, DEFAULT_ADMISSION_REASON_POLICY.capacity_unavailable);
  assert.equal(DEFAULT_ADMISSION_REASON_POLICY.node_updating?.action, "retry_then_fallback");

  // The unified classifier: a wait honouring the server's hint, on this model.
  const f = classifyInferenceFailure({
    error: new Error("503"),
    metadata: metadataFromResponse({ status: 503, headers: HEADERS, body: ENVELOPE.error }),
  });
  assert.equal(f.class, "capacity_unavailable");
  assert.equal(f.reason, "node_updating");
  assert.equal(f.retryable, true);
  assert.equal(f.action, "honor_retry_after");
  assert.equal(f.modelScoped, true);

  // The planner-worker executor waits on the same model instead of switching.
  const availability = parseAvailabilityError(503, ENVELOPE, HEADERS);
  assert.equal(availability?.code, "MODEL_LOADING");
  assert.equal(availability?.retryAfterMs, 30_000);
  assert.deepEqual(decideAvailability(availability!.code, 0, availability!.retryAfterMs), {
    action: "wait",
    ms: 30_000,
  });

  // The interactive pump waits it out and replays the request.
  const run = await pump([refused, answered]);
  assert.equal(run.opened, 2);
  assert.equal(run.ended?.stopReason, "stop");
  assert.equal(run.holds.length, 1);
  assert.equal(run.holds[0]?.reason, "node_updating");
});

test("waits retry_after_ms 30000", async () => {
  // Body and header agree: 30000 ms either way, and the wait is exactly that.
  const signal = parseGatewayWait({ text: TEXT, headers: HEADERS });
  assert.equal(signal?.retryAfterMs, 30_000);
  const delay = resolveRetryDelay({
    headers: HEADERS,
    body: ENVELOPE.error,
    attempt: 1,
    bounds: { minDelayMs: 0, maxDelayMs: 5_000, baseBackoffMs: 1_000, jitterRatio: 0 },
  });
  assert.equal(delay.serverDelayMs, 30_000);
  assert.equal(delay.delayMs, 30_000, "a server minimum is never clamped down to local policy");
  const headerOnly = resolveRetryDelay({
    headers: HEADERS,
    attempt: 1,
    bounds: { minDelayMs: 0, maxDelayMs: 5_000, baseBackoffMs: 1_000, jitterRatio: 0 },
  });
  assert.equal(headerOnly.delayMs, 30_000, "Retry-After: 30 means the same 30000 ms");

  // Flattened to the bare code, the hint is lost: the code's own 30 s applies,
  // not the generic 5 s, and only on the first attempt of a run.
  const bare = parseGatewayWait({ text: "node_updating" });
  assert.equal(bare?.retryAfterMs, 30_000);
  assert.equal(bare?.source, "default");
  assert.equal(parseGatewayWait({ text: "503: node_updating", headers: HEADERS })?.retryAfterMs, 30_000);

  const f = classifyInferenceFailure({
    error: new Error("503"),
    metadata: metadataFromResponse({ status: 503, headers: HEADERS, body: ENVELOPE.error }),
  });
  assert.equal(f.retryAfterMs, 30_000);

  const run = await pump([refused, answered]);
  assert.equal(run.holds[0]?.retryAfterMs, 30_000);
});

test('notice reads "updating node, please retry in 30 s"', () => {
  const signal = parseGatewayWait({ text: TEXT, headers: HEADERS });
  assert.ok(signal);
  const notice = describeAdmissionEvent({ type: "wait", waitMs: signal.retryAfterMs, signal, concurrency: 4 });
  assert.equal(notice.level, "warning");
  assert.ok(notice.text.includes(NOTICE), notice.text);
  assert.ok(!notice.text.includes("node updating"), "the gateway's sentence, not the code with spaces");

  // The flattened code carries no message: the same sentence anyway.
  const bare = parseGatewayWait({ text: "node_updating" });
  assert.ok(bare);
  const bareNotice = describeAdmissionEvent({ type: "wait", waitMs: bare.retryAfterMs, signal: bare, concurrency: 4 });
  assert.ok(bareNotice.text.includes(NOTICE), bareNotice.text);
});

test("stream cut mid-output resumes with the same notice", async () => {
  // The node restarts under an in-flight stream: the answer is cut after
  // partial output, which the pump must not replay ...
  const cut = await pump([
    [
      { type: "start" },
      { type: "text_delta", text: "partial" },
      { type: "error", error: { stopReason: "error", errorMessage: "terminated" } },
    ],
  ]);
  assert.equal(cut.opened, 1, "output reached the transcript: no replay inside the pump");
  assert.equal(cut.ended?.stopReason, "error");

  // ... so the after-output layer continues the turn ...
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const retry = new AfterOutputRetry({ schedule: { baseMs: 1, capMs: 1, jitter: 0, horizonMs: 60_000 } });
  retry.register({ on: (event, handler) => handlers.set(event, handler) });
  const model = { provider: "gw", id: "m" };
  retry.observe(model);
  const failed = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "terminated",
    content: [{ type: "text", text: "partial" }],
  };
  const settle = handlers.get("agent_before_settle")!(
    {
      outcome: "error",
      entries: [],
      context: { contextEntries: [{ sourceEntry: { id: "a1" }, messages: [failed] }] },
    } as never,
    { model } as never,
  ) as { continue?: boolean } | undefined;
  assert.equal(settle?.continue, true, "the cut answer is retried");

  // ... and the continued request meets the updating node: the pump waits it
  // out with the same notice an unbroken request gets.
  const resumed = await pump([refused, answered]);
  assert.equal(resumed.ended?.stopReason, "stop");
  const signal = resumed.holds[0];
  assert.ok(signal);
  assert.equal(signal.retryAfterMs, 30_000);
  const notice = describeAdmissionEvent({ type: "wait", waitMs: signal.retryAfterMs, signal, concurrency: 4 });
  assert.ok(notice.text.includes(NOTICE), notice.text);

  // A cut whose own error text is the refusal is retried by the same layer.
  const refusedCut = { ...failed, errorMessage: TEXT };
  retry.observe(model);
  await retry.beforeSend(model, undefined);
  const again = handlers.get("agent_before_settle")!(
    {
      outcome: "error",
      entries: [],
      context: { contextEntries: [{ sourceEntry: { id: "a2" }, messages: [refusedCut] }] },
    } as never,
    { model } as never,
  ) as { continue?: boolean } | undefined;
  assert.equal(again?.continue, true);
});

test("unknown code falls back to generic retry", async () => {
  // A code this pi-engineering does not know (a newer gateway's) must keep
  // the generic retry it always had: never terminal, never a borrowed delay.
  const code = "node_reticulating";
  assert.equal(DEFAULT_ADMISSION_REASON_POLICY[code], undefined);

  const flattened = parseGatewayWait({ text: `503: ${code}` });
  assert.equal(flattened?.retryable, true, "a 503 stays a retryable wait");
  assert.equal(flattened?.retryAfterMs, DEFAULT_WAIT_MS, "the generic default, not node_updating's 30 s");

  const envelope = { error: { ...ENVELOPE.error, code, reason: code, message: "something new" } };
  const fromEnvelope = parseGatewayWait({ text: `503: ${JSON.stringify(envelope)}` });
  assert.equal(fromEnvelope?.retryable, true);
  assert.equal(fromEnvelope?.retryAfterMs, 30_000, "a declared delay is still honoured");

  // Without an explicit contract the unknown reason is not refused either.
  const legacy = parseAdmissionPayload({ type: "inference_admission", reason: code });
  assert.ok(legacy);
  assert.equal(isAutomaticReplayAllowed(legacy, false), true);

  // The classifier falls through to the status-based class: retryable.
  const f = classifyInferenceFailure({
    error: new Error(`503 ${code}`),
    metadata: metadataFromResponse({ status: 503, body: { reason: code } }),
  });
  assert.equal(f.retryable, true);
  assert.notEqual(f.reason, "node_updating");

  // The notice is the generic one: the code made readable.
  const notice = describeAdmissionEvent({ type: "wait", waitMs: 5_000, signal: flattened!, concurrency: 4 });
  assert.ok(!notice.text.includes(NOTICE), notice.text);

  const run = await pump([[{ type: "error", error: { stopReason: "error", errorMessage: `503: ${code}` } }], answered]);
  assert.equal(run.ended?.stopReason, "stop");
  assert.equal(run.holds[0]?.retryAfterMs, DEFAULT_WAIT_MS);
});

// ─── Never a model switch ───────────────────────────────────────────────────

const CAPACITY = {
  error: {
    ...ENVELOPE.error,
    code: "capacity_unavailable",
    reason: "capacity_unavailable",
    message: "Try another eligible deployment after the declared delay.",
    retry_after_ms: 20000,
  },
};
const refusedWith = (body: unknown): Ev[] => [
  { type: "error", error: { stopReason: "error", errorMessage: `503: ${JSON.stringify(body)}` } },
];

/** A pump run whose caller would abandon every advised hold (a stand-in is armed). */
async function pumpWithStandIn(attempts: Ev[][]) {
  const script = scripted(attempts);
  let ended: Res | undefined;
  const holds: GatewayWaitSignal[] = [];
  const asked: GatewayWaitSignal[] = [];
  await pumpWithGatewayRetry(
    script.open,
    {
      push: () => {},
      end: (r?: Res) => {
        ended = r;
      },
    },
    {
      hold: async (signal) => {
        holds.push(signal);
      },
      abandonForAlternate: (info) => {
        asked.push(info.signal);
        return true;
      },
    },
  );
  return { ended, holds, asked, opened: script.opened() };
}

test("node_updating is held on the same model even with a stand-in armed; capacity_unavailable still abandons", async () => {
  const updating = await pumpWithStandIn([refusedWith(ENVELOPE), answered]);
  assert.deepEqual(updating.asked, [], "abandonForAlternate is never consulted");
  assert.equal(updating.holds.length, 1);
  assert.equal(updating.holds[0]?.retryAfterMs, 30_000);
  assert.equal(updating.opened, 2, "the same model is asked again after the wait");
  assert.equal(updating.ended?.stopReason, "stop");

  const capacity = await pumpWithStandIn([refusedWith(CAPACITY), answered]);
  assert.equal(capacity.asked.length, 1, "existing behaviour: the advised hold is offered to the switch");
  assert.equal(capacity.holds.length, 0);
  assert.equal(capacity.opened, 1);
  assert.equal(capacity.ended?.errorMessage, ALTERNATE_MODEL_SWITCHING);

  // The coordinator (what arms setModel at the settle boundary) is not armed either.
  const signal = parseGatewayWait({ text: TEXT, headers: HEADERS })!;
  assert.equal(advisesAlternateModel(signal), false);
  assert.equal(advisesAlternateModel(parseGatewayWait({ text: "node_updating" })!), false);
  assert.equal(advisesAlternateModel(parseGatewayWait({ text: `503: ${JSON.stringify(CAPACITY)}` })!), true);
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.noteStandIn(true);
  c.onGatewayHold({
    modelId: "m",
    provider: "gw",
    source: signal.source,
    accountWide: false,
    advisesAlternate: advisesAlternateModel(signal),
    retryAfterMs: signal.retryAfterMs,
  });
  assert.equal(c.hasPending, false, "no switch is armed for a deployment restart");
});

test("a node stuck updating ends the turn after the 15-minute ceiling, not the 12-hour horizon", async () => {
  let clock = 0;
  const script = scripted([refusedWith(ENVELOPE)]);
  let ended: Res | undefined;
  const outcome = await pumpWithGatewayRetry(
    script.open,
    {
      push: () => {},
      end: (r?: Res) => {
        ended = r;
      },
    },
    {
      now: () => clock,
      wallNow: () => clock,
      hold: async (signal) => {
        clock += signal.retryAfterMs;
      },
      abandonForAlternate: () => true,
    },
  );
  assert.equal(outcome.settled, "error");
  assert.ok(clock <= ALTERNATE_MODEL_MAX_ELAPSED_MS, `held ${clock} ms`);
  assert.ok(clock >= ALTERNATE_MODEL_MAX_ELAPSED_MS - 60_000, `held ${clock} ms: the whole ceiling, not less`);
  assert.ok(ended?.errorMessage?.includes("node_updating"));
  assert.ok(!ended?.errorMessage?.includes(ALTERNATE_MODEL_ADVICE), "no advice to switch models");

  // Settle recovery does not pick the turn up again: it ends.
  assert.equal(
    recoverableFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: ended?.errorMessage,
      content: [],
    } as never),
    undefined,
  );
  assert.equal(
    recoverableFailure({ role: "assistant", stopReason: "error", errorMessage: "node_updating", content: [] } as never),
    undefined,
  );
  // Unchanged for other refusals.
  assert.notEqual(
    recoverableFailure({
      role: "assistant",
      stopReason: "error",
      errorMessage: `503: ${JSON.stringify(CAPACITY)}`,
      content: [],
    } as never),
    undefined,
  );
});

test("Retry-After and retry_after_ms disagreeing: the larger wins", () => {
  const longerHeader = parseGatewayWait({ text: TEXT, headers: { "retry-after": "60" } });
  assert.equal(longerHeader?.retryAfterMs, 60_000);
  assert.equal(longerHeader?.source, "header");
  const longerBody = parseGatewayWait({
    text: `503: ${JSON.stringify({ error: { ...ENVELOPE.error, retry_after_ms: 45_000 } })}`,
    headers: HEADERS,
  });
  assert.equal(longerBody?.retryAfterMs, 45_000);
  const bounds = { minDelayMs: 0, maxDelayMs: 5_000, baseBackoffMs: 1_000, jitterRatio: 0 };
  assert.equal(
    resolveRetryDelay({ headers: { "retry-after": "60" }, body: ENVELOPE.error, attempt: 1, bounds }).delayMs,
    60_000,
  );
  assert.equal(
    resolveRetryDelay({ headers: HEADERS, body: { retry_after_ms: 45_000 }, attempt: 1, bounds }).delayMs,
    45_000,
  );
});

test("planner worker: waits out node_updating twice more, then switches on the third strike", () => {
  const availability = parseAvailabilityError(503, ENVELOPE, HEADERS)!;
  for (const strikes of [0, 1, 2]) {
    assert.deepEqual(decideAvailability(availability.code, strikes, availability.retryAfterMs), {
      action: "wait",
      ms: 30_000,
    });
  }
  assert.deepEqual(decideAvailability(availability.code, 3, availability.retryAfterMs), { action: "switch" });
});

test("the gateway's message is sanitised before it reaches the terminal", () => {
  const hostile = {
    error: {
      ...ENVELOPE.error,
      message: `\u001b[2J\u001b[31mupdating node,\u0007 please retry in 30 s${"x".repeat(5_000)}`,
    },
  };
  const signal = parseGatewayWait({ text: `503: ${JSON.stringify(hostile)}` })!;
  const notice = describeAdmissionEvent({ type: "wait", waitMs: 30_000, signal, concurrency: 4 });
  assert.ok(
    [...notice.text].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127),
    JSON.stringify(notice.text),
  );
  assert.ok(notice.text.length < 250, `capped: ${notice.text.length}`);
  assert.ok(notice.text.includes("updating node, please retry in 30 s"), notice.text);
});
