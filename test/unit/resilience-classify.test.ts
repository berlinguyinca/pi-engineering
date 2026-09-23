import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATEGORY_TO_STATE, classifyInfraError } from "../../src/resilience/classify.ts";

describe("classifyInfraError", () => {
  it("classifies 503 / no worker as transient infrastructure", () => {
    const cls = classifyInfraError(new Error("503 no worker for model"));
    assert.equal(cls.category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(cls.retryable, true);
  });

  it("classifies network/timeout failures as transient infrastructure", () => {
    assert.equal(classifyInfraError(new Error("ECONNRESET")).category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(classifyInfraError(new Error("request timed out")).category, "TRANSIENT_INFRASTRUCTURE");
  });

  it("classifies model relocation as transient infrastructure with scheduler state", () => {
    const err: Record<string, unknown> = {
      message: "MODEL_RELOCATING",
      scheduler_state: "relocating",
      retryable: true,
      retry_after_ms: 15000,
      request_id: "req-1",
    };
    const cls = classifyInfraError(err);
    assert.equal(cls.category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(cls.scheduler_state, "relocating");
    assert.equal(cls.request_id, "req-1");
    assert.equal(cls.retryAfterMs, 15_000);
  });

  it("classifies 429 caller_concurrency as rate-limited", () => {
    const err: Record<string, unknown> = { status: 429, message: "inference admission: caller_concurrency" };
    const cls = classifyInfraError(err);
    assert.equal(cls.category, "RATE_LIMITED");
  });

  it("honours retry-after hints", () => {
    const cls = classifyInfraError({ status: 503, retryAfter: 30 });
    assert.equal(cls.retryAfterMs, 30_000);
  });

  it("classifies 413 / context overflow as context-recoverable, not infra", () => {
    const cls = classifyInfraError(new Error("413 request too large: context length exceeded"));
    assert.equal(cls.category, "CONTEXT_RECOVERABLE");
    assert.equal(CATEGORY_TO_STATE.CONTEXT_RECOVERABLE, "RECOVERING_CONTEXT");
  });

  it("classifies auth/config errors as needs attention and non-retryable", () => {
    const cls = classifyInfraError(new Error("401 invalid API key"));
    assert.equal(cls.category, "AUTH_CONFIG");
    assert.equal(cls.retryable, false);
    assert.equal(CATEGORY_TO_STATE.AUTH_CONFIG, "NEEDS_ATTENTION");
  });

  it("classifies invalid requests as needs attention and non-retryable", () => {
    const cls = classifyInfraError(new Error("400 unknown model gpt-4-nonexistent"));
    assert.equal(cls.category, "INVALID_REQUEST");
    assert.equal(cls.retryable, false);
  });

  it("maps each category to the correct mission state", () => {
    assert.equal(CATEGORY_TO_STATE.TRANSIENT_INFRASTRUCTURE, "WAITING_FOR_LLM");
    assert.equal(CATEGORY_TO_STATE.RATE_LIMITED, "WAITING_FOR_CAPACITY");
    assert.equal(CATEGORY_TO_STATE.CONTEXT_RECOVERABLE, "RECOVERING_CONTEXT");
    assert.equal(CATEGORY_TO_STATE.AUTH_CONFIG, "NEEDS_ATTENTION");
    assert.equal(CATEGORY_TO_STATE.INVALID_REQUEST, "NEEDS_ATTENTION");
  });
});
