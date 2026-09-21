/**
 * Line numbers for panel content.
 *
 * A unified diff has two line sequences, and showing the wrong one is worse
 * than showing none: the number is there so the operator can open the file at
 * that point, and a number from the other side sends them to the wrong place.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatGutter,
  gutterWidth,
  numberDiffLines,
  numberFileLines,
  parseHunkHeader,
} from "../../src/panel/gutter.ts";

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -10,4 +40,5 @@ function x() {",
  " const before = 1;",
  "-  const removed = 2;",
  "+  const added = 3;",
  "+  const alsoAdded = 4;",
  " const after = 5;",
];

test("gutter: a hunk header yields both starting lines", () => {
  assert.deepEqual(parseHunkHeader("@@ -10,4 +40,5 @@ function x() {"), { oldStart: 10, newStart: 40 });
  assert.deepEqual(parseHunkHeader("@@ -1 +1 @@"), { oldStart: 1, newStart: 1 });
  assert.equal(parseHunkHeader(" not a hunk"), null);
});

test("gutter: added and context lines carry the NEW file's numbers", () => {
  // That is the file which now exists and the one the operator will open.
  const rows = numberDiffLines(DIFF);
  const byText = (t: string) => rows.find((r) => r.text.includes(t));

  assert.equal(byText("const before")?.lineNo, 40);
  assert.equal(byText("const added")?.lineNo, 41);
  assert.equal(byText("alsoAdded")?.lineNo, 42);
  assert.equal(byText("const after")?.lineNo, 43);
});

test("gutter: a removed line carries the OLD number, since it has no new one", () => {
  const removed = numberDiffLines(DIFF).find((r) => r.kind === "removed");
  assert.equal(removed?.lineNo, 11, "line 10 was context, so the removal is 11 in the old file");
  assert.equal(removed?.sign, "-");
});

test("gutter: the two sequences advance independently", () => {
  // A removal must not push the new-file counter, or every line after a
  // deletion points one line too far.
  const rows = numberDiffLines(["@@ -1,3 +1,2 @@", " keep", "-gone", " tail"]);
  assert.equal(rows.find((r) => r.text === "tail")?.lineNo, 2, "new file: keep=1, tail=2");
});

test("gutter: file and hunk headers get no number", () => {
  for (const row of numberDiffLines(DIFF).filter((r) => r.kind === "meta")) {
    assert.equal(row.lineNo, undefined, `${row.text} should not be numbered`);
  }
});

test("gutter: the diff marker is stripped from the text", () => {
  // The sign moves to the gutter; leaving it in the content shows it twice.
  const rows = numberDiffLines(DIFF);
  assert.equal(rows.find((r) => r.kind === "added")?.text, "  const added = 3;");
  assert.equal(rows.find((r) => r.kind === "removed")?.text, "  const removed = 2;");
});

test("gutter: a plain file is numbered from one", () => {
  const rows = numberFileLines(["a", "b", "c"]);
  assert.deepEqual(
    rows.map((r) => r.lineNo),
    [1, 2, 3],
  );
  assert.ok(rows.every((r) => r.kind === "context"));
});

test("gutter: width follows the widest number present", () => {
  assert.equal(gutterWidth(numberFileLines(Array.from({ length: 9 }, () => "x"))), 4, "1 digit + space + sign + space");
  assert.equal(gutterWidth(numberFileLines(Array.from({ length: 120 }, () => "x"))), 6, "3 digits");
  assert.equal(gutterWidth([{ sign: "", text: "meta", kind: "meta" }]), 0, "nothing numbered needs no column");
});

test("gutter: numbers are right-aligned so the content edge stays straight", () => {
  const rows = numberFileLines(Array.from({ length: 100 }, () => "x"));
  const w = gutterWidth(rows);
  assert.equal(formatGutter(rows[0] as never, w), "  1   ");
  assert.equal(formatGutter(rows[99] as never, w), "100   ");
});

test("gutter: a meta row still occupies the column, so content stays aligned", () => {
  const rows = numberDiffLines(DIFF);
  const w = gutterWidth(rows);
  const meta = rows.find((r) => r.kind === "meta") as never;
  assert.equal(formatGutter(meta, w).length, w, "an unnumbered row is blank, not absent");
});
