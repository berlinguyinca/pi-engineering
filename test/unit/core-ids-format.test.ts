import assert from "node:assert/strict";
import { test } from "node:test";
import {
  id,
  newArtifactId,
  newCandidateId,
  newContextPackageId,
  newEntityId,
  newEventId,
  newEvidenceId,
  newRunId,
  newTaskId,
  newWorkItemId,
} from "../../src/core/ids.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Assert that `value` is `<prefix>-` followed by exactly 6 base62 characters. */
function assertPrefixedBase62(prefix: string, value: string): void {
  const [head, suffix] = value.split("-");
  assert.equal(head, prefix, `expected prefix ${prefix}, got ${value}`);
  assert.equal(suffix?.length, 6, `expected 6-char suffix, got ${value}`);
  for (const ch of suffix) {
    assert.ok(BASE62.includes(ch), `non-base62 character ${ch} in ${value}`);
  }
}

test("id() produces prefix + exactly 6 base62 characters", () => {
  for (const prefix of ["MSN", "TSK", "EXC", "WI", "CAND"]) {
    const value = id(prefix);
    assertPrefixedBase62(prefix, value);
  }
});

test("two consecutive ids differ", () => {
  const a = id("WI");
  const b = id("WI");
  assert.notEqual(a, b);
});

test("typed id factories carry their documented prefixes", () => {
  const factories: Array<[string, () => string]> = [
    ["evt", newEventId],
    ["WI", newWorkItemId],
    ["CAND", newCandidateId],
    ["TASK", newTaskId],
    ["EVID", newEvidenceId],
    ["ART", newArtifactId],
    ["RUN", newRunId],
    ["CTX", newContextPackageId],
  ];
  for (const [prefix, factory] of factories) {
    assertPrefixedBase62(prefix, factory());
  }
});

test("newEntityId upper-cases the kind prefix", () => {
  assertPrefixedBase62("MSN", newEntityId("msn"));
  assertPrefixedBase62("TSK", newEntityId("tsk"));
});

test("two consecutive typed ids differ", () => {
  assert.notEqual(newWorkItemId(), newWorkItemId());
  assert.notEqual(newTaskId(), newTaskId());
  assert.notEqual(newRunId(), newRunId());
});
