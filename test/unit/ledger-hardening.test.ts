import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger, LedgerAuthorityStaleError, LedgerRevisionConflictError } from "../../src/ledger/Ledger.ts";
import { reclaimStaleLock } from "../../src/ledger/fileLock.ts";

const actor = { type: "system" as const };
const writer = join(import.meta.dirname, "..", "support", "ledgerBatchWriter.ts");

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ledger-hard-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const types = (l: Ledger, wi: string) => l.events(wi).map((e) => e.type);

test("typed helpers honour expected_revision and write nothing when it is stale", async () => {
  const l = Ledger.fromEvents([]);
  const wi = await l.createWorkItem("g", "low", [], actor);
  const rev = l.revision(wi.id);
  const stale = { guard: { expected_revision: rev - 1 } };
  const before = l.count();
  await assert.rejects(l.updateWorkItem(wi.id, { goal: "x" }, actor, stale), LedgerRevisionConflictError);
  await assert.rejects(
    l.createTask(wi.id, "t", "implementation", "low", actor, [], [], stale),
    LedgerRevisionConflictError,
  );
  await assert.rejects(l.recordEntity("fact", "c", "verified", actor, wi.id, {}, stale), LedgerRevisionConflictError);
  assert.equal(l.count(), before);
  assert.equal(l.getWorkItem(wi.id)?.goal, "g", "a rejected write leaves memory untouched");
  await l.updateWorkItem(wi.id, { goal: "y" }, actor, { guard: { expected_revision: rev } });
  assert.equal(l.getWorkItem(wi.id)?.goal, "y");
});

test("authority_generation is stamped on helper events and fences lower generations", async () => {
  const l = Ledger.fromEvents([]);
  const wi = await l.createWorkItem("g", "low", [], actor, { authority_generation: 3 });
  const task = await l.createTask(wi.id, "t", "implementation", "low", actor, [], [], { authority_generation: 3 });
  await assert.rejects(
    l.setTaskStatus(task.id, "completed", wi.id, actor, { authority_generation: 2 }),
    LedgerAuthorityStaleError,
  );
  await l.setTaskStatus(task.id, "completed", wi.id, actor, { authority_generation: 4 });
  assert.equal(l.getTask(task.id)?.status, "completed");
  assert.ok(l.events(wi.id).every((e) => e.authority_generation !== undefined));
});

test("a stale updateEntityStatus leaves no phantom in-memory change", async () => {
  const l = Ledger.fromEvents([]);
  const wi = await l.createWorkItem("g", "low", [], actor);
  const e = await l.recordEntity("finding", "bug", "open", actor, wi.id);
  await assert.rejects(
    l.updateEntityStatus(e.id, "resolved", wi.id, actor, { guard: { expected_revision: 0 } }),
    LedgerRevisionConflictError,
  );
  assert.equal(l.getEntity(e.id)?.status, "open");
});

test("multi-event helpers: fenced write appends none, unfenced keeps content and order", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const l = await Ledger.create(file);
    const wi = await l.createWorkItem("g", "low", [], actor);
    const lines = () => readFileSync(file, "utf-8").split("\n").filter(Boolean).length;
    const n = lines();
    await assert.rejects(
      l.createCandidate(wi.id, "b", "br", null, "implementer", "r1", null, actor, { guard: { expected_revision: 99 } }),
      LedgerRevisionConflictError,
    );
    assert.equal(lines(), n, "neither candidate.created nor work_item.updated was written");
    assert.equal(l.listCandidates(wi.id).length, 0);

    const c = await l.createCandidate(wi.id, "b", "br", null, "implementer", "r1", null, actor, {
      guard: { expected_revision: l.revision(wi.id) },
    });
    assert.deepEqual(types(l, wi.id).slice(-2), ["candidate.created", "work_item.updated"]);
    assert.equal(l.getWorkItem(wi.id)?.current_candidate_id, c.id);

    await assert.rejects(
      l.promoteCandidate(c.id, wi.id, actor, { guard: { expected_revision: 0 } }),
      LedgerRevisionConflictError,
    );
    await l.promoteCandidate(c.id, wi.id, actor, { guard: { expected_revision: l.revision(wi.id) } });
    assert.deepEqual(types(l, wi.id).slice(-2), ["candidate.promoted", "work_item.updated"]);
    assert.equal(l.getCandidate(c.id)?.status, "PROMOTED");

    const rev = l.revision(wi.id);
    await assert.rejects(
      l.recordEvidence(c.id, "test", "t", null, 0, "passed", {}, [], "deterministic", wi.id, actor, {
        guard: { expected_revision: rev - 1 },
      }),
      LedgerRevisionConflictError,
    );
    assert.deepEqual(l.getCandidate(c.id)?.evidence_ids, [], "candidate not mutated by a rejected write");
    const ev = await l.recordEvidence(c.id, "test", "t", null, 0, "passed", {}, [], "deterministic", wi.id, actor, {
      guard: { expected_revision: rev },
    });
    assert.deepEqual(types(l, wi.id).slice(-2), ["evidence.recorded", "candidate.changed"]);
    assert.deepEqual(l.getCandidate(c.id)?.evidence_ids, [ev.id]);
    assert.deepEqual((await Ledger.create(file)).getCandidate(c.id)?.evidence_ids, [ev.id], "replay agrees");
  });
});

test("concurrent processes never split a multi-event write", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "ledger.jsonl");
    const run = (tag: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [writer, file, tag, "25"], { stdio: ["ignore", "pipe", "inherit"] });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`))));
      });
    await Promise.all(["a", "b", "c", "d"].map(run));
    const evs = readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x) as { type: string; work_item_id: string });
    assert.equal(evs.length, 200);
    for (let i = 0; i < evs.length; i += 2) {
      assert.equal(evs[i]?.type, "candidate.created", `pair ${i / 2} starts with its candidate`);
      assert.equal(evs[i + 1]?.type, "work_item.updated", `pair ${i / 2} ends with its work item update`);
      assert.equal(evs[i]?.work_item_id, evs[i + 1]?.work_item_id, "the pair belongs to one writer");
    }
    assert.equal(existsSync(`${file}.lock`), false);
  });
});

test("lock reclaim: a truly stale lock is removed", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "x.lock");
    const raw = JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), token: "old", acquired_at: "t" });
    writeFileSync(path, raw);
    assert.equal(reclaimStaleLock(path, { raw }), "removed");
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("lock reclaim: a lock re-created after the stale judgement is restored intact, not deleted", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "x.lock");
    const judged = JSON.stringify({ pid: 1, host: "h", token: "old", acquired_at: "t" });
    const live = JSON.stringify({ pid: process.pid, host: hostname(), token: "live", acquired_at: "t2" });
    writeFileSync(path, live); // a new owner took the lock after the reclaimer judged `judged`
    assert.equal(reclaimStaleLock(path, { raw: judged }), "restored");
    assert.equal(readFileSync(path, "utf-8"), live);
    assert.deepEqual(readdirSync(dir), ["x.lock"], "no aside file left behind");
  });
});

test("lock reclaim: with nothing to reclaim it is a no-op", async () => {
  await withDir(async (dir) => {
    assert.equal(reclaimStaleLock(join(dir, "none.lock"), { raw: "{}" }), "raced");
  });
});
