import assert from "node:assert/strict";
import { test } from "node:test";
import { dropFailedTail, isCutStreamError, resolveStreamResumeMax } from "../../src/inference/streamResume.ts";

const user = { role: "user" };
const call = { role: "assistant", stopReason: "toolUse" };
const result = { role: "toolResult" };
const failed = { role: "assistant", stopReason: "error", errorMessage: "Stream ended without finish_reason" };

test("dropFailedTail removes only the trailing failed assistant message", () => {
  assert.deepEqual(dropFailedTail([user, call, result, failed]), [user, call, result]);
});

test("dropFailedTail refuses histories it cannot resume from", () => {
  assert.equal(dropFailedTail([user, call, result]), undefined, "nothing failed");
  assert.equal(dropFailedTail([failed]), undefined, "nothing left");
  assert.equal(dropFailedTail([user, call, failed]), undefined, "ends in an unanswered assistant turn");
});

test("isCutStreamError recognises cut streams and not gateway verdicts", () => {
  assert.equal(isCutStreamError("Stream ended without finish_reason"), true);
  assert.equal(isCutStreamError("terminated"), true);
  assert.equal(isCutStreamError("429 rate limited"), false);
  assert.equal(isCutStreamError(undefined), false);
});

test("resolveStreamResumeMax defaults to 3, accepts 0, ignores junk", () => {
  assert.equal(resolveStreamResumeMax({}), 3);
  assert.equal(resolveStreamResumeMax({ PI_STREAM_RESUME_MAX: "0" }), 0);
  assert.equal(resolveStreamResumeMax({ PI_STREAM_RESUME_MAX: "5" }), 5);
  assert.equal(resolveStreamResumeMax({ PI_STREAM_RESUME_MAX: "x" }), 3);
});
