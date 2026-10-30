import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitLinkRecorded } from "../../src/github/lineage.ts";
import type { GithubLinkRecord } from "../../src/github/types.ts";
import type { EnvelopeDraft } from "../../src/runtime/herdr/envelope.ts";
import { LineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { emitWorkTaskLineage } from "../../src/work/taskLineage.ts";
import { type TaskRefs, ledgerTaskRefs, prRefsFromLinks } from "../../src/work/taskRefs.ts";
import { type WorkGraph, emptyWorkGraph } from "../../src/work/types.ts";

const SHA = "a".repeat(40);
const PR = "pr:github.com/o/r#7";

function rig() {
  const drafts: EnvelopeDraft[] = [];
  const lineage = new LineageEmitter({ sink: { stage: async (d) => void drafts.push(d) }, source: "pi-test" });
  return { drafts, lineage };
}
const edges = (d: EnvelopeDraft[]) => d.filter((x) => x.event_type === "edge.add").map((x) => x.payload as any);

const graph = (): WorkGraph => ({
  ...emptyWorkGraph(),
  tasks: [
    {
      id: "wi_1",
      source: "ledger",
      title: "t",
      state: "working",
      raw_status: "x",
      verification_status: "unknown",
      parent_id: null,
      created_at: null,
      updated_at: null,
      run_ids: [],
      session_ids: [],
    },
  ],
});

const refs: TaskRefs = {
  commits: [SHA],
  prs: [PR],
  plans: [{ missionId: "m1", revision: 2, digest: "d".repeat(64), artifact: { id: "art1", version: "v3" } }],
  evidence: [
    { id: "ev1", type: "verify.test", passed: true, commit: SHA },
    { id: "ev2", type: "verify.lint", passed: false, commit: SHA },
    { id: "ev3", type: "verify.unbound", passed: true },
  ],
};

describe("task graph edges", () => {
  it("emits commit, pr, plan and validated edges with contract kinds only", () => {
    const { drafts, lineage } = rig();
    emitWorkTaskLineage(lineage, graph(), new Map(), () => refs);
    const e = edges(drafts);
    const find = (type: string, to: string) => e.find((x) => x.edge_type === type && x.to_id === to);
    assert.ok(find("produced", `commit:${SHA}`));
    assert.ok(find("issue_link", PR));
    const plan = find("dependency", "plan:m1/2");
    assert.equal(plan.from_id, "task:wi_1");
    assert.equal(plan.attrs.plan_artifact_id, "art1");
    assert.equal(plan.attrs.plan_digest, "d".repeat(64));
    assert.equal(find("validated", `commit:${SHA}`).from_id, "artifact:evidence/ev1");
    assert.equal(find("validated", `commit:${SHA}`).attrs.commit, SHA);
    // failed or unbound evidence validates nothing, but the evidence is still linked
    assert.equal(e.filter((x) => x.edge_type === "validated").length, 1);
    assert.ok(find("produced", "artifact:evidence/ev2"));
    for (const x of e)
      assert.ok(["produced", "issue_link", "dependency", "validated", "delegation"].includes(x.edge_type));
  });

  it("does not label or state the commons nodes it links", () => {
    const { drafts, lineage } = rig();
    emitWorkTaskLineage(lineage, graph(), new Map(), () => refs);
    const upserts = drafts.filter((x) => x.event_type === "node.upsert").map((x) => x.payload as any);
    for (const id of [PR, `commit:${SHA}`]) {
      for (const u of upserts.filter((x) => x.node_id === id))
        assert.deepEqual(Object.keys(u).sort(), ["node_id", "node_type"]);
    }
  });

  it("is idempotent per sync and re-reads refs while the task is live", () => {
    const { drafts, lineage } = rig();
    const seen = new Map<string, string>();
    let current: TaskRefs = { ...refs, evidence: [] };
    emitWorkTaskLineage(lineage, graph(), seen, () => current);
    const n = drafts.length;
    emitWorkTaskLineage(lineage, graph(), seen, () => current);
    assert.equal(drafts.length, n);
    current = { ...current, commits: [SHA, "b".repeat(40)] };
    emitWorkTaskLineage(lineage, graph(), seen, () => current);
    assert.ok(drafts.length > n);
    assert.ok(edges(drafts).some((x) => x.to_id === `commit:${"b".repeat(40)}`));
  });

  it("a throwing or absent refs source emits only the task node", () => {
    const { drafts, lineage } = rig();
    emitWorkTaskLineage(lineage, graph(), new Map(), () => {
      throw new Error("boom");
    });
    emitWorkTaskLineage(lineage, graph(), new Map());
    assert.equal(edges(drafts).length, 0);
  });

  it("a Mission-origin PR link and a Ledger-origin task link name the same pr node and edge", () => {
    const missionSide = rig();
    const link: GithubLinkRecord = {
      linkId: "l1",
      missionId: "m1",
      subject: { kind: "task", id: "wi_1" },
      target: PR,
      targetKind: "pr",
      provenance: "explicit_ref",
      source: "goal",
      observed: { state: "open", headSha: SHA },
      status: "active",
      recordedAt: "2026-10-30T00:00:00Z",
    };
    emitLinkRecorded(missionSide.lineage as any, link);
    const ledgerSide = rig();
    emitWorkTaskLineage(ledgerSide.lineage, graph(), new Map(), () => ({
      commits: [],
      plans: [],
      evidence: [],
      prs: prRefsFromLinks([link], "wi_1"),
    }));
    const a = edges(missionSide.drafts).find((x) => x.edge_type === "issue_link");
    const b = edges(ledgerSide.drafts).find((x) => x.edge_type === "issue_link");
    assert.equal(a.from_id, b.from_id);
    assert.equal(a.to_id, b.to_id);
    assert.equal(b.to_id, PR);
  });

  it("prRefsFromLinks ignores removed links, issues, other subjects and malformed ids", () => {
    const base = {
      linkId: "l",
      missionId: "m",
      provenance: "operator",
      source: "operator",
      observed: {},
      recordedAt: "",
    } as const;
    const links = [
      { ...base, subject: { kind: "task", id: "t" }, target: PR, targetKind: "pr", status: "removed" },
      {
        ...base,
        subject: { kind: "task", id: "t" },
        target: "issue:github.com/o/r#1",
        targetKind: "issue",
        status: "active",
      },
      { ...base, subject: { kind: "task", id: "other" }, target: PR, targetKind: "pr", status: "active" },
      { ...base, subject: { kind: "task", id: "t" }, target: "pr:bad", targetKind: "pr", status: "active" },
      { ...base, subject: { kind: "task", id: "t" }, target: PR, targetKind: "pr", status: "active" },
    ] as unknown as GithubLinkRecord[];
    assert.deepEqual(prRefsFromLinks(links, "t"), [PR]);
  });

  it("ledgerTaskRefs reads commits and evidence from the current candidate and skips Mission tasks", () => {
    const ledger = {
      getWorkItem: (id: string) =>
        id === "wi_1" ? ({ id, current_candidate_id: "c1", incumbent_candidate_id: null } as any) : undefined,
      getTask: () => undefined,
      listCandidates: () =>
        [
          { id: "c1", head_commit: SHA.toUpperCase() },
          { id: "c0", head_commit: "short" },
        ] as any,
      listEvidence: () =>
        [
          { id: "e1", type: "verify.test", status: "passed", trust: "deterministic", summary: {} },
          { id: "e2", type: "verify.x", status: "passed", trust: "unverified", summary: {} },
        ] as any,
    };
    const src = ledgerTaskRefs(ledger);
    const t = graph().tasks[0] as any;
    const r = src(t) as TaskRefs;
    assert.deepEqual(r.commits, [SHA]);
    assert.deepEqual(r.evidence, [{ id: "e1", type: "verify.test", passed: true, commit: SHA }]);
    assert.equal(src({ ...t, source: "mission" }), undefined);
  });
});
