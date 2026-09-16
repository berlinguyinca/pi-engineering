import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSERVATIVE_FALLBACK_CONTEXT } from "../../src/context/capability.ts";
import { type CapabilityFetchResult, InferWeaveCapabilityClient, modelsFromListing } from "../../src/context/client.ts";

function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (secs: number) => {
      now += secs;
    },
  };
}

test("capability refresh caches within the TTL and revalidates with ETag after it", async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; etag?: string }> = [];
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 60,
    staleIfErrorSeconds: 600,
    timeoutMs: 1_000,
    now: clock.now,
    transport: async (url, init) => {
      calls.push({ url, etag: init.etag });
      return {
        status: 200,
        etag: '"g1"',
        body: { id: "m", inferweave: { guaranteed_routable_tokens: 262_144 } },
      } satisfies CapabilityFetchResult;
    },
  });

  const first = await client.resolve("m");
  assert.equal(first.contextWindow, 262_144);
  clock.advance(10);
  await client.resolve("m");
  assert.equal(calls.length, 1, "a fresh capability is not re-fetched");

  clock.advance(60);
  const third = await client.resolve("m");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.etag, '"g1"', "a revalidation sends the ETag");
  assert.equal(third.contextWindow, 262_144);
});

test("304 keeps serving the cached capability without a new body", async () => {
  const clock = fakeClock();
  let seen = 0;
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 1,
    staleIfErrorSeconds: 600,
    timeoutMs: 1_000,
    now: clock.now,
    transport: async (_url, init) => {
      if (init.etag === '"g1"') return { status: 304 };
      seen += 1;
      return { status: 200, etag: '"g1"', body: { id: "m", context_window: 131_072 } };
    },
  });
  assert.equal((await client.resolve("m")).contextWindow, 131_072);
  clock.advance(5);
  const again = await client.resolve("m");
  assert.equal(again.contextWindow, 131_072);
  assert.equal(seen, 1, "the 304 path served from cache");
});

test("concurrent lookups share one in-flight refresh", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 30,
    staleIfErrorSeconds: 600,
    timeoutMs: 1_000,
    transport: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return { status: 200, body: { id: "m", context_window: 65_536 } };
    },
  });
  const results = await Promise.all(Array.from({ length: 25 }, () => client.resolve("m")));
  assert.equal(maxInflight, 1, "25 callers, one request: subagents do not hammer /v1/models");
  assert.ok(results.every((r) => r.contextWindow === 65_536));
});

test("a failed refresh degrades to stale, then past the stale bound the window does not expand", async () => {
  const clock = fakeClock();
  let fail = false;
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 10,
    staleIfErrorSeconds: 100,
    timeoutMs: 1_000,
    now: clock.now,
    transport: async () => {
      if (fail) throw new Error("connection refused");
      return { status: 200, body: { id: "m", inferweave: { guaranteed_routable_tokens: 262_144 } } };
    },
  });
  assert.equal((await client.resolve("m")).contextWindow, 262_144);

  fail = true;
  clock.advance(20);
  const stale = await client.resolve("m");
  assert.equal(stale.contextWindow, 262_144, "stale-if-error keeps working");
  assert.equal(stale.freshness, "stale_usable");
  assert.equal(stale.stale, true);

  clock.advance(500);
  const expired = await client.resolve("m");
  assert.equal(expired.freshness, "expired");
  assert.notEqual(expired.basis, "guaranteed_routable_tokens", "an expired value cannot be the guarantee");
  assert.ok(
    expired.contextWindow === CONSERVATIVE_FALLBACK_CONTEXT || expired.basis === "last_known_good",
    `unexpected basis ${expired.basis}`,
  );
});

test("aborting the caller's signal aborts the refresh and never hangs", async () => {
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 10,
    staleIfErrorSeconds: 60,
    timeoutMs: 10_000,
    transport: (_url, init) =>
      new Promise<CapabilityFetchResult>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const controller = new AbortController();
  const pending = client.resolve("m", undefined, controller.signal);
  setTimeout(() => controller.abort(), 5);
  const resolved = await pending;
  assert.equal(resolved?.contextWindow, CONSERVATIVE_FALLBACK_CONTEXT, "cancelled refresh falls back, never hangs");
});

test("a 404 capability response does not fabricate a window", async () => {
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 10,
    staleIfErrorSeconds: 60,
    timeoutMs: 1_000,
    transport: async () => ({ status: 404 }),
  });
  const resolved = await client.resolve("unknown-model");
  assert.equal(resolved.contextWindow, CONSERVATIVE_FALLBACK_CONTEXT);
  assert.equal(resolved.basis, "conservative_fallback");
});

test("listing models uses the guaranteed window for every id", () => {
  const listing = {
    data: [
      { id: "small", inferweave: { guaranteed_routable_tokens: 32_768 }, context_window: 32_768 },
      {
        id: "mixed",
        inferweave: { guaranteed_routable_tokens: 131_072, max_routable_tokens: 1_048_576 },
        context_window: 1_048_576,
      },
      { id: "plain-openai", created: 1 },
    ],
  };
  const models = modelsFromListing(listing, (id, capability) => ({
    modelId: id,
    contextWindow: capability.guaranteedRoutableTokens ?? CONSERVATIVE_FALLBACK_CONTEXT,
    maxTokens: capability.maxOutputTokens ?? 8_192,
    basis: "guaranteed_routable_tokens",
    source: "test",
    freshness: "fresh",
    stale: false,
    heterogeneous: false,
    warnings: [],
  }));
  assert.deepEqual(models, [
    { id: "small", contextWindow: 32_768, maxTokens: 8_192 },
    { id: "mixed", contextWindow: 131_072, maxTokens: 8_192 },
    { id: "plain-openai", contextWindow: CONSERVATIVE_FALLBACK_CONTEXT, maxTokens: 8_192 },
  ]);
});

test("inspect exposes age and last error without leaking content", async () => {
  const clock = fakeClock();
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 5,
    staleIfErrorSeconds: 50,
    timeoutMs: 100,
    now: clock.now,
    transport: async () => {
      throw new Error("upstream exploded");
    },
  });
  await client.resolve("m");
  const [entry] = client.inspect();
  assert.equal(entry?.modelId, "m");
  assert.match(entry?.lastError ?? "", /upstream exploded/);
});

test("one caller cancelling does not cancel another caller's shared refresh", async () => {
  let aborted = false;
  let requests = 0;
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 60,
    staleIfErrorSeconds: 600,
    timeoutMs: 5_000,
    transport: (_url, init) =>
      new Promise<CapabilityFetchResult>((resolve, reject) => {
        requests += 1;
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
        setTimeout(() => resolve({ status: 200, body: { id: "m", context_window: 131_072 } }), 20);
      }),
  });

  const cancelling = new AbortController();
  const first = client.resolve("m", undefined, cancelling.signal);
  await new Promise((r) => setTimeout(r, 5));
  const second = client.resolve("m"); // joins the same refresh
  cancelling.abort();

  assert.equal((await first).contextWindow, CONSERVATIVE_FALLBACK_CONTEXT, "the cancelled caller stops waiting");
  assert.equal((await second).contextWindow, 131_072, "the refresh that others waited for still lands");
  assert.equal(aborted, false, "one waiter leaving must not abort the shared fetch");
  assert.equal(requests, 1, "still a single request for the generation");
});

test("the last caller to leave does abandon the fetch", async () => {
  let aborted = false;
  const client = new InferWeaveCapabilityClient({
    baseUrl: "http://gw",
    ttlSeconds: 60,
    staleIfErrorSeconds: 600,
    timeoutMs: 5_000,
    transport: (_url, init) =>
      new Promise<CapabilityFetchResult>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
        setTimeout(() => resolve({ status: 200, body: { id: "m", context_window: 65_536 } }), 200);
      }),
  });
  const controller = new AbortController();
  const pending = client.resolve("m", undefined, controller.signal);
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(aborted, true, "nobody wants it any more: the work stops");
});
