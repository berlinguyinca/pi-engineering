import assert from "node:assert/strict";
import { test } from "node:test";
import { parallelLedgerWrites, reserveEphemeralPort } from "../../src/cav/concurrency.ts";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";

test("parallel ledger writes are collision-free and lossless", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const r = await parallelLedgerWrites(ledger, "CAV-16-03", 100);
  assert.equal(r.noCorruption, true);
  assert.equal(r.written, 100);
  assert.equal(r.uniqueRunIds, 100);
});

test("ephemeral port reservation returns a free port and fails closed when none is free", async () => {
  const reserved = await reserveEphemeralPort([20042, 20042], async () => true);
  assert.equal(reserved.port, 20042);
  // No free port in the range => fail closed.
  await assert.rejects(
    reserveEphemeralPort([30000, 30000], async () => false),
    /no free ephemeral port/,
  );
});
