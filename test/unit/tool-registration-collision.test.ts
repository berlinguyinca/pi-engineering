import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSkippedTools, registerToolsTolerant } from "../../src/tools/registration.ts";

/**
 * Loading the runtime twice — the installed package and a worktree checkout —
 * used to fail the second extension outright, because Pi rejects a tool name two
 * extensions both claim. The error named the extension that lost, so a healthy
 * checkout looked like a broken install.
 */

function host(opts: { taken?: string[]; reject?: string[] } = {}) {
  const taken = new Set(opts.taken ?? []);
  const registered: string[] = [];
  return {
    registered,
    getAllTools: () => [...taken].map((name) => ({ name })),
    registerTool: (tool: { name: string }) => {
      if (opts.reject?.includes(tool.name)) throw new Error(`Tool "${tool.name}" conflicts with another extension`);
      taken.add(tool.name);
      registered.push(tool.name);
    },
  };
}

test("a name another extension already owns is skipped, not fatal", () => {
  const h = host({ taken: ["ledger_read"] });
  const outcome = registerToolsTolerant(h, [{ name: "ledger_read" }, { name: "mission" }]);

  assert.deepEqual(h.registered, ["mission"], "the free tool still registers");
  assert.deepEqual(
    outcome.skipped.map((entry) => entry.name),
    ["ledger_read"],
  );
  assert.match(outcome.skipped[0]?.reason ?? "", /already registered/);
});

test("a host that throws on registration reports it and keeps going", () => {
  const h = host({ reject: ["mission"] });
  const outcome = registerToolsTolerant(h, [{ name: "mission" }, { name: "ledger_read" }]);

  assert.deepEqual(h.registered, ["ledger_read"], "one rejected tool does not take the batch down");
  assert.match(outcome.skipped[0]?.reason ?? "", /conflicts with another extension/, "the host's own words surface");
});

test("a name claimed twice in the same batch registers once", () => {
  const h = host();
  const outcome = registerToolsTolerant(h, [{ name: "mission" }, { name: "mission" }]);

  assert.deepEqual(h.registered, ["mission"]);
  assert.equal(outcome.skipped.length, 1);
});

test("a host without getAllTools still registers everything it accepts", () => {
  const registered: string[] = [];
  const outcome = registerToolsTolerant({ registerTool: (t) => void registered.push(t.name) }, [
    { name: "ledger_read" },
    { name: "mission" },
  ]);

  assert.deepEqual(registered, ["ledger_read", "mission"]);
  assert.deepEqual(outcome.skipped, []);
});

test("a host that refuses to answer getAllTools still registers what it accepts", () => {
  // Pi forbids action methods during extension loading, which is exactly when
  // this runs. A refused pre-flight view must degrade to the try/catch path.
  const registered: string[] = [];
  const outcome = registerToolsTolerant(
    {
      getAllTools: () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      },
      registerTool: (t) => void registered.push(t.name),
    },
    [{ name: "ledger_read" }, { name: "mission" }],
  );

  assert.deepEqual(registered, ["ledger_read", "mission"], "a load-time view refusal is not fatal");
  assert.deepEqual(outcome.skipped, []);
});

test("the operator line names the tools and the fix", () => {
  assert.equal(describeSkippedTools([]), null, "nothing skipped, nothing said");

  const line = describeSkippedTools([{ name: "ledger_read", reason: "already registered by another extension" }]) ?? "";
  assert.match(line, /1 tool already registered/);
  assert.match(line, /ledger_read/);
  assert.match(line, /--no-extensions/, "the line tells the operator how to load one runtime");
});
