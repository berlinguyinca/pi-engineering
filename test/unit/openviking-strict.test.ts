import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenVikingProvider, OpenVikingRequestError } from "../../src/blackhole/durable.ts";

const record = {
  id: "memory-1",
  text: "Use pnpm for this project",
  sourceRefs: ["operator"],
  evidenceIds: [],
  promotedFrom: "session-1",
  promotedAt: "2026-09-14T00:00:00Z",
  promotedBy: "operator",
};

function provider(fetch: typeof globalThis.fetch, timeoutMs = 100) {
  return new OpenVikingProvider({
    baseUrl: "https://memory.example.test",
    token: "private-test-token",
    strict: true,
    timeoutMs,
    fetch,
  });
}

function failure(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof OpenVikingRequestError);
    assert.equal(error.name, "OpenVikingRequestError");
    assert.equal((error as Error & { code: string }).code, code);
    assert.equal((error as Error & { status?: number }).status, status);
    assert.doesNotMatch(String(error), /private-test-token|sensitive-query|private-body|memory\.example/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("strict successful reads preserve records and distinguish valid empty results", async () => {
  assert.deepEqual(await provider(async () => Response.json([record])).recallAll(), [record]);
  assert.deepEqual(await provider(async () => Response.json([])).search("nothing"), []);
});

test("strict requests preserve auth, base paths and encoded queries while refusing redirects", async () => {
  let requested: { url: unknown; init?: RequestInit } | undefined;
  const client = new OpenVikingProvider({
    baseUrl: "https://memory.example.test/api/",
    strict: true,
    token: "private-test-token",
    fetch: async (url, init) => {
      requested = { url, init };
      return Response.json([]);
    },
  });
  assert.deepEqual(await client.search("a&b c"), []);
  assert.ok(requested);
  assert.equal(requested.url, "https://memory.example.test/api/memory/search?q=a%26b%20c");
  assert.equal(requested.init?.redirect, "error");
  assert.equal(new Headers(requested.init?.headers).get("authorization"), "Bearer private-test-token");
  assert.ok(requested.init?.signal instanceof AbortSignal);
});

for (const [status, code] of [
  [401, "auth"],
  [403, "forbidden"],
  [500, "http"],
  [302, "http"],
] as const) {
  for (const operation of ["recall", "search", "store"] as const) {
    test(`strict ${operation} reports sanitized ${status} failure`, async () => {
      const client = provider(async () => new Response("private-body", { status }));
      const promise =
        operation === "store"
          ? client.store(record)
          : operation === "recall"
            ? client.recallAll()
            : client.search("sensitive-query");
      await assert.rejects(promise, failure(code, status));
    });
  }
}

for (const body of [
  "private-body",
  "{}",
  "null",
  '[{"id":1,"text":"bad"}]',
  '[{"id":"x","text":{}}]',
  '[{"id":"x","text":"y","sourceRefs":null}]',
  '[{"id":"x","text":"y","evidenceIds":[1]}]',
]) {
  test(`strict malformed response rejects: ${body}`, async () => {
    await assert.rejects(provider(async () => new Response(body)).recallAll(), failure("response"));
    await assert.rejects(provider(async () => new Response(body)).search("sensitive-query"), failure("response"));
  });
}

test("strict read rejects more than 1000 records", async () => {
  await assert.rejects(provider(async () => Response.json(Array(1001).fill(record))).recallAll(), failure("response"));
});

test("strict read bounds streamed response bytes and cancels excess data", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(provider(async () => new Response(body)).recallAll(), failure("response"));
  assert.ok(cancelled);
});

test("strict read rejects an oversized content-length without downloading", async () => {
  await assert.rejects(
    provider(async () => new Response("[]", { headers: { "content-length": "8388609" } })).recallAll(),
    failure("response"),
  );
});

test("strict network errors and redirect rejections never leak transport details", async () => {
  await assert.rejects(
    provider(async () => {
      throw new Error("private-test-token sensitive-query private-body");
    }).search("sensitive-query"),
    failure("unreachable"),
  );
});

test("strict hanging fetch times out and aborts even if transport ignores abort", async () => {
  let signal: AbortSignal | null | undefined;
  const client = provider(async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }, 20);
  await assert.rejects(client.recallAll(), failure("timeout"));
  assert.equal(signal?.aborted, true);
});

test("strict hanging response body shares the deadline and is cancelled", async () => {
  let cancelled = false;
  const client = provider(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    20,
  );
  await assert.rejects(client.search("sensitive-query"), failure("timeout"));
  assert.ok(cancelled);
});

test("strict store accepts empty 201 and 204 responses", async () => {
  for (const status of [201, 204]) {
    await provider(async () => new Response(null, { status })).store(record);
  }
});

test("strict store response body is bounded by the same deadline", async () => {
  await assert.rejects(
    provider(async () => new Response(new ReadableStream(), { status: 201 }), 20).store(record),
    failure("timeout"),
  );
});

for (const baseUrl of [
  "http://public.example",
  "http://127.evil.example",
  "ftp://localhost",
  "https://user:pass@memory.example",
  "https://memory.example/?token=private-test-token",
  "https://memory.example/#private-test-token",
  "not a url",
]) {
  test(`strict configuration rejects unsafe base URL: ${baseUrl}`, () => {
    assert.throws(() => new OpenVikingProvider({ baseUrl, strict: true }), failure("response"));
  });
}

test("strict configuration permits HTTPS and local HTTP", async () => {
  for (const baseUrl of [
    "https://memory.example",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ]) {
    const client = new OpenVikingProvider({ baseUrl, strict: true, fetch: async () => Response.json([]) });
    assert.deepEqual(await client.recallAll(), []);
  }
});

test("strict configuration rejects invalid deadlines", () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => provider(async () => Response.json([]), timeoutMs), failure("response"));
  }
});
