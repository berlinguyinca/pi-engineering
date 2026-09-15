/**
 * Where the two retry layers meet.
 *
 * Two independent mechanisms can claim a 429, and only one of them is right
 * for THIS gateway:
 *
 *   * `withTransientRetry` (src/guard/transient.ts) backs off exponentially and
 *     gives up after `maxAttempts`, per worker. Its `extractRetryAfterMs` reads
 *     a `retryAfter` property or a `retry-after` HEADER — it never parses
 *     `retry_after_ms` out of the JSON BODY, which is where this gateway puts
 *     it. So it would back off 1s, 2s, 4s against a 30s ask and then fail the
 *     work item.
 *   * the admission controller parses the body, honours the exact advertised
 *     wait, holds it process-wide so parallel legs stop hammering, and never
 *     gives up.
 *
 * These tests pin the ownership boundary. Neither layer's own tests can: each
 * only ever sees its own side.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { decideGatewayRetry, parseGatewayWait } from "../../src/gateway/signals.ts";
import { classifyError } from "../../src/guard/transient.ts";

/** The verbatim production payload, as reported by the operator. */
const PRODUCTION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":100,"queued":30,"reason":"queue_timeout","request_id":"332ea9d2-6a34-4d06-ba7e-514081ccbdef","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';

test("boundary: a gateway admission 429 is NOT a transient rate_limit", () => {
  const classified = classifyError(new Error(PRODUCTION_429));
  assert.notEqual(classified.category, "rate_limit", "the transient layer must not claim this 429");
  assert.equal(classified.retryable, false, "claiming it retryable means backing off against a wait it cannot read");
});

test("boundary: the same payload IS a gateway wait, with the body's exact delay", () => {
  const decision = decideGatewayRetry(PRODUCTION_429, 0, resolveGatewayConfig().maxRetries);
  assert.equal(decision.action, "wait");
  assert.equal(decision.action === "wait" ? decision.signal.retryAfterMs : 0, 30_000);
  assert.equal(decision.action === "wait" ? decision.signal.source : "", "body");
});

test("boundary: the transient layer still owns every other transient failure", () => {
  // The handover is narrow on purpose: 503s, networks blips and timeouts are
  // exactly what the transient layer is good at, and the gateway parser does
  // not recognise them.
  assert.equal(classifyError(new Error("503 no worker for model")).category, "server_unavailable");
  assert.equal(classifyError(new Error("fetch failed ECONNRESET")).category, "network");
  assert.equal(classifyError(new Error("provider deadline exceeded: timeout")).category, "timeout");
  // The parser does produce a signal for a bare 503, but with source "default"
  // — a synthesized guess, not an advertised wait. That is precisely why the
  // handover keys on source === "body" rather than on "the parser recognised it".
  assert.equal(parseGatewayWait({ text: "503 no worker for model" })?.source, "default");
});

test("boundary: a plain rate limit with no gateway envelope stays transient", () => {
  // Not every 429 is this gateway. One without an admission body has no
  // advertised wait to honour, so exponential backoff is the right answer.
  const classified = classifyError(new Error("429 Too Many Requests"));
  assert.equal(classified.category, "rate_limit");
  assert.equal(classified.retryable, true);
});
