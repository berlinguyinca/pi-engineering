/**
 * llama.cpp turns the tool schema into a GBNF grammar and rejects the request
 * with HTTP 400 "failed to parse grammar" for what it cannot express. The
 * review_result schema must stay inside the subset that always compiles.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewResultTool } from "../../src/lifecycle/reviewResultTool.ts";

const HOSTILE = [
  "pattern",
  "format",
  "oneOf",
  "anyOf",
  "allOf",
  "const",
  "not",
  "$ref",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "additionalProperties",
  "patternProperties",
];

function keysOf(node: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) keysOf(entry, acc);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      acc.add(key);
      // Property NAMES are not schema keywords; only descend into their schemas.
      if (key === "properties") for (const schema of Object.values(value as object)) keysOf(schema, acc);
      else keysOf(value, acc);
    }
  }
  return acc;
}

describe("review_result schema is llama.cpp grammar safe", () => {
  const schema = JSON.parse(JSON.stringify(reviewResultTool.parameters));

  it("uses none of the grammar-hostile keywords", () => {
    const used = keysOf(schema);
    assert.deepEqual(
      HOSTILE.filter((keyword) => used.has(keyword)),
      [],
    );
  });

  it("describes enums as plain string enums", () => {
    assert.deepEqual(schema.properties.verdict, { type: "string", enum: ["approve", "request_changes"] });
    assert.equal(schema.properties.findings.items.properties.severity.type, "string");
    assert.ok(Array.isArray(schema.properties.findings.items.properties.severity.enum));
  });

  it("keeps required fields minimal", () => {
    assert.deepEqual(schema.required, [
      "verdict",
      "summary",
      "findings",
      "missing_tests",
      "spec_gaps",
      "acceptance_results",
    ]);
    assert.deepEqual(schema.properties.findings.items.required, ["severity", "title", "detail"]);
  });

  it("round-trips a representative review through the tool's evidence payload", async () => {
    const out = await reviewResultTool.execute(
      "call-1",
      {
        verdict: "request_changes",
        summary: "one blocking defect",
        confidence: 0.8,
        findings: [{ severity: "blocker", title: "Null deref", detail: "x is undefined", file: "src/a.ts", line: 4 }],
        missing_tests: [{ description: "no test for empty input", severity: "medium" }],
        spec_gaps: [{ requirement: "R1", status: "partial", detail: "half done", severity: "high" }],
        acceptance_results: [{ acceptance_id: "AC-1", status: "failed", detail: "returns 3" }],
      },
      undefined,
      undefined,
      {} as never,
    );
    const details = out.details as unknown as {
      verdict: string;
      findings: Array<Record<string, unknown>>;
      acceptanceResults: unknown;
    };
    assert.equal(details.verdict, "request_changes");
    assert.equal(details.findings[0]?.severity, "blocker");
    assert.equal(details.findings[0]?.file, "src/a.ts");
    assert.deepEqual(details.acceptanceResults, [{ acceptanceId: "AC-1", status: "failed", detail: "returns 3" }]);
    assert.equal(out.terminate, true);
  });
});
