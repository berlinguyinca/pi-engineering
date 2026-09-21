import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpRegistry } from "../../src/platform/McpRegistry.ts";

describe("McpRegistry", () => {
  it("discovery never grants permission", () => {
    const registry = new McpRegistry();
    registry.register({ name: "lcb", version: "1.0", command: "node lcb.mjs", tools: ["query", "write"] });
    // Default policy denies everything despite discovery.
    const allowed = registry.allowlistFor("PRJ-1", "implementer", null);
    assert.deepEqual(allowed, []);
    assert.equal(registry.discover().length, 1);
  });

  it("applies project/role allowlist via policy", () => {
    const registry = new McpRegistry({
      policy: ({ role, tool }) => role === "implementer" && tool === "write",
    });
    registry.register({ name: "lcb", version: "1.0", command: "x", tools: ["query", "write"] });
    // Server-SCOPED pairs, not bare names. `invoke` decides per (server, tool)
    // and this returned names across all servers, so a consumer using it as the
    // authorization answer re-opened the cross-server collision `invoke` closes.
    const allowed = registry.allowlistFor("PRJ-1", "implementer", null);
    assert.deepEqual(allowed, [{ server: "lcb", tool: "write" }]);
    assert.deepEqual(registry.allowlistFor("PRJ-1", "reviewer", null), []);
  });

  it("child capabilities never exceed the run ceiling", () => {
    const registry = new McpRegistry({
      policy: () => true,
    });
    registry.register({ name: "s", version: "1.0", command: "x", tools: ["a", "b", "c"] });
    const allowed = registry.allowlistFor("PRJ-1", "implementer", ["a", "b"]);
    assert.deepEqual(allowed, [
      { server: "s", tool: "a" },
      { server: "s", tool: "b" },
    ]);
  });

  it("a tool name shared by two servers is reported per server", () => {
    // The collision `invoke` already guards, now visible in the allowlist too.
    const registry = new McpRegistry({ policy: ({ tool }) => tool === "query" });
    registry.register({ name: "trusted", version: "1.0", command: "x", tools: ["query"] });
    registry.register({ name: "untrusted", version: "1.0", command: "x", tools: ["query"] });
    assert.deepEqual(registry.allowlistFor("PRJ-1", "implementer", null), [
      { server: "trusted", tool: "query" },
      { server: "untrusted", tool: "query" },
    ]);
  });

  it("a registration command is redacted before it is handed back", () => {
    const KEY = `sk-${"live"}-1234567890`;
    // These routinely carry `--api-key=…` in argv, and `discover()` is returned
    // to callers and printed by tooling.
    const registry = new McpRegistry();
    registry.register({ name: "lcb", version: "1.0", command: `node lcb.mjs --api-key=${KEY}`, tools: [] });
    const command = registry.discover()[0]?.command ?? "";
    assert.ok(!command.includes(KEY), "the key must not survive discovery");
    assert.ok(command.includes("node lcb.mjs"), "but the command is still recognisable");
  });

  it("records invocation correlation, duration/status and permission decision", async () => {
    const registry = new McpRegistry({ policy: ({ tool }) => tool === "ok" });
    registry.register({ name: "s", version: "1.0", command: "x", tools: ["ok", "denied"] });

    const ok = await registry.invoke({
      projectId: "PRJ-1",
      role: "implementer",
      server: "s",
      tool: "ok",
      ceilingTools: null,
      run: async () => "result",
    });
    assert.equal(ok.allowed, true);
    assert.equal(ok.status, "ok");
    assert.ok(ok.correlationId.startsWith("MCP-"));

    const denied = await registry.invoke({
      projectId: "PRJ-1",
      role: "implementer",
      server: "s",
      tool: "denied",
      ceilingTools: null,
      run: async () => "result",
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.status, "denied");

    assert.equal(registry.audit().length, 2);
  });

  it("requires the requested server to actually expose the tool", async () => {
    const registry = new McpRegistry({ policy: ({ tool }) => tool === "query" });
    registry.register({ name: "lcb", version: "1", command: "x", tools: ["query"] });
    registry.register({ name: "other", version: "1", command: "y", tools: ["read"] });
    // 'other' does not expose 'query': denied despite the policy allowing the name.
    const denied = await registry.invoke({
      projectId: "PRJ-1",
      role: "implementer",
      server: "other",
      tool: "query",
      ceilingTools: null,
      run: async () => "result",
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.status, "denied");
    // 'lcb' exposes 'query': allowed.
    const ok = await registry.invoke({
      projectId: "PRJ-1",
      role: "implementer",
      server: "lcb",
      tool: "query",
      ceilingTools: null,
      run: async () => "result",
    });
    assert.equal(ok.allowed, true);
  });
});
