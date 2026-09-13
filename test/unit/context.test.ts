import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ContextBroker, estimateTokens } from "../../src/context/ContextBroker.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

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

test("flagship goal with punctuation yields a non-empty context package (review HIGH F2)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = (await ContextBroker.open(fixture.root))!;
    // 'add(a, b)' must yield the keyword 'add' (punctuation stripped), so the
    // package is not empty and the relevant file is ranked in.
    const pkg = await broker.assembleContext("Implement add(a, b) to return a + b", 4000, []);
    assert.ok(pkg.items.length > 0, "punctuated goal should produce a non-empty package");
    assert.ok(pkg.items.some((i) => i.path === "src/add.js"), "relevant src/add.js should be included");
    assert.ok(pkg.totalTokens <= 4000);
  } finally {
    await fixture.cleanup();
  }
});

test("oversized required file is truncated, not silently dropped (review MED F3)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await writeFile(join(fixture.root, "big.txt"), "x".repeat(8000));
    const broker = (await ContextBroker.open(fixture.root))!;
    const pkg = await broker.assembleContext("implement add", 400, ["big.txt"]);
    const big = pkg.items.find((i) => i.path === "big.txt");
    assert.ok(big, "required big.txt must be present (truncated), not silently dropped");
    assert.equal(big.truncated, true);
    assert.ok(pkg.totalTokens <= 400, "package must stay within budget");
  } finally {
    await fixture.cleanup();
  }
});

test("repoMap matches ignore tokens against path segments, not substrings (review MED F4)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    // 'distribution' merely contains the ignore token 'dist'; it must survive.
    await writeFile(join(fixture.root, "src", "distribution.ts"), "export const x = 1;\n");
    await mkdir(join(fixture.root, "src", "dist"), { recursive: true });
    await writeFile(join(fixture.root, "src", "dist", "bundle.js"), "// ignored\n");
    await exec("git", ["-C", fixture.root, "add", "-A"]);
    await exec("git", ["-C", fixture.root, "commit", "-qm", "add files"]);
    const broker = (await ContextBroker.open(fixture.root))!;
    const map = await broker.repoMap(200);
    assert.ok(map.includes("src/distribution.ts"), "distribution.ts must not be dropped by the 'dist' ignore token");
    assert.ok(!map.includes("src/dist/bundle.js"), "a real dist/ directory must still be ignored");
  } finally {
    await fixture.cleanup();
  }
});

test("rankFiles ranks goal-relevant files first (milestone)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = (await ContextBroker.open(fixture.root))!;
    const ranked = await broker.rankFiles(["add"], 10);
    assert.ok(ranked.includes("src/add.js"), "src/add.js should rank as relevant to 'add'");
    assert.ok(ranked.includes("test/add.test.js"), "test/add.test.js should rank as relevant to 'add'");
    assert.equal(ranked[0], "src/add.js", "path match should rank first");
  } finally {
    await fixture.cleanup();
  }
});

test("assembleContext includes content of relevant files, not only symbol one-liners (milestone)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = (await ContextBroker.open(fixture.root))!;
    const pkg = await broker.assembleContext("implement add function", 4000, []);
    // The relevant src/add.js should appear as a file item with real content.
    const addFile = pkg.items.find((i) => i.kind === "file" && i.path === "src/add.js");
    assert.ok(addFile, "relevant file content should be included as a file item");
    assert.ok((addFile!.summary as string).includes("export function add"), "file item should carry content, not just a symbol line");
  } finally {
    await fixture.cleanup();
  }
});

test("searchAny matches any of several literal keywords (review HIGH: join('|') was escaped as a literal)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const broker = (await ContextBroker.open(fixture.root))!;
    // Multi-keyword: a file matching ANY keyword must be found (not the literal
    // text 'add|sum' which exists nowhere).
    const hits = await broker.searchAny(["add", "sum"]);
    assert.ok(hits.some((h) => h.path === "src/add.js"), "searchAny must find add.js for keyword 'add'");
    const literal = await broker.search("add|sum");
    assert.equal(literal.length, 0, "single search() must treat 'add|sum' as literal text (no matches)");
    assert.equal((await broker.searchAny([])).length, 0, "empty keywords yield no hits");
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
