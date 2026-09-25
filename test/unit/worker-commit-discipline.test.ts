import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "../../src/workers/prompts.ts";

// Only a worker's own commits are recovered after a wall-clock timeout, so the
// roles that edit the repository must be told to commit as they go.
const MUTATING = ["implementer", "debugger", "test-generator", "clean-room-challenger"] as const;

test("mutating roles are told to commit after every coherent unit", () => {
  for (const role of MUTATING) {
    const prompt = buildSystemPrompt(role, "change the widget");
    assert.match(prompt, /Commit discipline/, role);
    assert.match(prompt, /Only your own commits survive/, role);
  }
});

test("read-only roles get no commit instruction", () => {
  const prompt = buildSystemPrompt("reviewer", "review the widget");
  assert.doesNotMatch(prompt, /Commit discipline/);
});
