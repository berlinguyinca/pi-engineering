import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeFindings } from "../../src/orchestration/realBackends.ts";

describe("normalizeFindings (spec 07 — reviewer finding normalization)", () => {
  it("passes through structured objects, mapping summary/message/text/title", () => {
    const out = normalizeFindings([
      { severity: "blocking", summary: "crashes on empty input", file: "a.ts", line: 3 },
      { severity: "minor", message: "nit: naming" },
      { severity: "major", text: "unused import" },
      { severity: "warning", title: "title-based finding" },
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], {
      severity: "blocking",
      summary: "crashes on empty input",
      message: "crashes on empty input",
      file: "a.ts",
      line: 3,
    });
    assert.equal(out[1]!.severity, "minor");
    assert.equal(out[2]!.summary, "unused import");
    assert.equal(out[3]!.summary, "title-based finding");
  });

  it("treats plain strings as findings with no severity", () => {
    const out = normalizeFindings(["boom", "second issue"]);
    assert.deepEqual(out, [
      { summary: "boom", message: "boom" },
      { summary: "second issue", message: "second issue" },
    ]);
  });

  it("parses a JSON string (object or array)", () => {
    const arr = normalizeFindings('[{"severity":"blocking","summary":"a"},{"severity":"minor","summary":"b"}]');
    assert.equal(arr.length, 2);
    assert.equal(arr[0]!.severity, "blocking");
    const obj = normalizeFindings('{"severity":"major","summary":"single"}');
    assert.equal(obj.length, 1);
    assert.equal(obj[0]!.severity, "major");
  });

  it("treats a non-JSON string as a single finding", () => {
    const out = normalizeFindings("this is a problem");
    assert.deepEqual(out, [{ summary: "this is a problem", message: "this is a problem" }]);
  });

  it("returns [] for null, empty, or malformed input", () => {
    assert.deepEqual(normalizeFindings(null), []);
    assert.deepEqual(normalizeFindings(undefined), []);
    assert.deepEqual(normalizeFindings(""), []);
    assert.deepEqual(normalizeFindings("[not json"), [{ summary: "[not json", message: "[not json" }]);
    assert.deepEqual(normalizeFindings(42), []);
    assert.deepEqual(normalizeFindings([{ noSummaryField: true }]), []);
  });
});
