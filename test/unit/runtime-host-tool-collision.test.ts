import assert from "node:assert/strict";
import { test } from "node:test";
import { type BridgeTarget, PiBridge } from "../../src/runtime/host/piBridge.ts";

/**
 * Two runtime copies, one tool namespace.
 *
 * The release host and a worktree checkout both declare `ledger_read`, `mission`
 * and the rest. Pi refuses the second registration, and that throw used to
 * propagate out of the generation's registration loop and fail the whole load —
 * so the copy that lost a name lost every tool it had, and the error named it as
 * though it were broken. Losing a name is now a recorded outcome: the copy that
 * registered first serves it, the loser keeps the rest of its surface.
 */

function target(): BridgeTarget {
  return {
    dispatchGeneration: () => 1,
    whenOpen: () => Promise.resolve(),
    track: (_gen, _type, _label, work) => Promise.resolve(work()),
    isLive: () => true,
  };
}

function harness(taken: string[]) {
  const registered: string[] = [];
  const pi = {
    on: () => () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string }) => {
      if (taken.includes(tool.name)) throw new Error(`Tool "${tool.name}" conflicts with another extension`);
      registered.push(tool.name);
    },
  } as never;
  const bridge = new PiBridge(pi, target());
  return { bridge, registered };
}

test("a tool name another extension owns is shadowed, not fatal", () => {
  const { bridge, registered } = harness(["ledger_read"]);
  const api = bridge.createGenerationApi(1);

  assert.doesNotThrow(() => {
    api.registerTool({ name: "ledger_read", execute: async () => "ok" } as never);
    api.registerTool({ name: "mission", execute: async () => "ok" } as never);
  }, "a lost name must not take the load down");

  assert.deepEqual(registered, ["mission"], "the tools this copy does own still register");
  assert.equal(bridge.isForwardedTool("mission"), true);
  assert.equal(bridge.isForwardedTool("ledger_read"), false, "a shadowed name is not routed to this generation");
  assert.deepEqual(bridge.shadowedTools(1), [
    { name: "ledger_read", reason: 'Tool "ledger_read" conflicts with another extension' },
  ]);
});

test("a generation that loses nothing reports no shadowed tools", () => {
  const { bridge, registered } = harness([]);
  const api = bridge.createGenerationApi(1);
  api.registerTool({ name: "mission", execute: async () => "ok" } as never);

  assert.deepEqual(registered, ["mission"]);
  assert.deepEqual(bridge.shadowedTools(1), []);
});
