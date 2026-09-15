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

test("narrative: over-long output is cut at a sentence, not mid-word", () => {
  // The first live run returned exactly 400 characters ending "in the midst of
  // th…", which reads as a panel bug rather than a long answer.
  const a = "We began work on the gateway wait so a saturated gateway stops killing the interactive turn. ";
  const b = "Then we moved to verifying the implementation across the admission controller and the pump. ";
  const c = "We are currently in the midst of recording evidence for the release gate and it runs long.";
  const clean = sanitizeNarrative(a + b + c, 200);

  assert.ok(clean);
  assert.doesNotMatch(clean, /…$/, "a sentence boundary was available");
  assert.match(clean, /\.$/, "it ends on a full stop");
  assert.ok(clean.length <= 200);
});

test("narrative: a run-on with no usable boundary still gets bounded", () => {
  const runOn = `${"word ".repeat(200)}end`;
  const clean = sanitizeNarrative(runOn, 120);

  assert.ok(clean);
  assert.equal(clean.length, 120);
  assert.match(clean, /…$/, "no sentence boundary exists, so the character cut stands");
});

test("narrative: an early first sentence does not swallow the whole answer", () => {
  // "Ok." followed by the real content must not become the narrative.
  const text = `Ok. ${"detail ".repeat(60)}`;
  const clean = sanitizeNarrative(text, 200);

  assert.ok(clean);
  assert.notEqual(clean, "Ok.", "a five-character first sentence is not a summary");
  assert.ok(clean.length > 100);
});
