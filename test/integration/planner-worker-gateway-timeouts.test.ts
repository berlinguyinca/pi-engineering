/**
 * A planner/worker chat completion is non-streaming: the gateway may hold the
 * response headers for as long as admission plus generation take. Node's
 * global fetch would cut that off after undici's default 300 s headers/body
 * timeouts, a fixed wall clock the mission cannot opt out of. Completions
 * therefore must not depend on the global fetch dispatcher's timeouts.
 *
 * The test shrinks the process-wide fetch dispatcher's timeouts to 400 ms and
 * has a real local gateway answer after 1.5 s.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chatCompletion } from "../../src/plannerWorker/gateway.ts";
import { type GatewayServer, startGatewayServer } from "../support/gatewayServer.ts";

const DISPATCHER = Symbol.for("undici.globalDispatcher.1");
type Dispatcher = { constructor: new (opts: Record<string, number>) => unknown };
const globals = globalThis as unknown as Record<symbol, Dispatcher | undefined>;
let original: Dispatcher | undefined;
let server: GatewayServer;

before(async () => {
  server = await startGatewayServer({
    models: [{ id: "slow" }],
    respond: async () => {
      await new Promise((r) => setTimeout(r, 1_500));
      return { content: "finally" };
    },
  });
  // Materialise fetch's global dispatcher, then swap in one with tiny timeouts.
  await fetch(`${server.baseUrl}/models`).then((r) => r.text());
  original = globals[DISPATCHER];
  assert.ok(original, "node's fetch has a global undici dispatcher");
  globals[DISPATCHER] = new original.constructor({ headersTimeout: 400, bodyTimeout: 400 }) as Dispatcher;
});

after(async () => {
  globals[DISPATCHER] = original;
  await server.close();
});

test("a completion whose headers arrive after the fetch dispatcher's timeouts still completes", async () => {
  // The knob is live: plain fetch now gives up on the slow gateway.
  await assert.rejects(
    fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "slow",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
        ],
      }),
    }).then((r) => r.text()),
    (err: unknown) => (err as { cause?: { code?: string } }).cause?.code === "UND_ERR_HEADERS_TIMEOUT",
  );
  const out = await chatCompletion({ baseUrl: server.baseUrl }, { model: "slow", system: "s", user: "u" });
  assert.equal(out.ok, true, out.ok ? "" : out.message);
  assert.equal(out.ok && out.content, "finally");
});

test("the caller's signal still ends a completion", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const started = Date.now();
  const out = await chatCompletion(
    { baseUrl: server.baseUrl },
    { model: "slow", system: "s", user: "u", signal: ac.signal },
  );
  assert.equal(out.ok, false);
  assert.ok(Date.now() - started < 1_400, "aborted before the gateway answered");
});
