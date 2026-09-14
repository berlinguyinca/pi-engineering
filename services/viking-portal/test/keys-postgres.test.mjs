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
        stores[i % 2].create(owner, { name: `device-${i}`, scopes: ["memory:read"] }),
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
