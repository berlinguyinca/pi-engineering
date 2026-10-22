/** Central fleet config client (src/runtime/herdr/HostConfig.ts). No network: injected fetch, temp home. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HostConfigUnavailable, loadHostConfig } from "../../src/runtime/herdr/HostConfig.ts";

const TOKEN = "tok-SECRET-123";
const SECRET_VALUE = "sk-VALUE-SECRET-456";

function homeWith(host: object | null = { control_plane_url: "http://cp.lan/", host_id: "h1", token: TOKEN }) {
  const home = mkdtempSync(join(tmpdir(), "hostcfg-"));
  if (host) {
    mkdirSync(join(home, ".config", "herdr-engineering"), { recursive: true });
    writeFileSync(join(home, ".config", "herdr-engineering", "host.json"), JSON.stringify(host), { mode: 0o600 });
  }
  return home;
}
const cachePath = (home: string) => join(home, ".cache", "herdr-engineering", "fleet-config.json");
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const VALUES = { inspector: { enabled: true, reasoning: "summary" }, ingest: { api_key: "ing" } };

interface Call { url: string; init: RequestInit }
function fakeFetch(handler: (c: Call) => Response | Promise<Response>, calls: Call[] = []) {
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return handler(c);
    }) as unknown as typeof fetch,
  };
}

test("fetch: sends X-Host-Token, never follows redirects, writes 0600 cache in 0700 dir, posts applied", async () => {
  const home = homeWith();
  const f = fakeFetch((c) => (c.url.endsWith("/applied") ? new Response("{}") : ok({ revision: "r1", values: VALUES })));
  const cfg = await loadHostConfig({ home, fetch: f.fetch });
  assert.equal(cfg.source, "fetch");
  assert.equal(cfg.revision, "r1");
  assert.equal(cfg.url, "http://cp.lan");
  assert.equal(cfg.hostId, "h1");
  assert.equal(f.calls[0]?.url, "http://cp.lan/api/v1/fleet/config");
  assert.equal((f.calls[0]?.init.headers as any)["X-Host-Token"], TOKEN);
  assert.equal(f.calls[0]?.init.redirect, "manual");
  assert.equal(f.calls[1]?.url, "http://cp.lan/api/v1/fleet/config/applied");
  assert.equal(f.calls[1]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init.body)), { host_id: "h1", revision: "r1" });
  assert.equal(statSync(cachePath(home)).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".cache", "herdr-engineering")).mode & 0o777, 0o700);
  const cached = JSON.parse(readFileSync(cachePath(home), "utf8"));
  assert.equal(cached.host_id, "h1");
  assert.ok(!JSON.stringify(cached).includes(TOKEN));
});

test("a failing applied POST does not fail the load", async () => {
  const home = homeWith();
  const f = fakeFetch((c) => {
    if (c.url.endsWith("/applied")) throw new Error("boom");
    return ok({ revision: "r1", values: VALUES });
  });
  assert.equal((await loadHostConfig({ home, fetch: f.fetch })).source, "fetch");
});

for (const [name, handler] of [
  ["5xx", () => new Response("x", { status: 503 })],
  ["network error", () => { throw new Error("ECONNREFUSED"); }],
  ["3xx (not followed)", () => new Response(null, { status: 302, headers: { location: "http://evil/" } })],
  ["malformed body", () => new Response("not json", { status: 200 })],
] as const) {
  test(`cache fallback on ${name}, source is cache`, async () => {
    const home = homeWith();
    await loadHostConfig({ home, fetch: fakeFetch((c) => (c.url.endsWith("/applied") ? new Response("{}") : ok({ revision: "r1", values: VALUES }))).fetch });
    const cfg = await loadHostConfig({ home, fetch: fakeFetch(handler as any).fetch });
    assert.equal(cfg.source, "cache");
    assert.equal(cfg.revision, "r1");
    assert.equal(cfg.get("inspector.reasoning"), "summary");
    assert.ok(existsSync(cachePath(home)), "3xx/5xx keep the cache");
  });
}

test("unreachable with no cache is unavailable (not revoked) and leaks nothing", async () => {
  const home = homeWith();
  await assert.rejects(
    loadHostConfig({ home, fetch: fakeFetch(() => { throw new Error(`down ${TOKEN}`); }).fetch }),
    (e: any) => e instanceof HostConfigUnavailable && e.revoked === false && !e.message.includes(TOKEN),
  );
});

test("a cache for another host_id is ignored", async () => {
  const home = homeWith();
  mkdirSync(join(home, ".cache", "herdr-engineering"), { recursive: true });
  writeFileSync(cachePath(home), JSON.stringify({ host_id: "other", revision: "r", values: VALUES }));
  await assert.rejects(loadHostConfig({ home, fetch: fakeFetch(() => new Response("", { status: 500 })).fetch }), HostConfigUnavailable);
});

test("401 deletes the cache and fails revoked=true without leaking the token or values", async () => {
  const home = homeWith();
  await loadHostConfig({ home, fetch: fakeFetch((c) => (c.url.endsWith("/applied") ? new Response("{}") : ok({ revision: "r1", values: { ingest: { api_key: SECRET_VALUE } } }))).fetch });
  assert.ok(existsSync(cachePath(home)));
  await assert.rejects(
    loadHostConfig({ home, fetch: fakeFetch(() => new Response("nope", { status: 401 })).fetch }),
    (e: any) => e instanceof HostConfigUnavailable && e.revoked === true && !e.message.includes(TOKEN) && !e.message.includes(SECRET_VALUE),
  );
  assert.equal(existsSync(cachePath(home)), false);
});

const primeCache = (home: string) =>
  loadHostConfig({ home, fetch: fakeFetch((c) => (c.url.endsWith("/applied") ? new Response("{}") : ok({ revision: "r1", values: VALUES }))).fetch });

for (const status of [404, 403]) {
  test(`HTTP ${status} with a cache falls back to the cache (source cache) and keeps it`, async () => {
    const home = homeWith();
    await primeCache(home);
    const cfg = await loadHostConfig({ home, fetch: fakeFetch(() => new Response("", { status })).fetch });
    assert.equal(cfg.source, "cache");
    assert.equal(cfg.revision, "r1");
    assert.ok(existsSync(cachePath(home)), `${status} keeps the cache`);
  });
}

test("HTTP 404 without a cache is a clear, non-revoked failure", async () => {
  const home = homeWith();
  await assert.rejects(
    loadHostConfig({ home, fetch: fakeFetch(() => new Response("", { status: 404 })).fetch }),
    (e: any) => e instanceof HostConfigUnavailable && e.revoked === false && /no cached configuration/.test(e.message) && !e.message.includes(TOKEN),
  );
});

test("empty apiKey values send no X-API-Key header downstream", async () => {
  const home = homeWith();
  const f = fakeFetch((c) => (c.url.endsWith("/applied") ? new Response("{}") : ok({ revision: "r", values: { agent: { api_key: "" }, ingest: { api_key: "" } } })));
  const cfg = await loadHostConfig({ home, fetch: f.fetch });
  assert.equal(cfg.apiKey, null);
  for (const c of f.calls) {
    const keys = Object.keys(c.init.headers as object).map((k) => k.toLowerCase());
    assert.ok(!keys.includes("x-api-key"), "host-config requests carry no api key header");
  }
});

test("array / non-object values are rejected (falls back to cache or unavailable)", async () => {
  for (const values of [[1, 2], "x", null]) {
    const home = homeWith();
    await assert.rejects(
      loadHostConfig({ home, fetch: fakeFetch(() => ok({ revision: "r", values })).fetch }),
      HostConfigUnavailable,
    );
    assert.equal(existsSync(cachePath(home)), false, "invalid payload is never cached");
  }
  const home = homeWith();
  mkdirSync(join(home, ".cache", "herdr-engineering"), { recursive: true });
  writeFileSync(cachePath(home), JSON.stringify({ host_id: "h1", revision: "r", values: [1] }));
  await assert.rejects(loadHostConfig({ home, fetch: fakeFetch(() => new Response("", { status: 500 })).fetch }), HostConfigUnavailable);
});

test("missing or incomplete host.json is unavailable and names no secret", async () => {
  await assert.rejects(loadHostConfig({ home: homeWith(null), fetch: fakeFetch(() => ok({})).fetch }), HostConfigUnavailable);
  const home = homeWith({ control_plane_url: "http://cp", host_id: "h", token: "" });
  await assert.rejects(loadHostConfig({ home, fetch: fakeFetch(() => ok({})).fetch }), /incomplete/);
});

test("get() returns fallbacks for missing section, key, null and undotted keys", async () => {
  const home = homeWith();
  const cfg = await loadHostConfig({ home, fetch: fakeFetch(() => ok({ revision: "r", values: { inspector: { enabled: false, nul: null }, ci: { n: 0 } } })).fetch });
  assert.equal(cfg.get("inspector.enabled", true), false, "false is a value, not missing");
  assert.equal(cfg.get("ci.n", 9), 0);
  assert.equal(cfg.get("inspector.nul", "fb"), "fb");
  assert.equal(cfg.get("inspector.absent", "fb"), "fb");
  assert.equal(cfg.get("llm.model", "fb"), "fb");
  assert.equal(cfg.get("noDot", "fb"), "fb");
  assert.equal(cfg.get("llm.model"), undefined);
});

test("apiKey: agent.api_key wins, then ingest.api_key, else null", async () => {
  const mk = async (values: object) => (await loadHostConfig({ home: homeWith(), fetch: fakeFetch(() => ok({ revision: "r", values })).fetch })).apiKey;
  assert.equal(await mk({ agent: { api_key: "a" }, ingest: { api_key: "i" } }), "a");
  assert.equal(await mk({ ingest: { api_key: "i" } }), "i");
  assert.equal(await mk({ agent: { api_key: "" }, ingest: { api_key: "i" } }), "i");
  assert.equal(await mk({}), null);
});

test("timeout: a hung control plane falls back instead of hanging", async () => {
  const home = homeWith();
  const hang = (async (_u: string, init: RequestInit) =>
    new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout is unref'd
  try {
    await assert.rejects(loadHostConfig({ home, fetch: hang, timeoutMs: 30 }), HostConfigUnavailable);
  } finally {
    clearTimeout(keepAlive);
  }
});
