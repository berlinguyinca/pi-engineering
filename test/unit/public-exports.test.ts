import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as api from "../../src/index.ts";

// Value exports of src/index.ts on origin/main@67bf054c, minus the deliberately
// removed BudgetManager. Adding exports is fine; losing one must be deliberate.
const REMOVED = new Set(["BudgetManager", "DEFAULT_BUDGETS"]);

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
