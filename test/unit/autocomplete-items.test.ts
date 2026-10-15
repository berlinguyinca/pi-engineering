import assert from "node:assert/strict";
import { test } from "node:test";
import { toAutocompleteItems } from "../../src/runtime/host/completions.ts";

test("bare strings become items with a string value and label (issue #254)", () => {
  assert.deepEqual(toAutocompleteItems(["version", "verbose"]), [
    { value: "version", label: "version" },
    { value: "verbose", label: "verbose" },
  ]);
});

test("item objects pass through unchanged", () => {
  const item = { value: "status", label: "status", description: "show status" };
  const out = toAutocompleteItems([item]);
  assert.equal(out?.[0], item);
});

test("null, empty, non-array and value-less entries yield null or are dropped", () => {
  assert.equal(toAutocompleteItems(null), null);
  assert.equal(toAutocompleteItems(undefined), null);
  assert.equal(toAutocompleteItems([]), null);
  assert.equal(toAutocompleteItems("version"), null);
  assert.equal(toAutocompleteItems([{ label: "x" }, 3]), null);
  assert.deepEqual(toAutocompleteItems([{ label: "x" }, "ok"]), [{ value: "ok", label: "ok" }]);
});
