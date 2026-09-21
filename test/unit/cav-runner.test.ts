import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { runDeterministicTest } from "../../src/cav/runner.ts";

const REPO = resolve(import.meta.dirname, "../..");
const base = {
  requirementId: "CAV-02-03",
  role: "implementer",
  workerRunId: "RUN-1",
  gitSha: "abc",
  cwd: REPO,
};

test("a passing command records TESTED evidence and returns passed=true", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const res = await runDeterministicTest(ledger, { ...base, command: "node", args: ["-e", "console.log('ok')"] });
  assert.equal(res.passed, true);
  assert.equal(res.exitCode, 0);
  assert.equal(ledger.latestStatus("CAV-02-03"), "TESTED");
  assert.equal(ledger.latestEvidence("CAV-02-03")!.role, "implementer");
  // The implementer must NOT be able to promote to VERIFIED.
  await assert.rejects(
    ledger.promote("CAV-02-03", "VERIFIED", {
      gitSha: "abc",
      role: "implementer",
      workerRunId: "RUN-1",
      gateType: "unit",
      tool: "node",
      command: "node",
      exitCode: 0,
    }),
  );
});

test("a failing command fails closed: SPECIFIED + failure reason, never TESTED", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const res = await runDeterministicTest(ledger, { ...base, command: "node", args: ["-e", "process.exit(3)"] });
  assert.equal(res.passed, false);
  assert.equal(res.exitCode, 3);
  assert.equal(ledger.latestStatus("CAV-02-03"), "SPECIFIED");
  const ev = ledger.latestEvidence("CAV-02-03")!;
  assert.ok(ev.failure_reason && /exited 3/.test(ev.failure_reason));
});

test("missing command fails closed and records a failure", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const res = await runDeterministicTest(ledger, { ...base, command: "definitely-not-a-real-command-xyz", args: [] });
  assert.equal(res.passed, false);
  assert.equal(ledger.latestStatus("CAV-02-03"), "SPECIFIED");
});
