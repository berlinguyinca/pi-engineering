// Exercises the Herdr connection layer; opts back in from the harness-wide
// HERDR_DISABLED default (test/support/isolatedState.ts).
delete process.env.HERDR_DISABLED;
/**
 * T16 wiring: the plan CLIs (standalone `plan` and `plan --from-autospec`) project the mission, the plan revision, its
 * digest, the review decision and the AutoSpec issue DAG into Herdr through the global-YAML emitter. The recorded
 * requests are the proof; each assertion fails when the caller is removed.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runStandalonePlan } from "../../src/orchestration/standaloneEntry.ts";

type Rec = Record<string, any>;
const dagFixture = JSON.parse(
  readFileSync(new URL("../fixtures/autospec-dag/valid.json", import.meta.url), "utf8"),
) as { mission: Rec; tasks: Rec[] };

interface Setup {
  root: string;
  agent: string;
  state: string;
  store: string;
  key: string;
  calls: Rec[];
  fetch: typeof globalThis.fetch;
}

function setup(herdrBlock: string | null, extraYaml = ""): Setup {
  const root = mkdtempSync(join(tmpdir(), "pi-plan-lineage-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const key = randomBytes(12).toString("hex"); // built at run time, never a literal
  const keyFile = join(agent, "ingest.key");
  writeFileSync(keyFile, `${key}\n`);
  chmodSync(keyFile, 0o600);
  const yaml =
    (herdrBlock === null
      ? ""
      : `herdr:\n  url: http://127.0.0.1:9\n  api_key_file: ${keyFile}\n  instance_id: pi-plan-1\n${herdrBlock}`) +
    extraYaml;
  if (yaml) writeFileSync(join(agent, "engineering.yaml"), yaml);
  const calls: Rec[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { root, agent, state: join(root, "state"), store: join(root, "store"), key, calls, fetch };
}

async function plan(s: Setup, args: string[], stdin: unknown) {
  let out = "";
  let err = "";
  const code = await runStandalonePlan(
    ["--store", s.store, ...args],
    stdin === undefined ? "" : JSON.stringify(stdin),
    { PI_CODING_AGENT_DIR: s.agent, HOME: s.root },
    {
      write: (t) => {
        out += t;
      },
      error: (t) => {
        err += t;
      },
    },
    { cwd: s.root, lineageDir: s.state, fetch: s.fetch },
  );
  return { code, out, err, json: out ? (JSON.parse(out.trim().split("\n").pop() as string) as Rec) : null };
}

const events = (s: Setup) => s.calls.map((c) => c.body).sort((a, b) => a.source_sequence - b.source_sequence);
const byType = (s: Setup, type: string) => events(s).filter((e) => e.event_type === type);

const LOW = { goal: "tidy the docs", tasks: [{ objective: "tidy the docs", write_domains: ["docs/x.md"] }] };

describe("standalone plan CLI -> Herdr", () => {
  it("projects the mission, the plan revision with its digest, the decision and the produced edge", async () => {
    const s = setup("  lineage: true\n  visibility: room\n  room_id: room-7\n");
    const r = await plan(s, [], LOW);
    assert.equal(r.code, 0, r.err);
    const mission = `mission:${r.json?.missionId}`;
    const planNode = `plan:${r.json?.missionId}/${r.json?.revision}`;
    const upserts = byType(s, "node.upsert");
    const m = upserts.find((e) => e.payload.node_id === mission);
    assert.ok(m, "mission node was sent");
    assert.equal(m.payload.state, "pending");
    assert.equal(m.payload.label, "tidy the docs");
    const p = upserts.find((e) => e.payload.node_id === planNode);
    assert.equal(p?.payload.attrs.plan_digest, r.json?.planDigest, "the digest on the node is the CLI's digest");
    const decision = byType(s, "node.state").find((e) => e.payload.node_id === planNode);
    assert.ok(decision, "the review decision (skipped by policy) reached Herdr");
    const edge = byType(s, "edge.add").find((e) => e.payload.edge_type === "produced");
    assert.deepEqual([edge?.payload.from_id, edge?.payload.to_id], [mission, planNode]);
    // the mission node precedes the edge that needs it (Herdr refuses an edge to an undefined node)
    assert.ok(m.source_sequence < edge?.source_sequence);
    // scope, visibility, key and instance come from the YAML through the emitter
    for (const e of events(s)) {
      assert.equal(e.room_id, "room-7");
      assert.equal(e.visibility_scope, "room");
    }
    assert.ok(s.calls.every((c) => c.headers.get("x-api-key") === s.key));
    assert.equal(m.payload.attrs.instance_id, "pi-plan-1");
  });

  it("an approved Plannotator decision becomes a reviewed edge bound to the plan digest", async () => {
    const s = setup("  lineage: true\n  visibility: room\n");
    const { PlannotatorAdapter } = await import("../../src/platform/Plannotator.ts");
    const approving = new PlannotatorAdapter({
      transport: {
        submitPlan: async (p: { planDigest?: string }) => ({
          decision: "approved" as const,
          externalDecisionId: "E1",
          approvedBy: "ops",
          planDigest: p.planDigest ?? "",
        }),
      },
    });
    let out = "";
    const code = await runStandalonePlan(
      ["--store", s.store, "--review", "require", "--reason", "test"],
      JSON.stringify(LOW),
      { PI_CODING_AGENT_DIR: s.agent, HOME: s.root },
      {
        write: (t) => {
          out += t;
        },
        error: () => undefined,
      },
      { cwd: s.root, lineageDir: s.state, fetch: s.fetch, adapter: approving },
    );
    assert.equal(code, 0, out);
    const reviewed = byType(s, "edge.add").find((e) => e.payload.edge_type === "reviewed");
    assert.ok(reviewed, "a reviewed edge was sent");
    assert.equal(reviewed.payload.attrs.plan_digest, JSON.parse(out).planDigest);
    assert.equal(reviewed.payload.attrs.decision, "approved");
  });

  it("no herdr: block (or lineage not true): no request, same result, same exit code", async () => {
    for (const block of [null, "  lineage: false\n"]) {
      const s = setup(block);
      const r = await plan(s, [], LOW);
      assert.equal(r.code, 0, r.err);
      assert.equal(s.calls.length, 0);
    }
  });

  it("an unreachable control plane never changes the result or the exit code", async () => {
    const s = setup("  lineage: true\n");
    const refuse = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const dead = { ...s, fetch: refuse };
    const r = await plan(dead, [], LOW);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json?.result, "may_proceed");
  });
});

describe("plan --from-autospec -> Herdr", () => {
  function dagInput(s: Setup): string {
    const d = structuredClone(dagFixture);
    d.mission.state = "PLANNED";
    d.tasks[1]!.executor = "pi-local";
    d.tasks[0]!.required_extensions = ["autospec.issue_refs"];
    d.tasks[0]!.extensions = { "autospec.issue_refs": ["acme/widgets#12", "acme/other#3"] };
    const file = join(s.root, "dag.json");
    writeFileSync(file, JSON.stringify(d));
    return file;
  }

  it("projects the DAG's issues (fields, no invented state), the task links and the dependency edges", async () => {
    const s = setup("  lineage: true\n  visibility: room\n", "autospec:\n  dag:\n    enabled: true\n");
    const r = await plan(s, ["--from-autospec", dagInput(s)], undefined);
    assert.equal(r.code, 0, r.err);
    const missionId = r.json?.missionId as string;
    const upserts = byType(s, "node.upsert");
    for (const id of ["issue:github.com/acme/widgets#12", "issue:github.com/acme/other#3"]) {
      const n = upserts.find((e) => e.payload.node_id === id);
      assert.ok(n, id);
      assert.equal(n.payload.state, undefined, "Pi has not asked GitHub: no state is invented");
      assert.ok(n.payload.label && n.payload.attrs.number, "a field-bearing upsert, not a bare ensure");
    }
    const links = byType(s, "edge.add").filter((e) => e.payload.edge_type === "issue_link");
    assert.deepEqual(links.map((e) => e.payload.to_id).sort(), [
      "issue:github.com/acme/other#3",
      "issue:github.com/acme/widgets#12",
    ]);
    assert.ok(links.every((e) => e.payload.from_id === `task:${missionId}/t-1`));
    const deps = byType(s, "edge.add").filter((e) => e.payload.edge_type === "dependency");
    assert.deepEqual(
      deps.map((e) => [e.payload.from_id, e.payload.to_id]),
      [[`task:${missionId}/t-2`, `task:${missionId}/t-1`]],
    );
    // each issue node is defined before the edge that uses it
    for (const e of links) {
      const def = upserts.find((u) => u.payload.node_id === e.payload.to_id);
      assert.ok((def?.source_sequence ?? 1e9) < e.source_sequence, e.payload.to_id);
    }
    assert.ok(upserts.some((e) => e.payload.node_id === `mission:${missionId}`));
  });

  it("DAG refused (not enabled / bad executor): nothing is sent", async () => {
    const s = setup("  lineage: true\n", "");
    const r = await plan(s, ["--from-autospec", dagInput(s)], undefined);
    assert.equal(r.code, 2);
    assert.equal(s.calls.length, 0);
  });
});
