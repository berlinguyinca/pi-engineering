import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAcceptanceResults } from "../../src/orchestration/evidence.ts";

const ALLOWED = ["AC-1", "AC-2", "AC_3"];

test("strict mode (store replay) still rejects unknown and duplicate IDs", () => {
  assert.throws(() => validateAcceptanceResults([{ acceptanceId: "AC-9", status: "passed", detail: "x" }], ALLOWED));
  assert.throws(() =>
    validateAcceptanceResults(
      [
        { acceptanceId: "AC-1", status: "passed", detail: "x" },
        { acceptanceId: "AC-1", status: "passed", detail: "y" },
      ],
      ALLOWED,
    ),
  );
});

test("tolerant mode matches IDs case- and punctuation-insensitively and returns the canonical ID", () => {
  const warnings: string[] = [];
  const results = validateAcceptanceResults(
    [
      { acceptanceId: " ac 1 ", status: "passed", detail: "ok" },
      { acceptanceId: "ac2", status: "failed", detail: "nope" },
      { acceptanceId: "ac-3", status: "passed", detail: "ok" },
    ],
    ALLOWED,
    { tolerant: true, warnings },
  );
  assert.deepEqual(
    results.map((r) => [r.acceptanceId, r.status]),
    [
      ["AC-1", "passed"],
      ["AC-2", "failed"],
      ["AC_3", "passed"],
    ],
  );
  assert.deepEqual(warnings, []);
});

test("tolerant mode keeps the first duplicate, drops unknown IDs with a warning, and fails omitted IDs", () => {
  const warnings: string[] = [];
  const results = validateAcceptanceResults(
    [
      { acceptanceId: "AC-1", status: "passed", detail: "first" },
      { acceptanceId: "ac-1", status: "failed", detail: "second" },
      { acceptanceId: "AC-99", status: "passed", detail: "invented" },
    ],
    ALLOWED,
    { tolerant: true, warnings },
  );
  assert.deepEqual(results, [
    { acceptanceId: "AC-1", status: "passed", detail: "first" },
    { acceptanceId: "AC-2", status: "failed", detail: "not reported by reviewer" },
    { acceptanceId: "AC_3", status: "failed", detail: "not reported by reviewer" },
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /AC-99/);
  assert.match(warnings.join("\n"), /duplicate/i);
});

test("tolerant mode treats a missing array as all-omitted and drops malformed entries", () => {
  const warnings: string[] = [];
  const results = validateAcceptanceResults(undefined, ["AC-1"], { tolerant: true, warnings });
  assert.deepEqual(results, [{ acceptanceId: "AC-1", status: "failed", detail: "not reported by reviewer" }]);
  const dropped = validateAcceptanceResults([null, { acceptanceId: "AC-1", status: "maybe", detail: "x" }], ["AC-1"], {
    tolerant: true,
    warnings,
  });
  assert.equal(dropped[0]?.status, "failed");
  assert.ok(warnings.length >= 2);
});
