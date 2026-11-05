import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGraphReader, formatTaskGraph, parseNeighborhood } from "../../src/runtime/herdr/graphClient.ts";

const body = {
  root: "task:t1",
  depth: 2,
  truncated: false,
  nodes: [
    { id: "task:t1", node_type: "task", label: "do it", state: "running", attrs: {} },
    { id: "pr:github.com/o/r#7", node_type: "pr", label: "fix", state: "pending", attrs: { x: 1 } },
    { bogus: true },
  ],
  edges: [
    {
      edge_type: "issue_link",
      from_id: "task:t1",
      to_id: "pr:github.com/o/r#7",
      stale: false,
      removed: false,
      attrs: {},
    },
    { edge_type: "produced", from_id: "task:t1", to_id: "gone", removed: true },
    { edge_type: 5 },
  ],
};
const conn = { baseUrl: "http://127.0.0.1:1", apiKey: "k" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("herdr graph client", () => {
  it("parses a neighborhood and ignores malformed rows", () => {
    const g = parseNeighborhood(body);
    assert.equal(g?.nodes.length, 2);
    assert.equal(g?.edges.length, 2);
    assert.equal(parseNeighborhood({ nodes: [] }), undefined);
    assert.equal(parseNeighborhood("x"), undefined);
  });

  it("reads the task neighborhood with the key, encodes the id, and caches within the TTL", async () => {
    const calls: { url: string; key: string | undefined }[] = [];
    let t = 1000;
    const r = createGraphReader(conn, {
      now: () => t,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, key: (init.headers as Record<string, string>)["X-API-Key"] });
        return json(body);
      }) as any,
    });
    const a = await r.getTaskGraph("t1");
    assert.equal(a.state, "ok");
    assert.match(calls[0]?.url ?? "", /\/api\/v1\/graph\/nodes\/task%3At1\/neighborhood\?depth=2/);
    assert.equal(calls[0]?.key, "k");
    const b = await r.getTaskGraph("t1");
    assert.equal(calls.length, 1);
    assert.equal(b.state === "ok" && b.cached, true);
    t += 20_000;
    await r.getTaskGraph("t1");
    assert.equal(calls.length, 2);
  });

  it("degrades to unavailable / not_found and never throws", async () => {
    const mk = (f: any) => createGraphReader(conn, { fetch: f });
    assert.deepEqual(await mk(async () => json({}, 404)).getTaskGraph("t1"), { state: "not_found" });
    const r500 = await mk(async () => json({}, 500)).getTaskGraph("t1");
    assert.equal(r500.state, "unavailable");
    assert.equal((await mk(async () => json({ nope: 1 })).getTaskGraph("t1")).state, "unavailable");
    assert.equal(
      (
        await mk(async () => {
          throw new Error("ECONNREFUSED");
        }).getTaskGraph("t1")
      ).state,
      "unavailable",
    );
    assert.equal((await createGraphReader(null).getTaskGraph("t1")).state, "unavailable");
    assert.deepEqual(await mk(async () => json(body)).getTaskGraph("bad\u0000id"), { state: "not_found" });
  });

  it("times out instead of hanging", async () => {
    const r = createGraphReader(conn, {
      timeoutMs: 20,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          // AbortSignal.timeout's own timer is unref'd; keep the loop alive until it fires.
          const keep = setInterval(() => {}, 1000);
          init.signal?.addEventListener("abort", () => {
            clearInterval(keep);
            rej(init.signal?.reason);
          });
        })) as any,
    });
    const out = await r.getTaskGraph("t1");
    assert.deepEqual(out, { state: "unavailable", reason: "timed out" });
  });

  it("failures are cached briefly so a dead Herdr is not hammered", async () => {
    let n = 0;
    let t = 0;
    const r = createGraphReader(conn, {
      now: () => t,
      fetch: (async () => {
        n++;
        return json({}, 503);
      }) as any,
    });
    await r.getTaskGraph("t1");
    await r.getTaskGraph("t1");
    assert.equal(n, 1);
    t += 6000;
    await r.getTaskGraph("t1");
    assert.equal(n, 2);
  });

  it("formats ok, not_found and unavailable results", async () => {
    const g = parseNeighborhood(body);
    const ok = formatTaskGraph({ state: "ok", graph: g as any, cached: false }, "t1");
    assert.match(ok, /issue_link: task:t1 "do it" -> pr:github.com\/o\/r#7 "fix"/);
    assert.ok(!ok.includes("gone"), "removed edges are hidden");
    assert.match(formatTaskGraph({ state: "unavailable", reason: "timed out" }, "t1"), /unavailable \(timed out\)/);
    assert.match(formatTaskGraph({ state: "not_found" }, "t1"), /not in the Herdr graph/);
  });
});
