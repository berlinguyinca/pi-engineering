import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { OpenVikingProvider } from "../../../src/blackhole/durable.ts";
import { PostgresKeyStore } from "../src/keys.mjs";
import { startPortal } from "../src/server.mjs";
import { UpstreamMemory } from "../src/upstream.mjs";

const enabled = process.env.VIKING_LIVE_TEST === "1";
test(
  "real upstream + PostgreSQL + existing Pi provider: two users, overwrite, search, restart and revocation",
  { skip: !enabled, timeout: 180000 },
  async () => {
    // Opt-in isolated test only: this provisions and later deletes NEW test accounts.
    const upstreamURL = process.env.VIKING_TEST_UPSTREAM_URL;
    const rootKey = process.env.VIKING_TEST_UPSTREAM_KEY;
    const databaseURL = process.env.VIKING_TEST_DATABASE_URL;
    assert.ok(upstreamURL && rootKey && databaseURL, "All three isolated test endpoints must be configured");
    assert.ok(
      ["127.0.0.1", "localhost"].includes(new URL(upstreamURL).hostname),
      "Live smoke is restricted to loopback",
    );
    assert.ok(["127.0.0.1", "localhost"].includes(new URL(databaseURL).hostname), "Test database must be loopback");
    const issuer = "https://test-issuer.example/isolated";
    const subjects = [`alice-${randomUUID()}`, `bob-${randomUUID()}`];
    const owners = subjects.map((s) => createHash("sha256").update(`${issuer}\0${s}`).digest("hex"));
    const keys = new PostgresKeyStore({ connectionString: databaseURL });
    await keys.init();
    const memory = new UpstreamMemory({ baseUrl: upstreamURL, rootKey, timeoutMs: 30000 });
    const portal = await startPortal({
      port: 0,
      origin: "http://127.0.0.1",
      issuer,
      keys,
      memory,
      cognito: {
        authorizationUrl: ({ state }) => `https://test-login.example/?state=${state}`,
        exchange: async ({ code }) => ({ sub: code, email: "test@example.com", expiresAt: Date.now() + 3600000 }),
      },
    });
    try {
      const credentials = await Promise.all(
        owners.map((owner) =>
          keys.create(owner, {
            name: "isolated live smoke",
            scopes: ["memory:read", "memory:write"],
            expiresInDays: 1,
          }),
        ),
      );
      const clients = credentials.map((key) => new OpenVikingProvider({ baseUrl: portal.url, token: key.secret }));
      const record = {
        id: "same/id",
        text: "Calibration evidence for Alice",
        sourceRefs: ["repo:calibration"],
        evidenceIds: ["verified:1"],
        promotedFrom: "candidate:1",
        promotedBy: "not-an-owner",
        promotedAt: "2026-09-14T00:00:00.000Z",
      };
      await clients[0].store(record);
      const bobRecord = { ...record, text: "Bob private evidence" };
      await clients[1].store(bobRecord);
      assert.deepEqual(await clients[0].recallAll(), [record]);
      assert.deepEqual(await clients[1].recallAll(), [bobRecord]);
      assert.deepEqual(await clients[0].search("calibration absent"), [record]);
      assert.deepEqual(await clients[1].search("Alice"), []);
      const updated = { ...record, text: "Revised calibration evidence" };
      await clients[0].store(updated);
      assert.deepEqual(await clients[0].recallAll(), [updated]);
      const other = new PostgresKeyStore({ connectionString: databaseURL });
      await other.init();
      try {
        assert.equal((await other.authenticate(credentials[0].secret)).owner, owners[0]);
        await other.revoke(owners[0], credentials[0].id);
        assert.equal(
          (await fetch(`${portal.url}/memory`, { headers: { authorization: `Bearer ${credentials[0].secret}` } }))
            .status,
          401,
        );
      } finally {
        await other.close();
      }
      // Direct root-authenticated negative probe still asserts USER and another user's URI.
      const cross = await fetch(
        `${upstreamURL}/api/v1/content/read?${new URLSearchParams({ uri: `viking://user/pi-${owners[0]}/resources/pi-memories/${createHash("sha256").update(record.id).digest("hex")}.json`, raw: "true" })}`,
        {
          headers: {
            "X-API-Key": rootKey,
            "X-OpenViking-Account": `pi-${owners[1]}`,
            "X-OpenViking-User": `pi-${owners[1]}`,
            "X-OpenViking-Role": "user",
          },
        },
      );
      assert.ok([403, 404].includes(cross.status), `Cross-user read returned ${cross.status}`);
      assert.equal(
        (
          await fetch(`${portal.url}/api/v1/admin/accounts`, {
            headers: { authorization: `Bearer ${credentials[1].secret}` },
          })
        ).status,
        404,
      );
    } finally {
      await portal.close();
      await keys.close();
      for (const owner of owners) {
        const deleted = await fetch(`${upstreamURL}/api/v1/admin/accounts/pi-${owner}`, {
          method: "DELETE",
          headers: { "X-API-Key": rootKey },
        });
        assert.ok([200, 404].includes(deleted.status), "Failed to clean isolated upstream test account");
      }
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: databaseURL });
      try {
        await pool.query("DELETE FROM viking_portal_keys WHERE owner = ANY($1::text[])", [owners]);
      } finally {
        await pool.end();
      }
    }
  },
);
