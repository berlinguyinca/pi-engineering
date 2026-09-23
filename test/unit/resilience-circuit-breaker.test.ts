import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CircuitBreaker } from "../../src/resilience/circuitBreaker.ts";

describe("CircuitBreaker", () => {
  it("starts closed and allows requests", () => {
    const b = new CircuitBreaker({ threshold: 5 });
    assert.equal(b.snapshot().state, "CLOSED");
    assert.ok(b.allowRequest());
  });

  it("opens after the failure threshold", () => {
    const t = 0;
    const b = new CircuitBreaker({ threshold: 3, now: () => t });
    b.recordFailure();
    assert.equal(b.snapshot().state, "CLOSED");
    b.recordFailure();
    assert.equal(b.snapshot().state, "CLOSED");
    b.recordFailure();
    assert.equal(b.snapshot().state, "OPEN");
    assert.ok(!b.allowRequest());
  });

  it("allows a half-open probe after cooldown then closes on success", () => {
    let t = 0;
    const b = new CircuitBreaker({ threshold: 2, openCooldownMs: 10_000, now: () => t });
    b.recordFailure();
    b.recordFailure();
    assert.equal(b.snapshot().state, "OPEN");
    assert.ok(!b.allowRequest());
    t = 10_000;
    assert.ok(b.allowRequest());
    assert.ok(b.tryHalfOpen());
    assert.equal(b.snapshot().state, "HALF_OPEN");
    b.recordSuccess();
    assert.equal(b.snapshot().state, "CLOSED");
  });

  it("reopens on a half-open failure", () => {
    let t = 0;
    const b = new CircuitBreaker({ threshold: 2, openCooldownMs: 5_000, now: () => t });
    b.recordFailure();
    b.recordFailure();
    t = 5_000;
    b.tryHalfOpen();
    assert.equal(b.snapshot().state, "HALF_OPEN");
    b.recordFailure();
    assert.equal(b.snapshot().state, "OPEN");
  });

  it("records consecutive failures", () => {
    const t = 0;
    const b = new CircuitBreaker({ threshold: 5, now: () => t });
    b.recordFailure();
    b.recordFailure();
    assert.equal(b.snapshot().consecutiveFailures, 2);
    b.recordSuccess();
    assert.equal(b.snapshot().consecutiveFailures, 0);
  });
});
