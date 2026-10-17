import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MISSION_CANCEL_REASON,
  MISSION_PAUSE_REASON,
  interruptibleRun,
  isPauseAbort,
} from "../../src/orchestration/interrupt.ts";

test("isPauseAbort returns true only for a pause abort", () => {
  const pause = new AbortController();
  pause.abort(MISSION_PAUSE_REASON);
  assert.equal(isPauseAbort(pause.signal), true);
});

test("isPauseAbort returns false for undefined", () => {
  assert.equal(isPauseAbort(undefined), false);
});

test("isPauseAbort returns false for a plain abort", () => {
  const plain = new AbortController();
  plain.abort();
  assert.equal(isPauseAbort(plain.signal), false);
});

test("isPauseAbort returns false for a cancel abort", () => {
  const cancel = new AbortController();
  cancel.abort(MISSION_CANCEL_REASON);
  assert.equal(isPauseAbort(cancel.signal), false);
});

test("pause and cancel reasons carry their frozen kind strings", () => {
  assert.equal(MISSION_PAUSE_REASON.kind, "pi-engineering.mission-pause");
  assert.equal(MISSION_CANCEL_REASON.kind, "pi-engineering.mission-cancel");
  assert.equal(Object.isFrozen(MISSION_PAUSE_REASON), true);
  assert.equal(Object.isFrozen(MISSION_CANCEL_REASON), true);
  assert.throws(() => {
    (MISSION_PAUSE_REASON as { kind: string }).kind = "mutated";
  });
  assert.throws(() => {
    (MISSION_CANCEL_REASON as { kind: string }).kind = "mutated";
  });
  assert.equal(MISSION_PAUSE_REASON.kind, "pi-engineering.mission-pause");
  assert.equal(MISSION_CANCEL_REASON.kind, "pi-engineering.mission-cancel");
});

test("aborting the run controller cancels with the cancel reason", () => {
  const run = interruptibleRun(undefined, "cancel");
  run.controller.abort(MISSION_CANCEL_REASON);
  assert.equal(run.signal.aborted, true);
  assert.equal(run.signal.reason, MISSION_CANCEL_REASON);
});

test("pause mode: caller abort invokes hook once and pauses the run", () => {
  const caller = new AbortController();
  const run = interruptibleRun(caller.signal, "pause");
  let calls = 0;
  run.onPause(() => {
    calls += 1;
  });
  assert.equal(run.signal.aborted, false);
  caller.abort();
  assert.equal(calls, 1);
  assert.equal(run.signal.aborted, true);
  assert.equal(run.signal.reason, MISSION_PAUSE_REASON);
  assert.equal(isPauseAbort(run.signal), true);
});

test("pause mode: registering onPause after already paused invokes hook immediately", () => {
  const caller = new AbortController();
  const run = interruptibleRun(caller.signal, "pause");
  caller.abort();
  assert.equal(run.signal.aborted, true);
  assert.equal(isPauseAbort(run.signal), true);
  let called = false;
  run.onPause(() => {
    called = true;
  });
  assert.equal(called, true);
});

test("cancel mode: caller abort propagates the caller's reason and skips pause hooks", () => {
  const caller = new AbortController();
  const run = interruptibleRun(caller.signal, "cancel");
  let pauseCalls = 0;
  run.onPause(() => {
    pauseCalls += 1;
  });
  caller.abort(MISSION_CANCEL_REASON);
  assert.equal(run.signal.aborted, true);
  assert.equal(run.signal.reason, MISSION_CANCEL_REASON);
  assert.equal(pauseCalls, 0);
  assert.equal(isPauseAbort(run.signal), false);
});

test("dispose detaches the caller signal so later aborts do not reach the run", () => {
  const caller = new AbortController();
  const run = interruptibleRun(caller.signal, "pause");
  run.dispose();
  caller.abort();
  assert.equal(run.signal.aborted, false);
});
