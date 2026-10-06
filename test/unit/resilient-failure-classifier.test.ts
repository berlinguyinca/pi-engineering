/**
 * Unit tests for the unified inference-failure classifier (fault-tolerance
 * spec §29). Every required failure shape is classified, and the InferWeave
 * structural sources — JSON error bodies and `X-InferWeave-*` headers — are
 * tested INDEPENDENTLY of each other and of HTTP status / stream state /
 * network codes, so a regression in one source cannot be masked by another.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyInferenceFailure } from "../../src/inference/failureClassifier.ts";
import { metadataFromResponse } from "../../src/inference/inferweaveMetadata.ts";

function netError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

// ─── Incomplete stream (spec §3) ─────────────────────────────────────────────

describe("incomplete stream (transient:incomplete_stream)", () => {
  it("classifies 'stream ended without finish_reason' from the stream state", () => {
    const f = classifyInferenceFailure({
      streamState: { finished: false, outputCommitted: true, partialChars: 412 },
      model: "qwen3.8-27b",
    });
    assert.equal(f.class, "incomplete_stream");
    assert.equal(f.retryable, true);
    assert.equal(f.action, "retry_same_model");
    assert.equal(f.modelScoped, false, "a stream cut is not evidence the model is unselectable");
    assert.equal(f.source, "stream_state");
  });

  it("classifies 'stream ended without finish_reason' from the rendered error text", () => {
    const f = classifyInferenceFailure({ error: new Error("Stream ended without finish_reason") });
    assert.equal(f.class, "incomplete_stream");
    assert.equal(f.retryable, true);
    assert.equal(f.action, "retry_same_model");
    assert.equal(f.source, "string_fallback");
  });

  it("classifies unexpected EOF", () => {
    const f = classifyInferenceFailure({ error: new Error("unexpected EOF while reading response body") });
    assert.equal(f.class, "incomplete_stream");
    assert.equal(f.retryable, true);
  });

  it("classifies connection reset / socket hang up / premature close / incomplete SSE", () => {
    for (const text of [
      "connection reset by peer",
      "socket hang up",
      "Premature close",
      "incomplete SSE stream: aborted after 14 events",
      "fetch failed",
    ]) {
      const f = classifyInferenceFailure({ error: new Error(text) });
      assert.equal(f.class, text === "fetch failed" ? "network_interruption" : "incomplete_stream", text);
      assert.equal(f.retryable, true, text);
    }
  });

  it("classifies network error codes (ECONNRESET, EPIPE, ETIMEDOUT, UND_ERR_SOCKET)", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
      const f = classifyInferenceFailure({ error: netError(code, "request failed") });
      assert.equal(f.class, "network_interruption", code);
      assert.equal(f.retryable, true, code);
      assert.equal(f.action, "retry_same_model", code);
      assert.equal(f.source, "network_code", code);
    }
  });
});

// ─── InferWeave JSON error bodies (structural, independent of headers) ──────

describe("InferWeave structured error bodies", () => {
  it("classifies no_workers from the body reason", () => {
    const md = metadataFromResponse({ status: 503, body: { reason: "no_workers", model: "qwen3.8-27b" } });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "no_workers");
    assert.equal(f.modelScoped, true);
    assert.equal(f.canFallback, true);
    assert.equal(f.shouldRefreshCatalog, true);
    assert.equal(f.action, "refresh_then_fallback");
    assert.equal(f.source, "inferweave_body");
    assert.equal(f.model, "qwen3.8-27b");
  });

  it("classifies capacity_unavailable from the body reason (provider scope, no model switch)", () => {
    const md = metadataFromResponse({ status: 503, body: { reason: "capacity_unavailable", retry_after_ms: 45_000 } });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "capacity_unavailable");
    assert.equal(f.providerScoped, true);
    assert.equal(f.action, "honor_retry_after");
    assert.equal(f.canFallback, false, "global saturation must wait, not switch models");
    assert.equal(f.retryAfterMs, 45_000);
  });

  it("classifies model_activating with server timing", () => {
    const md = metadataFromResponse({ status: 503, body: { reason: "model_activating", retry_after_ms: 90_000 } });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "model_activating");
    assert.equal(f.modelScoped, true);
    assert.equal(f.action, "honor_retry_after");
    assert.equal(f.retryAfterMs, 90_000);
  });

  it("classifies worker_evicted", () => {
    const md = metadataFromResponse({ status: 503, body: { reason: "worker_evicted", worker: "gpu-3" } });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "worker_evicted");
    assert.equal(f.modelScoped, true);
    assert.equal(f.canFallback, true);
  });

  it("classifies worker_restarting with a server wait as honour-wait", () => {
    const md = metadataFromResponse({ status: 503, body: { reason: "worker_restarting", retry_after_ms: 30_000 } });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "worker_restarting");
    assert.equal(f.action, "honor_retry_after");
  });

  it("classifies model_not_found from the body", () => {
    const md = metadataFromResponse({ status: 404, body: { reason: "model_not_found", model: "ghost-9" } });
    const f = classifyInferenceFailure({ error: new Error("404"), metadata: md });
    assert.equal(f.class, "model_not_found");
    assert.equal(f.modelScoped, true);
    assert.equal(f.canFallback, true);
  });

  it("classifies context_overflow and requests compaction", () => {
    const md = metadataFromResponse({ status: 400, body: { reason: "context_overflow", message: "prompt too long" } });
    const f = classifyInferenceFailure({ error: new Error("400"), metadata: md });
    assert.equal(f.class, "context_overflow");
    assert.equal(f.action, "compact_and_retry");
    assert.equal(f.shouldCompactContext, true);
  });

  it("classifies invalid_request as permanent (fail fast)", () => {
    const md = metadataFromResponse({ status: 400, body: { reason: "invalid_request" } });
    const f = classifyInferenceFailure({ error: new Error("400"), metadata: md });
    assert.equal(f.class, "invalid_request");
    assert.equal(f.retryable, false);
    assert.equal(f.action, "fail");
  });

  it("classifies authentication as permanent", () => {
    const md = metadataFromResponse({ status: 401, body: { reason: "authentication", message: "invalid api key" } });
    const f = classifyInferenceFailure({ error: new Error("401"), metadata: md });
    assert.equal(f.class, "authentication");
    assert.equal(f.retryable, false);
    assert.equal(f.action, "fail");
    assert.equal(f.providerScoped, true);
  });
});

// ─── InferWeave headers (structural, independent of bodies) ─────────────────

describe("InferWeave headers", () => {
  it("classifies from x-inferweave-reason when no body is present", () => {
    const md = metadataFromResponse({
      status: 503,
      headers: { "x-inferweave-reason": "no_workers", "x-inferweave-gateway-id": "gw-1" },
    });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "no_workers");
    assert.equal(f.source, "inferweave_header");
    assert.equal(f.modelScoped, true);
    assert.equal(f.gateway, "gw-1");
  });

  it("captures unknown X-InferWeave-* headers verbatim (forward compatibility)", () => {
    const md = metadataFromResponse({
      status: 200,
      headers: { "x-inferweave-scheduler-state": "warming", "x-inferweave-brand-new": "v2" },
    });
    assert.equal(md.inferweave["x-inferweave-scheduler-state"], "warming");
    assert.equal(md.inferweave["x-inferweave-brand-new"], "v2");
    assert.equal(md.inferweaveProtocol, true);
  });

  it("prefers the body reason over the header reason", () => {
    const md = metadataFromResponse({
      status: 503,
      body: { reason: "model_activating", retry_after_ms: 90_000 },
      headers: { "x-inferweave-reason": "no_workers" },
    });
    const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
    assert.equal(f.class, "model_activating");
    assert.equal(f.source, "inferweave_body");
  });
});

// ─── HTTP status (when no InferWeave structure is present) ──────────────────

describe("HTTP status classification", () => {
  it("classifies 429 as rate_limited (never a model switch)", () => {
    const f = classifyInferenceFailure({ error: Object.assign(new Error("429 Too Many Requests"), { status: 429 }) });
    assert.equal(f.class, "rate_limited");
    assert.equal(f.action, "honor_retry_after");
    assert.equal(f.canFallback, false);
    assert.equal(f.providerScoped, true);
  });

  it("classifies 429 queue_timeout as queue_saturated and honours Retry-After", () => {
    const md = metadataFromResponse({
      status: 429,
      headers: { "retry-after": "120" },
      body: { reason: "queue_timeout" },
    });
    const f = classifyInferenceFailure({ error: Object.assign(new Error("429"), { status: 429 }), metadata: md });
    assert.equal(f.class, "queue_saturated");
    assert.equal(f.action, "honor_retry_after");
    assert.equal(f.canFallback, false, "a 429 queue wait MUST NOT model-switch");
    assert.equal(f.retryAfterMs, 120_000);
  });

  it("classifies 401 as authentication, 400 as invalid_request, 413 as request_too_large", () => {
    assert.equal(
      classifyInferenceFailure({ error: Object.assign(new Error("401"), { status: 401 }) }).class,
      "authentication",
    );
    assert.equal(
      classifyInferenceFailure({ error: Object.assign(new Error("400"), { status: 400 }) }).class,
      "invalid_request",
    );
    assert.equal(
      classifyInferenceFailure({ error: Object.assign(new Error("413"), { status: 413 }) }).class,
      "request_too_large",
    );
  });

  it("classifies bare 5xx as gateway_unavailable (wait the gateway, same model)", () => {
    const f = classifyInferenceFailure({ error: Object.assign(new Error("502 Bad Gateway"), { status: 502 }) });
    assert.equal(f.class, "gateway_unavailable");
    assert.equal(f.action, "wait_gateway_retry");
    assert.equal(f.canFallback, false);
  });
});

// ─── Scope determination (spec §10) ─────────────────────────────────────────

describe("model- vs gateway-scoped behaviour (spec §10)", () => {
  for (const reason of [
    "no_workers",
    "model_unavailable",
    "model_activating",
    "worker_evicted",
    "worker_restarting",
    "model_not_found",
  ] as const) {
    it(`model-scoped ${reason} may fall back`, () => {
      const md = metadataFromResponse({ status: 503, body: { reason } });
      const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
      assert.equal(f.modelScoped, true);
      assert.equal(f.canFallback, true, `${reason} is a model-scope availability failure`);
    });
  }

  for (const reason of ["capacity_unavailable", "queue_saturated", "authentication"] as const) {
    it(`gateway/provider-scoped ${reason} must wait, not switch`, () => {
      const md = metadataFromResponse({ status: 503, body: { reason } });
      const f = classifyInferenceFailure({ error: new Error("503"), metadata: md });
      assert.equal(f.providerScoped, true);
      assert.equal(f.canFallback, false, `${reason} waits on the gateway; never a model switch`);
    });
  }

  it("treats connection refused / DNS failure as gateway scope", () => {
    assert.equal(
      classifyInferenceFailure({ error: netError("ECONNREFUSED", "connect ECONNREFUSED") }).providerScoped,
      true,
    );
    assert.equal(
      classifyInferenceFailure({ error: netError("ENOTFOUND", "getaddrinfo ENOTFOUND gw.example") }).providerScoped,
      true,
    );
  });
});
