/**
 * The interactive turn's survival under gateway saturation.
 *
 * Pi's agent loop calls `modelRuntime.streamSimple` (core/sdk.js:194) and wraps
 * it in `retryAssistantCall` (pi-ai/dist/utils/retry.js), which retries a
 * `stopReason: "error"` message `settings.retry.maxRetries` times — 3 by
 * default — with `baseDelayMs * 2 ** (attempt - 1)`, ignoring any wait the
 * gateway advertised. A saturated gateway therefore kills the turn with
 * "Retry failed after 3 attempts" while every engineering worker waits happily.
 *
 * There is no accessor for that budget on `ExtensionAPI`. The lever that does
 * exist is `registerProvider({ api, streamSimple })`: `composeModelProvider`
 * routes the agent's call through an extension-supplied `streamSimple`
 * (provider-composer.js:315-323), so a retry performed INSIDE that call is
 * invisible to Pi's budget — one attempt, from Pi's point of view, however
 * long it takes.
 *
 * These tests pin the pump that does it. The load-bearing rule is that a retry
 * is only safe while nothing has reached the transcript: pi's
 * `AssistantMessageEventStream` completes on the first `done`/`error` event and
 * ignores every push after it (utils/event-stream.js), and re-running a stream
 * that already emitted text would duplicate that text in the message.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";

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

const text = (t: string): Ev => ({ type: "text_delta", text: t });
const done = (): Ev => ({ type: "done", message: { stopReason: "stop" } });
const failed = (msg: string): Ev => ({ type: "error", error: { stopReason: "error", errorMessage: msg } });
const aborted = (): Ev => ({ type: "error", error: { stopReason: "aborted" } });

/** The verbatim payload the operator reported. */
const SATURATED = "503 no worker for model";
const ADMISSION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":100,"queued":30,' +
  '"reason":"queue_timeout","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';
const EXPLICIT_FALSE =
  '503: {"error":{"type":"inferweave_backpressure","code":"FINAL-CODE","reason":"internal_error",' +
  '"retryable":false,"replay_safe":false,"request_state":"dispatched","action":"do_not_retry",' +
  '"action_code":"IW-ACT-DO-NOT-RETRY","message":"final server message"}}';

/** A scripted attempt sequence, shaped like pi's AssistantMessageEventStream. */
function scripted(attempts: Ev[][]) {
  let opened = 0;
  const open = () => {
    const events = attempts[Math.min(opened, attempts.length - 1)] ?? [];
    opened++;
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: async (): Promise<Res> => terminal?.message ?? terminal?.error ?? {},
    };
  };
  return {
    open,
    get opened() {
      return opened;
    },
  };
}

/** Collects what actually reached the transcript. */
function sink() {
  const pushed: Ev[] = [];
  let ended: Res | undefined;
  let endCalls = 0;
  return {
    pushed,
    get ended() {
      return ended;
    },
    get endCalls() {
      return endCalls;
    },
    push: (e: Ev) => pushed.push(e),
    end: (r?: Res) => {
      endCalls++;
      ended = r;
    },
  };
}

function holds() {
  const seen: Array<{ attempt: number; ms: number }> = [];
  return {
    seen,
    hold: async (signal: { retryAfterMs: number }, attempt: number) => {
      seen.push({ attempt, ms: signal.retryAfterMs });
    },
  };
}

test("stream retry: a clean stream is passed through untouched", async () => {
  const s = scripted([[text("hello"), text(" world"), done()]]);
  const out = sink();
  const h = holds();
  const outcome = await pumpWithGatewayRetry(s.open, out, { hold: h.hold });

  assert.equal(s.opened, 1, "no retry for a healthy stream");
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["text_delta", "text_delta", "done"],
  );
  assert.equal(out.ended?.stopReason, "stop");
  assert.equal(outcome.attempts, 1);
  assert.equal(h.seen.length, 0);
});

test("stream retry: a 503 before any output is retried, and the error never reaches the transcript", async () => {
  const s = scripted([[failed(SATURATED)], [text("recovered"), done()]]);
  const out = sink();
  const h = holds();
  const outcome = await pumpWithGatewayRetry(s.open, out, { hold: h.hold });

  assert.equal(s.opened, 2, "the failed attempt is retried");
  // The decisive assertion: pi's stream completes on the FIRST error event and
  // ignores everything after it, so forwarding the 503 would end the turn.
  assert.equal(
    out.pushed.some((e) => e.type === "error"),
    false,
    "a retried error must never be forwarded",
  );
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["text_delta", "done"],
  );
  assert.equal(out.ended?.stopReason, "stop");
  assert.equal(out.endCalls, 1, "the sink is ended exactly once");
  assert.equal(outcome.attempts, 2);
});

test("stream retry: a 503 AFTER output is not retried — retrying would duplicate the text", async () => {
  const s = scripted([
    [text("partial"), failed(SATURATED)],
    [text("again"), done()],
  ]);
  const out = sink();
  const h = holds();
  await pumpWithGatewayRetry(s.open, out, { hold: h.hold });

  assert.equal(s.opened, 1, "content already in the transcript makes a retry unsafe");
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["text_delta", "error"],
    "the error is forwarded so the turn fails honestly",
  );
  assert.equal(out.ended?.errorMessage, SATURATED);
  assert.equal(h.seen.length, 0);
});

test("stream retry: the body-advertised wait is honoured exactly", async () => {
  const s = scripted([[failed(ADMISSION_429)], [done()]]);
  const h = holds();
  await pumpWithGatewayRetry(s.open, sink(), { hold: h.hold });

  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]?.ms, 30_000, "the gateway said 30s; anything else walks back into the queue");
});

test("stream retry: one decision chooses the larger 503 header delay over the body", async () => {
  const body =
    '503: {"type":"inferweave_backpressure","reason":"NO_CONTEXT_CAPACITY","retryable":true,' +
    '"replay_safe":true,"request_state":"queued","action":"backoff","action_code":"IW-ACT-BACKOFF",' +
    '"retry_after_ms":1000,"scope":"model"}';
  const s = scripted([[failed(body)], [done()]]);
  const h = holds();
  await pumpWithGatewayRetry(s.open, sink(), {
    hold: h.hold,
    response: () => ({ status: 503, headers: { "retry-after": "8" } }),
  });
  assert.deepEqual(
    h.seen.map((entry) => entry.ms),
    [8_000],
  );
});

test("stream retry: non-finite direct budgets fail closed to finite defaults", async () => {
  const s = scripted(Array.from({ length: 50 }, () => [failed(SATURATED)]));
  const outcome = await pumpWithGatewayRetry(s.open, sink(), {
    hold: holds().hold,
    maxAttempts: Number.POSITIVE_INFINITY,
    maxElapsedMs: Number.POSITIVE_INFINITY,
  });
  assert.ok(outcome.attempts < 50);
});

test("stream retry: a zero elapsed budget permits no replay", async () => {
  const s = scripted([[failed(SATURATED)], [done()]]);
  const out = sink();
  const h = holds();
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: h.hold,
    maxElapsedMs: 0,
    now: () => 0,
  });

  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.holds, 0);
  assert.equal(s.opened, 1);
  assert.equal(out.ended?.errorMessage, SATURATED);
});

test("stream retry: a synthesized wait escalates instead of hammering a flat 5s", async () => {
  // A bare 503 advertises no wait, so the 5s default is a guess. Repeating it
  // unchanged against a gateway with no workers is a busy-wait.
  const s = scripted([[failed(SATURATED)], [failed(SATURATED)], [failed(SATURATED)], [done()]]);
  const h = holds();
  await pumpWithGatewayRetry(s.open, sink(), { hold: h.hold });

  assert.equal(h.seen.length, 3);
  const waits = h.seen.map((x) => x.ms);
  assert.ok(waits[1]! > waits[0]!, `expected escalation, got ${waits.join(",")}`);
  assert.ok(waits[2]! > waits[1]!, `expected escalation, got ${waits.join(",")}`);
});

test("stream retry: an escalated wait is capped so it never becomes an outage", async () => {
  const s = scripted([...Array.from({ length: 40 }, () => [failed(SATURATED)]), [done()]]);
  const h = holds();
  await pumpWithGatewayRetry(s.open, sink(), { hold: h.hold, maxEscalatedWaitMs: 60_000 });

  assert.ok(
    h.seen.every((x) => x.ms <= 60_000),
    "a synthesized wait must stay bounded",
  );
  assert.equal(h.seen.at(-1)?.ms, 60_000, "and should reach the cap");
});

test("stream retry: default attempt budget is finite and preserves the last server failure", async () => {
  const s = scripted(Array.from({ length: 50 }, () => [failed(`${SATURATED} final-code`)]));
  const out = sink();
  const h = holds();
  const outcome = await pumpWithGatewayRetry(s.open, out, { hold: h.hold });

  assert.ok(Number.isFinite(outcome.attempts));
  assert.ok(outcome.attempts < 50);
  assert.equal(out.ended?.stopReason, "error");
  assert.match(out.ended?.errorMessage ?? "", /final-code/);
});

test("stream retry: elapsed budget stops before a server minimum that cannot fit", async () => {
  const now = 0;
  const s = scripted([[failed(ADMISSION_429)], [done()]]);
  const out = sink();
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: async () => {},
    now: () => now,
    maxElapsedMs: 1_000,
  });
  assert.equal(outcome.attempts, 1);
  assert.equal(out.ended?.errorMessage, ADMISSION_429);
});

test("stream retry: a hold that overruns the elapsed budget does not open another request", async () => {
  let now = 0;
  const s = scripted([[failed(SATURATED)], [done()]]);
  const out = sink();
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    maxElapsedMs: 10_000,
    now: () => now,
    hold: async () => {
      now = 10_001;
    },
  });

  assert.equal(outcome.attempts, 1);
  assert.equal(s.opened, 1, "elapsed time must be rechecked immediately before replay");
  assert.equal(out.ended?.errorMessage, SATURATED);
});

test("stream retry: a non-gateway error fails fast", async () => {
  const s = scripted([[failed("401 invalid api key")], [done()]]);
  const out = sink();
  const h = holds();
  await pumpWithGatewayRetry(s.open, out, { hold: h.hold });

  assert.equal(s.opened, 1, "waiting cannot fix a bad key");
  assert.equal(out.ended?.errorMessage, "401 invalid api key");
  assert.equal(h.seen.length, 0);
});

test("stream retry: explicit false preserves the final server error without replay", async () => {
  const s = scripted([[failed(EXPLICIT_FALSE)], [done()]]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: holds().hold });
  assert.equal(s.opened, 1);
  assert.equal(out.ended?.errorMessage, EXPLICIT_FALSE);
  assert.match(out.ended?.errorMessage ?? "", /FINAL-CODE/);
  assert.match(out.ended?.errorMessage ?? "", /IW-ACT-DO-NOT-RETRY/);
});

test("stream retry: quota exhaustion fails fast even though it is a 429", async () => {
  const s = scripted([[failed('429: {"message":"quota exceeded","type":"billing"}')], [done()]]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: holds().hold });

  assert.equal(s.opened, 1, "retrying a billing failure is an infinite loop");
});

test("stream retry: an aborted turn is terminal", async () => {
  const s = scripted([[aborted()], [done()]]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: holds().hold });

  assert.equal(s.opened, 1);
  assert.equal(out.ended?.stopReason, "aborted");
});

test("stream retry: aborting during the hold ends the turn instead of retrying forever", async () => {
  const controller = new AbortController();
  const s = scripted([[failed(SATURATED)], [failed(SATURATED)], [done()]]);
  const out = sink();

  const outcome = await pumpWithGatewayRetry(s.open, out, {
    signal: controller.signal,
    hold: async () => {
      controller.abort();
    },
  });

  assert.equal(out.ended?.stopReason, "aborted", "escape must end the turn, not restart it");
  assert.equal(outcome.attempts, 1);
  assert.equal(
    out.pushed.some((e) => e.type === "error"),
    false,
  );
});

test("stream retry: a thrown transport failure is retried like a returned one", async () => {
  // Some transports throw rather than completing the stream with an error.
  let opened = 0;
  const open = () => {
    opened++;
    if (opened === 1) throw new Error(SATURATED);
    return {
      async *[Symbol.asyncIterator]() {
        yield done();
      },
      result: async (): Promise<Res> => ({ stopReason: "stop" }),
    };
  };
  const out = sink();
  const outcome = await pumpWithGatewayRetry(open, out, { hold: holds().hold });

  assert.equal(opened, 2);
  assert.equal(out.ended?.stopReason, "stop");
  assert.equal(outcome.attempts, 2);
});

test("stream retry: a thrown non-gateway failure propagates to the caller", async () => {
  const boom = new Error("TypeError: cannot read property of undefined");
  const out = sink();
  await assert.rejects(
    () =>
      pumpWithGatewayRetry(
        () => {
          throw boom;
        },
        out,
        { hold: holds().hold },
      ),
    /cannot read property/,
  );
  assert.equal(out.endCalls, 0, "the binding layer owns the error message for a throw");
});

test("stream retry: every hold is reported so the status bar can show it", async () => {
  const seen: Array<{ attempt: number; queued?: number }> = [];
  const s = scripted([[failed(ADMISSION_429)], [done()]]);
  await pumpWithGatewayRetry(s.open, sink(), {
    hold: async () => {},
    onHold: (info) => seen.push({ attempt: info.attempt, queued: info.signal.queued }),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.attempt, 1);
  assert.equal(seen[0]?.queued, 30, "queue position is what the operator actually wants to see");
});

test("stream retry: maxAttempts is a usable ceiling for callers that want one", async () => {
  const s = scripted([[failed(SATURATED)], [failed(SATURATED)], [failed(SATURATED)], [done()]]);
  const out = sink();
  const outcome = await pumpWithGatewayRetry(s.open, out, { hold: holds().hold, maxAttempts: 2 });

  assert.equal(outcome.attempts, 2);
  assert.equal(out.ended?.errorMessage, SATURATED, "the last failure is surfaced once the budget is spent");
  assert.equal(
    out.pushed.some((e) => e.type === "error"),
    true,
  );
});

test("stream retry: escalation continues from prior holds instead of restarting", async () => {
  // The agent loop makes one provider call per tool round-trip, and a gateway
  // outage outlives a turn. An escalation scoped to one call would drop back to
  // the base wait every few seconds — the busy-wait it exists to prevent.
  const s = scripted([[failed(SATURATED)], [done()]]);
  const h = holds();
  await pumpWithGatewayRetry(s.open, sink(), { hold: h.hold, priorHolds: 3 });

  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]?.ms, 5_000 * 2 ** 3, "a fresh call must not restart the escalation");
});

test("stream retry: the outcome says how the stream settled, so callers can reset", async () => {
  const ok = await pumpWithGatewayRetry(scripted([[done()]]).open, sink(), { hold: holds().hold });
  assert.equal(ok.settled, "ok");

  const bad = await pumpWithGatewayRetry(scripted([[failed("401 invalid api key")]]).open, sink(), {
    hold: holds().hold,
  });
  assert.equal(bad.settled, "error");

  const stopped = await pumpWithGatewayRetry(scripted([[aborted()]]).open, sink(), { hold: holds().hold });
  assert.equal(stopped.settled, "aborted");
});

test("stream retry: progress is reported synchronously, before the result resolves", async () => {
  // The reset this drives has to beat the agent loop's next provider call. If
  // it were derived from the returned outcome it would land one microtask after
  // `end()` — by which time the next call has already read a stale ladder.
  const order: string[] = [];
  const s = scripted([[failed(SATURATED)], [text("hi"), done()]]);
  const out = sink();
  const originalEnd = out.end;

  await pumpWithGatewayRetry(
    s.open,
    {
      push: out.push,
      end: (r) => {
        order.push("end");
        originalEnd(r);
      },
    },
    { hold: holds().hold, onProgress: () => order.push("progress") },
  );

  assert.deepEqual(order, ["progress", "end"], "progress must precede the settle, not follow it");
});

test("stream retry: progress fires once, not per event", async () => {
  let progress = 0;
  const s = scripted([[text("a"), text("b"), text("c"), done()]]);
  await pumpWithGatewayRetry(s.open, sink(), { hold: holds().hold, onProgress: () => progress++ });
  assert.equal(progress, 1);
});

test("stream retry: a withheld error alone is not progress", async () => {
  // Otherwise the very failure being retried would reset the ladder.
  let progress = 0;
  const s = scripted([[failed(SATURATED)], [failed(SATURATED)], [done()]]);
  const h = holds();
  await pumpWithGatewayRetry(s.open, sink(), { hold: h.hold, onProgress: () => progress++ });

  assert.equal(progress, 1, "only the successful attempt counted as progress");
  assert.ok(h.seen[1]!.ms > h.seen[0]!.ms, "the ladder kept climbing through the retries");
});

test("stream retry: a saturation delivered as 'done' is waited out like any other", () => {
  // Found by fresh-context review. A provider may report a failed turn as a
  // `done` event whose message has stopReason "error". Treating only the
  // `error` SHAPE as a failure forwarded this one — completing the stream —
  // and left the turn to Pi's three-attempt budget, so it could still die on
  // exactly the gateway this module exists to wait out.
  const doneButFailed: Ev = { type: "done", message: { stopReason: "error", errorMessage: SATURATED } };
  const s = scripted([[doneButFailed], [text("recovered"), done()]]);
  const out = sink();
  const h = holds();

  return pumpWithGatewayRetry(s.open, out, { hold: h.hold }).then(() => {
    assert.equal(s.opened, 2, "the failure was retried, whichever shape it arrived in");
    assert.equal(h.seen.length, 1);
    assert.equal(out.ended?.stopReason, "stop");
    assert.equal(
      out.pushed.some((e) => e.message?.stopReason === "error"),
      false,
      "the withheld failure never reached the transcript",
    );
  });
});

test("stream retry: a 'done' failure AFTER output is still not retried", () => {
  // The transcript-safety rule is unchanged: once content is out, the attempt
  // is the answer whatever shape its ending takes.
  const doneButFailed: Ev = { type: "done", message: { stopReason: "error", errorMessage: SATURATED } };
  const s = scripted([[text("partial"), doneButFailed], [done()]]);
  const out = sink();

  return pumpWithGatewayRetry(s.open, out, { hold: holds().hold }).then(() => {
    assert.equal(s.opened, 1);
    assert.equal(out.ended?.stopReason, "error");
  });
});

test("stream retry: a successful 'done' is never withheld", () => {
  const s = scripted([[text("hi"), done()]]);
  const out = sink();
  return pumpWithGatewayRetry(s.open, out, { hold: holds().hold }).then(() => {
    assert.equal(s.opened, 1);
    assert.equal(out.ended?.stopReason, "stop");
    assert.equal(out.pushed.at(-1)?.type, "done");
  });
});
