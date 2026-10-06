import assert from "node:assert/strict";
import { test } from "node:test";
import { SupervisorRepairBackoff } from "../../src/orchestration/supervisorBackoff.ts";

test("repeated supervisor repairs of the same unchanged decision back off exponentially (session review churn)", () => {
  const backoff = new SupervisorRepairBackoff({ baseMs: 30_000, maxMs: 30 * 60_000 });
  const fp = "RCV-1|BLOCKED|BLK-1";
  let now = 0;
  assert.equal(backoff.shouldAttempt("MSN-1", fp, now), true, "first attempt runs");
  backoff.recordAttempt("MSN-1", fp, now);
  now += 30_000;
  assert.equal(backoff.shouldAttempt("MSN-1", fp, now), false, "the next 30s tick is skipped");
  now += 30_000;
  assert.equal(backoff.shouldAttempt("MSN-1", fp, now), true);
  backoff.recordAttempt("MSN-1", fp, now);
  now += 45_000;
  assert.equal(backoff.shouldAttempt("MSN-1", fp, now), false, "delay doubles to 60s");
  now += 30_000;
  assert.equal(backoff.shouldAttempt("MSN-1", fp, now), true);
  for (let i = 0; i < 20; i++) backoff.recordAttempt("MSN-1", fp, now);
  assert.equal(backoff.shouldAttempt("MSN-1", fp, now + 30 * 60_000 + 1), true, "delay is capped");
});

test("a changed decision or mission state resets the backoff; missions are independent", () => {
  const backoff = new SupervisorRepairBackoff({ baseMs: 30_000, maxMs: 60_000 });
  backoff.recordAttempt("MSN-1", "RCV-1|BLOCKED|BLK-1", 0);
  assert.equal(backoff.shouldAttempt("MSN-1", "RCV-2|BLOCKED|BLK-1", 1_000), true, "new decision runs at once");
  assert.equal(backoff.shouldAttempt("MSN-2", "RCV-1|BLOCKED|BLK-1", 1_000), true, "other missions unaffected");
  backoff.forget("MSN-1");
  assert.equal(backoff.shouldAttempt("MSN-1", "RCV-1|BLOCKED|BLK-1", 1_000), true);
});
