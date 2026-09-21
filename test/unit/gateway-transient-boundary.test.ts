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
import {
  decideGatewayRetry,
  isAccountWideRefusal,
  isGatewayAdmissionRefusal,
  parseGatewayWait,
} from "../../src/gateway/signals.ts";
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

test("boundary: an advertised wait is owned by the admission controller whatever carried it", () => {
  // The two predicates answer different questions, and a fresh-context review
  // found them disagreeing in a way that mattered: a rate limit reporting its
  // wait in a header was handed to the layer that gives up after four attempts,
  // reintroducing the exact "fails after N attempts" behaviour on the worker
  // path that this subsystem removed from the interactive one.
  const bodySeconds = '429: {"retry_after": 30, "message": "slow down"}';
  assert.equal(parseGatewayWait({ text: bodySeconds })?.source, "body");
  assert.equal(classifyError(new Error(bodySeconds)).retryable, false, "handed over, not retried here");
});

test("boundary: a refusal that advertises nothing still belongs to the transient layer", () => {
  // No advertised wait means no instruction to honour, and a guess is what
  // exponential backoff is for.
  for (const text of ["503 no worker for model", "429 Too Many Requests", "overloaded, try again later"]) {
    const signal = parseGatewayWait({ text });
    assert.equal(signal?.source, "default", `${text} should synthesize its wait`);
    assert.equal(classifyError(new Error(text)).retryable, true, `${text} should stay transient`);
  }
});

test("boundary: the two discriminators answer different questions on purpose", () => {
  // Ownership (which layer waits) is not scope (who waits). A bare 503 is owned
  // by the transient layer AND is caller-scoped; an admission 429 is owned by
  // the admission controller AND is account-wide. They coincide often enough
  // that conflating them looks harmless, which is why this is pinned.
  const bare503 = parseGatewayWait({ text: "503 no worker for model" });
  assert.ok(bare503);
  assert.equal(isGatewayAdmissionRefusal("503 no worker for model"), false, "ownership: transient layer");
  assert.equal(isAccountWideRefusal(bare503), false, "scope: this caller only");

  const admission = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(admission);
  assert.equal(isGatewayAdmissionRefusal(PRODUCTION_429), true, "ownership: admission controller");
  assert.equal(isAccountWideRefusal(admission), true, "scope: everyone");
});
