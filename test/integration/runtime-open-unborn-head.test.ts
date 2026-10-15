import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

test("a freshly initialised repo with no commit opens and closes a runtime without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-unborn-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const rt = await EngineeringRuntime.open({
      cwd: root,
      worker: new FakeWorkerExecutor({}),
      verifier: new CommandVerifier(),
    });
    await rt.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
