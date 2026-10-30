import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Ledger,
  LedgerAuthorityStaleError,
  LedgerLockTimeoutError,
  LedgerRevisionConflictError,
} from "../../src/ledger/Ledger.ts";

const actor = { type: "system" as const };
const writer = join(import.meta.dirname, "..", "support", "ledgerWriter.ts");

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ledger-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(file: string, tag: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writer, file, tag, String(count)], { stdio: ["ignore", "pipe", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`))));
  });
}

function lines(file: string): string[] {
  return readFileSync(file, "utf-8").split("\n").filter(Boolean);
}

test("concurrent writer processes never interleave or lose events", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const tags = ["a", "b", "c", "d"];
    await Promise.all(tags.map((t) => run(file, t, 40)));
    const events = lines(file).map((l) => JSON.parse(l) as { event_id: string; payload: { tag: string; i: number } });
    assert.equal(events.length, 160, "every append is one intact line");
    assert.equal(new Set(events.map((e) => e.event_id)).size, 160);
    for (const t of tags) {
      assert.deepEqual(
        events.filter((e) => e.payload.tag === t).map((e) => e.payload.i),
        Array.from({ length: 40 }, (_, i) => i),
        `writer ${t} kept its own order`,
      );
    }
    assert.equal(existsSync(`${file}.lock`), false, "lock released");
    assert.equal((await Ledger.create(file)).count(), 160);
  });
});

test("a lock whose owner process is dead is reclaimed", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const owner = { pid: Number(dead.stdout.toString()), host: hostname(), token: "dead", acquired_at: "x" };
    writeFileSync(`${file}.lock`, JSON.stringify(owner));
    const ledger = await Ledger.create(file, { lock: { waitMs: 2000 } });
    await ledger.emitEvent("work_item.updated", "WI-1", actor, {});
    assert.equal(lines(file).length, 1);
    assert.equal(existsSync(`${file}.lock`), false);
  });
});

test("an old lock from another host is reclaimed by age; a fresh live one is not", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const lock = `${file}.lock`;
    const foreign = { pid: process.pid, host: "elsewhere", token: "t", acquired_at: "x" };
    writeFileSync(lock, JSON.stringify(foreign));
    const ledger = await Ledger.create(file, { lock: { waitMs: 150, staleMs: 60_000, pollMs: 5 } });
    await assert.rejects(ledger.emitEvent("work_item.updated", "WI-1", actor, {}), LedgerLockTimeoutError);
    assert.equal(existsSync(file), false, "a timed-out append writes nothing");
    assert.equal(readFileSync(lock, "utf-8"), JSON.stringify(foreign), "a live holder's lock is left alone");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await ledger.emitEvent("work_item.updated", "WI-1", actor, {});
    assert.equal(lines(file).length, 1);
    assert.equal(existsSync(lock), false);
  });
});

test("a stale expected_revision is rejected and the event is not written", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const a = await Ledger.create(file);
    const b = await Ledger.create(file);
    await a.emitEvent("work_item.updated", "WI-1", actor, { n: 1 });
    const seen = a.revision("WI-1");
    assert.equal(seen, 1);
    await b.emitEvent("work_item.updated", "WI-1", actor, { n: 2 }, undefined, { expected_revision: 1 });
    // a's read is now stale: b advanced the log in between.
    await assert.rejects(
      a.emitEvent("work_item.updated", "WI-1", actor, { n: 3 }, undefined, { expected_revision: seen }),
      (error: unknown) =>
        error instanceof LedgerRevisionConflictError && error.expectedRevision === 1 && error.actualRevision === 2,
    );
    assert.equal(lines(file).length, 2, "the rejected event never reached the log");
    assert.equal(a.revision("WI-1"), 2, "the rejected writer caught up");
    await a.emitEvent("work_item.updated", "WI-1", actor, { n: 3 }, undefined, { expected_revision: 2 });
    assert.equal(lines(file).length, 3);
    // Other work items are independent scopes.
    await a.emitEvent("work_item.updated", "WI-2", actor, {}, undefined, { expected_revision: 0 });
  });
});

test("a stale authority_generation is rejected; equal and newer are accepted and recorded", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const a = await Ledger.create(file);
    const b = await Ledger.create(file);
    await a.emitEvent("work_item.updated", "WI-1", actor, {}, { authority_generation: 2 });
    await b.emitEvent("work_item.updated", "WI-1", actor, {}, { authority_generation: 2 });
    await b.emitEvent("work_item.updated", "WI-1", actor, {}, { authority_generation: 3 });
    await assert.rejects(
      a.emitEvent("work_item.updated", "WI-1", actor, {}, { authority_generation: 2 }),
      (error: unknown) => error instanceof LedgerAuthorityStaleError && error.currentGeneration === 3,
    );
    const stored = lines(file).map((l) => JSON.parse(l));
    assert.deepEqual(
      stored.map((e) => e.authority_generation),
      [2, 2, 3],
    );
    assert.equal(stored[0].schema_version, 2);
    // Other scopes are not fenced by it, and unfenced callers are unaffected.
    await a.emitEvent("work_item.updated", "WI-2", actor, {}, { authority_generation: 1 });
    await a.emitEvent("work_item.updated", "WI-1", actor, {});
  });
});

test("the lock is released when an append is rejected or throws", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const ledger = await Ledger.create(file);
    await ledger.emitEvent("work_item.updated", "WI-1", actor, {});
    await assert.rejects(
      ledger.emitEvent("work_item.updated", "WI-1", actor, {}, undefined, { expected_revision: 9 }),
      LedgerRevisionConflictError,
    );
    assert.equal(existsSync(`${file}.lock`), false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(ledger.emitEvent("work_item.updated", "WI-1", actor, circular));
    assert.equal(existsSync(`${file}.lock`), false, "released after a serialization throw");
    await ledger.emitEvent("work_item.updated", "WI-1", actor, {});
    assert.equal(lines(file).length, 2);
  });
});

test("idempotency holds across two ledger instances on one file", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const a = await Ledger.create(file);
    const b = await Ledger.create(file);
    const first = await a.emitEvent("work_item.updated", "WI-1", actor, {}, { idempotency_key: "k" });
    const second = await b.emitEvent("work_item.updated", "WI-1", actor, {}, { idempotency_key: "k" });
    assert.equal(second.event_id, first.event_id);
    assert.equal(lines(file).length, 1);
  });
});

test("an old log (no envelope fields, torn final line) replays and keeps appending", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const legacy = {
      event_id: "EVT-old",
      work_item_id: "WI-1",
      timestamp: "t",
      actor,
      type: "work_item.updated",
      payload: {},
    };
    writeFileSync(file, `${JSON.stringify(legacy)}\n{"event_id":"torn`);
    const ledger = await Ledger.create(file);
    assert.equal(ledger.count(), 1);
    assert.equal(ledger.revision("WI-1"), 1);
    await ledger.emitEvent("work_item.updated", "WI-1", actor, {});
    const reread = await Ledger.create(file);
    assert.equal(reread.count(), 2);
  });
});
