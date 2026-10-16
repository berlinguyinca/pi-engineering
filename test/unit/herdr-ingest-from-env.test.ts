/**
 * Convergence emitter factory tests — createIngestFromEnv (CI-001, FLEET-001).
 *
 * The emitter is OFF by default: missing or invalid HERDR_INGEST_URL yields
 * null. When configured, the returned ControlPlaneIngest exposes url + host id
 * as public fields; the api key and source are carried on the fetch envelope
 * (ControlPlaneIngest exposes no api-key/source fields and must not be
 * modified), so they are asserted via a stubbed fetch call.
 */

import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";

import { createIngestFromEnv } from "../../src/runtime/herdr/ingestFromEnv.ts";

interface CapturedCall {
  url: string;
  init?: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Recording fetch that captures the request envelope and resolves ok. */
function recordingFetch(calls: CapturedCall[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      init,
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
}

test("createIngestFromEnv returns null when HERDR_INGEST_URL is unset", () => {
  assert.equal(createIngestFromEnv({}), null);
  assert.equal(createIngestFromEnv({ HERDR_INGEST_API_KEY: "k" }), null);
  assert.equal(createIngestFromEnv({ HERDR_HOST_ID: "host-a" }), null);
});

test("createIngestFromEnv returns null for an invalid or non-http(s) URL", () => {
  assert.equal(createIngestFromEnv({ HERDR_INGEST_URL: "not a url" }), null);
  assert.equal(createIngestFromEnv({ HERDR_INGEST_URL: "ftp://dev.lan" }), null);
  assert.equal(createIngestFromEnv({ HERDR_INGEST_URL: "file:///tmp/x" }), null);
  assert.equal(createIngestFromEnv({ HERDR_INGEST_URL: "http://" }), null);
});

test("createIngestFromEnv builds an ingest with url and host id visible via public fields", () => {
  const ingest = createIngestFromEnv({ HERDR_INGEST_URL: "http://dev.lan", HERDR_HOST_ID: "bender" });
  assert.ok(ingest);
  assert.equal(ingest.url, "http://dev.lan");
  assert.equal(ingest.host.hostId, "bender");
});

test("createIngestFromEnv defaults host id to os.hostname() when HERDR_HOST_ID is unset", () => {
  const ingest = createIngestFromEnv({ HERDR_INGEST_URL: "https://dev.lan" });
  assert.ok(ingest);
  assert.equal(ingest.host.hostId, os.hostname());
});

test("createIngestFromEnv sends the api key header and source 'pi' on the ingest request", async () => {
  const calls: CapturedCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const ingest = createIngestFromEnv({
      HERDR_INGEST_URL: "https://dev.lan",
      HERDR_HOST_ID: "bender",
      HERDR_INGEST_API_KEY: "secret-key",
    });
    assert.ok(ingest);

    await ingest.hostRegistered();

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, "https://dev.lan/api/v1/ingest");
    assert.equal(call.headers["x-api-key"], "secret-key");
    assert.equal(call.body.source, "pi");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createIngestFromEnv omits the api key header when HERDR_INGEST_API_KEY is unset", async () => {
  const calls: CapturedCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const ingest = createIngestFromEnv({ HERDR_INGEST_URL: "http://dev.lan", HERDR_HOST_ID: "bender" });
    assert.ok(ingest);
    await ingest.hostRegistered();
    const call = calls[0]!;
    assert.equal(call.headers["x-api-key"], undefined);
    assert.equal(call.body.source, "pi");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
