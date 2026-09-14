import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryKeyStore } from "../src/keys.mjs";

const options = { name: "laptop", scopes: ["memory:read", "memory:write"] };
const base = Date.parse("2026-09-14T00:00:00Z");

test("key secret is random, returned once, scoped and isolated by owner", async () => {
  let now = base;
  const store = new MemoryKeyStore({ now: () => now });
  await store.init();
  const first = await store.create("alice", options);
  const second = await store.create("bob", options);
  assert.match(first.secret, /^vkg_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.secret, second.secret);
  assert.equal(first.expiresAt, new Date(base + 30 * 86400000).toISOString());
  assert.equal(first.lastUsedAt, null);
  now += 1000;
  assert.deepEqual(await store.authenticate(first.secret), { owner: "alice", scopes: options.scopes });
  const [listed] = await store.list("alice");
  assert.equal(listed.id, first.id);
  assert.equal(listed.lastUsedAt, new Date(now).toISOString());
  assert.equal("secret" in listed, false);
  assert.equal("hash" in listed, false);
  assert.deepEqual(
    Object.keys(listed).sort(),
    ["id", "name", "scopes", "createdAt", "expiresAt", "lastUsedAt", "revokedAt"].sort(),
  );
  assert.deepEqual(await store.list("unknown"), []);
  assert.equal(await store.revoke("bob", first.id), false);
  assert.notEqual(await store.authenticate(first.secret), null);
  assert.equal(await store.revoke("alice", first.id), true);
  assert.equal(await store.revoke("alice", first.id), false);
  assert.equal(await store.authenticate(first.secret), null);
  assert.equal((await store.list("alice"))[0].revokedAt, new Date(now).toISOString());
  await store.close();
});

test("expiry is enforced at the exact boundary and only active keys count toward limit", async () => {
  let now = base;
  const store = new MemoryKeyStore({ now: () => now });
  const keys = await Promise.all(
    Array.from({ length: 20 }, () => store.create("alice", { ...options, expiresInDays: 1 })),
  );
  await assert.rejects(store.create("alice", options), RangeError);
  await store.revoke("alice", keys[0].id);
  await store.create("alice", { ...options, expiresInDays: 1 });
  now += 86400000;
  assert.equal(await store.authenticate(keys[1].secret), null);
  assert.ok(await store.create("alice", options));
});

test("returned data cannot mutate persisted scope or authentication decisions", async () => {
  const store = new MemoryKeyStore();
  const input = { name: "read only", scopes: ["memory:read"] };
  const key = await store.create("alice", input);
  input.scopes.push("memory:write");
  key.scopes.push("memory:write");
  (await store.list("alice"))[0].scopes.push("memory:write");
  (await store.authenticate(key.secret)).scopes.push("memory:write");
  assert.deepEqual(await store.authenticate(key.secret), { owner: "alice", scopes: ["memory:read"] });
});

for (const expiresInDays of [undefined, 1, 90, null]) {
  test(`expiry ${String(expiresInDays)} is preserved and enforced`, async () => {
    let now = base;
    const store = new MemoryKeyStore({ now: () => now });
    const key = await store.create("alice", { ...options, expiresInDays });
    const expiresAt = expiresInDays === null ? null : new Date(base + (expiresInDays ?? 30) * 86400000).toISOString();
    assert.equal(key.expiresAt, expiresAt);
    assert.equal((await store.list("alice"))[0].expiresAt, expiresAt);
    now = Date.parse("2126-09-14T00:00:00Z");
    assert.deepEqual(
      await store.authenticate(key.secret),
      expiresInDays === null ? { owner: "alice", scopes: options.scopes } : null,
    );
    assert.equal(await store.revoke("alice", key.id), true);
    assert.equal(await store.authenticate(key.secret), null);
  });
}

test("never-expiring keys consume active quota until revoked", async () => {
  let now = base;
  const store = new MemoryKeyStore({ now: () => now });
  const keys = await Promise.all(
    Array.from({ length: 20 }, () => store.create("alice", { ...options, expiresInDays: null })),
  );
  now = Date.parse("2126-09-14T00:00:00Z");
  await assert.rejects(store.create("alice", options), RangeError);
  await assert.rejects(store.create("alice", { ...options, expiresInDays: null }), RangeError);
  await store.revoke("alice", keys[0].id);
  assert.equal((await store.create("alice", { ...options, expiresInDays: null })).expiresAt, null);
});

for (const [label, change] of [
  ["empty name", { name: "" }],
  ["blank name", { name: "   " }],
  ["long name", { name: "a".repeat(101) }],
  ["non-string name", { name: 3 }],
  ["no scopes", { scopes: [] }],
  ["unknown scope", { scopes: ["admin"] }],
  ["non-array scopes", { scopes: "memory:read" }],
  ["missing scopes", { scopes: undefined }],
  ["zero expiry", { expiresInDays: 0 }],
  ["negative expiry", { expiresInDays: -1 }],
  ["fraction expiry", { expiresInDays: 1.5 }],
  ["huge expiry", { expiresInDays: 91 }],
  ["NaN expiry", { expiresInDays: Number.NaN }],
  ["string expiry", { expiresInDays: "30" }],
  ["string null expiry", { expiresInDays: "null" }],
  ["boolean expiry", { expiresInDays: false }],
  ["infinite expiry", { expiresInDays: Number.POSITIVE_INFINITY }],
]) {
  test(`rejects ${label}`, async () => {
    await assert.rejects(
      new MemoryKeyStore().create("alice", { ...options, ...change }),
      (error) => error instanceof TypeError || error instanceof RangeError,
    );
  });
}

test("rejects missing owner and handles malformed or nonexistent credentials without throwing", async () => {
  const store = new MemoryKeyStore();
  for (const owner of ["", null, undefined, 1]) await assert.rejects(store.create(owner, options), TypeError);
  for (const secret of ["", null, undefined, 1, "vkg_wrong", "qte_123", `vkg_${"a".repeat(43)}`])
    assert.equal(await store.authenticate(secret), null);
  assert.equal(await store.revoke("alice", "nonexistent"), false);
});
