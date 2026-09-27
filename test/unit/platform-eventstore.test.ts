import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventStore } from "../../src/ledger/EventStore.ts";
import { LedgerEventStoreBackend } from "../../src/platform/eventstore/adapters.ts";
import { ExclusiveFileLock } from "../../src/platform/eventstore/fileLock.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const evt = (i: number) => ({
  event_id: `evt-${i}`,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "platform.run.status",
  project_id: "PRJ-1",
  run_id: "RUN-1",
  worker_id: null,
  payload: { i },
});

const jsonlModule = pathToFileURL(
  fileURLToPath(new URL("../../src/platform/eventstore/jsonl.ts", import.meta.url)),
).href;
const fileLockModule = pathToFileURL(
  fileURLToPath(new URL("../../src/platform/eventstore/fileLock.ts", import.meta.url)),
).href;

async function startStoreOwner(file: string) {
  const script = `
    import { JsonlEventStore } from ${JSON.stringify(jsonlModule)};
    const store = await JsonlEventStore.open(${JSON.stringify(file)});
    process.stdout.write("READY\\n");
    process.on("message", (message) => {
      if (message === "close") {
        store.close();
        process.exit(0);
      }
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("READY")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`store owner exited early (${code}): ${stderr}`)));
  });
  return child;
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function startRecoveryClaimant(file: string) {
  const script = `
    import { ExclusiveFileLock } from ${JSON.stringify(fileLockModule)};
    await ExclusiveFileLock.acquire(${JSON.stringify(file)}, {
      afterRecoveryClaimPublished: async (claimPath) => {
        process.stdout.write("READY:" + claimPath + "\\n");
        setInterval(() => {}, 1_000);
        await new Promise(() => {});
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const claimPath = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout!.on("data", (chunk) => {
      const match = String(chunk).match(/READY:(.+)\n/);
      if (match?.[1]) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`recovery claimant exited early (${code}): ${stderr}`)));
  });
  return { child, claimPath };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startRacingOwner(file: string) {
  const script = `
    import { JsonlEventStore } from ${JSON.stringify(jsonlModule)};
    try {
      const store = await JsonlEventStore.open(${JSON.stringify(file)});
      process.stdout.write("READY\\n");
      process.on("message", (message) => {
        if (message === "close") {
          store.close();
          process.exit(0);
        }
      });
    } catch (error) {
      process.stdout.write("BLOCKED:" + String(error) + "\\n");
      process.exit(2);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const outcome = new Promise<"ready" | "blocked">((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      const line = String(chunk);
      if (line.includes("READY")) resolve("ready");
      if (line.includes("BLOCKED:")) resolve("blocked");
    });
    child.once("error", reject);
  });
  return { child, outcome };
}

async function outcomeWithin(
  contender: ReturnType<typeof startRacingOwner>,
  timeoutMs = 500,
): Promise<"ready" | "blocked" | "timeout"> {
  return Promise.race([
    contender.outcome,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
}

describe("EventStore backends", () => {
  it("JsonlEventStore in-memory appends and replays in order", async () => {
    const store = JsonlEventStore.inMemory();
    await store.append(evt(1));
    await store.appendAll([evt(2), evt(3)]);
    assert.equal(store.count(), 3);
    assert.deepEqual(
      store.all().map((e) => e.event_id),
      ["evt-1", "evt-2", "evt-3"],
    );
    assert.equal(store.get("evt-2")?.payload.i, 2);
  });

  it("JsonlEventStore persists to disk and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-"));
    const file = join(dir, "events.jsonl");
    const s1 = await JsonlEventStore.open(file);
    await s1.append(evt(1));
    await s1.append(evt(2));
    const raw = await readFile(file, "utf-8");
    assert.equal(raw.split("\n").filter(Boolean).length, 2);

    // Released before reopening: the backend is single-instance on purpose, so
    // a restart closes the old handle rather than running two views of one file.
    s1.close();
    const s2 = await JsonlEventStore.open(file);
    assert.equal(s2.count(), 2);
    assert.equal(s2.all()[1]?.event_id, "evt-2");
    s2.close();
  });

  it("creates a missing parent directory before acquiring its writer lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-parent-"));
    const file = join(dir, "nested", "events.jsonl");
    const store = await JsonlEventStore.open(file);
    await store.append(evt(1));
    store.close();
    assert.equal((await readFile(file, "utf8")).trim().length > 0, true);
  });

  it("refuses a second instance over one file rather than diverging silently", async () => {
    // Two instances each held their own array and never re-read, so each
    // reported a silently partial history — and every consumer built on `all()`
    // (the control plane's feed, a rebuild, a health rollup) inherited it.
    const dir = await mkdtemp(join(tmpdir(), "pie-store-dup-"));
    const file = join(dir, "events.jsonl");
    const first = await JsonlEventStore.open(file);
    await assert.rejects(() => JsonlEventStore.open(file), /already open/);
    first.close();
    const second = await JsonlEventStore.open(file);
    assert.equal(second.count(), 0);
    second.close();
  });

  it("holds the JSONL writer lock across processes and recovers only after release or verified death", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-process-lock-"));
    const file = join(dir, "events.jsonl");

    const cleanOwner = await startStoreOwner(file);
    try {
      await assert.rejects(() => JsonlEventStore.open(file), /writer lock.*pid/i);
    } finally {
      cleanOwner.send("close");
      await waitForExit(cleanOwner);
    }

    const afterCleanRelease = await JsonlEventStore.open(file);
    afterCleanRelease.close();

    const crashedOwner = await startStoreOwner(file);
    crashedOwner.kill("SIGKILL");
    await waitForExit(crashedOwner);

    const afterVerifiedDeath = await JsonlEventStore.open(file);
    afterVerifiedDeath.close();
  });

  it("preserves the live winner when two processes race to recover one stale lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-stale-race-"));
    const file = join(dir, "events.jsonl");
    await writeFile(
      `${file}.lock`,
      `${JSON.stringify({
        pid: 2_000_000_000,
        host: hostname(),
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerToken: "stale-race-owner",
      })}\n`,
    );
    const contenders = [startRacingOwner(file), startRacingOwner(file)];
    const outcomes = await Promise.all(contenders.map((contender) => contender.outcome));
    assert.deepEqual(outcomes.slice().sort(), ["blocked", "ready"]);
    await assert.rejects(() => JsonlEventStore.open(file), /writer lock.*pid/i);

    const winner = contenders[outcomes.indexOf("ready")]!.child;
    winner.send("close");
    await waitForExit(winner);
    for (const contender of contenders) {
      if (contender.child !== winner) await waitForExit(contender.child);
    }
  });

  it("recovers a stale lock after the recovery claimant is killed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-dead-recovery-claim-"));
    const file = join(dir, "events.jsonl");
    const staleOwnerToken = "stale-owner-with-killed-claimant";
    await writeFile(
      `${file}.lock`,
      `${JSON.stringify({
        pid: 2_000_000_000,
        host: hostname(),
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerToken: staleOwnerToken,
      })}\n`,
    );
    const killedClaimant = await startRecoveryClaimant(file);
    assert.equal((await stat(killedClaimant.claimPath)).isDirectory(), true);
    const atomicIdentity = await readdir(killedClaimant.claimPath);
    assert.equal(atomicIdentity.length, 1, "published claim identity is complete in one directory entry");
    assert.match(atomicIdentity[0]!, /^owner\./);
    killedClaimant.child.kill("SIGKILL");
    await waitForExit(killedClaimant.child);

    const contender = startRacingOwner(file);
    const outcome = await outcomeWithin(contender);
    try {
      assert.equal(outcome, "ready", "a dead recovery claimant must not wedge stale-lock recovery");
      await assert.rejects(() => JsonlEventStore.open(file), /writer lock.*pid/i);
    } finally {
      if (outcome === "ready") contender.child.send("close");
      else contender.child.kill("SIGKILL");
      await waitForExit(contender.child);
    }
  });

  it("does not remove a recovery claim held by a live process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-live-recovery-claim-"));
    const file = join(dir, "events.jsonl");
    const staleOwnerToken = "stale-owner-with-live-claimant";
    await writeFile(
      `${file}.lock`,
      `${JSON.stringify({
        pid: 2_000_000_000,
        host: hostname(),
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerToken: staleOwnerToken,
      })}\n`,
    );
    const claimant = await startRecoveryClaimant(file);
    const before = await readdir(claimant.claimPath);

    const contender = startRacingOwner(file);
    const outcome = await outcomeWithin(contender);
    try {
      assert.equal(outcome, "blocked");
      assert.deepEqual(await readdir(claimant.claimPath), before);
    } finally {
      if (outcome === "ready") contender.child.send("close");
      else contender.child.kill("SIGKILL");
      await waitForExit(contender.child);
      claimant.child.kill("SIGKILL");
      await waitForExit(claimant.child);
    }
  });

  it("keeps a replacement live claim when two dead-claim reapers race", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-reaper-race-"));
    const file = join(dir, "events.jsonl");
    await writeFile(
      `${file}.lock`,
      `${JSON.stringify({
        pid: 2_000_000_000,
        host: hostname(),
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerToken: "stale-owner-reaper-race",
      })}\n`,
    );
    const deadClaimant = await startRecoveryClaimant(file);
    deadClaimant.child.kill("SIGKILL");
    await waitForExit(deadClaimant.child);

    const aBefore = deferred();
    const bBefore = deferred();
    const releaseAReap = deferred();
    const releaseBReap = deferred();
    const aReplacement = deferred();
    const releaseAReplacement = deferred();
    let lockA: ExclusiveFileLock | undefined;
    const acquireA = ExclusiveFileLock.acquire(file, {
      beforeRecoveryClaimReap: async () => {
        aBefore.resolve();
        await releaseAReap.promise;
      },
      afterRecoveryClaimPublished: async () => {
        aReplacement.resolve();
        await releaseAReplacement.promise;
      },
    }).then((lock) => {
      lockA = lock;
      return lock;
    });
    const acquireB = ExclusiveFileLock.acquire(file, {
      beforeRecoveryClaimReap: async () => {
        bBefore.resolve();
        await releaseBReap.promise;
      },
    });

    try {
      await Promise.all([aBefore.promise, bBefore.promise]);
      releaseAReap.resolve();
      await aReplacement.promise;
      releaseBReap.resolve();
      await assert.rejects(acquireB, /recovery.*claimed/i);
      await assert.rejects(() => ExclusiveFileLock.acquire(file), /recovery.*claimed/i);
      releaseAReplacement.resolve();
      const winner = await acquireA;
      assert.equal(winner.owner.ownerToken, lockA?.owner.ownerToken);
      await assert.rejects(() => ExclusiveFileLock.acquire(file), /writer lock.*pid/i);
    } finally {
      releaseAReap.resolve();
      releaseBReap.resolve();
      releaseAReplacement.resolve();
      await Promise.allSettled([acquireA, acquireB]);
      lockA?.release();
    }
  });

  it("repairs a torn final record instead of swallowing the next event", async () => {
    // A process killed mid-write leaves a partial line with no newline. The
    // next append fused onto it, so the FOLLOWING event — whose `append()` had
    // resolved, and which was therefore committed by this store's own contract
    // — silently vanished on the restart after that.
    const dir = await mkdtemp(join(tmpdir(), "pie-store-torn-"));
    const file = join(dir, "events.jsonl");
    const first = await JsonlEventStore.open(file);
    await first.append(evt(1));
    first.close();
    // Simulate the kill: a complete record, then a fragment with no newline.
    await appendFile(file, '{"event_id":"evt-torn","timestamp":"2026-09', "utf-8");

    const second = await JsonlEventStore.open(file);
    assert.equal(second.count(), 1, "the complete record survives");
    await second.append(evt(4));
    second.close();

    const third = await JsonlEventStore.open(file);
    assert.equal(third.count(), 2, "and the event appended afterwards is still there");
    assert.ok(third.get("evt-4"), "an append that resolved must survive the next restart");
    third.close();
  });

  it("serialises an event when it is appended, not when the write drains", async () => {
    // `JSON.stringify` inside the write chain meant the persisted bytes
    // reflected entity state at WRITE time, so a caller that mutated an entity
    // between `append()` and the queued write changed what history recorded.
    const dir = await mkdtemp(join(tmpdir(), "pie-store-snapshot-"));
    const file = join(dir, "events.jsonl");
    const store = await JsonlEventStore.open(file);
    const live = { status: "PENDING" };
    const pending = store.append({ ...evt(9), payload: { run: live } });
    live.status = "COMPLETED"; // mutated before the write drains
    await pending;
    store.close();

    const reopened = await JsonlEventStore.open(file);
    const payload = reopened.all()[0]?.payload.run as { status: string };
    assert.equal(payload.status, "PENDING", "history records what was true when the event was appended");
    reopened.close();
  });

  it("does not release the writer lock while a queued append is still draining", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-close-drain-"));
    const file = join(dir, "events.jsonl");
    const store = await JsonlEventStore.open(file);
    const pending = store.append(evt(10));
    store.close();

    await assert.rejects(() => JsonlEventStore.open(file), /already open|writer lock/i);
    await pending;

    const reopened = await JsonlEventStore.open(file);
    assert.ok(reopened.get("evt-10"));
    reopened.close();
  });

  it("appendAll is one write, so a batch is not half-applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-batch-"));
    const file = join(dir, "events.jsonl");
    const store = await JsonlEventStore.open(file);
    await store.appendAll([evt(1), evt(2), evt(3)]);
    store.close();
    const reopened = await JsonlEventStore.open(file);
    assert.equal(reopened.count(), 3);
    reopened.close();
  });

  it("LedgerEventStoreBackend adapts the existing single-project store", async () => {
    const ledger = EventStore.inMemory();
    const backend = new LedgerEventStoreBackend(ledger);
    await backend.append(evt(1));
    assert.equal(backend.count(), 1);
    assert.equal(backend.get("evt-1")?.project_id, "PRJ-1");
    assert.equal(ledger.count(), 1);
  });

  it("a Platform over a ledger store shares one event model", async () => {
    const ledger = EventStore.inMemory();
    const { Platform } = await import("../../src/platform/index.ts");
    const platform = new Platform({ ledgerStore: ledger });
    const run = platform.graph.createRun({ projectId: "PRJ-1", goal: "g" });
    platform.graph.setRunStatus(run.id, "RUNNING");
    await platform.graph.flush();
    // Both the ledger and the backend see the same events.
    assert.ok(ledger.all().length > 0);
    assert.ok(platform.store.count() > 0);
  });
});
