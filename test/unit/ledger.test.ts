import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/ledger/Ledger.ts";

const actor = { type: "system" as const };

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-eng-ledger-"));
}

test("create work item and query it back", async () => {
  const dir = await tmpDir();
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const wi = await ledger.createWorkItem("implement add", "medium", ["."], actor);
    assert.match(wi.id, /^WI-/);
    assert.equal(ledger.getWorkItem(wi.id)?.goal, "implement add");
    assert.equal(ledger.getWorkItem(wi.id)?.status, "DEFINED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate lifecycle: created -> promoted", async () => {
  const dir = await tmpDir();
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const wi = await ledger.createWorkItem("task", "high", ["."], actor);
    const cand = await ledger.createCandidate(wi.id, "abc123", "pi-eng-x", "/tmp/wt", "implementer", "run1", null, actor);
    assert.equal(cand.status, "CREATED");
    assert.equal(ledger.getWorkItem(wi.id)?.current_candidate_id, cand.id);

    await ledger.promoteCandidate(cand.id, wi.id, actor);
    assert.equal(ledger.getCandidate(cand.id)?.status, "PROMOTED");
    assert.equal(ledger.getWorkItem(wi.id)?.incumbent_candidate_id, cand.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entities are recorded with typed kinds", async () => {
  const dir = await tmpDir();
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const wi = await ledger.createWorkItem("task", "medium", ["."], actor);
    const hyp = await ledger.recordEntity("hypothesis", "retry drops affinity", "open", actor, wi.id, { confidence: 0.6 });
    assert.equal(hyp.kind, "hypothesis");
    assert.equal(hyp.status, "open");
    const find = await ledger.recordEntity("finding", "candidate breaks reconnect", "open", actor, wi.id, { severity: "high" });
    assert.equal(find.severity, "high");
    assert.deepEqual(ledger.listOpenFindings().map((f) => f.id), [find.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger survives reload by replaying events (INV-001, AC-011)", async () => {
  const dir = await tmpDir();
  const file = join(dir, "ledger.jsonl");
  try {
    const ledger1 = await Ledger.create(file);
    const wi = await ledger1.createWorkItem("resumable", "high", ["."], actor);
    const cand = await ledger1.createCandidate(wi.id, "abc", "b", "/tmp/wt", "implementer", "r", null, actor);
    await ledger1.promoteCandidate(cand.id, wi.id, actor);

    // Reopen the same file in a "fresh process".
    const ledger2 = await Ledger.create(file);
    assert.equal(ledger2.getWorkItem(wi.id)?.goal, "resumable");
    assert.equal(ledger2.getWorkItem(wi.id)?.current_candidate_id, cand.id);
    assert.equal(ledger2.getCandidate(cand.id)?.status, "PROMOTED");
    assert.equal(ledger2.getWorkItem(wi.id)?.incumbent_candidate_id, cand.id);
    // The event file is append-only JSONL.
    const raw = await readFile(file, "utf-8");
    assert.ok(raw.trim().split("\n").length >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence is recorded and linked to a candidate", async () => {
  const dir = await tmpDir();
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const wi = await ledger.createWorkItem("task", "medium", ["."], actor);
    const cand = await ledger.createCandidate(wi.id, "abc", "b", null, "implementer", "r", null, actor);
    const ev = await ledger.recordEvidence(cand.id, "verify.test", "node", "node --test", 0, "passed", { passed: true }, ["artifact://verify/x"], "deterministic", wi.id, actor);
    assert.equal(ev.trust, "deterministic");
    assert.deepEqual(ledger.getCandidate(cand.id)?.evidence_ids, [ev.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
