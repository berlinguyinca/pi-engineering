import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { ledgerLinkedPrs } from "../../src/work/linkedPrs.ts";
import { getSessionSummary } from "../../src/work/sessionSummary.ts";
import { formatSessionSummary } from "../../src/work/summaryText.ts";
import type { WorkTask } from "../../src/work/types.ts";
import { emptyWorkGraph } from "../../src/work/types.ts";

const actor = { type: "system" as const };

test("/summary shows the PRs the Ledger recorded for a session's work item and its tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-eng-linked-prs-"));
  try {
    const ledger = await Ledger.create(join(dir, "ledger.jsonl"));
    const wi = await ledger.createWorkItem("goal", "low", ["."], actor);
    const other = await ledger.createWorkItem("other", "low", ["."], actor);
    const t = await ledger.createTask(wi.id, "step", "implementation", "low", actor);
    await ledger.recordPrLink(wi.id, { host: "github.com", owner: "acme", repo: "w", number: 7 }, actor);
    await ledger.recordPrLink(wi.id, { host: "ghe.example", owner: "acme", repo: "w", number: 3 }, actor);
    await ledger.recordPrLink(other.id, { host: "github.com", owner: "acme", repo: "w", number: 99 }, actor);
    const task = (id: string): WorkTask => ({
      id,
      source: "ledger",
      title: id,
      state: "working",
      raw_status: "EXECUTING",
      verification_status: "pending",
      parent_id: null,
      created_at: null,
      updated_at: null,
      run_ids: [],
      session_ids: ["S"],
    });
    const graph = { ...emptyWorkGraph(), tasks: [task(wi.id), task(t.id)] };
    const s = getSessionSummary(graph, "S", { linkedPrs: ledgerLinkedPrs(ledger) });
    assert.deepEqual(s.linked_prs, ["acme/w#7", "ghe.example/acme/w#3"]);
    assert.match(formatSessionSummary(s), /PRs: acme\/w#7, ghe\.example\/acme\/w#3/);
    assert.deepEqual(getSessionSummary(graph, "S").linked_prs, [], "no resolver, no PRs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
