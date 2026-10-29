import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_REQUEST_ORIGIN,
  REQUEST_ORIGIN_RELAY_HEADER,
  type RequestOrigin,
  normalizeRequestOrigin,
  parseAdmissionPayload,
  requestOriginHeaders,
} from "../../src/inference/admissionContract.ts";

/**
 * #419 — "batch workers are refused while interactive requests succeed" cannot be
 * checked provider-side until the client says, on the wire, which kind of request
 * it is making. `scope` is not that: it names the resource the gate applies to
 * (request / model / caller / global), not who asked.
 *
 * Decision: origin IS a real, wanted signal, carried as `request_origin` with the
 * default `interactive` so existing traffic is unambiguous. Unknown tokens are
 * preserved rather than dropped — a gateway that invents an origin must still be
 * visible, and a missing origin must never be fabricated during parsing.
 */

/** A worker's origin survives the envelope it is relayed in. */
test("request origin survives the admission envelope relay", () => {
  const wire = JSON.stringify({
    type: "inference_admission",
    reason: "queue_deadline_exceeded",
    scope: "model",
    request_origin: "mission-worker",
    retry_after_ms: 5_000,
  });

  const info = parseAdmissionPayload(JSON.parse(wire));
  assert.equal(info?.requestOrigin, "mission-worker", "the origin the gateway relayed is the origin we read");
  assert.equal(info?.scope, "model", "origin is separate from the admission scope");
});

/** Absent origin is absent — parsing never invents one. */
test("an envelope without origin claims none", () => {
  const info = parseAdmissionPayload({ type: "inference_admission", reason: "queue_timeout", retry_after_ms: 1_000 });

  assert.equal(info?.requestOrigin, undefined, "no origin in, no origin out");
});

/** The default is applied where a request is EMITTED, so old traffic is unambiguous. */
test("an emitted request without an explicit origin is interactive", () => {
  assert.equal(DEFAULT_REQUEST_ORIGIN, "interactive");
  assert.deepEqual(requestOriginHeaders(undefined), { [REQUEST_ORIGIN_RELAY_HEADER]: "interactive" });
  assert.deepEqual(requestOriginHeaders("mission-worker" as RequestOrigin), {
    [REQUEST_ORIGIN_RELAY_HEADER]: "mission-worker",
  });
});

/** An origin we do not know is preserved, not dropped — a new producer stays visible. */
test("an unknown origin token is preserved", () => {
  assert.equal(normalizeRequestOrigin("  Mission-Worker  "), "mission-worker", "spelling is normalised");
  assert.equal(normalizeRequestOrigin("batch-etl"), "batch-etl", "an unfamiliar producer stays identifiable");
  assert.equal(normalizeRequestOrigin(""), undefined, "an empty origin is no origin");
  assert.equal(normalizeRequestOrigin(undefined), undefined);
});

/** The header name is the one the relay is told to carry, and it is stable. */
test("the relay header is a stable inferweave header", () => {
  assert.equal(REQUEST_ORIGIN_RELAY_HEADER, "x-inferweave-request-origin");
});
