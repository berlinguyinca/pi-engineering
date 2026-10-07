/**
 * A corrupt machine registry is quarantined by whichever session finds it
 * (renamed aside, a fresh database created). Other LIVE sessions still hold a
 * handle on the quarantined file; they must notice the swap and re-open and
 * re-register in the fresh database instead of heartbeating into the old one.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RuntimeSession, registryFileFor } from "../../src/runtime/isolation/RuntimeSession.ts";
import { runDoctor } from "../../src/runtime/isolation/doctor.ts";

const sessionModule = new URL("../../src/runtime/isolation/RuntimeSession.ts", import.meta.url).href;

test("a live session follows a registry another process quarantined: re-opens, re-registers, keeps heartbeating", async () => {
  const session = RuntimeSession.current();
  const registry = await session.ensureRegistered();
  assert.ok(registry, "registered");
  const file = registryFileFor(session.stateRoot());
  const before = session.generationId;

  // Another process finds the registry corrupt and quarantines it.
  const child = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { rmSync, writeFileSync } from "node:fs";
       import { openRegistryWithRecovery } from ${JSON.stringify(sessionModule)};
       for (const suffix of ["-wal", "-shm"]) rmSync(${JSON.stringify(file)} + suffix, { force: true });
       writeFileSync(${JSON.stringify(file)}, "this is not a database ".repeat(512));
       const r = await openRegistryWithRecovery(${JSON.stringify(file)}, "repairing-child");
       r.close();
       process.stdout.write("REPAIRED\\n");`,
    ],
    { env: process.env, encoding: "utf8", timeout: 60_000 },
  );
  assert.match(child.stdout, /REPAIRED/, child.stderr);
  assert.ok(
    readdirSync(join(dirname(file), "recovery")).some((name) => name.includes("-corrupt-")),
    "the corrupt registry was moved aside",
  );

  assert.equal(session.heartbeat(), true, "the heartbeat succeeds against the fresh registry");
  assert.notEqual(session.generationId, before, "re-registered under a new generation");
  assert.deepEqual(
    session
      .registry()
      ?.list()
      .map((r) => r.sessionId),
    [session.sessionId],
    "this live session is visible in the fresh registry",
  );

  const report = await runDoctor({ cwd: process.cwd() });
  const quarantine = report.checks.find((c) => c.name === "Registry quarantine");
  assert.equal(quarantine?.status, "warn", "doctor reports the quarantined registry");
  session.shutdown("test");
});
