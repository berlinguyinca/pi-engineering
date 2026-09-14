/**
 * Service-local smoke test (does not require Postgres). Exercises the HTTP
 * contract via fetch against an in-memory server. The richer end-to-end tests
 * live at the repo root (test/integration/openviking.test.ts) and run the real
 * OpenVikingProvider against this service.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "../src/server.mjs";

test("smoke: health + promote + recall + search + auth", async () => {
  const srv = await startServer({ port: 0, token: "t" });
  try {
    const auth = { authorization: "Bearer t", "content-type": "application/json" };
    const h = await fetch(`${srv.url}/health`);
    assert.equal(h.status, 200);

    const rec = {
      id: "s1",
      text: "adapter seam is canonical",
      sourceRefs: ["e1"],
      promotedFrom: "c1",
      evidenceIds: ["e1"],
      promotedAt: "2026-01-01T00:00:00.000Z",
      promotedBy: "op",
    };
    const post = await fetch(`${srv.url}/memory`, { method: "POST", headers: auth, body: JSON.stringify(rec) });
    assert.equal(post.status, 201);

    const all = await (await fetch(`${srv.url}/memory`, { headers: auth })).json();
    assert.equal(all.length, 1);

    const hits = await (await fetch(`${srv.url}/memory/search?q=adapter`, { headers: auth })).json();
    assert.equal(hits.length, 1);

    // unauthenticated denied
    const denied = await fetch(`${srv.url}/memory`);
    assert.equal(denied.status, 401);

    // metrics (Prometheus text format, unauthenticated)
    const m = await (await fetch(`${srv.url}/metrics`)).text();
    assert.match(m, /^openviking_up\{kind="memory".*\} 1/m);
    assert.match(m, /openviking_requests_total\{method="POST",route="\/memory",status=201\} 1/);
  } finally {
    await srv.close();
  }
});
