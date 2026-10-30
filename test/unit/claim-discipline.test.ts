import assert from "node:assert/strict";
import { test } from "node:test";
import type { Evidence } from "../../src/core/types.ts";
import {
  countClaims,
  countGuardMessage,
  countValuesInOutput,
  countsAreBacked,
  metricEvidenceReports,
} from "../../src/ledger/claimDiscipline.ts";

function evidence(summary: Record<string, unknown>, over: Partial<Evidence> = {}): Evidence {
  return {
    id: "EVID-abc123",
    candidate_id: null,
    type: "metric",
    tool: "node --test",
    command: "node --test --experimental-strip-types test/unit/room-client.test.ts",
    started_at: "2026-10-30T00:00:00.000Z",
    finished_at: "2026-10-30T00:00:02.000Z",
    exit_code: 0,
    status: "passed",
    summary,
    artifacts: ["artifact://verify/tap-run"],
    trust: "deterministic",
    ...over,
  };
}

test("countClaims reads the counts a claim states, and leaves everything else alone", () => {
  assert.deepEqual(
    countClaims("main's room-client file has 12 unit tests; the repo runs 5,521 unit tests in total").map(
      (c) => `${c.value} ${c.noun}`,
    ),
    ["12 tests", "5521 tests"],
  );
  // A sha, an exit code, a duration and a PR number are not counts of anything.
  assert.deepEqual(countClaims("PR #475 merged as 4ad600d; node exit=137 after 25 seconds"), []);
});

test("metric evidence reports only the number its own command produced", () => {
  assert.equal(metricEvidenceReports(evidence({ tests: 12 }), 12), true);
  assert.equal(metricEvidenceReports(evidence({ tests: 12 }), 13), false);
  assert.equal(metricEvidenceReports(evidence({ stage: "unit" }), 12), false, "a stage name is not a measurement");
  assert.equal(
    metricEvidenceReports(evidence({ tests: 12 }, { status: "failed", exit_code: 1 }), 12),
    false,
    "a run that failed says nothing about a count",
  );
  assert.equal(
    metricEvidenceReports(evidence({ tests: 12 }, { trust: "unverified" }), 12),
    false,
    "unverified trust cannot authenticate a number",
  );
  assert.equal(
    metricEvidenceReports(evidence({ tests: 12 }, { command: null }), 12),
    false,
    "no producing command, no metric",
  );
});

test("countValuesInOutput reads the quantities a command's own output printed", () => {
  const tap = "# Subtest: room client\nok 1 - room client\n# tests 12\n# suites 3\n# pass 12\n# fail 0\n";
  assert.deepEqual(
    countValuesInOutput(tap).sort((a, b) => a - b),
    [0, 3, 12],
  );
  assert.deepEqual(
    countValuesInOutput("12 tests passed").sort((a, b) => a - b),
    [12],
  );
  assert.deepEqual(countValuesInOutput("tests: 12"), [12]);
});

test("a count is backed only by output that reports that number", () => {
  const twelve = countClaims("room-client.test.ts has 12 unit tests");
  const thirteen = countClaims("room-client.test.ts has 13 unit tests");
  const tap = "# tests 12\n# pass 12\n# fail 0\n";

  assert.deepEqual(countsAreBacked(twelve, null, tap).unbacked, []);
  assert.deepEqual(countsAreBacked(thirteen, null, tap).unbacked, [{ value: 13, noun: "tests", raw: "13 unit tests" }]);
  assert.deepEqual(countsAreBacked(thirteen, evidence({ tests: 13 }), tap).unbacked, [], "the metric carries 13");
  assert.deepEqual(countsAreBacked(twelve, evidence({ tests: 13 }), null).unbacked, [
    { value: 12, noun: "tests", raw: "12 unit tests" },
  ]);
  assert.deepEqual(countsAreBacked(twelve, null, null).unbacked.length, 1, "no output cited, nothing backs the count");
});

test("the refusal names the number, the evidence, and the command shape that would back it", () => {
  const message = countGuardMessage(countClaims("room-client.test.ts has 13 unit tests"), "artifact://verify/tap-run");
  assert.match(message, /Refused: the claim states a count \("13 unit tests"\)/);
  assert.match(message, /artifact:\/\/verify\/tap-run/);
  assert.match(message, /`# tests 12`/);
  assert.match(message, /not a count/);
});
