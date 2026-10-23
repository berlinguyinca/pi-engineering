/**
 * Acceptance scenario 1 (standalone), up to worker spawn: a local goal is
 * planned with a risk-based review policy, Plannotator skipped or approved,
 * with no network and no AutoSpec / GitHub / Herdr / InferWeave.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runExternalEntry } from "../../src/orchestration/externalEntry.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { runStandalonePlan } from "../../src/orchestration/standaloneEntry.ts";
import { PlannotatorAdapter } from "../../src/platform/Plannotator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const CLEAN_ENV: NodeJS.ProcessEnv = {}; // no PI_AUTOSPEC_*, no GitHub/Herdr/InferWeave variables

async function run(args: string[], body: unknown, deps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runStandalonePlan(
    args,
    JSON.stringify(body),
    CLEAN_ENV,
    { write: (t) => out.push(t), error: (t) => err.push(t) },
    deps,
  );
  return { code, out: out.join(""), err: err.join(""), json: out.length ? JSON.parse(out.join("")) : null };
}

describe("standalone plan flow", () => {
  let realFetch: typeof fetch;
  let fetches = 0;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetches = 0;
    globalThis.fetch = (() => {
      fetches++;
      return Promise.reject(new Error("network is off in this test"));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("low-risk goal: reviewed by policy as skip, may proceed, ledger holds revision + policy + decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-standalone-"));
    const r = await run(["--store", dir], {
      goal: "fix a typo in the readme",
      tasks: [{ objective: "fix a typo in the readme", write_domains: ["README.md"] }],
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.result, "may_proceed");
    assert.equal(r.json.riskClass, "low");
    assert.equal(r.json.mode, "skip");
    assert.equal(r.json.outcome, "skipped");
    assert.match(r.json.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(fetches, 0);

    const backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
    const store = MissionStore.open(backend);
    const id = r.json.missionId as string;
    assert.ok(store.getMission(id));
    assert.equal(store.listPlanRevisions(id)[0]?.planDigest, r.json.planDigest);
    assert.equal(store.listPlanPolicies(id)[0]?.source, "risk_default");
    assert.equal(store.listPlanDecisions(id)[0]?.proceed, true);
    assert.equal(store.listTasks(id).length, 0, "no worker task is created by the plan stage");
    backend.close();
  });

  it("high-risk goal without Plannotator blocks; an explicit reasoned override proceeds and is recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-standalone-"));
    const req = {
      goal: "rotate auth token handling",
      tasks: [{ objective: "change login token handling", write_domains: ["src/auth/**"] }],
    };
    const blocked = await run(["--store", dir], req);
    assert.equal(blocked.code, 1);
    assert.equal(blocked.json.result, "blocked");
    assert.equal(blocked.json.code, "plannotator_unavailable");
    assert.equal(blocked.json.mode, "require");

    const noReason = await run(["--store", dir, "--review", "skip"], req);
    assert.equal(noReason.code, 2);
    assert.match(noReason.err, /reason/);

    const ok = await run(
      ["--store", dir, "--review", "skip", "--reason", "offline hotfix", "--operator", "alice"],
      req,
    );
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.json.mode, "skip");
    const backend = await JsonlEventStore.open(join(dir, "orchestration.jsonl"));
    const store = MissionStore.open(backend);
    const policies = store.listPlanPolicies(ok.json.missionId);
    assert.deepEqual(
      policies.map((p) => p.source),
      ["risk_default", "override"],
    );
    assert.equal(policies[1]?.overrideReason, "offline hotfix");
    assert.equal(store.listPlanRevisions(ok.json.missionId).length, 1, "same plan, same digest, one revision");
    backend.close();
  });

  it("high-risk goal approved by an injected Plannotator bound to the digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-standalone-"));
    const adapter = new PlannotatorAdapter({
      transport: {
        submitPlan: async (p) => ({
          decision: "approved",
          externalDecisionId: "X1",
          approvedBy: "reviewer",
          planDigest: p.planDigest,
        }),
      },
    });
    const r = await run(
      ["--store", dir],
      { goal: "g", tasks: [{ objective: "change login token handling", write_domains: ["src/auth/**"] }] },
      { adapter },
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.outcome, "approved");
    assert.equal(fetches, 0);
  });

  it("is idempotent for the same goal and refuses a nested mission worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-standalone-"));
    const body = { goal: "tidy docs", tasks: [{ objective: "tidy docs", write_domains: ["docs/x.md"] }] };
    const a = await run(["--store", dir], body);
    const b = await run(["--store", dir], body);
    assert.equal(a.json.missionId, b.json.missionId);
    assert.equal(a.json.planDigest, b.json.planDigest);
    const out: string[] = [];
    const code = await runStandalonePlan(
      ["--store", dir],
      JSON.stringify(body),
      { PI_MISSION_DEPTH: "1" },
      { write: (t) => out.push(t), error: () => {} },
    );
    assert.equal(code, 2);
  });

  it("does not change the AutoSpec-gated external entry contract (still off without the flag)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-standalone-"));
    const err: string[] = [];
    const code = await runExternalEntry(["submit", "--store", dir], "{}", CLEAN_ENV, { error: (t) => err.push(t) });
    assert.equal(code, 2);
    assert.match(err.join(""), /PI_AUTOSPEC_ENABLED/);
  });
});
