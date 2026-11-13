// R05: replay safety is a pure classification — never permission (toolCallGuard) and never the ledger's duplicate-event fence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { READ_ONLY_TOOL_NAMES, type ToolAction, classifyReplaySafety } from "../../src/inference/recoverySafety.ts";

it("non-idempotent operations cannot be replayed", () => {
  assert.deepEqual(classifyReplaySafety({ name: "bash", writes: true }), {
    safety: "unsafe",
    replayAllowed: false,
    reason: "mutating",
  });
  assert.deepEqual(classifyReplaySafety({ name: "edit", external: true }), {
    safety: "unsafe",
    replayAllowed: false,
    reason: "external",
  });
  assert.deepEqual(
    classifyReplaySafety({ name: "read", writes: true }),
    { safety: "unsafe", replayAllowed: false, reason: "mutating" },
    "the safeguard dominates the name",
  );
  assert.deepEqual(classifyReplaySafety({ name: "read", writes: true, external: true, idempotencyKey: "k1" }), {
    safety: "unsafe",
    replayAllowed: false,
    reason: "mutating",
  });
});

it("unknown operations cannot be replayed", () => {
  for (const name of ["mystery_tool", "Read", "grep "])
    assert.deepEqual(
      classifyReplaySafety({ name }),
      { safety: "unknown", replayAllowed: false, reason: "unknown_tool" },
      name,
    );
  assert.deepEqual([...READ_ONLY_TOOL_NAMES], ["read", "grep", "glob", "ls", "symbol", "repo_search", "tests_for"]);
});

it("missing information defaults to no replay", () => {
  const missing: ToolAction[] = [{ name: "" }, { name: 42 as unknown as string }, {} as ToolAction];
  for (const action of [...missing, null as unknown as ToolAction])
    assert.deepEqual(
      classifyReplaySafety(action),
      { safety: "unknown", replayAllowed: false, reason: "invalid_input" },
      JSON.stringify(action) ?? "null",
    );
  assert.deepEqual(
    classifyReplaySafety({ name: "read", writes: undefined, external: undefined }),
    { safety: "safe", replayAllowed: true, reason: "read_only" },
    "absent flags are the read-only default, never proof of idempotency",
  );
});

it("read-only is replayable, with the key recorded distinctly", () => {
  for (const name of READ_ONLY_TOOL_NAMES) {
    assert.deepEqual(
      classifyReplaySafety({ name }),
      { safety: "safe", replayAllowed: true, reason: "read_only" },
      name,
    );
    assert.deepEqual(
      classifyReplaySafety({ name, idempotencyKey: "k1" }),
      { safety: "safe", replayAllowed: true, reason: "idempotent_key" },
      name,
    );
    assert.deepEqual(
      classifyReplaySafety({ name, idempotencyKey: "   " }),
      { safety: "safe", replayAllowed: true, reason: "read_only" },
      `${name}: blank is absent, not a key`,
    );
  }
});

it("replayAllowed is true exactly when safety is safe, over the whole table", () => {
  const keys: (string | undefined)[] = [undefined, "", "   ", "k1", "k2", " k3 "];
  let evaluated = 0;
  for (const name of READ_ONLY_TOOL_NAMES)
    for (const writes of [undefined, true])
      for (const external of [undefined, true])
        for (const idempotencyKey of keys) {
          const verdict = classifyReplaySafety({ name, writes, external, idempotencyKey });
          const label = `${name}/writes=${writes}/external=${external}/key=${idempotencyKey}`;
          evaluated += 1;
          assert.equal(verdict.replayAllowed, verdict.safety === "safe", label);
          if (writes === true || external === true) assert.notEqual(verdict.safety, "safe", `${label} is never safe`);
        }
  assert.equal(evaluated, READ_ONLY_TOOL_NAMES.length * 2 * 2 * keys.length, "7 names x writes x external x 6 keys");
  assert.equal(evaluated, 168);
});

it("the classifier is pure and side-effect free", () => {
  const source = readFileSync(new URL("../../src/inference/recoverySafety.ts", import.meta.url), "utf8");
  for (const forbidden of ["import ", "Date.now", "Math.random", "process.env", "setTimeout", "fetch", "writeFile"])
    assert.ok(!source.includes(forbidden), `recoverySafety.ts must not contain ${forbidden}`);
  assert.equal(source.match(/from\s+"/gu), null, "recoverySafety.ts declares no module specifier");
  const action: ToolAction = { name: "symbol", writes: undefined, external: undefined, idempotencyKey: "k1" };
  assert.deepEqual(classifyReplaySafety(action), classifyReplaySafety(action));
  assert.deepEqual(classifyReplaySafety({ name: "tests_for" }), classifyReplaySafety({ name: "tests_for" }));
});
