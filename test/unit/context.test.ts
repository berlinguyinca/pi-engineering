import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextBroker, estimateTokens } from "../../src/context/ContextBroker.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("token estimation is deterministic", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens(""), 0);
});

test("context broker assembles a bounded package from a repo", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = await ContextBroker.open(fixture.root);
    assert.ok(broker, "broker should open in a git repo");
    const pkg = await broker.assembleContext("implement add function", 4000, ["src/add.js"]);
    assert.ok(pkg.totalTokens <= 4000, `total ${pkg.totalTokens} exceeds budget`);
    assert.ok(pkg.items.some((i) => i.kind === "file" && i.path === "src/add.js"));
    const hits = await broker.search("export function add");
    assert.ok(hits.length >= 1);
    const tests = await broker.testsFor(["add"]);
    assert.ok(tests.some((t) => t.includes("add.test.js")));
  } finally {
    await fixture.cleanup();
  }
});
