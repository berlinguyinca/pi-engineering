/**
 * Wrapping the narrative pane.
 *
 * The tree truncates single lines; a narrative is a paragraph, and truncating
 * it to one line throws away most of what it says.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wrapTail, wrapText } from "../../src/panel/wrap.ts";

test("wrap: no line exceeds the column", () => {
  const text = "We started on the gateway wait, moved to the panel, and are now recording evidence.";
  for (const width of [10, 20, 37, 80]) {
    for (const line of wrapText(text, width)) {
      assert.ok(line.length <= width, `"${line}" exceeds ${width}`);
    }
  }
});

test("wrap: every word survives, in order", () => {
  // Wrapping may change where lines break and nothing else.
  const text = "alpha beta gamma delta epsilon zeta eta theta";
  assert.equal(wrapText(text, 12).join(" "), text);
});

test("wrap: a word longer than the column is broken rather than overflowing", () => {
  const long = "supercalifragilisticexpialidocious";
  const lines = wrapText(`x ${long} y`, 10);
  assert.ok(lines.every((l) => l.length <= 10));
  assert.equal(lines.join("").replace(/ /g, ""), `x${long}y`, "no characters lost to the break");
});

test("wrap: an over-long word after a line break is still broken", () => {
  // The case where the word is re-handled against an empty line.
  const lines = wrapText("short averyveryverylongtokenindeed", 8);
  assert.ok(lines.every((l) => l.length <= 8));
});

test("wrap: whitespace is normalised, not preserved", () => {
  assert.deepEqual(wrapText("  a\n\n  b   c  ", 20), ["a b c"]);
});

test("wrap: empty input produces no lines rather than one blank", () => {
  assert.deepEqual(wrapText("", 20), []);
  assert.deepEqual(wrapText("   ", 20), []);
  assert.deepEqual(wrapText("anything", 0), []);
});

test("wrap: the tail keeps the END of a narrative", () => {
  // The end is the current state of the work; the beginning is where it
  // started. In a pane too small for both, the end is what is needed.
  const text = "one two three four five six seven eight nine ten";
  const tail = wrapTail(text, 10, 2);
  assert.equal(tail.length, 2);
  assert.ok(tail.join(" ").includes("ten"), "the most recent words must survive");
  assert.ok(!tail.join(" ").includes("one"), "the oldest are the ones dropped");
});

test("wrap: a tail larger than the text returns all of it", () => {
  assert.deepEqual(wrapTail("a b c", 20, 10), ["a b c"]);
  assert.deepEqual(wrapTail("a b c", 20, 0), []);
});

test("wrap: a wide character costs two columns, not one", () => {
  // The wrapper measured UTF-16 units, which is the same number as columns for
  // ASCII and wrong for everything else. The narrative is model-generated
  // prose, so it is exactly the text most likely to carry CJK or emoji, and a
  // review proved a 50-character CJK line rendering 102 columns wide in a
  // 60-column pane — not merely ugly, it corrupts the frame around it.
  for (const width of [2, 5, 20, 40, 60]) {
    for (const text of ["漢".repeat(50), "😀".repeat(30), `mixed 漢字 and ${"😀".repeat(5)} text`.repeat(4)]) {
      for (const line of wrapText(text, width)) {
        assert.ok(visibleWidth(line) <= width, `"${line}" exceeds ${width} (${visibleWidth(line)} cols)`);
      }
    }
  }
});

test("wrap: breaking a wide word never splits a character in half", () => {
  // Slicing by UTF-16 index cuts a surrogate pair into two invalid halves,
  // which a terminal renders as replacement characters.
  for (const line of wrapText("😀".repeat(20), 7)) {
    assert.ok(!line.includes("�"), "no replacement characters");
    assert.equal(
      [...line].every((c) => c === "😀"),
      true,
      "every emoji survived whole",
    );
  }
});

test("wrap: an odd column cannot fit half a wide character, and does not pretend to", () => {
  const lines = wrapText("漢".repeat(6), 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 3);
  assert.equal(lines.join(""), "漢".repeat(6), "and nothing is lost to the rounding");
});

test("wrap: a character wider than the whole column terminates rather than looping", () => {
  // Width 1 cannot hold a 2-column character. The wrapper must make progress
  // and stop, not spin trying to place something that can never fit.
  const lines = wrapText("漢漢漢", 1);
  assert.ok(Array.isArray(lines));
  for (const line of lines) assert.ok(visibleWidth(line) <= 1);
});

test("wrap: ASCII wrapping is unchanged", () => {
  assert.deepEqual(wrapText("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(wrapText("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
});
