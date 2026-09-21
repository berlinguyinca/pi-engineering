/**
 * Colouring panel content.
 *
 * The rule the whole module rests on: highlighting may change a line's COLOUR
 * and must never change its TEXT. It is a line-oriented approximation rather
 * than a parser, so it will be wrong sometimes — and a wrong guess must cost a
 * wrong shade, not a corrupted file view.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLineKind, highlightDiffLine, highlightLine, looksLikeDiff } from "../../src/panel/highlight.ts";

/** A theme that marks spans visibly so assertions can be about structure. */
const theme = { fg: (colour: string, text: string) => `<${colour}>${text}</${colour}>` };
const opts = { theme, filename: "x.ts" };

/** The text that survives, with all colour markers removed. */
function plain(out: string): string {
  return out.replace(/<\/?[a-zA-Z]+>/g, "");
}

test("highlight: the text is never altered, only wrapped", () => {
  // The invariant that makes an approximate highlighter safe.
  for (const line of [
    'const x = "hello";',
    "  return 42;",
    "// a comment with return and 42 in it",
    "if (a === b) { throw new Error('boom'); }",
    "",
    "   ",
    "no keywords here at all",
  ]) {
    assert.equal(plain(highlightLine(line, opts)), line, `text changed for: ${line}`);
  }
});

test("highlight: a whole-line comment wins over keywords inside it", () => {
  // Otherwise a comment mentioning `return` renders half keyword-coloured.
  const out = highlightLine("// return this later", opts);
  assert.match(out, /^<syntaxComment>/);
  assert.doesNotMatch(out, /syntaxKeyword/);
});

test("highlight: a keyword inside a string stays a string", () => {
  const out = highlightLine('const s = "return false";', opts);
  assert.match(out, /<syntaxString>"return false"<\/syntaxString>/);
  assert.equal(plain(out), 'const s = "return false";');
});

test("highlight: comment markers follow the file type", () => {
  assert.match(highlightLine("# python comment", { theme, filename: "a.py" }), /syntaxComment/);
  assert.doesNotMatch(highlightLine("# not a comment in ts", { theme, filename: "a.ts" }), /^<syntaxComment>/);
});

test("highlight: numbers and keywords are distinguished", () => {
  const out = highlightLine("const n = 42;", opts);
  assert.match(out, /<syntaxKeyword>const<\/syntaxKeyword>/);
  assert.match(out, /<syntaxNumber>42<\/syntaxNumber>/);
});

test("highlight: a line with nothing to colour is returned unchanged", () => {
  assert.equal(highlightLine("plain prose line", opts), "plain prose line");
});

// ─── Diffs ──────────────────────────────────────────────────────────────────

test("diff: line kinds are read from the first character", () => {
  assert.equal(diffLineKind("+added"), "added");
  assert.equal(diffLineKind("-removed"), "removed");
  assert.equal(diffLineKind("@@ -1,2 +1,3 @@"), "meta");
  assert.equal(diffLineKind("--- a/file.ts"), "meta", "a file header is not a removed line");
  assert.equal(diffLineKind("+++ b/file.ts"), "meta", "nor is it an added line");
  assert.equal(diffLineKind(" context"), "context");
});

test("diff: added and removed lines take one colour for the whole line", () => {
  // "What changed" is the question; a line that is half green from a string
  // literal answers it less clearly.
  const added = highlightDiffLine('+  const s = "x";', opts);
  assert.match(added, /^<toolDiffAdded>/);
  assert.doesNotMatch(added, /syntaxString/);

  assert.match(highlightDiffLine("-  old();", opts), /^<toolDiffRemoved>/);
});

test("diff: context lines still get the syntax pass", () => {
  // Context is where reading happens.
  const out = highlightDiffLine("   const x = 1;", opts);
  assert.match(out, /syntaxKeyword/);
});

test("diff: diff text is never altered either", () => {
  for (const line of ["+added", "-removed", "@@ -1 +1 @@", " context const x = 1;", "--- a/x.ts"]) {
    assert.equal(plain(highlightDiffLine(line, opts)), line);
  }
});

test("diff: unified diff output is recognised, plain files are not", () => {
  assert.equal(looksLikeDiff(["diff --git a/x b/x", "@@ -1 +1 @@"]), true);
  assert.equal(looksLikeDiff(["const x = 1;", "export default x;"]), false);
});
