import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as api from "../../src/index.ts";

// Value exports of src/index.ts on origin/main@67bf054c — a snapshot, so new
// names must not be added here (adding exports is fine; losing one is what this
// test guards). Losing a name means listing it in REMOVED, never deleting it from
// the fixture, which would silence the guard for everyone after you.
const REMOVED = new Set([
  "BudgetManager",
  "DEFAULT_BUDGETS",
  // OpenViking was retired as the durable backend. Pi now reaches Hindsight only
  // through the herdr-memory client (`HindsightDurableMemory`), which cannot talk
  // to a URL, so the old class is gone rather than aliased to a new name.
  "OpenVikingProvider",
]);

test("src/index.ts keeps every public value export (except the deliberately removed ones)", () => {
  const expected = readFileSync(new URL("../fixtures/public-exports.txt", import.meta.url), "utf8")
    .split(/\s+/)
    .filter((n) => n && !REMOVED.has(n));
  assert.ok(expected.length > 500);
  assert.deepEqual(
    expected.filter((n) => !(n in api)),
    [],
    "exports lost from src/index.ts",
  );
});
