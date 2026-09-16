/**
 * Repeat suppression, and the reason it is keyed the way it is.
 *
 * The first version keyed on the notice's TEXT. That looks right until you read
 * the text a gateway wait produces: it names the live queue depth. Two waits
 * for one condition, a second apart, are different strings — so the throttle
 * never fired for the case it was written for, and fired only for the case it
 * should not have.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAdmissionEvent } from "../../src/gateway/admissionNotice.ts";
import { createRepeatThrottle } from "../../src/telemetry/throttle.ts";

function waitEvent(queued: number) {
  return describeAdmissionEvent({
    type: "wait",
    waitMs: 30_000,
    signal: {
      retryAfterMs: 30_000,
      retryable: true,
      source: "body" as const,
      status: 429,
      reason: "queue_timeout",
      queued,
      queueLimit: 100,
      activeLimit: 4,
    },
    concurrency: 4,
  });
}

test("throttle: two waits for one condition are one notification, renumbered or not", () => {
  let now = 0;
  const allow = createRepeatThrottle({ now: () => now, repeatMs: 60_000 });
  const first = waitEvent(31);
  const second = waitEvent(44);
  assert.notEqual(first.text, second.text, "the premise: the sentence carries a moving number");
  assert.equal(allow(first), true);
  now += 1_000;
  assert.equal(allow(second), false, "the same condition, one second later, is not news");
});

test("throttle: the window expires", () => {
  let now = 0;
  const allow = createRepeatThrottle({ now: () => now, repeatMs: 60_000 });
  assert.equal(allow(waitEvent(31)), true);
  now += 59_999;
  assert.equal(allow(waitEvent(31)), false);
  now += 2;
  assert.equal(allow(waitEvent(31)), true, "a condition still holding after a minute is worth saying again");
});

test("throttle: different conditions do not suppress each other", () => {
  const allow = createRepeatThrottle({ now: () => 0 });
  assert.equal(allow(waitEvent(31)), true);
  assert.equal(
    allow(describeAdmissionEvent({ type: "relax", concurrency: 4, previous: 2 })),
    true,
    "recovery must not be swallowed by the wait that preceded it",
  );
});

test("throttle: a notice with no key falls back to its text", () => {
  let now = 0;
  const allow = createRepeatThrottle({ now: () => now, repeatMs: 10 });
  assert.equal(allow({ level: "warning", text: "disk is full" }), true);
  assert.equal(allow({ level: "warning", text: "disk is full" }), false);
  assert.equal(allow({ level: "warning", text: "disk is nearly full" }), true);
  now += 11;
  assert.equal(allow({ level: "warning", text: "disk is full" }), true);
});

test("throttle: a long session does not accumulate keys without limit", () => {
  let now = 0;
  const allow = createRepeatThrottle({ now: () => now, repeatMs: 10 });
  for (let i = 0; i < 500; i++) {
    now += 1;
    assert.equal(allow({ level: "info", text: `event ${i}`, key: `k${i}` }), true);
  }
  // The sweep drops only EXPIRED entries, so nothing still inside its window
  // can be un-suppressed by it.
  assert.equal(allow({ level: "info", text: "recent", key: "k499" }), false);
});
