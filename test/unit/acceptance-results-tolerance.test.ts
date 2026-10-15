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

test("tolerant mode reports a missing, non-list or empty list as a problem, not as failed criteria", () => {
  for (const raw of [undefined, "nope", []]) {
    const problems: string[] = [];
    validateAcceptanceResults(raw, ["AC-1"], { tolerant: true, problems });
    assert.equal(problems.length, 1, JSON.stringify(raw));
  }
  const none: string[] = [];
  validateAcceptanceResults([], [], { tolerant: true, problems: none });
  assert.deepEqual(none, [], "no criteria, nothing to report");
});

test("colliding normalised IDs need an exact match; unique forms match loosely", () => {
  const warnings: string[] = [];
  const results = validateAcceptanceResults(
    [
      { acceptanceId: "AC-10", status: "passed", detail: "ten" },
      { acceptanceId: "AC-1-0", status: "failed", detail: "one-zero" },
      { acceptanceId: "ac10", status: "passed", detail: "ambiguous" },
      { acceptanceId: "r 3", status: "passed", detail: "unique" },
    ],
    ["AC-10", "AC-1-0", "R-3"],
    { tolerant: true, warnings },
  );
  assert.deepEqual(
    results.map((r) => [r.acceptanceId, r.status, r.detail]),
    [
      ["AC-10", "passed", "ten"],
      ["AC-1-0", "failed", "one-zero"],
      ["R-3", "passed", "unique"],
    ],
  );
  assert.match(warnings.join("\n"), /ac10/);
});

test("tolerant mode drops malformed entries", () => {
  const warnings: string[] = [];
  const dropped = validateAcceptanceResults([null, { acceptanceId: "AC-1", status: "maybe", detail: "x" }], ["AC-1"], {
    tolerant: true,
    warnings,
  });
  assert.equal(dropped[0]?.status, "failed");
  assert.ok(warnings.length >= 2);
});
