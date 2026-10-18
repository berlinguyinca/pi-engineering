import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

test("worker observations retain real references without auto-verifying causal hypotheses", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-claim-"));
  let runtime: EngineeringRuntime | undefined;
  let observedUri = "";
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    runtime = await EngineeringRuntime.open({
      cwd: root,
      worker: new FakeWorkerExecutor({
        scout: () => ({
          summary: "hypotheses for inspection",
          claims: [
            { claim: "swap caused the timeout", evidence: observedUri },
            { claim: "deployment succeeded", evidence: "EVID-invented" },
            { claim: "tests passed", evidence: "artifact://verify/invented" },
          ],
        }),
      }),
    });
    observedUri = (await runtime.artifacts.put("verify", "sample", "wa=0 id=50", "vmstat sample")).uri;
    const wi = await runtime.ledger.createWorkItem("inspect evidence", "low", [root], { type: "system" });
    await runtime.scout(wi, "inspect evidence", "");
    const claims = runtime.ledger.listEntities("hypothesis", wi.id);
    assert.equal(claims.length, 3);
    for (const claim of claims) assert.equal(claim.status, "open", claim.claim);
    assert.deepEqual(claims[0]!.evidence, [observedUri]);
    assert.deepEqual(claims[1]!.evidence, []);
    assert.deepEqual(claims[2]!.evidence, []);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
