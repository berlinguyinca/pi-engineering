import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatElapsed,
  recordProbe,
  remainingMs,
  restoreRetryWindow,
  startRetryWindow,
  windowOpen,
} from "../../src/resilience/retryWindow.ts";

describe("retry window (time-based)", () => {
  it("opens a 90-minute window from the start time", () => {
    const w = startRetryWindow(1000, 5_400_000);
    assert.equal(w.retry_started_at_ms, 1000);
    assert.equal(w.retry_deadline_ms, 5_401_000);
    assert.ok(windowOpen(w, 1000));
  });

  it("tracks remaining budget", () => {
    const w = startRetryWindow(0, 10_000);
    assert.equal(remainingMs(w, 4_000), 6_000);
    assert.ok(windowOpen(w, 9_999));
    assert.ok(!windowOpen(w, 10_000));
    assert.equal(remainingMs(w, 99_000), 0);
  });

  it("restoring a persisted window does NOT reset the deadline (restart survival)", () => {
    const w = startRetryWindow(1000, 90 * 60_000);
    const restored = restoreRetryWindow(w);
    assert.equal(restored.retry_started_at_ms, 1000);
    assert.equal(restored.retry_deadline_ms, w.retry_deadline_ms);
    // A process that restarts later keeps the ORIGINAL deadline.
    assert.ok(!windowOpen(restored, w.retry_deadline_ms + 1));
  });

  it("records probes", () => {
    let w = startRetryWindow(0, 10_000);
    w = recordProbe(w, 5_000);
    w = recordProbe(w, 15_000);
    assert.equal(w.probe_count, 2);
    assert.equal(w.last_probe_at_ms, 15_000);
  });

  it("formats elapsed time as HH:MM:SS", () => {
    assert.equal(formatElapsed(10_000), "00:00:10");
    assert.equal(formatElapsed(90 * 60_000), "01:30:00");
    assert.equal(formatElapsed(5_400_000), "01:30:00");
  });
});
