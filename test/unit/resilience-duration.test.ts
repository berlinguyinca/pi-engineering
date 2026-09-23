import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDurationMs } from "../../src/resilience/duration.ts";

describe("parseDurationMs", () => {
  it("parses plain millisecond integers", () => {
    assert.equal(parseDurationMs("90000"), 90_000);
    assert.equal(parseDurationMs("10000"), 10_000);
  });

  it("parses human duration strings", () => {
    assert.equal(parseDurationMs("90m"), 5_400_000);
    assert.equal(parseDurationMs("10s"), 10_000);
    assert.equal(parseDurationMs("1h"), 3_600_000);
    assert.equal(parseDurationMs("1h30m"), 5_400_000);
    assert.equal(parseDurationMs("1500ms"), 1_500);
  });

  it("rejects invalid durations", () => {
    assert.equal(parseDurationMs(""), null);
    assert.equal(parseDurationMs("abc"), null);
    assert.equal(parseDurationMs("-5"), null);
    assert.equal(parseDurationMs("0"), null);
    assert.equal(parseDurationMs("5x"), null);
  });
});
