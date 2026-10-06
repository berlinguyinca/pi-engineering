/**
 * SQLite contention must never freeze Pi's main thread for long: a registry
 * write that cannot get the write lock gives up within a bounded time (and the
 * caller degrades and retries later) instead of blocking for busy_timeout x
 * attempts. Correctness is unchanged: once the lock is free, writes succeed.
 * The lock is held by a REAL second process.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RuntimeRegistry } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { RuntimeSession, registryFileFor } from "../../src/runtime/isolation/RuntimeSession.ts";
import { currentProcessIdentity } from "../../src/runtime/isolation/processIdentity.ts";
import { MAX_SYNC_BLOCK_MS, SqliteBusyError, immediate, openDatabase } from "../../src/runtime/isolation/sqlite.ts";

const root = mkdtempSync(join(tmpdir(), "rt-sqlite-busy-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A second process that takes the write lock and holds it until told to stop. */
async function holdWriteLock(file: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module";
       const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
       const db = new DatabaseSync(${JSON.stringify(file)});
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("HELD\\n");
       process.stdin.on("data", () => { db.exec("COMMIT"); db.close(); process.exit(0); });`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("HELD")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return child;
}

async function release(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.stdin?.write("go\n");
  await exited;
}

test("a write blocked by another process's lock gives up within the bound, then succeeds once free", async () => {
  const file = join(root, "registry.db");
  const registry = RuntimeRegistry.open(file);
  const holder = await holdWriteLock(file);
  try {
    const started = Date.now();
    assert.throws(
      () => immediate(registry.db, () => registry.db.exec("SELECT 1")),
      (error: unknown) => error instanceof SqliteBusyError,
    );
    const blocked = Date.now() - started;
    assert.ok(blocked <= MAX_SYNC_BLOCK_MS + 750, `blocked ${blocked}ms, bound ${MAX_SYNC_BLOCK_MS}ms`);
    assert.ok(MAX_SYNC_BLOCK_MS <= 2_000, "the bound itself is small enough for an interactive UI");

    // Callers degrade instead of throwing into Pi: a lease claim reports contention.
    const owner = { sessionId: "busy-session", process: currentProcessIdentity() };
    const leaseStarted = Date.now();
    assert.throws(() => registry.leases.acquire("busy:resource", owner), SqliteBusyError);
    assert.ok(Date.now() - leaseStarted <= MAX_SYNC_BLOCK_MS + 750);
  } finally {
    await release(holder);
  }
  // Correctness: with the lock free, the same write goes through.
  const owner = { sessionId: "busy-session", process: currentProcessIdentity() };
  const acquired = registry.leases.acquire("busy:resource", owner);
  assert.equal(acquired.ok, true);
  registry.close();
});

test("a session heartbeat under a held write lock degrades within the bound and recovers on the next beat", async () => {
  const session = RuntimeSession.current();
  assert.ok(await session.ensureRegistered());
  const holder = await holdWriteLock(registryFileFor(session.stateRoot()));
  try {
    const started = Date.now();
    assert.equal(session.heartbeat(), false, "the beat fails soft instead of freezing");
    assert.ok(Date.now() - started <= MAX_SYNC_BLOCK_MS + 750);
    assert.equal(session.health.state, "degraded");
  } finally {
    await release(holder);
  }
  assert.equal(session.heartbeat(), true);
  assert.equal(session.health.state, "healthy", "transient busy clears on the next successful beat");
  session.shutdown("test");
});

test("a narrowed wait restores the caller's own busy_timeout, not the default", async () => {
  const file = join(root, "custom-timeout.db");
  const db = openDatabase(file, { busyTimeoutMs: 700 });
  db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
  const busyTimeout = () => (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  assert.equal(busyTimeout(), 700);
  const holder = await holdWriteLock(file);
  try {
    assert.throws(() => immediate(db, () => db.exec("INSERT INTO t VALUES (1)")), SqliteBusyError);
  } finally {
    await release(holder);
  }
  assert.equal(busyTimeout(), 700, "the connection keeps the busy_timeout its owner configured");
  db.close();
});
