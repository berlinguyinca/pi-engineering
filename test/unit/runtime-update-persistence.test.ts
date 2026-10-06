/**
 * Phase 3 building blocks: mutation lock, crash-safe journal, schema
 * versioning, migration planning/dry-run/checkpoint (spec §25-§29).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { currentProcessIdentity, readProcessStartTime } from "../../src/runtime/isolation/processIdentity.ts";
import {
  type StateMigration,
  applyMigrations,
  createCheckpoint,
  dryRunMigrations,
  planMigrations,
  restoreCheckpoint,
} from "../../src/runtime/migrations/framework.ts";
import {
  BASELINE_STATE_SCHEMA,
  readStateSchema,
  schemaCompatibility,
  writeStateSchema,
} from "../../src/runtime/migrations/schema.ts";
import { UpdateJournal, isTerminal, mayHaveMutated } from "../../src/update/journal.ts";
import { MutationLockBusyError, RuntimeMutationLock } from "../../src/update/mutationLock.ts";

const lockModule = new URL("../../src/update/mutationLock.ts", import.meta.url).href;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rt-persist-"));
  dirs.push(d);
  return d;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((r) => child.on("exit", r));
  return pid;
}

test("mutation lock: in-process mutex and cross-process lock file", () => {
  const lock = new RuntimeMutationLock(join(tmp(), "runtime-update.lock"));
  const a = lock.acquire("update");
  assert.throws(() => lock.acquire("reload"), MutationLockBusyError);
  assert.throws(() => new RuntimeMutationLock(lock.file).acquire("rollback"), /already in progress/);
  assert.equal(lock.readOwner()?.operation, "update");
  a.release();
  a.release();
  assert.equal(existsSync(lock.file), false);
  const b = lock.acquire("reload");
  b.release();
});

test("mutation lock: a lock held by a live process is respected, a dead owner's lock is taken over", async () => {
  const file = join(tmp(), "runtime-update.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    writeFileSync(file, JSON.stringify({ pid: sleeper.pid, token: "t", operation: "update", acquiredAt: "x" }));
    assert.throws(() => new RuntimeMutationLock(file).acquire("reload"), MutationLockBusyError);
  } finally {
    sleeper.kill("SIGKILL");
  }
  writeFileSync(file, JSON.stringify({ pid: await deadPid(), token: "t", operation: "update", acquiredAt: "x" }));
  const handle = new RuntimeMutationLock(file).acquire("crash-recovery");
  assert.equal(handle.owner.pid, process.pid);
  handle.release();
});

test("mutation lock: records its process incarnation; a lock whose PID was reused is stale (forged start time)", async () => {
  const file = join(tmp(), "runtime-update.lock");
  const own = new RuntimeMutationLock(file).acquire("update");
  const recorded = new RuntimeMutationLock(file).readOwner();
  assert.equal(recorded?.pid, process.pid);
  assert.equal(recorded?.processStartTime, currentProcessIdentity().processStartTime);
  assert.equal(recorded?.bootId, currentProcessIdentity().bootId);
  own.release();

  // A live PID (a real sleeper), but the recorded start time is not its own:
  // the process that wrote the lock is gone and the PID was reused.
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const identity = { ...currentProcessIdentity(), pid: sleeper.pid as number };
    const forged = { ...identity, processStartTime: "1", token: "t", operation: "update", acquiredAt: "x" };
    if (readProcessStartTime(sleeper.pid as number).state !== "present") return; // no /proc: nothing to forge
    writeFileSync(file, JSON.stringify(forged));
    const lock = new RuntimeMutationLock(file);
    assert.equal(lock.isHeldByLiveProcess(), false, "PID reused: not held");
    const handle = lock.acquire("crash-recovery");
    assert.equal(handle.owner.pid, process.pid);
    handle.release();

    // The genuine incarnation of the same live PID is respected.
    const start = readProcessStartTime(sleeper.pid as number);
    const genuine = { ...forged, processStartTime: start.state === "present" ? start.value : null };
    writeFileSync(file, JSON.stringify(genuine));
    assert.equal(new RuntimeMutationLock(file).isHeldByLiveProcess(), true);
    assert.throws(() => new RuntimeMutationLock(file).acquire("reload"), MutationLockBusyError);
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("mutation lock: an unreadable stale-break claim (empty, truncated, null) expires; a fresh one is respected", async () => {
  const dir = tmp();
  const file = join(dir, "runtime-update.lock");
  const claim = `${file}.claim`;
  const old = new Date(Date.now() - 60_000);
  for (const content of ["", '{"pid":', "null", "42abc", "[]"]) {
    writeFileSync(file, JSON.stringify({ pid: await deadPid(), token: "t", operation: "update", acquiredAt: "x" }));
    writeFileSync(claim, content);
    utimesSync(claim, old, old);
    const handle = new RuntimeMutationLock(file).acquire("crash-recovery");
    assert.equal(handle.owner.pid, process.pid, `claim ${JSON.stringify(content)} was broken`);
    handle.release();
    assert.equal(existsSync(claim), false);
  }
  // A claimant may be between creating and writing its claim: not broken yet.
  writeFileSync(file, JSON.stringify({ pid: await deadPid(), token: "t", operation: "update", acquiredAt: "x" }));
  writeFileSync(claim, "");
  assert.throws(() => new RuntimeMutationLock(file).acquire("reload"), MutationLockBusyError);
  assert.equal(existsSync(claim), true, "a fresh unreadable claim is left alone");
});

test("journal: atomic records, phases, incomplete detection, corrupt detection", () => {
  const journal = new UpdateJournal(join(tmp(), "update-journal.json"));
  assert.equal(journal.read(), null);
  let rec = journal.begin({
    transaction: "update-def456",
    kind: "update",
    fromVersion: "0.2.0",
    fromCommit: "abc123",
    toVersion: "0.2.1",
    toCommit: "def456",
    previousRuntime: null,
    candidateRuntime: null,
    pointers: { current: null, previous: null },
  });
  assert.equal(rec.phase, "checking");
  rec = journal.advance(rec, "activating", { candidateRuntime: "/x" });
  assert.equal(journal.incomplete()?.phase, "activating");
  assert.equal(journal.incomplete()?.candidateRuntime, "/x");
  assert.deepEqual(
    journal.incomplete()?.history.map((h) => h.phase),
    ["checking", "activating"],
  );
  journal.advance(rec, "committed");
  assert.equal(journal.incomplete(), null);
  writeFileSync(journal.file, '{"transaction": "x", "pha');
  assert.equal(journal.read(), "corrupt");
  assert.equal(isTerminal("rolled_back"), true);
  assert.equal(mayHaveMutated("validating"), false);
  assert.equal(mayHaveMutated("migrating"), true);
});

test("schema: unversioned state is baseline; compatibility decides compatible / migrate / incompatible", () => {
  const state = tmp();
  assert.equal(readStateSchema(state), BASELINE_STATE_SCHEMA);
  writeStateSchema(state, 7);
  assert.equal(readStateSchema(state), 7);
  writeFileSync(join(state, "state-schema.json"), "{not json");
  assert.equal(readStateSchema(state), null);
  const support = { minReadable: 8, maxReadable: 9, writes: 9 };
  assert.deepEqual(schemaCompatibility(9, support), { kind: "compatible", schema: 9 });
  assert.deepEqual(schemaCompatibility(7, support), { kind: "migrate", from: 7, to: 9 });
  assert.equal(schemaCompatibility(10, support).kind, "incompatible");
  assert.equal(schemaCompatibility(null, support).kind, "incompatible");
});

function step(from: number, to: number, body: (dir: string) => void, touches = ["data.json"]): StateMigration {
  return { id: `v${from}-v${to}`, from, to, description: "t", touches, apply: async (d) => body(d) };
}

test("migrations: path planning, dry-run leaves state untouched, apply is resumable", async () => {
  const state = tmp();
  writeStateSchema(state, 6);
  writeFileSync(join(state, "data.json"), JSON.stringify({ n: 1 }));
  writeFileSync(join(state, "untouched.log"), "keep");
  let applied = 0;
  const bump = (d: string) => {
    applied++;
    const v = JSON.parse(readFileSync(join(d, "data.json"), "utf8"));
    writeFileSync(join(d, "data.json"), JSON.stringify({ n: v.n + 1 }));
  };
  const registry = [step(6, 7, bump), step(7, 8, bump)];
  const plan = planMigrations(registry, 6, 8);
  assert.deepEqual(
    plan.map((m) => m.id),
    ["v6-v7", "v7-v8"],
  );
  assert.throws(() => planMigrations(registry, 5, 8), /no migration from schema 5/);
  assert.throws(() => planMigrations(registry, 8, 6), /no downgrade/);

  assert.deepEqual(await dryRunMigrations(state, plan), { ok: true });
  assert.equal(readStateSchema(state), 6, "dry-run did not touch the real state");
  assert.equal(JSON.parse(readFileSync(join(state, "data.json"), "utf8")).n, 1);

  // A crash after step one: the marker says 7; re-running resumes at step two.
  await applyMigrations(state, plan.slice(0, 1));
  await applyMigrations(state, plan);
  assert.equal(readStateSchema(state), 8);
  assert.equal(JSON.parse(readFileSync(join(state, "data.json"), "utf8")).n, 3);
  assert.equal(applied, 4, "two dry-run steps + two real steps, none repeated");
  const failing = [step(8, 9, () => assert.fail("boom"))];
  const dry = await dryRunMigrations(state, failing);
  assert.equal(dry.ok, false);
});

test("checkpoint restores touched paths exactly, including files the migration created", async () => {
  const state = tmp();
  const cp = join(tmp(), "checkpoint");
  writeStateSchema(state, 7);
  writeFileSync(join(state, "data.json"), "original");
  mkdirSync(join(state, "dir"));
  writeFileSync(join(state, "dir", "a"), "a");
  const plan = [
    step(
      7,
      8,
      (d) => {
        writeFileSync(join(d, "data.json"), "migrated");
        writeFileSync(join(d, "new.json"), "created");
        rmSync(join(d, "dir"), { recursive: true });
      },
      ["data.json", "new.json", "dir"],
    ),
  ];
  await createCheckpoint(state, plan, cp);
  await applyMigrations(state, plan);
  assert.equal(readStateSchema(state), 8);
  await restoreCheckpoint(cp, state);
  assert.equal(readStateSchema(state), 7);
  assert.equal(readFileSync(join(state, "data.json"), "utf8"), "original");
  assert.equal(existsSync(join(state, "new.json")), false);
  assert.equal(readFileSync(join(state, "dir", "a"), "utf8"), "a");
  await assert.rejects(createCheckpoint(state, [step(1, 2, () => {}, ["../escape"])], cp), /unsafe path/);
});

test("mutation lock: processes racing to break the same stale lock never both hold it", async () => {
  const file = join(tmp(), "runtime-update.lock");
  for (let round = 0; round < 3; round++) {
    writeFileSync(
      file,
      JSON.stringify({ pid: await deadPid(), token: `stale-${round}`, operation: "update", acquiredAt: "x" }),
    );
    const script = `
      import { RuntimeMutationLock } from ${JSON.stringify(lockModule)};
      const lock = new RuntimeMutationLock(${JSON.stringify(file)});
      await new Promise((r) => setTimeout(r, 200 - Date.now() % 200));
      let h;
      try { h = lock.acquire("race"); } catch { process.stdout.write("BUSY\\n"); process.exit(0); }
      process.stdout.write("HELD " + Date.now() + "\\n");
      await new Promise((r) => setTimeout(r, 400));
      process.stdout.write("RELEASED " + Date.now() + "\\n");
      h.release();
    `;
    const runs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolveRun) => {
            const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
              stdio: ["ignore", "pipe", "inherit"],
            });
            let out = "";
            child.stdout.on("data", (d: Buffer) => {
              out += d.toString();
            });
            child.on("exit", () => resolveRun(out));
          }),
      ),
    );
    const windows = runs
      .filter((o) => o.includes("HELD"))
      .map((o) => {
        const held = Number(/HELD (\d+)/.exec(o)?.[1]);
        const released = Number(/RELEASED (\d+)/.exec(o)?.[1]);
        return [held, released] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    assert.ok(windows.length >= 1, "someone took over the stale lock");
    for (let i = 1; i < windows.length; i++) {
      assert.ok(
        (windows[i]?.[0] as number) >= (windows[i - 1]?.[1] as number),
        `overlapping holders in round ${round}`,
      );
    }
  }
});
