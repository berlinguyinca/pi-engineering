import assert from "node:assert/strict";
import { test } from "node:test";
import { SUMMARY_WORD_CAP, latestUserRequest, summaryInstructions } from "../../src/compaction/summaryInstructions.ts";

const entries = [
  { type: "message", message: { role: "user", content: "Build the CSV importer." } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done: importer." }] } },
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "New spec: replace CSV with Parquet export." }] },
  },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } },
  { type: "compaction", summary: "old" },
];

test("finds the latest user request in string or part-array content", () => {
  assert.equal(latestUserRequest(entries), "New spec: replace CSV with Parquet export.");
  assert.equal(latestUserRequest([]), undefined);
});

test("instructions anchor the Goal on the latest request, drop completed goals, cap size, keep caller focus", () => {
  const text = summaryInstructions(entries, "Focus on the database layer.");
  assert.match(text, /Goal/);
  assert.match(text, /New spec: replace CSV with Parquet export\./);
  assert.match(text, /supersede/i);
  assert.match(text, /completed goals/i);
  assert.match(text, new RegExp(String(SUMMARY_WORD_CAP)));
  assert.match(text, /Focus on the database layer\./);
});

test("a very long latest request is clipped", () => {
  const long = "spec ".repeat(5_000);
  const text = summaryInstructions([{ type: "message", message: { role: "user", content: long } }], undefined);
  assert.ok(text.length < 6_000, `instructions stay bounded (${text.length})`);
});
