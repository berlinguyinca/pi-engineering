/**
 * A mid-session reload cannot re-register tools: Pi's registry is global and the
 * first registration wins, so the candidate generation inherits the names the
 * previous generation holds (src/tools/registration.ts). The health check has to
 * ask whether the session can use the tool, not which generation wrote the
 * registration — otherwise every in-session update fails its own health check
 * ("tools registered (missing ledger_read)") and rolls back a candidate that
 * works.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeContext } from "../../src/runtime/host/contract.ts";
import { ExtensionGenerationRuntime } from "../../src/runtime/host/runtimeEntry.ts";

/** A generation-2 context whose Pi registry already holds `tools`. */
function contextWithRegistry(tools: string[]): RuntimeContext {
  const pi = {
    registerCommand: () => {},
    registerTool: () => {},
    getAllTools: () => tools.map((name) => ({ name })),
  };
  return {
    generation: 2,
    pi: pi as unknown as RuntimeContext["pi"],
    resources: {} as RuntimeContext["resources"],
    operations: { active: () => [] } as unknown as RuntimeContext["operations"],
    isActive: () => true,
    log: () => {},
    info: {
      version: "0.2.0",
      commit: "c".repeat(40),
      label: "installed:test",
      root: "/tmp",
    } as unknown as RuntimeContext["info"],
    latestContext: () => ({ cwd: "/tmp" }),
    session: { active: () => false, replay: async () => [] },
  };
}

function toolsCheck(runtime: ExtensionGenerationRuntime) {
  return runtime.health().then((health) => health.checks.find((check) => check.name === "tools registered")!);
}

/** A factory that registers `ledger_read` through the generation's own API. */
const registerLedgerRead = ((pi: { registerTool(tool: { name: string }): void }) => {
  pi.registerTool({ name: "ledger_read" });
}) as unknown as ConstructorParameters<typeof ExtensionGenerationRuntime>[1];

test("the previous generation holding the name satisfies health (§47 mid-session reload)", async () => {
  // The candidate registers nothing: every name is already taken by its predecessor.
  const runtime = new ExtensionGenerationRuntime(contextWithRegistry(["ledger_read"]), () => {});
  const check = await toolsCheck(runtime);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail ?? "", /previous generation/);
});

test("health still fails when nobody holds the required tool", async () => {
  const runtime = new ExtensionGenerationRuntime(contextWithRegistry([]), () => {});
  const check = await toolsCheck(runtime);
  assert.equal(check.ok, false);
  assert.match(check.detail ?? "", /ledger_read/);
});

test("a generation that registers the tool itself passes with no inherited note", async () => {
  const runtime = new ExtensionGenerationRuntime(contextWithRegistry([]), registerLedgerRead);
  await runtime.start();
  const check = await toolsCheck(runtime);
  assert.equal(check.ok, true, check.detail);
  assert.equal(check.detail, undefined);
});

test("a registry view that throws does not take the health check down", async () => {
  const context = contextWithRegistry([]);
  (context.pi as unknown as { getAllTools: () => never }).getAllTools = () => {
    throw new Error("not available while loading");
  };
  const runtime = new ExtensionGenerationRuntime(context, registerLedgerRead);
  await runtime.start();
  const check = await toolsCheck(runtime);
  assert.equal(check.ok, true, check.detail);
});
