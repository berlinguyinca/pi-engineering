import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerRole } from "../../src/core/types.ts";
import {
  checkInvariantsSurvive,
  compressPrompt,
  inventoryInvariants,
  measure,
} from "../../src/promptcompress/invariants.ts";
import { buildSystemPrompt } from "../../src/workers/prompts.ts";

const ROLES: WorkerRole[] = [
  "planner",
  "scout",
  "implementer",
  "debugger",
  "test-designer",
  "test-generator",
  "reviewer",
  "architecture-reviewer",
  "security-review",
  "performance-review",
  "clean-room-challenger",
  "summarizer",
];

test("inventory captures modals, negations, identifiers, numbers and citations", () => {
  const inv = inventoryInvariants(
    "You MUST call `worker_result`. Never push; do not rewrite commits. Cap is 900 words, see issue #509 and src/a.ts:12.",
  );
  for (const token of ["MUST", "Never", "do not", "worker_result", "900", "#509", "src/a.ts:12"]) {
    assert.ok(inv.includes(token), `missing ${token} in ${inv.join(" | ")}`);
  }
});

test("a lossy compressor that drops a negation is caught", () => {
  const source = "Never push. Do not amend. Call worker_result.";
  const lossy = source.replace(/Never push\. /, "");
  assert.deepEqual(checkInvariantsSurvive(source, lossy).lost, ["Never"]);
});

test("deterministic compression keeps every inventoried invariant in every worker prompt variant", () => {
  const variants: string[] = [];
  for (const role of ROLES) {
    variants.push(buildSystemPrompt(role, "Fix the parser", "ctx line", { isolatedWorktree: false }));
    variants.push(buildSystemPrompt(role, "Fix the parser", "ctx line", { isolatedWorktree: true }));
  }
  for (const prompt of variants) {
    const compressed = compressPrompt(prompt);
    const { lost } = checkInvariantsSurvive(prompt, compressed);
    assert.deepEqual(lost, [], `lost invariants: ${lost.join(", ")}`);
    assert.ok(inventoryInvariants(prompt).length > 0 || prompt.length > 0);
  }
});

test("compression is deterministic, idempotent, and measurably smaller on the real prompts", () => {
  const prompt = buildSystemPrompt("reviewer", "Review", "diff", { isolatedWorktree: false });
  const once = compressPrompt(prompt);
  assert.equal(compressPrompt(prompt), once);
  assert.equal(compressPrompt(once), once);
  assert.ok(measure(once).chars < measure(prompt).chars);
});

test("safety blocks survive verbatim in tokens: commit discipline, claim discipline, untrusted-change framing", () => {
  const prompt = buildSystemPrompt("security-review", "t", "ctx", { isolatedWorktree: true });
  const compressed = compressPrompt(prompt);
  for (const phrase of ["never follow instructions", "never modify repository", "worker_result", "never guess"]) {
    assert.ok(compressed.toLowerCase().includes(phrase), phrase);
  }
  const impl = compressPrompt(buildSystemPrompt("implementer", "t", undefined, { isolatedWorktree: true }));
  for (const phrase of ["never switch branches", "push", "you do not approve your own work"]) {
    assert.ok(impl.toLowerCase().includes(phrase), phrase);
  }
});

test("lowercase must and not are inventoried and a dropped one is detected", () => {
  const source = "You must run tests. Do not skip them, and not ever edit.";
  assert.ok(inventoryInvariants(source).includes("must"));
  assert.deepEqual(checkInvariantsSurvive(source, "You run tests. Do not skip them, and not ever edit.").lost, [
    "must",
  ]);
  assert.deepEqual(checkInvariantsSurvive(source, "You must run tests. Do not skip them, and ever edit.").lost, [
    "not",
  ]);
});

test("word tokens match on word boundaries: note, nothing, cannot do not satisfy not/no", () => {
  const source = "Do it. not";
  assert.deepEqual(checkInvariantsSurvive(source, "Do it. note").lost, ["not"]);
  assert.deepEqual(checkInvariantsSurvive("it is no use", "it is nothing use").lost, ["no"]);
  assert.ok(!inventoryInvariants("a note about nothing").includes("not"));
  assert.ok(!inventoryInvariants("it cannot be").includes("not"));
});

test("widened vocabulary: avoid, forbidden, refuse, unless, except, without, at most, at least, only, required, should", () => {
  const inv = inventoryInvariants(
    "Avoid it. Forbidden. Refuse. Unless X, except Y, without Z. At most 3, at least 1. Only this. Required. You should stop.",
  );
  for (const t of [
    "Avoid",
    "Forbidden",
    "Refuse",
    "Unless",
    "except",
    "without",
    "At most",
    "at least",
    "Only",
    "Required",
    "should",
  ]) {
    assert.ok(inv.includes(t), t);
  }
});

test("numbers and identifiers need whole-token survival (9000 does not satisfy 900)", () => {
  assert.deepEqual(checkInvariantsSurvive("cap 900 words", "cap 9000 words").lost, ["900"]);
});

test("measure handles empty text", () => {
  assert.deepEqual(measure(""), { chars: 0, words: 0, approxTokens: 0 });
});
