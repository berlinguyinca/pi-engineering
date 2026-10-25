import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHerdrQuorumReader } from "../../src/github/quorum.ts";

const reader = (answer: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { read: createHerdrQuorumReader({ baseUrl: "http://127.0.0.1:1", apiKey: "k-1" }, f), calls };
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("quorum reader fails closed", () => {
  it("reads the route with the key header and no redirects; head is lower-cased", async () => {
    const { read, calls } = reader(() =>
      ok({ status: "satisfied", head: "ABCDEF1", counted: [1], rereview_required: false }),
    );
    const q = await read("pr:github.com/a/b#1");
    assert.deepEqual(q, { status: "satisfied", head: "abcdef1", counted: [1], rereviewRequired: false });
    assert.equal(calls[0]?.url, "http://127.0.0.1:1/api/v1/graph/nodes/pr%3Agithub.com%2Fa%2Fb%231/review-quorum");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["X-API-Key"], "k-1");
    assert.equal(calls[0]?.init.redirect, "error");
  });
  it("a non-2xx answer is null, never a quorum", async () => {
    for (const status of [401, 403, 404, 500]) {
      const { read } = reader(() => new Response(JSON.stringify({ status: "satisfied" }), { status }));
      assert.equal(await read("pr:x/y/z#1"), null, String(status));
    }
  });
  it("a network failure or a timeout is null", async () => {
    const { read } = reader(() => {
      throw new Error("down");
    });
    assert.equal(await read("pr:x/y/z#1"), null);
  });
  it("an unexpected shape or a non-JSON body is null", async () => {
    for (const body of [{}, { status: 3 }, []]) {
      const { read } = reader(() => ok(body));
      assert.equal(await read("pr:x/y/z#1"), null, JSON.stringify(body));
    }
    const { read } = reader(() => new Response("<html>", { status: 200 }));
    assert.equal(await read("pr:x/y/z#1"), null);
  });
  it("a missing head stays null (so it can never equal a real head)", async () => {
    const { read } = reader(() => ok({ status: "satisfied" }));
    assert.equal((await read("pr:x/y/z#1"))?.head, null);
  });
});
