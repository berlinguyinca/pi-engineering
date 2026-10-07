import assert from "node:assert/strict";
import { test } from "node:test";
import { newMissionId } from "../../src/plannerWorker/extension.ts";

test("planner-worker mission ids started in the same second never collide", () => {
  const at = new Date("2026-10-06T12:34:56.789Z");
  const ids = new Set(Array.from({ length: 200 }, () => newMissionId(at)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^PW-20261006123456-[0-9a-f]{6}$/);
});
