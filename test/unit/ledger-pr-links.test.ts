import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalId } from "../../src/github/refs.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { LedgerTransitions } from "../../src/runtime/ledgerTransitions.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { ledgerTaskRefs } from "../../src/work/taskRefs.ts";
import { generateEvents } from "../support/ledgerEventGen.ts";

const actor = { type: "system" as const };
const PR = { host: "github.com", owner: "Acme", repo: "Widgets", number: 7 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pi-eng-prlink-"));
  dirs.push(d);
  return join(d, "ledger.jsonl");
};
const NOW = Date.parse("2026-01-05T00:00:00Z");
const popts = () => ({ now: () => NOW, staleAfterMs: 3_600_000 });

describe("work_item.pr_linked", () => {
  it("round-trips through the log and replays identically, de-duplicating a repeated PR", async () => {
    const f = file();
    const ledger = await Ledger.create(f);
    const wi = await ledger.createWorkItem("g", "low", ["."], actor);
    assert.equal(await ledger.recordPrLink(wi.id, PR, actor), true);
    assert.equal(await ledger.recordPrLink(wi.id, { ...PR, owner: "acme" }, actor), false);
    assert.equal(await ledger.recordPrLink("WI-nope", PR, actor), false);
    const expected = [{ ...PR, url_canonical: "https://github.com/Acme/Widgets/pull/7" }];
    assert.deepEqual(ledger.listPrLinks(wi.id), expected);
    const replay = await Ledger.create(f);
    assert.deepEqual(replay.listPrLinks(wi.id), expected);
    assert.equal(
      readFileSync(f, "utf-8")
        .split("\n")
        .filter((l) => l.includes("work_item.pr_linked")).length,
      1,
    );
  });

  it("an old log without the event replays unchanged, and a malformed event is ignored", async () => {
    const f = file();
    const ledger = await Ledger.create(f);
    const wi = await ledger.createWorkItem("g", "low", ["."], actor);
    const before = JSON.stringify(ledger.getWorkItem(wi.id));
    await ledger.emitEvent("work_item.pr_linked", wi.id, actor, { host: "github.com", number: "x" });
    const replay = await Ledger.create(f);
    assert.deepEqual(replay.listPrLinks(wi.id), []);
    assert.equal(JSON.stringify(replay.getWorkItem(wi.id)), before);
  });

  it("is written through the guarded transition API", async () => {
    const ledger = await Ledger.create(file());
    const wi = await ledger.createWorkItem("g", "low", ["."], actor);
    const t = new LedgerTransitions({ ledger, authorityGeneration: 1, strictCompletion: false });
    assert.equal(await t.linkPullRequest(wi.id, PR, actor), true);
    assert.equal(await t.linkPullRequest(wi.id, PR, actor), false);
    assert.equal(ledger.listPrLinks(wi.id).length, 1);
    const ev = ledger.events(wi.id).find((e) => e.type === "work_item.pr_linked");
    assert.equal(ev?.authority_generation, 1);
  });

  it("ledgerTaskRefs emits the same pr node id a Mission-origin link has", async () => {
    const ledger = await Ledger.create(file());
    const wi = await ledger.createWorkItem("g", "low", ["."], actor);
    await ledger.recordPrLink(wi.id, PR, actor);
    const mission = canonicalId({ host: "github.com", owner: "acme", repo: "widgets", number: 7, kind: "pr" });
    const refs = ledgerTaskRefs(ledger)({ id: wi.id, source: "ledger" } as never);
    assert.deepEqual(refs?.prs, [mission]);
    assert.equal(mission, "pr:github.com/acme/widgets#7");
    // A Mission link for the same PR and a Ledger link collapse to one id.
    const both = ledgerTaskRefs(ledger, {
      githubLinks: () => [
        { status: "active", targetKind: "pr", target: mission, subject: { kind: "task", id: wi.id } } as never,
      ],
    })({ id: wi.id, source: "ledger" } as never);
    assert.deepEqual(both?.prs, [mission]);
  });

  it("the incremental work projection still equals a full replay with PR events in the log", async () => {
    const f = file();
    const evs = generateEvents({ events: 400, seed: 3 });
    const ledger = await Ledger.create(f);
    const incremental = new LedgerWorkProjection(ledger, popts());
    const ids = new Set<string>();
    for (const e of evs) {
      await ledger.emitEvent(e.type, e.work_item_id, e.actor, e.payload, {
        ...(e.run_id ? { run_id: e.run_id } : {}),
        ...(e.task_id ? { task_id: e.task_id } : {}),
        ...(e.session_id ? { session_id: e.session_id } : {}),
      });
      if (e.work_item_id && !ids.has(e.work_item_id) && ledger.getWorkItem(e.work_item_id)) {
        ids.add(e.work_item_id);
        await ledger.recordPrLink(e.work_item_id, { ...PR, number: ids.size }, actor);
        if (ids.size % 5 === 0) incremental.graph();
      }
    }
    assert.ok(ids.size > 0);
    assert.deepEqual(incremental.graph(), new LedgerWorkProjection(ledger, popts()).graph());
  });
});
