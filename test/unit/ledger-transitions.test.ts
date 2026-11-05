import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { claimAuthorityGeneration } from "../../src/ledger/authority.ts";
import { LedgerTransitions } from "../../src/runtime/ledgerTransitions.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { formatWorkStatus } from "../../src/work/statusText.ts";

const actor = { type: "system" as const };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pi-ledger-tr-"));
  dirs.push(d);
  return d;
};

async function promotedWorkItem(ledger: Ledger): Promise<string> {
  const wi = await ledger.createWorkItem("do the thing", "low", ["/r"], actor);
  const c = await ledger.createCandidate(wi.id, "base", "b", null, "implementer", "run-c", null, actor);
  await ledger.recordEvidence(c.id, "test", "unit", null, 0, "passed", {}, [], "deterministic", wi.id, actor);
  await ledger.promoteCandidate(c.id, wi.id, actor);
  return wi.id;
}

const startRun = (ledger: Ledger, wi: string, run: string) =>
  ledger.emitEvent("agent.started", wi, { type: "agent", run_id: run }, {}, { task_id: wi, run_id: run });

describe("completion policy on the Ledger path", () => {
  it("accepts completion when nothing is live and verification passed", async () => {
    const ledger = await Ledger.create(join(tmp(), "l.jsonl"));
    const wi = await promotedWorkItem(ledger);
    const tr = new LedgerTransitions({ ledger, authorityGeneration: 1, strictCompletion: true });
    const v = await tr.settleWorkItem(wi, "COMPLETED", actor);
    assert.deepEqual(v, { applied: true, blockers: [] });
    assert.equal(ledger.getWorkItem(wi)?.status, "COMPLETED");
  });

  it("refuses completion with a live run, records why, and shows it in /work", async () => {
    const ledger = await Ledger.create(join(tmp(), "l.jsonl"));
    const wi = await promotedWorkItem(ledger);
    await startRun(ledger, wi, "run-live");
    const tr = new LedgerTransitions({ ledger, authorityGeneration: 1, strictCompletion: true });
    const v = await tr.settleWorkItem(wi, "COMPLETED", actor);
    assert.equal(v.applied, false);
    assert.match(v.blockers.join(), /run-live is active/);
    const item = ledger.getWorkItem(wi);
    assert.equal(item?.status, "BLOCKED");
    assert.match(item?.blocked_reason ?? "", /run-live is active/);
    assert.match(formatWorkStatus(new LedgerWorkProjection(ledger).graph()), /blocked: run run-live is active/);
  });

  it("refuses a plan task whose work did not verify, leaving it blocked with the reason", async () => {
    const ledger = await Ledger.create(join(tmp(), "l.jsonl"));
    const plan = await ledger.createWorkItem("plan", "low", ["/r"], actor);
    const task = await ledger.createTask(plan.id, "t", "implementation", "low", actor, [], []);
    const result = await ledger.createWorkItem("result", "low", ["/r"], actor);
    await ledger.createCandidate(result.id, "base", "b", null, "implementer", "run-c", null, actor); // no evidence
    const tr = new LedgerTransitions({ ledger, authorityGeneration: 1, strictCompletion: true });
    await tr.settleTask(task.id, "started", plan.id, actor);
    const v = await tr.settleTask(task.id, "completed", plan.id, actor, result.id);
    assert.equal(v.applied, false);
    assert.equal(ledger.getTask(task.id)?.status, "blocked");
    assert.match(ledger.getTask(task.id)?.blocked_reason ?? "", /verification is pending/);
  });

  it("strict_completion: false keeps the unchecked behaviour", async () => {
    const ledger = await Ledger.create(join(tmp(), "l.jsonl"));
    const wi = await promotedWorkItem(ledger);
    await startRun(ledger, wi, "run-live");
    const tr = new LedgerTransitions({ ledger, authorityGeneration: 1, strictCompletion: false });
    assert.equal((await tr.settleWorkItem(wi, "COMPLETED", actor)).applied, true);
    assert.equal(ledger.getWorkItem(wi)?.status, "COMPLETED");
  });
});

describe("revision and generation guards on the Ledger path", () => {
  it("re-reads once after a second writer and re-evaluates instead of retrying the stale verdict", async () => {
    const file = join(tmp(), "l.jsonl");
    const a = await Ledger.create(file);
    const wi = await promotedWorkItem(a);
    const b = await Ledger.create(file);
    await startRun(b, wi, "run-other"); // a has not seen this yet; its first verdict would say "complete"
    const tr = new LedgerTransitions({ ledger: a, authorityGeneration: 1, strictCompletion: true });
    const v = await tr.settleWorkItem(wi, "COMPLETED", actor);
    assert.equal(v.applied, false, "the retry saw the other writer's live run");
    assert.match(v.blockers.join(), /run-other is active/);
    assert.equal(a.getWorkItem(wi)?.status, "BLOCKED");
  });

  it("surfaces a clear error and writes nothing when the item keeps changing under it", async () => {
    const file = join(tmp(), "l.jsonl");
    const a = await Ledger.create(file);
    const wi = await promotedWorkItem(a);
    const b = await Ledger.create(file);
    const update = a.updateWorkItem.bind(a);
    let n = 0;
    a.updateWorkItem = async (...args) => {
      await b.emitEvent("entity.updated", wi, actor, { entity: { id: `x${n++}` } }); // another writer wins every race
      return update(...args);
    };
    const tr = new LedgerTransitions({ ledger: a, authorityGeneration: 1, strictCompletion: true });
    await assert.rejects(tr.settleWorkItem(wi, "COMPLETED", actor), /not applied: .* changed under this runtime twice/);
    assert.notEqual(a.getWorkItem(wi)?.status, "COMPLETED");
    assert.equal(b.getWorkItem(wi)?.status, "DEFINED");
  });

  it("rejects a runtime whose generation was superseded and leaves the status unchanged", async () => {
    const file = join(tmp(), "l.jsonl");
    const a = await Ledger.create(file);
    const wi = await promotedWorkItem(a);
    await a.updateWorkItem(wi, { status: "EXECUTING" }, actor, { authority_generation: 2 }); // a newer owner wrote
    const stale = new LedgerTransitions({ ledger: a, authorityGeneration: 1, strictCompletion: true });
    await assert.rejects(stale.settleWorkItem(wi, "COMPLETED", actor), /superseded by generation 2/);
    assert.equal(a.getWorkItem(wi)?.status, "EXECUTING");
    const current = new LedgerTransitions({ ledger: a, authorityGeneration: 2, strictCompletion: true });
    assert.equal((await current.settleWorkItem(wi, "COMPLETED", actor)).applied, true);
  });
});

describe("claimAuthorityGeneration", () => {
  it("is strictly increasing across claims and never below the log's highest generation", async () => {
    const file = join(tmp(), "l.jsonl");
    assert.equal(await claimAuthorityGeneration(file), 1);
    assert.equal(await claimAuthorityGeneration(file), 2);
    assert.equal(readFileSync(`${file}.generation`, "utf-8").trim(), "2");
    assert.equal(await claimAuthorityGeneration(file, 7), 8);
    const results = await Promise.all([1, 2, 3, 4].map(() => claimAuthorityGeneration(file)));
    assert.deepEqual(
      [...results].sort((x, y) => x - y),
      [9, 10, 11, 12],
    );
  });
});
