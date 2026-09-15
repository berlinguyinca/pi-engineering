import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_CONTENT_LINES, readDiffContent, readFileContent, toContentView } from "../../src/panel/content.ts";

test("content: a short body is returned whole and untruncated", () => {
  const view = toContentView("a.ts", "one\ntwo\n");
  assert.deepEqual(view.lines, ["one", "two"]);
  assert.equal(view.truncated, false);
  assert.equal(view.title, "a.ts");
});

test("content: a long body is capped and marked truncated", () => {
  const body = Array.from({ length: MAX_CONTENT_LINES + 500 }, (_, i) => `line ${i}`).join("\n");
  const view = toContentView("big.ts", body);
  assert.equal(view.lines.length, MAX_CONTENT_LINES);
  assert.equal(view.truncated, true);
});

test("content: an empty body is not an error", () => {
  const view = toContentView("empty.ts", "");
  assert.deepEqual(view.lines, []);
  assert.equal(view.error, undefined);
});

test("content: reads a working-tree file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-content-"));
  try {
    const p = join(dir, "a.ts");
    await writeFile(p, "export const a = 1;\n");
    const view = await readFileContent(p, "a.ts");
    assert.deepEqual(view.lines, ["export const a = 1;"]);
    assert.equal(view.error, undefined);
    assert.equal(view.title, "a.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content: a missing file reports an error instead of throwing", async () => {
  const view = await readFileContent("/nonexistent/nope.ts");
  assert.ok(view.error, "expected an error");
  assert.deepEqual(view.lines, []);
});

test("content: an oversized file is truncated rather than loaded whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-content-big-"));
  try {
    const p = join(dir, "big.log");
    // Comfortably past the byte cap.
    await writeFile(p, "x".repeat(400 * 1024));
    const view = await readFileContent(p);
    assert.equal(view.truncated, true);
    assert.equal(view.error, undefined, "a big file is truncated, not an error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content: reads a candidate diff through the artifact store by URI", async () => {
  const artifacts = { readContentByUri: async () => "diff --git a/x b/x\n+added\n" };
  const view = await readDiffContent(artifacts, "artifact://diffs/CAND-3");
  assert.match(view.lines.join("\n"), /\+added/);
  assert.equal(view.error, undefined);
});

test("content: a missing artifact reports an error rather than an empty view", async () => {
  const artifacts = { readContentByUri: async () => undefined };
  const view = await readDiffContent(artifacts, "artifact://diffs/CAND-3");
  assert.ok(view.error, "a missing artifact must be reported");
});

test("content: an unreadable artifact reports an error", async () => {
  const artifacts = {
    readContentByUri: async () => {
      throw new Error("artifact gone");
    },
  };
  const view = await readDiffContent(artifacts, "artifact://diffs/CAND-3");
  assert.match(view.error ?? "", /artifact gone/);
});
