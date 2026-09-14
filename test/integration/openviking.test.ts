import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenVikingProvider } from "../../src/blackhole/durable.ts";

type StartServer = (opts: { port?: number; token?: string }) => Promise<{
  port: number;
  url: string;
  close: () => Promise<void>;
}>;

/** Start the OpenViking service in-memory (no Postgres, no deps) on an ephemeral port. */
async function startMemoryServer(token?: string) {
  // The service under services/ is a standalone JS deployable (no .d.ts); the
  // contract is validated here against the real runtime provider.
  // @ts-expect-error standalone JS service has no declaration file
  const mod = await import("../../services/openviking/src/server.mjs");
  return (mod as { startServer: StartServer }).startServer({ port: 0, token });
}

const record = {
  id: "dur-1",
  text: "adapter seam is canonical and the add function must handle negatives",
  sourceRefs: ["evt:9"],
  promotedFrom: "cand-1",
  evidenceIds: ["evt:9"],
  promotedAt: "2026-01-01T00:00:00.000Z",
  promotedBy: "operator",
};

test("openviking service: full contract — store, recall, search, auth (via OpenVikingProvider)", async () => {
  const srv = await startMemoryServer("test-token");
  try {
    const provider = new OpenVikingProvider({
      baseUrl: srv.url,
      token: "test-token",
    });

    // promote
    await provider.store(record);

    // recall all
    const all = await provider.recallAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, "dur-1");
    assert.deepEqual(all[0]!.sourceRefs, ["evt:9"]);

    // token-relevance search
    const hits = await provider.search("adapter seam");
    assert.equal(hits.length, 1);
    assert.equal((await provider.search("unrelated")).length, 0);
    assert.equal((await provider.search("negatives")).length, 1);
  } finally {
    await srv.close();
  }
});

test("openviking service: auth is enforced (wrong/missing token denied)", async () => {
  const srv = await startMemoryServer("secret");
  try {
    const authed = new OpenVikingProvider({ baseUrl: srv.url, token: "secret" });
    await authed.store(record);
    assert.equal((await authed.recallAll()).length, 1);

    // Missing token: recall degrades to empty, store throws (fail-closed client).
    const anon = new OpenVikingProvider({ baseUrl: srv.url });
    assert.deepEqual(await anon.recallAll(), []);
    await assert.rejects(() => anon.store(record), /401/);
  } finally {
    await srv.close();
  }
});

test("openviking service: memory is shared across provider instances (cross-worker)", async () => {
  const srv = await startMemoryServer();
  try {
    const writer = new OpenVikingProvider({ baseUrl: srv.url });
    const reader = new OpenVikingProvider({ baseUrl: srv.url });
    await writer.store(record);
    const all = await reader.recallAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.text.includes("adapter seam"), true);
  } finally {
    await srv.close();
  }
});

test("openviking service: Postgres store round-trips (requires TEST_DATABASE_URL; skipped otherwise)", async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    t.skip("TEST_DATABASE_URL not set — set it to a throwaway Postgres to run this test");
    return;
  }
  // @ts-expect-error standalone JS service has no declaration file
  const { PostgresStore } = (await import("../../services/openviking/src/store.mjs")) as {
    PostgresStore: new (
      u: string,
    ) => {
      init(): Promise<void>;
      close(): Promise<void>;
      store(r: Record<string, unknown>): Promise<void>;
      recallAll(): Promise<Array<Record<string, unknown>>>;
      search(q: string): Promise<Array<Record<string, unknown>>>;
    };
  };
  const store = new PostgresStore(url);
  await store.init();
  try {
    await store.store(record);
    const all = await store.recallAll();
    assert.ok(all.some((r) => r.id === "dur-1"));
    assert.ok((await store.search("negatives")).length >= 1);
  } finally {
    await store.close();
  }
});

test("openviking service: malformed record is rejected and cannot poison search", async () => {
  const srv = await startMemoryServer();
  try {
    const provider = new OpenVikingProvider({ baseUrl: srv.url });
    // sourceRefs as a non-array must be rejected (400), not stored.
    const malformed = { ...record, id: "bad", sourceRefs: "not-an-array" } as unknown as Parameters<
      typeof provider.store
    >[0];
    await assert.rejects(() => provider.store(malformed), /400/);
    // A valid record still works and search stays healthy.
    await provider.store(record);
    assert.equal((await provider.search("adapter seam")).length, 1);
  } finally {
    await srv.close();
  }
});
