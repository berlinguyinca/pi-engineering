import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ContextBroker, goalKeywords } from "../../src/context/ContextBroker.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";
const exec = promisify(execFile);

test("goalKeywords filters stopwords, weights distinctive tokens, orders deterministically, stays bounded", () => {
  const prose = ["Bluetooth", "flow", "settings", "screen", "pairing"]; // never 'the' / 'in' / 'fix'
  assert.deepEqual(goalKeywords("Fix the Bluetooth pairing flow in the settings screen"), prose);
  const ids = "refactor the max_attempts field in SettingsRouter over HTTP via config.json";
  const shapes = ["SettingsRouter", "HTTP", "config.json", "max_attempts", "refactor", "field"]; // code > prose
  assert.deepEqual(goalKeywords(ids), shapes);
  assert.deepEqual(goalKeywords("add support for the settings page"), ["settings", "page", "support"], "tail > head");
  const tail = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  assert.deepEqual(goalKeywords(tail), ["zeta", "eta", "theta", "iota", "kappa", "alpha"], "score then first seen");
  assert.deepEqual(goalKeywords(tail, 3), ["zeta", "eta", "theta"], "bounded by limit");
  assert.deepEqual(goalKeywords("settings panel settings dialog"), ["settings", "dialog", "panel"], "de-duplicated");
  assert.deepEqual(goalKeywords("Implement add(a, b) to return a + b"), ["add", "Implement"], "glue words dropped");
  assert.deepEqual(goalKeywords("the and of"), ["the"], "an all-stopword goal keeps its first raw token");
});

test("rankFiles tie-breaks score, then test path, then length, then lexicographic path", async () => {
  const fixture = await makeFixtureRepo();
  try {
    for (const n of ["aaa.js", "bbb.js"]) await writeFile(join(fixture.root, "src", n), "");
    await exec("git", ["-C", fixture.root, "add", "-A"]);
    const broker = (await ContextBroker.open(fixture.root))!;
    assert.deepEqual((await broker.rankFiles(["src"], 10)).slice(0, 3), ["src/aaa.js", "src/add.js", "src/bbb.js"]);
  } finally {
    await fixture.cleanup();
  }
});
