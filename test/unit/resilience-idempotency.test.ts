import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdempotencyRegistry, cryptoRequestId, hashResult } from "../../src/resilience/idempotency.ts";

describe("IdempotencyRegistry", () => {
  it("returns a stable request_id across beginRequest calls (retry idempotency)", () => {
    const r = new IdempotencyRegistry();
    const k1 = r.beginRequest("MSN-1", "step-1");
    const k2 = r.beginRequest("MSN-1", "step-1");
    assert.equal(k1.request_id, k2.request_id);
    assert.equal(k1.mission_id, "MSN-1");
    assert.equal(k1.step_id, "step-1");
  });

  it("derives deterministic request ids from mission + step", () => {
    assert.equal(cryptoRequestId("MSN-1", "step-1"), cryptoRequestId("MSN-1", "step-1"));
    assert.notEqual(cryptoRequestId("MSN-1", "step-1"), cryptoRequestId("MSN-1", "step-2"));
  });

  it("records and replays tool completions (tool idempotency)", () => {
    const r = new IdempotencyRegistry();
    const rec = r.recordToolCompletion({
      tool_call_id: "call_abc",
      mission_id: "MSN-1",
      step_id: "step-1",
      status: "completed",
      result: "the shell command output",
      completed_at: "2026-01-01T00:00:00Z",
    });
    assert.ok(r.hasToolCompletion("call_abc"));
    const replayed = r.getToolCompletion("call_abc");
    assert.ok(replayed);
    assert.equal(replayed!.status, "completed");
    assert.equal(replayed!.result_hash, hashResult("the shell command output"));
    assert.equal(rec.result_hash, replayed!.result_hash);
  });

  it("does not report an unrecorded tool as completed", () => {
    const r = new IdempotencyRegistry();
    assert.ok(!r.hasToolCompletion("call_never_made"));
    assert.equal(r.getToolCompletion("call_never_made"), undefined);
  });
});
