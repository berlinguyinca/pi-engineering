import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PostgresKeyStore } from "../src/keys.mjs";

const connectionString = process.env.VIKING_TEST_DATABASE_URL;
const skip = connectionString ? false : "Set VIKING_TEST_DATABASE_URL to an isolated local PostgreSQL database";

test(
  "PostgreSQL persistence, hashed secrets, owner isolation, expiry and immediate cross-process revocation",
  { skip },
  async (t) => {
    const { default: pg } = await import("pg");
    const db = new pg.Pool({ connectionString });
    const owner = `test-${randomUUID()}`;
    let now = Date.parse("2026-09-14T00:00:00Z");
    let first = new PostgresKeyStore({ connectionString, now: () => now });
    const second = new PostgresKeyStore({ connectionString, now: () => now });
    t.after(async () => {
      await db.query("DELETE FROM viking_portal_keys WHERE owner = $1", [owner]);
      await Promise.all([first.close(), second.close(), db.end()]);
    });
    await first.init();
    const key = await first.create(owner, { name: "laptop", scopes: ["memory:read"], expiresInDays: 1 });
    const { rows } = await db.query("SELECT * FROM viking_portal_keys WHERE owner = $1", [owner]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].secret_hash, createHash("sha256").update(key.secret).digest("hex"));
    assert.equal(JSON.stringify(rows).includes(key.secret), false);
    await first.close();
    first = new PostgresKeyStore({ connectionString, now: () => now });
    await first.init();
    await second.init();
    assert.equal((await first.list(owner))[0].id, key.id);
    assert.equal("secret_hash" in (await first.list(owner))[0], false);
    now += 1000;
    assert.deepEqual(await second.authenticate(key.secret), { owner, scopes: ["memory:read"] });
    assert.equal((await first.list(owner))[0].lastUsedAt, new Date(now).toISOString());
    assert.equal(await second.revoke("other-owner", key.id), false);
    assert.equal(await first.revoke(owner, key.id), true);
    assert.equal(await second.authenticate(key.secret), null);
    const expired = await first.create(owner, { name: "expires", scopes: ["memory:write"], expiresInDays: 1 });
    now += 86400000;
    assert.equal(await second.authenticate(expired.secret), null);
    assert.equal(await second.authenticate("invalid"), null);
    await assert.rejects(first.create(owner, { name: "bad", scopes: ["admin"] }), TypeError);
  },
);

test(
  "PostgreSQL enforces per-owner active-key cap under concurrent creation by independent stores",
  { skip },
  async (t) => {
    const { default: pg } = await import("pg");
    const db = new pg.Pool({ connectionString });
    const owner = `test-limit-${randomUUID()}`;
    const stores = [new PostgresKeyStore({ connectionString }), new PostgresKeyStore({ connectionString })];
    t.after(async () => {
      await db.query("DELETE FROM viking_portal_keys WHERE owner = $1", [owner]);
      await Promise.all([...stores.map((store) => store.close()), db.end()]);
    });
    for (const store of stores) await store.init();
    const attempts = await Promise.allSettled(
      Array.from({ length: 28 }, (_, i) =>
        stores[i % 2].create(owner, { name: `device-${i}`, scopes: ["memory:read"], expiresInDays: i % 2 ? 30 : null }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 20);
    assert.ok(
      attempts.filter((result) => result.status === "rejected").every((result) => result.reason instanceof RangeError),
    );
    const listed = await stores[0].list(owner);
    assert.equal(listed.length, 20);
    await stores[1].revoke(owner, listed[0].id);
    assert.ok(await stores[0].create(owner, { name: "replacement", scopes: ["memory:read"] }));
  },
);

test(
  "PostgreSQL upgrades old expiry schema without changing existing keys and persists never-expiring keys",
  { skip },
  async (t) => {
    const { default: pg } = await import("pg");
    const admin = new pg.Pool({ connectionString });
    const schema = `expiry_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const isolatedConnection = isolatedUrl.toString();
    const db = new pg.Pool({ connectionString: isolatedConnection });
    let now = Date.parse("2026-09-14T00:00:00Z");
    let store = new PostgresKeyStore({ connectionString: isolatedConnection, now: () => now });
    t.after(async () => {
      await store.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    await db.query(`CREATE TABLE viking_portal_keys (
    id UUID PRIMARY KEY, owner TEXT NOT NULL, secret_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, scopes TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
  )`);
    const oldSecret = `vkg_${"a".repeat(43)}`;
    const oldId = randomUUID();
    await db.query(
      `INSERT INTO viking_portal_keys
    (id, owner, secret_hash, name, scopes, created_at, expires_at)
    VALUES ($1, 'alice', $2, 'existing', ARRAY['memory:read'], '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z')`,
      [oldId, createHash("sha256").update(oldSecret).digest("hex")],
    );
    await store.init();
    const { rows: columns } = await db.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'viking_portal_keys' AND column_name = 'expires_at'",
      [schema],
    );
    assert.equal(columns[0].is_nullable, "YES");
    const original = (await store.list("alice"))[0];
    assert.equal(original.id, oldId);
    assert.equal(original.expiresAt, "2026-09-15T00:00:00.000Z");
    assert.deepEqual(await store.authenticate(oldSecret), { owner: "alice", scopes: ["memory:read"] });
    const permanent = await store.create("alice", { name: "permanent", scopes: ["memory:read"], expiresInDays: null });
    assert.equal(permanent.expiresAt, null);
    assert.equal(
      (await db.query("SELECT expires_at FROM viking_portal_keys WHERE id = $1", [permanent.id])).rows[0].expires_at,
      null,
    );
    await store.close();
    store = new PostgresKeyStore({ connectionString: isolatedConnection, now: () => now });
    await store.init();
    assert.equal((await store.list("alice")).find((key) => key.id === permanent.id).expiresAt, null);
    assert.equal((await store.list("alice")).find((key) => key.id === oldId).expiresAt, original.expiresAt);
    now = Date.parse("2026-09-15T00:00:00Z");
    assert.equal(await store.authenticate(oldSecret), null);
    now = Date.parse("2126-09-14T00:00:00Z");
    assert.deepEqual(await store.authenticate(permanent.secret), { owner: "alice", scopes: ["memory:read"] });
    assert.equal(await store.revoke("bob", permanent.id), false);
    assert.equal(await store.revoke("alice", permanent.id), true);
    assert.equal(await store.authenticate(permanent.secret), null);
  },
);
