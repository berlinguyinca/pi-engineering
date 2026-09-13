import assert from "node:assert/strict";
import { test } from "node:test";
import { id, newCandidateId, newWorkItemId } from "../../src/core/ids.ts";

test("ids are unique and prefixed", () => {
  const a = id("WI");
  const b = id("WI");
  assert.notEqual(a, b);
  assert.match(a, /^WI-[A-Za-z0-9]{6}$/);
});

test("typed id factories produce expected prefixes", () => {
  assert.match(newWorkItemId(), /^WI-/);
  assert.match(newCandidateId(), /^CAND-/);
});
