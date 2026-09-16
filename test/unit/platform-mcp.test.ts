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
    const allowed = registry.allowlistFor("PRJ-1", "implementer", null);
    assert.deepEqual(allowed, ["write"]);
    assert.deepEqual(registry.allowlistFor("PRJ-1", "reviewer", null), []);
  });

  it("child capabilities never exceed the run ceiling", () => {
    const registry = new McpRegistry({
      policy: () => true,
    });
    registry.register({ name: "s", version: "1.0", command: "x", tools: ["a", "b", "c"] });
    const allowed = registry.allowlistFor("PRJ-1", "implementer", ["a", "b"]);
    assert.deepEqual(allowed, ["a", "b"]);
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
});
