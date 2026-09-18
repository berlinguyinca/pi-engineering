import assert from "node:assert/strict";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { buildPortableManifest, checkPortability, derivePortableStatus } from "../../src/cav/portability.ts";

const BASE = {
  gitSha: "abc123",
  role: "implementer" as const,
  workerRunId: "RUN-1",
  gateType: "unit",
  tool: "node",
  command: "npm test",
  exitCode: 0,
};

test("a manifest from clean evidence is portable (no absolute paths or hostnames)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-21-02", "TESTED", BASE);
  const manifest = await buildPortableManifest(ledger);
  assert.equal(manifest.format, "cav-portable-manifest");
  const check = checkPortability(manifest);
  assert.equal(check.portable, true, JSON.stringify(check.blockers));
  assert.equal(check.absolutePathCount, 0);
  assert.equal(check.hostnameCount, 0);
});

test("evidence embedding an absolute path or hostname is flagged as non-portable", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-21-02", "TESTED", { ...BASE, command: "node /home/alice/proj/run.ts" });
  await ledger.record("CAV-21-03", "TESTED", { ...BASE, command: "curl http://localhost:3000/health" });
  const manifest = await buildPortableManifest(ledger);
  const check = checkPortability(manifest);
  assert.equal(check.portable, false);
  assert.equal(check.absolutePathCount, 1);
  assert.equal(check.hostnameCount, 1);
});

test("derived status is deterministic from the manifest (latest record wins)", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-21-02", "TESTED", BASE);
  await ledger.record("CAV-21-02", "VERIFIED", { ...BASE, role: "reviewer" });
  const manifest = await buildPortableManifest(ledger);
  const status = derivePortableStatus(manifest);
  assert.equal(status["CAV-21-02"], "VERIFIED");
  // Loading the same manifest twice yields identical status (portable).
  assert.deepEqual(derivePortableStatus(manifest), derivePortableStatus(manifest));
});
