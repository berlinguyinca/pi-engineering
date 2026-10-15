import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CAPABILITY_MAP,
  LONG_CONTEXT_MIN_TOKENS,
  toGatewayCapabilities,
} from "../../src/inference/inferweaveCapabilities.ts";
import { chatCompletion } from "../../src/plannerWorker/gateway.ts";
import { DEFAULT_ROLE_CONFIG } from "../../src/plannerWorker/roles.ts";
import { type GatewayServer, startGatewayServer } from "../support/gatewayServer.ts";

describe("toGatewayCapabilities", () => {
  it("maps tool_calling to tool_use", () => {
    const out = toGatewayCapabilities(["tool_calling"], []);
    assert.deepEqual(out.required, ["tool_use"]);
    assert.deepEqual(out.preferred, []);
    assert.deepEqual(out.dropped, []);
    assert.equal(out.minContextTokens, undefined);
  });

  it("throws for a required name that is neither mapped nor gateway-native", () => {
    assert.throws(() => toGatewayCapabilities(["no_such_cap"], []), /no_such_cap/);
    // A Pi-only quality hint cannot be a hard requirement either.
    assert.throws(() => toGatewayCapabilities(["fast"], []), /fast/);
  });

  it("passes gateway-native names through untouched", () => {
    const out = toGatewayCapabilities(["coding.review", "tool_use", "llm.code"], []);
    assert.deepEqual(out.required, ["coding.review", "tool_use", "llm.code"]);
  });

  it("maps every Pi coding role to the same coding.* name the role config requests", () => {
    for (const [role, cfg] of Object.entries(DEFAULT_ROLE_CONFIG)) {
      assert.equal(CAPABILITY_MAP[role], cfg.capability, role);
      assert.deepEqual(toGatewayCapabilities([role], []).required, [cfg.capability]);
    }
  });

  it("drops and logs an unmapped preference instead of sending it", () => {
    const logged: string[] = [];
    const out = toGatewayCapabilities(["tool_calling"], ["fast", "coding.review", "code_strong"], {
      warn: (m) => logged.push(m),
    });
    assert.deepEqual(out.preferred, ["coding.review"]);
    assert.deepEqual(out.dropped, ["fast", "code_strong"]);
    assert.equal(logged.length, 1);
    assert.match(logged[0] as string, /fast, code_strong/);
  });

  it("moves required long_context out of the list and into a minimum context", () => {
    const out = toGatewayCapabilities(["tool_calling", "long_context"], []);
    assert.deepEqual(out.required, ["tool_use"]);
    assert.equal(out.minContextTokens, LONG_CONTEXT_MIN_TOKENS);
  });

  it("treats a preferred long_context as a dropped preference, never a hard minimum", () => {
    const out = toGatewayCapabilities([], ["long_context"], { warn: () => {} });
    assert.equal(out.minContextTokens, undefined);
    assert.deepEqual(out.dropped, ["long_context"]);
  });

  it("de-duplicates after mapping", () => {
    const out = toGatewayCapabilities(["implementer", "fixer", "coding.implementation"], []);
    assert.deepEqual(out.required, ["coding.implementation"]);
  });
});

describe("chatCompletion gateway headers", () => {
  let server: GatewayServer;
  before(async () => {
    server = await startGatewayServer({ models: [{ id: "m1" }], respond: () => ({ content: "ok" }) });
  });
  after(async () => {
    await server.close();
  });
  const call = (extra: Record<string, unknown>) =>
    chatCompletion({ baseUrl: server.baseUrl }, { model: "m1", system: "s", user: "u", ...extra });

  it("a request with sessionId sends header x-inferweave-session", async () => {
    const seen = server.requests.length;
    const out = await call({ sessionId: "mission-42" });
    assert.equal(out.ok, true);
    assert.equal(server.requests[seen]?.headers["x-inferweave-session"], "mission-42");
  });

  it("sends no session header without a sessionId", async () => {
    const seen = server.requests.length;
    await call({});
    assert.equal(server.requests[seen]?.headers["x-inferweave-session"], undefined);
  });

  it("rejects a session id that is not a safe header value", async () => {
    await assert.rejects(call({ sessionId: "a\r\nx-evil: 1" }), /session/i);
    await assert.rejects(call({ sessionId: "" }), /session/i);
  });

  it("sends translated capabilities and the long-context minimum", async () => {
    const seen = server.requests.length;
    await call({ capability: { capabilities: ["tool_calling", "long_context", "implementer"] } });
    const h = server.requests[seen]?.headers;
    assert.equal(h?.["x-inferweave-capabilities"], "tool_use,coding.implementation");
    assert.equal(h?.["x-inferweave-min-context"], String(LONG_CONTEXT_MIN_TOKENS));
  });

  it("keeps an explicit larger minimumContext over the long-context default", async () => {
    const seen = server.requests.length;
    await call({ capability: { capabilities: ["long_context"], minimumContext: 256_000 } });
    const h = server.requests[seen]?.headers;
    assert.equal(h?.["x-inferweave-min-context"], "256000");
    assert.equal(h?.["x-inferweave-capabilities"], undefined);
  });

  it("never sends an untranslatable required capability", async () => {
    const seen = server.requests.length;
    await assert.rejects(call({ capability: { capabilities: ["no_such_cap"] } }), /no_such_cap/);
    assert.equal(server.requests.length, seen);
  });
});
