import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { UpstreamMemory } from "../src/upstream.mjs";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const hash = (id) => createHash("sha256").update(id).digest("hex");
const directory = (owner) => `viking://user/pi-${owner}/resources/pi-memories`;
const response = (result, status = 200) => new Response(JSON.stringify({ status: "ok", result }), { status });
const failure = (status, code) =>
  new Response(JSON.stringify({ status: "error", error: { code, message: "SECRET upstream details" } }), { status });
function fixture(handler = () => response({})) {
  const calls = [];
  const memory = new UpstreamMemory({
    baseUrl: "http://127.0.0.1:1933",
    rootKey: "root-secret",
    fetch: async (url, init) => {
      const call = { url: new URL(url), ...init, json: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return handler(call, calls);
    },
  });
  return { memory, calls };
}

test("stores exact JSON under separately provisioned accounts and users", async () => {
  const { memory, calls } = fixture();
  const records = [
    { id: "../same/😎", text: "one", sourceRefs: ["a"], extra: { retained: true } },
    { id: "../same/😎", text: "two" },
  ];
  for (const [index, owner] of [alice, bob].entries()) await memory.store(owner, records[index]);
  for (const [index, owner] of [alice, bob].entries()) {
    const account = calls.find((c) => c.json?.account_id === `pi-${owner}`);
    assert.deepEqual(account.json, { account_id: `pi-${owner}`, admin_user_id: "portal-admin" });
    const user = calls.find((c) => c.json?.user_id === `pi-${owner}`);
    assert.equal(user.url.pathname, `/api/v1/admin/accounts/pi-${owner}/users`);
    assert.equal(user.json.role, "user");
    const write = calls.find((c) => c.json?.content === JSON.stringify(records[index]));
    assert.equal(write.json.uri, `${directory(owner)}/${hash(records[index].id)}.json`);
    assert.equal(write.json.processing_mode, "vectors_only");
    assert.equal(write.json.mode, "create");
    assert.equal(write.headers["X-OpenViking-Account"], `pi-${owner}`);
    assert.equal(write.headers["X-OpenViking-User"], `pi-${owner}`);
    assert.equal(write.headers["X-OpenViking-Role"], "user");
  }
  for (const call of calls) {
    assert.equal(call.headers["X-API-Key"], "root-secret");
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test("recall paginates every record and preserves metadata", async () => {
  const records = Array.from({ length: 205 }, (_, i) => ({
    id: `record-${i}`,
    text: `text ${i}`,
    evidenceIds: [i],
    extra: "unchanged",
  }));
  const indexed = new Map(records.map((r) => [`${directory(alice)}/${hash(r.id)}.json`, r]));
  const { memory, calls } = fixture(({ url }) => {
    if (url.pathname.endsWith("/ls")) {
      assert.equal(url.searchParams.get("limit"), "100");
      assert.equal(url.searchParams.get("output"), "original");
      const offset = Number(url.searchParams.get("offset"));
      return response([...indexed.keys()].slice(offset, offset + 100).map((uri) => ({ uri, isDir: false })));
    }
    if (url.pathname.endsWith("/read")) {
      assert.equal(url.searchParams.get("raw"), "true");
      return response(JSON.stringify(indexed.get(url.searchParams.get("uri"))));
    }
    return response({});
  });
  assert.deepEqual(await memory.recallAll(alice), records);
  assert.deepEqual(
    calls.filter((c) => c.url.pathname.endsWith("/ls")).map((c) => c.url.searchParams.get("offset")),
    ["0", "100", "200"],
  );
});

for (const [query, matches] of [
  ["calibration nope", true],
  ["SOURCE", true],
  ["zzz", false],
  ["x", true],
  ["", true],
]) {
  test(`legacy token search: ${JSON.stringify(query)}`, async () => {
    const { memory } = fixture();
    const record = { id: "r", text: "Calibration", sourceRefs: ["source.txt"] };
    memory.recallAll = async () => [record];
    assert.deepEqual(await memory.search(alice, query), matches ? [record] : []);
  });
}

for (const owner of ["", "../evil", "A".repeat(64), `${alice}/x`]) {
  test(`rejects invalid owner ${owner.slice(0, 12)}`, async () => {
    const { memory, calls } = fixture();
    await assert.rejects(memory.store(owner, { id: "r", text: "a" }));
    assert.equal(calls.length, 0);
  });
}

for (const modes of [
  ["create", "replace"],
  ["create", "replace", "create"],
]) {
  test(`bounded create/replace retry: ${modes.join(" then ")}`, async () => {
    let writes = 0;
    const { memory, calls } = fixture(({ url }) => {
      if (!url.pathname.endsWith("/write")) return response({});
      writes++;
      if (writes === 1) return failure(409, "ALREADY_EXISTS");
      if (writes < modes.length) return failure(404, "NOT_FOUND");
      return response({});
    });
    await memory.store(alice, { id: "r", text: "replacement" });
    assert.deepEqual(
      calls.filter((c) => c.url.pathname.endsWith("/write")).map((c) => c.json.mode),
      modes,
    );
  });
}

for (const [status, code] of [
  [403, "PERMISSION_DENIED"],
  [500, "ALREADY_EXISTS"],
  [409, "CONFLICT"],
  [400, "ALREADY_EXISTS"],
]) {
  test(`does not suppress provisioning failure ${status} ${code}`, async () => {
    const { memory, calls } = fixture(() => failure(status, code));
    await assert.rejects(memory.store(alice, { id: "r" }), (error) => !String(error).includes("SECRET"));
    assert.equal(calls.length, 1);
  });
  test(`does not retry write failure ${status} ${code}`, async () => {
    const { memory, calls } = fixture(({ url }) =>
      url.pathname.endsWith("/write") ? failure(status, code) : response({}),
    );
    await assert.rejects(memory.store(alice, { id: "r" }));
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/write")).length, 1);
  });
}

test("bounded retries eventually report conflicting writes", async () => {
  const { memory, calls } = fixture(({ url, json }) =>
    url.pathname.endsWith("/write")
      ? failure(json.mode === "create" ? 409 : 404, json.mode === "create" ? "ALREADY_EXISTS" : "NOT_FOUND")
      : response({}),
  );
  await assert.rejects(memory.store(alice, { id: "r" }));
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/write")).length, 3);
});

test("accepts account/user AlreadyExists but validates an existing directory after mkdir CONFLICT", async () => {
  const { memory, calls } = fixture(({ url }) => {
    if (url.pathname.startsWith("/api/v1/admin/")) return failure(409, "ALREADY_EXISTS");
    if (url.pathname.endsWith("/mkdir")) return failure(409, "CONFLICT");
    if (url.pathname.endsWith("/stat")) return response({ uri: directory(alice), isDir: true });
    return response({});
  });
  await memory.store(alice, { id: "r" });
  assert.equal(calls.find((c) => c.url.pathname.endsWith("/stat")).url.searchParams.get("uri"), directory(alice));
});

for (const uri of [
  `${directory(bob)}/${hash("r")}.json`,
  `${directory(alice)}/../${hash("r")}.json`,
  `${directory(alice)}/%2e%2e/secret`,
  `${directory(alice)}/nested/${hash("r")}.json`,
  `https://other/${hash("r")}.json`,
]) {
  test(`rejects escaped listing path ${uri}`, async () => {
    const { memory, calls } = fixture(({ url }) =>
      url.pathname.endsWith("/ls") ? response([{ uri, isDir: false }]) : response({}),
    );
    await assert.rejects(memory.recallAll(alice));
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/read")).length, 0);
  });
}

for (const [name, handler] of [
  ["invalid JSON", () => new Response("SECRET invalid")],
  ["invalid envelope", () => new Response(JSON.stringify({ secret: "SECRET" }))],
  ["oversized body", () => new Response("x".repeat(2 * 1024 * 1024 + 1))],
  ["declared oversized body", () => new Response("{}", { headers: { "content-length": 3 * 1024 * 1024 } })],
  ["redirect", () => new Response("{}", { status: 302, headers: { location: "https://elsewhere.example" } })],
  [
    "network error",
    () => {
      throw new Error("SECRET URL credentials");
    },
  ],
]) {
  test(`sanitizes and rejects ${name}`, async () => {
    const { memory } = fixture(handler);
    await assert.rejects(memory.health(), (error) => !String(error).includes("SECRET"));
  });
}

test("health succeeds with upstream ok envelope", async () => {
  const { memory, calls } = fixture(() => new Response('{"status":"ok"}'));
  assert.equal(await memory.health(), true);
  assert.equal(calls[0].url.pathname, "/health");
});

test("timeout bounds a stalled response body and fetch", async () => {
  for (const fetch of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const memory = new UpstreamMemory({ baseUrl: "http://127.0.0.1:1933", rootKey: "secret", fetch, timeoutMs: 20 });
    const start = Date.now();
    await assert.rejects(memory.health());
    assert.ok(Date.now() - start < 500);
  }
});

for (const stat of [{ uri: directory(bob), isDir: true }, { uri: directory(alice), isDir: false }, {}]) {
  test(`mkdir conflict requires exact directory proof ${JSON.stringify(stat)}`, async () => {
    const { memory, calls } = fixture(({ url }) => {
      if (url.pathname.endsWith("/mkdir")) return failure(409, "CONFLICT");
      if (url.pathname.endsWith("/stat")) return response(stat);
      return response({});
    });
    await assert.rejects(memory.store(alice, { id: "r" }));
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/write")).length, 0);
  });
}

for (const raw of ["{broken", "{}", '{"id":"other"}', "null"]) {
  test(`rejects corrupted stored record ${raw}`, async () => {
    const { memory } = fixture(({ url }) => {
      if (url.pathname.endsWith("/ls"))
        return response([{ uri: `${directory(alice)}/${hash("r")}.json`, isDir: false }]);
      if (url.pathname.endsWith("/read")) return response(raw);
      return response({});
    });
    await assert.rejects(memory.recallAll(alice));
  });
}

test("a failed provisioning step is attempted again on the next call", async () => {
  let fail = true;
  const { memory } = fixture(({ url }) => {
    if (url.pathname.endsWith("/users") && fail) return failure(503, "UNAVAILABLE");
    return response({});
  });
  await assert.rejects(memory.store(alice, { id: "r" }));
  fail = false;
  await memory.store(alice, { id: "r" });
});

test("rejects access-denied listing rows before attempting to read", async () => {
  const { memory, calls } = fixture(({ url }) => {
    if (url.pathname.endsWith("/ls"))
      return response([{ uri: `${directory(alice)}/${hash("r")}.json`, isDir: false, access: "denied" }]);
    if (url.pathname.endsWith("/read")) return response('{"id":"r"}');
    return response({});
  });
  await assert.rejects(memory.recallAll(alice));
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/read")).length, 0);
});

for (const baseUrl of [
  "http://viking.example",
  "http://192.168.1.10:1933",
  "https://viking.example/prefix",
  "http://127.0.0.1:1933/api/v1",
]) {
  test(`rejects unsafe or prefixed upstream origin ${baseUrl}`, () => {
    assert.throws(() => new UpstreamMemory({ baseUrl, rootKey: "secret" }));
  });
}
for (const baseUrl of [
  "http://127.0.0.1:1933",
  "http://127.0.0.2:1933",
  "http://[::1]:1933",
  "http://localhost:1933",
  "https://viking.example",
]) {
  test(`accepts approved upstream origin ${baseUrl}`, () => {
    assert.doesNotThrow(() => new UpstreamMemory({ baseUrl, rootKey: "secret" }));
  });
}

for (const [method, count, permitted] of [
  ["recallAll", 1000, true],
  ["recallAll", 1001, false],
  ["search", 1001, false],
]) {
  test(`${method} returns complete results or rejects above 1000 records (${count})`, async () => {
    const records = Array.from({ length: count }, (_, i) => ({ id: `limit-${i}`, text: "test" }));
    const indexed = new Map(records.map((r) => [`${directory(alice)}/${hash(r.id)}.json`, r]));
    const { memory } = fixture(({ url }) => {
      if (url.pathname.endsWith("/ls")) {
        const offset = Number(url.searchParams.get("offset"));
        return response([...indexed.keys()].slice(offset, offset + 100).map((uri) => ({ uri, isDir: false })));
      }
      if (url.pathname.endsWith("/read")) return response(JSON.stringify(indexed.get(url.searchParams.get("uri"))));
      return response({});
    });
    if (permitted) assert.equal((await memory[method](alice, "")).length, count);
    else await assert.rejects(memory[method](alice, ""));
  });
}

for (const method of ["recallAll", "search"]) {
  test(`${method} rejects the whole result above 8 MiB aggregate UTF-8 bytes`, async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: `large-${i}`, text: "ä".repeat(512 * 1024) }));
    const indexed = new Map(records.map((r) => [`${directory(alice)}/${hash(r.id)}.json`, r]));
    const { memory, calls } = fixture(({ url }) => {
      if (url.pathname.endsWith("/ls")) return response([...indexed.keys()].map((uri) => ({ uri, isDir: false })));
      if (url.pathname.endsWith("/read")) return response(JSON.stringify(indexed.get(url.searchParams.get("uri"))));
      return response({});
    });
    await assert.rejects(memory[method](alice, ""));
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/read")).length, 8);
  });
}

for (const method of ["store", "recallAll", "search"]) {
  test(`${method} checks the overall deadline across provisioning and data access`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    let calls = 0;
    const memory = new UpstreamMemory({
      baseUrl: "http://localhost:1933",
      rootKey: "secret",
      timeoutMs: 1000,
      fetch: async (url) => {
        calls++;
        t.mock.timers.tick(800);
        return response(new URL(url).pathname.endsWith("/ls") ? [] : {});
      },
    });
    await assert.rejects(memory[method](alice, method === "store" ? { id: "r" } : ""));
    assert.equal(calls, 4);
  });
}

test("the final request timeout is reduced to the remaining operation budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let calls = 0;
  let lastSignal;
  const memory = new UpstreamMemory({
    baseUrl: "http://localhost:1933",
    rootKey: "secret",
    timeoutMs: 1000,
    fetch: async (_url, init) => {
      calls++;
      if (calls <= 3) {
        t.mock.timers.tick(calls === 3 ? 994 : 998);
        return response({});
      }
      lastSignal = init.signal;
      return new Promise(() => {});
    },
  });
  const started = performance.now();
  await assert.rejects(memory.store(alice, { id: "r" }));
  assert.ok(performance.now() - started < 500);
  assert.equal(lastSignal.aborted, true);
});
