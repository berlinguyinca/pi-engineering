import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNarrativePrompt, computeDeltas, sanitizeNarrative } from "../../src/panel/narrator/deltas.ts";

test("deltas: a first observation is entirely new", () => {
  const d = computeDeltas(undefined, { workItemId: "WI-1", goal: "add a status bar", phase: "scout", files: [] });
  assert.ok(d.length > 0);
  assert.ok(d.some((x) => x.kind === "work-item"));
});

test("deltas: an unchanged observation produces nothing to say", () => {
  const input = { workItemId: "WI-1", goal: "add a status bar", phase: "scout", files: ["a.ts"] };
  assert.deepEqual(computeDeltas(input, { ...input, files: ["a.ts"] }), []);
});

test("deltas: a phase transition is a delta", () => {
  const before = { workItemId: "WI-1", goal: "g", phase: "scout", files: [] };
  const d = computeDeltas(before, { ...before, phase: "implement" });
  assert.equal(d.length, 1);
  assert.equal(d[0]?.kind, "phase");
  assert.match(d[0]?.text ?? "", /implement/);
});

test("deltas: a new work item is a delta even when the phase is unchanged", () => {
  const before = { workItemId: "WI-1", goal: "first goal", phase: "scout", files: [] };
  const d = computeDeltas(before, { ...before, workItemId: "WI-2", goal: "second goal" });
  assert.ok(d.some((x) => x.kind === "work-item"));
  assert.match(d.map((x) => x.text).join(" "), /second goal/);
});

test("deltas: only newly changed files are reported, not the whole set", () => {
  const before = { workItemId: "WI-1", goal: "g", phase: "implement", files: ["a.ts", "b.ts"] };
  const d = computeDeltas(before, { ...before, files: ["a.ts", "b.ts", "c.ts"] });
  const text = d.map((x) => x.text).join(" ");
  assert.match(text, /c\.ts/);
  assert.doesNotMatch(text, /b\.ts/, "a file already reported is not news");
});

test("deltas: a file list that only lost entries is not news", () => {
  const before = { workItemId: "WI-1", goal: "g", phase: "implement", files: ["a.ts", "b.ts"] };
  assert.deepEqual(computeDeltas(before, { ...before, files: ["a.ts"] }), []);
});

test("deltas: the file delta is bounded rather than listing hundreds of paths", () => {
  const files = Array.from({ length: 300 }, (_, i) => `src/file-${i}.ts`);
  const d = computeDeltas(
    { workItemId: "WI-1", goal: "g", phase: "implement", files: [] },
    {
      workItemId: "WI-1",
      goal: "g",
      phase: "implement",
      files,
    },
  );
  const text = d.map((x) => x.text).join(" ");
  assert.ok(text.length < 600, `file delta too large: ${text.length}`);
});

test("deltas: the prompt carries the deltas and the previous narrative", () => {
  const prompt = buildNarrativePrompt(
    [{ kind: "phase", text: "moved to implement" }],
    "started on a status bar update",
  );
  assert.match(prompt, /moved to implement/);
  assert.match(prompt, /started on a status bar update/);
});

test("deltas: the prompt never carries file contents or a transcript", () => {
  // The narrator is fed deltas, not transcripts — this is the cost control.
  const prompt = buildNarrativePrompt([{ kind: "files", text: "changed src/a.ts" }], undefined);
  assert.ok(prompt.length < 2000, `prompt too large: ${prompt.length}`);
});

test("sanitize: whitespace is trimmed and the result bounded", () => {
  assert.equal(sanitizeNarrative("  we did a thing.  "), "we did a thing.");
  assert.equal((sanitizeNarrative("x".repeat(5000)) ?? "").length <= 400, true);
});

test("sanitize: empty or whitespace-only output is unusable", () => {
  assert.equal(sanitizeNarrative(""), undefined);
  assert.equal(sanitizeNarrative("   \n  "), undefined);
});

test("sanitize: newlines are collapsed so the tab stays a short prose arc", () => {
  assert.equal(sanitizeNarrative("first line\n\nsecond line"), "first line second line");
});
