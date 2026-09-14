import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { startPortal } from "../src/server.mjs";

async function fixture() {
  const keyRows = new Map();
  const records = new Map();
  let serial = 0;
  let now = Date.now();
  const keys = {
    init: async () => {},
    close: async () => {},
    create: async (owner, options) => {
      const row = {
        ...options,
        owner,
        id: String(++serial),
        secret: `device-${serial}`,
        expiresAt: new Date(now + 86400000).toISOString(),
      };
      keyRows.set(row.secret, row);
      return row;
    },
    list: async (owner) =>
      [...keyRows.values()].filter((k) => k.owner === owner).map(({ secret, owner, ...rest }) => rest),
    revoke: async (owner, id) => {
      const row = [...keyRows.values()].find((k) => k.owner === owner && k.id === id);
      return row ? keyRows.delete(row.secret) : false;
    },
    authenticate: async (secret) => keyRows.get(secret) ?? null,
  };
  const memory = {
    health: async () => true,
    store: async (owner, record) => {
      if (!records.has(owner)) records.set(owner, new Map());
      records.get(owner).set(record.id, record);
    },
    recallAll: async (owner) => [...(records.get(owner)?.values() ?? [])],
    search: async (owner, query) => [...(records.get(owner)?.values() ?? [])].filter((r) => r.text.includes(query)),
  };
  const cognito = {
    authorizationUrl: ({ state, nonce, verifier }) =>
      `https://login.example/authorize?${new URLSearchParams({ state, nonce, verifier })}`,
    exchange: async ({ code }) => ({ sub: code, email: `${code}@example.com`, expiresAt: now + 3600000 }),
  };
  const portal = await startPortal({
    port: 0,
    origin: "http://127.0.0.1",
    issuer: "https://issuer.example/pool",
    cognito,
    keys,
    memory,
    now: () => now,
  });
  const request = (path, opts = {}) => fetch(`${portal.url}${path}`, { redirect: "manual", ...opts });
  async function login(name) {
    const start = await request("/auth/login");
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cookie = start.headers.get("set-cookie").split(";")[0];
    const callback = await request(`/auth/callback?code=${name}&state=${state}`, { headers: { cookie } });
    assert.equal(callback.status, 302);
    const session = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith("viking_session="))
      .split(";")[0];
    const me = await (await request("/api/me", { headers: { cookie: session } })).json();
    return { cookie: session, origin: "http://127.0.0.1", "x-csrf-token": me.csrfToken };
  }
  return {
    ...portal,
    request,
    login,
    keys,
    setTime: (n) => {
      now = n;
    },
  };
}

test("browser-bound login, personal memory isolation, legacy-compatible envelopes and revocation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/")).status, 200);
    assert.equal((await f.request("/memory")).status, 401);
    const alice = await f.login("alice");
    const bob = await f.login("bob");
    async function mint(headers, scopes = ["memory:read", "memory:write"]) {
      const r = await f.request("/api/keys", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "laptop", scopes, expiresInDays: 30 }),
      });
      assert.equal(r.status, 201);
      return r.json();
    }
    const ak = await mint(alice);
    const bk = await mint(bob);
    const record = {
      id: "same-id",
      text: "Alice private evidence",
      sourceRefs: ["repo:a"],
      evidenceIds: ["e1"],
      promotedBy: "pretend-bob",
      promotedAt: "2026-09-14T00:00:00Z",
    };
    const auth = {
      authorization: `Bearer ${ak.secret}`,
      "content-type": "application/json",
      "X-OpenViking-User": "bob",
    };
    assert.equal(
      (await f.request("/memory", { method: "POST", headers: auth, body: JSON.stringify(record) })).status,
      201,
    );
    assert.deepEqual(await (await f.request("/memory", { headers: auth })).json(), [record]);
    assert.deepEqual(
      await (await f.request("/memory", { headers: { authorization: `Bearer ${bk.secret}` } })).json(),
      [],
    );
    assert.deepEqual(await (await f.request("/memory/search?q=evidence", { headers: alice })).json(), [record]);
    assert.equal((await f.request(`/api/keys/${ak.id}`, { method: "DELETE", headers: bob })).status, 404);
    assert.equal((await f.request("/api/keys", { method: "POST", headers: auth, body: "{}" })).status, 401);
    const readOnly = await mint(alice, ["memory:read"]);
    assert.equal(
      (
        await f.request("/memory", {
          method: "POST",
          headers: { authorization: `Bearer ${readOnly.secret}`, "content-type": "application/json" },
          body: JSON.stringify(record),
        })
      ).status,
      403,
    );
    assert.equal((await f.request(`/api/keys/${ak.id}`, { method: "DELETE", headers: alice })).status, 204);
    assert.equal((await f.request("/memory", { headers: auth })).status, 401);
    assert.equal((await f.request("/auth/logout", { method: "POST", headers: alice })).status, 204);
    assert.equal((await f.request("/api/me", { headers: alice })).status, 401);
  } finally {
    await f.close();
  }
});

test("login rejects missing cookie, bad state and replay; sessions expire", async () => {
  const f = await fixture();
  try {
    const start = await f.request("/auth/login");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cookie = start.headers.get("set-cookie").split(";")[0];
    assert.equal((await f.request(`/auth/callback?code=alice&state=${state}`)).status, 400);
    assert.equal((await f.request("/auth/callback?code=alice&state=bad", { headers: { cookie } })).status, 400);
    assert.equal((await f.request(`/auth/callback?code=alice&state=${state}`, { headers: { cookie } })).status, 302);
    assert.equal((await f.request(`/auth/callback?code=alice&state=${state}`, { headers: { cookie } })).status, 400);
    const alice = await f.login("alice");
    f.setTime(Date.now() + 7200000);
    assert.equal((await f.request("/api/me", { headers: alice })).status, 401);
  } finally {
    await f.close();
  }
});

test("CSRF, malformed records and unsupported upstream routes fail closed", async () => {
  const f = await fixture();
  try {
    const alice = await f.login("alice");
    for (const headers of [
      { cookie: alice.cookie },
      { ...alice, origin: "https://evil.example" },
      { ...alice, "x-csrf-token": "bad" },
    ]) {
      assert.equal((await f.request("/api/keys", { method: "POST", headers, body: "{}" })).status, 403);
    }
    for (const path of ["/api/keys/nonexistent", "/auth/logout"]) {
      assert.equal(
        (
          await f.request(path, {
            method: path.includes("keys") ? "DELETE" : "POST",
            headers: { cookie: alice.cookie },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await f.request("/auth/logout", {
          method: "POST",
          headers: { ...alice, "x-csrf-token": "é".repeat(alice["x-csrf-token"].length) },
        })
      ).status,
      403,
    );
    const key = await f.keys.create("test", { scopes: ["memory:write"] });
    for (const body of ["bad", "null", "{}", JSON.stringify({ id: "x", text: "y", sourceRefs: "not-array" })]) {
      assert.equal(
        (
          await f.request("/memory", {
            method: "POST",
            headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
            body,
          })
        ).status,
        400,
      );
    }
    assert.equal((await f.request("/api/v1/admin/accounts", { headers: alice })).status, 404);
    const ui = await f.request("/");
    assert.match(ui.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(ui.headers.get("cache-control"), /no-store/);
  } finally {
    await f.close();
  }
});

test("HTTPS login cookies are host-only, Secure, HttpOnly and SameSite=Lax", async () => {
  const f = await startPortal({
    port: 0,
    origin: "https://viking.example",
    issuer: "https://issuer.example",
    cognito: { authorizationUrl: () => "https://login.example" },
    keys: {},
    memory: {},
  });
  try {
    const r = await fetch(`${f.url}/auth/login`, { redirect: "manual" });
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /^__Host-viking_login=/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/);
  } finally {
    await f.close();
  }
});

test("login attempts expire after five minutes", async () => {
  const f = await fixture();
  try {
    const r = await f.request("/auth/login");
    const state = new URL(r.headers.get("location")).searchParams.get("state");
    const cookie = r.headers.get("set-cookie").split(";")[0];
    f.setTime(Date.now() + 301000);
    assert.equal((await f.request(`/auth/callback?state=${state}&code=alice`, { headers: { cookie } })).status, 400);
  } finally {
    await f.close();
  }
});

test("login attempts are throttled per peer before consuming the global allowance", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await f.request("/auth/login")).status, 302);
    assert.equal((await f.request("/auth/login")).status, 429);
    f.setTime(Date.now() + 61000);
    assert.equal((await f.request("/auth/login")).status, 302);
  } finally {
    await f.close();
  }
});

test("memory requests have a per-owner concurrency limit", async () => {
  const waiters = [];
  const f = await startPortal({
    port: 0,
    origin: "http://127.0.0.1",
    issuer: "https://issuer.example",
    cognito: {},
    keys: { authenticate: async () => ({ owner: "alice", scopes: ["memory:read"] }) },
    memory: { recallAll: () => new Promise((resolve) => waiters.push(resolve)) },
  });
  const request = () => fetch(`${f.url}/memory`, { headers: { authorization: "Bearer test" } });
  try {
    const a = request();
    const b = request();
    while (waiters.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const third = request();
    // Release even if the assertion fails so a regression does not hang the suite.
    const timer = setTimeout(() => {
      for (const resolve of waiters) resolve([]);
    }, 200);
    assert.equal((await third).status, 429);
    for (const resolve of waiters) resolve([]);
    clearTimeout(timer);
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
  } finally {
    for (const resolve of waiters) resolve([]);
    await f.close();
  }
});

test("trusted proxy addresses isolate login quotas, direct callers cannot forge addresses", async () => {
  for (const trustProxy of [true, false]) {
    const f = await startPortal({
      port: 0,
      origin: "http://127.0.0.1",
      issuer: "https://issuer.example",
      trustProxy,
      cognito: { authorizationUrl: () => "https://login.example" },
      keys: {},
      memory: {},
    });
    try {
      const login = (address) =>
        fetch(`${f.url}/auth/login`, { redirect: "manual", headers: { "x-real-ip": address } });
      for (let i = 0; i < 10; i++) assert.equal((await login("192.0.2.1")).status, 302);
      assert.equal((await login("192.0.2.1")).status, 429);
      assert.equal((await login("192.0.2.2")).status, trustProxy ? 302 : 429);
    } finally {
      await f.close();
    }
  }
});

test("failed upstream calls release concurrency slots", async () => {
  let count = 0;
  const f = await startPortal({
    port: 0,
    origin: "http://127.0.0.1",
    issuer: "https://issuer.example",
    cognito: {},
    keys: { authenticate: async () => ({ owner: "alice", scopes: ["memory:read"] }) },
    memory: {
      recallAll: async () => {
        if (count++ < 3) throw new Error("upstream unavailable");
        return [];
      },
    },
  });
  try {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${f.url}/memory`, { headers: { authorization: "Bearer test" } });
      assert.equal(r.status, i < 3 ? 503 : 200);
    }
  } finally {
    await f.close();
  }
});

test("legacy key forwards only memory routes without caller-controlled identity headers", async () => {
  const received = [];
  const legacy = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ id: "legacy", text: "unchanged" }]));
  });
  await new Promise((resolve) => legacy.listen(0, "127.0.0.1", resolve));
  const f = await startPortal({
    port: 0,
    origin: "http://127.0.0.1",
    issuer: "https://issuer.example",
    cognito: {},
    keys: { authenticate: async () => null },
    memory: {},
    legacy: { baseUrl: `http://127.0.0.1:${legacy.address().port}`, token: "old-secret" },
  });
  try {
    const headers = { authorization: "Bearer old-secret", "X-OpenViking-User": "attacker" };
    const r = await fetch(`${f.url}/memory/search?q=hello`, { headers });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [{ id: "legacy", text: "unchanged" }]);
    assert.equal(received[0].url, "/memory/search?q=hello");
    assert.equal(received[0].headers["x-openviking-user"], undefined);
    assert.equal((await fetch(`${f.url}/api/keys`, { headers })).status, 401);
  } finally {
    await f.close();
    await new Promise((resolve) => legacy.close(resolve));
  }
});
