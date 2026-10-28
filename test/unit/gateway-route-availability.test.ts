/**
 * #428 — route-availability refusals. `retryable: false` in an InferWeave
 * envelope is a statement about THAT REQUEST's replay-safety, not about the
 * route's availability: `upstream_error` (upstream died mid-request) and
 * `model_not_found` (cold/moved route, `x_availability: MODEL_UNAVAILABLE`)
 * must hand the long wait to the mission scheduler as a capacity wait, while
 * quota/billing/malformed refusals keep failing the task. Envelopes below are
 * the field-observed ones from 2026-10-25 (MSN-03avoS/1WShkr/RqGkem/80gYOG).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatewayFailureMarker, isRouteAvailabilitySignal, parseGatewayWait } from "../../src/gateway/signals.ts";
import { FailureClassifier, RecoveryPlanner } from "../../src/orchestration/recovery.ts";
import type { RecoveryDecision } from "../../src/orchestration/types.ts";

const UPSTREAM_400 =
  '400: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"upstream_error","message":"Correct the request syntax, parameters, endpoint, or model identity.","reason":"upstream_error","replay_safe":false,"request_state":"unknown","retryable":false,"scope":"request","type":"inferweave_backpressure"}';
const NOT_FOUND_404 =
  '404: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"model_not_found","message":"Model qwen3.8-27b-modality-text-ctx-c128k-quant-q4_k_m is not served here (model_not_found).","reason":"model_not_found","replay_safe":false,"request_state":"not_started","retryable":false,"scope":"request","type":"inferweave_backpressure","x_availability":"MODEL_UNAVAILABLE","x_fallback_candidates":[]}';

const signal = (text: string) => {
  const s = parseGatewayWait({ text });
  assert.ok(s, `expected a gateway signal for: ${text.slice(0, 60)}`);
  return s;
};

describe("#428 route-availability capacity wait", () => {
  it("hands upstream_error (retryable:false) to the scheduler as transient", () => {
    const s = signal(UPSTREAM_400);
    assert.equal(s.retryable, false, "the envelope says non-replayable");
    assert.equal(isRouteAvailabilitySignal(s), true);
    assert.equal(gatewayFailureMarker(s), "transient:server_unavailable");
  });

  it("hands model_not_found / MODEL_UNAVAILABLE to the scheduler as transient", () => {
    const s = signal(NOT_FOUND_404);
    assert.equal(isRouteAvailabilitySignal(s), true);
    assert.equal(gatewayFailureMarker(s), "transient:server_unavailable");
  });

  it("keeps quota/billing refusals failing the task", () => {
    const s = signal(
      '402: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"quota_exceeded","message":"billing exhausted","reason":"quota_exceeded","retryable":false,"type":"inferweave_backpressure"}',
    );
    assert.equal(isRouteAvailabilitySignal(s), false);
    assert.equal(gatewayFailureMarker(s), "gateway:quota_exceeded");
  });

  it("does not park on unstructured prose about upstream errors", () => {
    const parsed = parseGatewayWait({ text: "the upstream error rate is high these days" });
    if (parsed) assert.equal(isRouteAvailabilitySignal(parsed), false);
  });

  it("leaves the ordinary replay-safe transient path alone", () => {
    const s = signal('503: {"error":{"code":"upstream_error","type":"api_error"},"retry_after":5}');
    assert.equal(s.retryable, true, "ordinary retryable upstream errors");
    assert.equal(isRouteAvailabilitySignal(s), false, "the special case applies only to non-replayable refusals");
    assert.equal(gatewayFailureMarker(s), "transient:server_unavailable");
  });

  it("ends the mission-side loop: the executor summary capacity-waits, never STOPs", () => {
    const summary = `backend reported failed: Model gateway refused the request after 0 honoured wait(s): ${UPSTREAM_400}`;
    const classification = new FailureClassifier().classify({ missionId: "MSN-428", taskId: "TSK-428", summary });
    assert.equal(classification.category, "PROVIDER_TRANSIENT");
    const planner = new RecoveryPlanner({ missionCeiling: 50, strategyMaxAttempts: 2 });
    const decision = (attempt: number): RecoveryDecision => ({
      recoveryId: `RCV-${attempt}`,
      missionId: "MSN-428",
      classificationId: classification.classificationId,
      action: "PROBE_AND_BACKOFF",
      expectedMaterialChange: "observe a healthy provider probe",
      attempt,
      maxAttempts: 2,
      deadline: "2026-10-26T00:00:00.000Z",
      nextActionAt: "2026-10-25T00:00:00.000Z",
      status: "failed",
      decidedAt: "2026-10-25T00:00:00.000Z",
      failureFingerprint: classification.fingerprint,
    });
    const history = [decision(1), decision(2), decision(3), decision(4)];
    const parked = planner.decide({ classification, history, now: 10_000 });
    assert.equal(parked.action, "PROBE_AND_BACKOFF", "a gateway availability refusal is waited out, never STOPped");
  });
});
