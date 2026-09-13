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

test("search treats goal keywords as literals, not regex (review MED #4)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = (await ContextBroker.open(fixture.root))!;
    // 'add(' contains a regex metacharacter. It must be searched literally and
    // must not be swallowed as an empty result set due to a git-grep regex error.
    const hits = await broker.search("add(");
    assert.ok(hits.length >= 1, `literal search for 'add(' should match, got ${hits.length}`);
    // A goal whose keywords contain parens should still assemble context.
    const pkg = await broker.assembleContext("implement add(a,b)", 4000, []);
    assert.ok(pkg.totalTokens >= 0);
  } finally {
    await fixture.cleanup();
  }
});

test("readSlice refuses paths that escape the repo root (path-traversal safety)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = await ContextBroker.open(fixture.root);
    assert.ok(broker);
    // In-repo slice works.
    assert.ok((await broker.readSlice("src/add.js", 0, 3))?.includes("add"));
    // Escape attempts return null.
    assert.equal(await broker.readSlice("../../etc/passwd", 0, 5), null);
    assert.equal(await broker.readSlice("/etc/passwd", 0, 5), null);
  } finally {
    await fixture.cleanup();
  }
});
