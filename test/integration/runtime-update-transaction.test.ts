/**
 * Journaled activation with state migration and rollback (spec §26, §27, §29,
 * §35, §52, §54). Real Pi session, real installed version trees, real `.pi-eng`
 * state files.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readStateSchema, writeStateSchema } from "../../src/runtime/migrations/schema.ts";
import { InstallLayout } from "../../src/update/installLayout.ts";
import { prepareMigration, runActivation } from "../../src/update/transaction.ts";
import { beginRecord, hostSession, installFixtureVersion } from "../support/hostHarness.ts";
import { bag, writeFixtureRuntime } from "../support/runtimeFixtures.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let seq = 0;
async function world() {
  const key = `__rt_tx_${process.pid}_${++seq}`;
  const b = bag(key);
  const root = mkdtempSync(join(tmpdir(), "rt-tx-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const layout = new InstallLayout(join(root, "install"));
  const pkg = join(root, "package");
  writeFixtureRuntime(pkg, key, { value: "PKG" });
  const cwd = join(root, "project");
  const state = join(cwd, ".pi-eng");
  mkdirSync(state, { recursive: true });
  writeStateSchema(state, 7);
  const missions = JSON.stringify({ schema: 7, missions: ["MSN-1", "MSN-2"] });
  writeFileSync(join(state, "missions.json"), missions);
  const a = await installFixtureVersion(layout, key, {
    version: "0.2.0",
    value: "A",
    stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 },
  });
  await layout.setPointer("current", a);
  const s = await hostSession({ installRoot: layout.root, packageRoot: pkg, cwd });
  cleanups.push(() => s.pi.close());
  return { key, b, root, layout, cwd, state, missions, a, ...s };
}

test("migration failure: candidate not committed, schema 7 restored, old runtime restored, missions preserved (§54)", async () => {
  const w = await world();
  const candidate = await installFixtureVersion(w.layout, w.key, {
    version: "0.3.0",
    value: "B",
    stateSchema: { minReadable: 8, maxReadable: 8, writes: 8 },
    migration: { from: 7, to: 8, behaviour: "throw" },
  });
  // The dry-run catches this one before anything is touched (§47).
  await assert.rejects(prepareMigration(candidate, w.state), /migration dry-run failed/);
  assert.equal(readStateSchema(w.state), 7);

  // Force the real run (a failure the dry-run could not see) to prove recovery.
  const decision = {
    plan: [...(await import(join(candidate, "migrations.ts"))).migrations],
    from: 7,
    to: 8,
  };
  const record = beginRecord(w.ext, "update", candidate);
  const tx = await runActivation({
    host: w.ext,
    journal: w.ext.journal,
    record,
    candidateDir: candidate,
    kind: "update",
    stateDir: w.state,
    migration: decision,
  });
  const { result, record: final } = await tx.done;
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(final.phase, "rolled_back");
  assert.equal(readStateSchema(w.state), 7, "schema 7 remains");
  assert.equal(readFileSync(join(w.state, "missions.json"), "utf8"), w.missions, "missions preserved byte for byte");
  assert.equal(w.layout.readPointer("current"), w.a, "old runtime still current");
  assert.equal((await w.host.health()).healthy, true);
  w.b.values.length = 0;
  await w.pi.emit({ type: "agent_settled" });
  assert.deepEqual(w.b.values, ["A"]);
  assert.ok(w.ext.telemetry.recent().some((e) => e.event === "runtime.migration.failed"));
});

test("successful migration commits: schema 8, checkpoint retained, candidate current (§26)", async () => {
  const w = await world();
  const candidate = await installFixtureVersion(w.layout, w.key, {
    version: "0.3.0",
    value: "B",
    stateSchema: { minReadable: 8, maxReadable: 8, writes: 8 },
    migration: { from: 7, to: 8, behaviour: "ok" },
  });
  const migration = await prepareMigration(candidate, w.state);
  assert.deepEqual(
    migration.plan.map((m) => m.id),
    ["v7-v8"],
  );
  const record = beginRecord(w.ext, "update", candidate, "update-ok");
  const tx = await runActivation({
    host: w.ext,
    journal: w.ext.journal,
    record,
    candidateDir: candidate,
    kind: "update",
    stateDir: w.state,
    migration,
  });
  const { result, record: final } = await tx.done;
  assert.equal(result.ok, true, result.failure);
  assert.equal(final.phase, "committed");
  assert.deepEqual(
    final.history.map((h) => h.phase),
    [
      "validating",
      "waiting_safe_point",
      "quiescing",
      "snapshotting",
      "migrating",
      "activating",
      "loading",
      "restoring",
      "health_check",
      "committing",
      "committed",
    ],
  );
  assert.equal(readStateSchema(w.state), 8);
  assert.deepEqual(JSON.parse(readFileSync(join(w.state, "missions.json"), "utf8")).items, ["MSN-1", "MSN-2"]);
  assert.ok(existsSync(join(w.layout.checkpointsDir, "update-ok", "checkpoint-manifest.json")));
  assert.equal(w.layout.readPointer("current"), candidate);
  assert.equal(w.layout.readPointer("previous"), w.a);
});

test("broken candidate through the journaled path: rolled_back, Pi session continues (§52)", async () => {
  const w = await world();
  const candidate = await installFixtureVersion(w.layout, w.key, {
    version: "0.2.1",
    value: "BROKEN",
    mode: "throw-start",
    stateSchema: { minReadable: 7, maxReadable: 7, writes: 7 },
  });
  const record = beginRecord(w.ext, "update", candidate);
  const tx = await runActivation({
    host: w.ext,
    journal: w.ext.journal,
    record,
    candidateDir: candidate,
    kind: "update",
    stateDir: w.state,
    migration: await prepareMigration(candidate, w.state),
  });
  const { result, record: final } = await tx.done;
  assert.equal(result.rolledBack, true);
  assert.equal(final.phase, "rolled_back");
  assert.equal(w.layout.readPointer("current"), w.a);
  await w.pi.run("/engineering version");
  await w.pi.emit({ type: "agent_settled" });
  assert.equal(w.b.values.at(-1), "A");
});

test("a candidate whose schema is newer than the state can hold is refused before activation", async () => {
  const w = await world();
  writeStateSchema(w.state, 9);
  const candidate = await installFixtureVersion(w.layout, w.key, {
    version: "0.3.0",
    value: "B",
    stateSchema: { minReadable: 8, maxReadable: 8, writes: 8 },
  });
  await assert.rejects(prepareMigration(candidate, w.state), /newer than this runtime reads/);
});
