import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { admissionFromResponse, isAutomaticReplayAllowed } from "../../src/inference/admissionContract.ts";
import { resolveRetryDelay } from "../../src/inference/retryDelay.ts";

const FIXTURE_URL = new URL("../fixtures/backpressure-conformance-v1.json", import.meta.url);
const FIXTURE_SHA256 = "775be4843952d3a8db99fdccdf9d82820ec17eb31c7fc4a3da3aa7fa003dfc9d";

interface ExpectedGuidance {
  code: string;
  reason: string;
  retryable: boolean;
  replay_safe: boolean;
  request_state: "not_started" | "queued" | "dispatched" | "streaming" | "unknown";
  action: string | null;
  action_code: string | null;
  retry_after_ms?: number;
  scope: string;
}

interface ConformanceCase {
  name: string;
  role: "producer" | "client_input";
  valid: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  expected: ExpectedGuidance;
}

interface ConformanceDocument {
  version: number;
  cases: ConformanceCase[];
}

async function loadFixture(): Promise<ConformanceDocument> {
  const raw = await readFile(FIXTURE_URL);
  assert.equal(createHash("sha256").update(raw).digest("hex"), FIXTURE_SHA256, "vendored fixture hash drifted");

  const canonicalPath = process.env.INFERWEAVE_BACKPRESSURE_CONFORMANCE;
  if (canonicalPath) {
    const canonical = await readFile(canonicalPath);
    assert.deepEqual(raw, canonical, `vendored fixture differs byte-for-byte from ${canonicalPath}`);
  }

  return JSON.parse(raw.toString("utf8")) as ConformanceDocument;
}

test("consumes the canonical backpressure conformance vectors", async (t) => {
  const document = await loadFixture();
  assert.equal(document.version, 1);
  assert.ok(document.cases.length > 0, "fixture must contain conformance cases");

  for (const vector of document.cases) {
    await t.test(vector.name, () => {
      const info = admissionFromResponse({
        status: vector.status,
        headers: vector.headers,
        body: vector.body,
      });
      assert.ok(info, "actual admission parser must recognize the vector");
      assert.equal(info.code, vector.expected.code);
      assert.equal(info.reason, vector.expected.reason);
      assert.equal(info.retryable, vector.expected.retryable);
      assert.equal(info.replaySafe, vector.expected.replay_safe);
      assert.equal(info.requestState, vector.expected.request_state);
      assert.equal(info.action, vector.expected.action ?? undefined);
      assert.equal(info.actionCode, vector.expected.action_code ?? undefined);
      assert.equal(info.scope, vector.expected.scope);

      const replayAllowed = isAutomaticReplayAllowed(info, false);
      assert.equal(replayAllowed, vector.expected.replay_safe, "automatic replay must fail closed");

      if (vector.expected.retry_after_ms !== undefined) {
        const delay = resolveRetryDelay({
          headers: vector.headers,
          body: info.payload,
          attempt: 1,
          bounds: { minDelayMs: 0, maxDelayMs: 60_000, baseBackoffMs: 100, jitterRatio: 0 },
        });
        assert.equal(delay.serverDelayMs, vector.expected.retry_after_ms);
        assert.equal(delay.delayMs, vector.expected.retry_after_ms);
      }
    });
  }
});
