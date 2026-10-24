/**
 * The plan gate on the real orchestrator path: EngineeringRuntime's default
 * planner, with plan review enabled by option and by the repo's YAML config.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/index.ts";
import { mergePlanReviewLayers } from "../../src/orchestration/planReviewConfig.ts";
import { PLANNER_CLARIFICATION_CATEGORY } from "../../src/orchestration/types.ts";
import { PlannotatorAdapter, type PlannotatorTransport } from "../../src/platform/Plannotator.ts";
import { LineageEmitter } from "../../src/runtime/herdr/lineage.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const GOAL = "change login token handling in the auth module";
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function open(extra: Record<string, unknown> = {}, yaml?: string, globalYaml?: string) {
  const fx = await makeFixtureRepo();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-agent-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
  if (globalYaml !== undefined) await writeFile(join(agentDir, "engineering.yaml"), globalYaml);
  if (yaml !== undefined) {
    await mkdir(join(fx.root, ".pi"), { recursive: true });
    await writeFile(join(fx.root, ".pi", "engineering.yaml"), yaml);
  }
  const runtime = await EngineeringRuntime.open({ cwd: fx.root, agentDir, worker: {} as never, ...extra });
  const store = runtime.missionStore!;
  const mission = store.createMission({
    title: "t",
    goal: GOAL,
    user_request: GOAL,
    repository: fx.root,
    base_ref: "HEAD",
    risk_profile: {} as never,
    workflow_class: "engineering",
  });
  const plan = () => runtime.missionPlanner!(store.getMission(mission.mission_id)!, {} as never);
  return { runtime, store, mission, plan };
}

const transportOf = (replies: Array<"approved" | "annotated" | "rejected">) => {
  const digests: string[] = [];
  const t: PlannotatorTransport = {
    submitPlan: async (p) => {
      digests.push(p.planDigest ?? "");
      return {
        decision: replies[Math.min(digests.length, replies.length) - 1]!,
        externalDecisionId: `E${digests.length}`,
        annotations: ["use a narrower scope for the token code"],
        planDigest: p.planDigest,
      };
    },
  };
  return { t, digests };
};

describe("plan review on the orchestrator path", () => {
  it("default OFF: tasks are the unchanged single task and no plan records or findings exist", async () => {
    for (const yaml of [undefined, "plan_review:\n  enabled: false\n", "version: 1\n"]) {
      const { plan, store, mission } = await open({}, yaml);
      const tasks = await plan();
      assert.equal(tasks.length, 1);
      const { task_id: _ignored, ...rest } = tasks[0] as unknown as Record<string, unknown>;
      assert.deepEqual(rest, {
        kind: "agent",
        role: "implementer",
        objective: GOAL,
        mutates_repo: true,
        write_domains: ["**"],
        isolation: "worktree",
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: [],
        deliverables: ["implementation", "targeted-tests"],
        checkpoint_policy: { activity_milestone: 5, before_deadline_ms: 30_000 },
        max_attempts: 3,
        failure_policy: "retry",
      });
      assert.equal(store.listPlanRevisions(mission.mission_id).length, 0);
      assert.equal(store.listPlanDecisions(mission.mission_id).length, 0);
      assert.equal(store.listFindings(mission.mission_id).length, 0);
    }
  });

  it("(a) require + Plannotator unavailable: no tasks and a visible finding", async () => {
    const { plan, store, mission } = await open({
      planReview: { adapter: new PlannotatorAdapter({ transport: null }) },
    });
    const tasks = await plan();
    assert.deepEqual(tasks, []);
    const findings = store.listFindings(mission.mission_id);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.category, PLANNER_CLARIFICATION_CATEGORY);
    assert.match(findings[0]?.summary ?? "", /Plan review blocked implementation \(plannotator_unavailable\)/);
    assert.match(findings[0]?.evidence ?? "", /failing closed/);
    const [d] = store.listPlanDecisions(mission.mission_id);
    assert.equal(d?.proceed, false);
    assert.equal(d?.mode, "require");
  });

  it("(b) an approved digest lets the workers proceed with exactly the reviewed tasks", async () => {
    const { t, digests } = transportOf(["approved"]);
    const { plan, store, mission } = await open({ planReview: { adapter: new PlannotatorAdapter({ transport: t }) } });
    const tasks = await plan();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.objective, GOAL);
    const [rev] = store.listPlanRevisions(mission.mission_id);
    assert.equal(rev?.planDigest, digests[0]);
    assert.equal(store.listPlanDecisions(mission.mission_id)[0]?.outcome, "approved");
    assert.equal(store.listFindings(mission.mission_id).length, 0);
  });

  it("(c) changes requested replans with the feedback; the new revision needs its own decision", async () => {
    const { t, digests } = transportOf(["annotated", "approved"]);
    const { plan, store, mission } = await open({ planReview: { adapter: new PlannotatorAdapter({ transport: t }) } });
    const tasks = await plan();
    assert.equal(tasks.length, 1);
    assert.match(tasks[0]?.objective ?? "", /plan reviewer requested changes to revision 1/);
    assert.match(tasks[0]?.objective ?? "", /use a narrower scope for the token code/);
    const revs = store.listPlanRevisions(mission.mission_id);
    assert.equal(revs.length, 2);
    assert.equal(revs[1]?.parentRevision, 1);
    assert.equal(digests.length, 2);
    assert.notEqual(digests[0], digests[1]);
    assert.deepEqual(
      store.listPlanDecisions(mission.mission_id).map((d) => [d.revision, d.outcome]),
      [
        [1, "changes_requested"],
        [2, "approved"],
      ],
    );
  });

  it("enabled from the GLOBAL YAML with a CLI that is not installed: fail closed; a global skip override is recorded", async () => {
    const closed = await open(
      {},
      undefined,
      "plan_review:\n  enabled: true\n  plannotator:\n    command: definitely-not-installed-plannotator\n",
    );
    assert.deepEqual(await closed.plan(), []);
    assert.equal(closed.store.listFindings(closed.mission.mission_id).length, 1);

    const skipped = await open(
      {},
      undefined,
      'plan_review:\n  enabled: true\n  override:\n    mode: skip\n    reason: "offline hotfix"\n    operator: alice\n',
    );
    assert.equal((await skipped.plan()).length, 1);
    const [policy] = skipped.store.listPlanPolicies(skipped.mission.mission_id);
    assert.equal(policy?.source, "override");
    assert.equal(policy?.overrideReason, "offline hotfix");
  });

  it("a repo YAML cannot disable, lower or override the global gate, and says so", async () => {
    const global =
      "plan_review:\n  enabled: true\n  modes: {high: require}\n  plannotator:\n    command: definitely-not-installed-plannotator\n";
    const repo =
      'plan_review:\n  enabled: false\n  modes: {high: skip}\n  override: {mode: skip, reason: "trust me"}\n  plannotator: {command: ./evil.sh}\n';
    const { plan, store, mission } = await open({}, repo, global);
    assert.deepEqual(await plan(), [], "still blocked");
    const f = store.listFindings(mission.mission_id)[0];
    assert.match(f?.summary ?? "", /blocked implementation/);
    assert.equal(store.listPlanPolicies(mission.mission_id)[0]?.source, "policy");
    assert.equal(store.listPlanPolicies(mission.mission_id)[0]?.mode, "require");
  });

  it("a malformed global file or a typo'd block fails closed with the reason in the finding", async () => {
    for (const [global, expected] of [
      ["plan_review: [unclosed", /global config unreadable/],
      ['plan_review:\n  enabled: "true"\n', /must be true or false/],
      ["plan_review: true\n", /must be a mapping/],
    ] as const) {
      const { plan, store, mission } = await open({}, undefined, global);
      assert.deepEqual(await plan(), [], global);
      assert.match(store.listFindings(mission.mission_id)[0]?.evidence ?? "", expected);
    }
  });

  it("(f) with a lineage emitter, the runtime's plan gate projects the mission, plan digest and decision to Herdr", async () => {
    const { t, digests } = transportOf(["approved"]);
    const drafts: Array<{ event_type: string; payload: Record<string, any>; mission_id?: string; room_id?: string }> =
      [];
    const lineage = new LineageEmitter({
      source: "pi-test",
      visibility: "room",
      defaultScope: { room_id: "room-rt" },
      sink: { stage: async (d) => void drafts.push(d as never) },
    });
    const { plan, mission } = await open({
      lineage,
      planReview: { adapter: new PlannotatorAdapter({ transport: t }) },
    });
    await plan();
    await lineage.idle();
    const node = `plan:${mission.mission_id}/1`;
    const planUpsert = drafts.find((d) => d.event_type === "node.upsert" && d.payload.node_id === node);
    assert.equal(planUpsert?.payload.attrs.plan_digest, digests[0], "the digest on the plan node is the reviewed digest");
    assert.equal(planUpsert?.room_id, "room-rt", "the emitter's default scope applies to the gate's events");
    assert.ok(drafts.some((d) => d.event_type === "node.upsert" && d.payload.node_id === `mission:${mission.mission_id}`));
    const reviewed = drafts.find((d) => d.event_type === "edge.add" && d.payload.edge_type === "reviewed");
    assert.equal(reviewed?.payload.attrs.plan_digest, digests[0]);
  });

  it("(f2) without a lineage emitter nothing is projected and planning is unchanged", async () => {
    const { t } = transportOf(["approved"]);
    const { plan } = await open({ planReview: { adapter: new PlannotatorAdapter({ transport: t }) } });
    assert.equal((await plan()).length, 1);
  });

  it("layer merge: absent/disabled is off; malformed fails closed; repo can only raise", () => {
    const L = (raw?: unknown) => ({ raw });
    assert.equal(mergePlanReviewLayers({ global: L(), repo: L() }, "/tmp"), null);
    assert.equal(mergePlanReviewLayers({ global: L({ enabled: false }), repo: L() }, "/tmp"), null);
    const bad = mergePlanReviewLayers(
      { global: L({ enabled: true, modes: { high: "sometimes" } }), repo: L() },
      "/tmp",
    );
    assert.equal(bad?.adapter, null);
    assert.deepEqual(bad?.policy?.modes, { low: "require", medium: "require", high: "require", critical: "require" });
    assert.ok(bad?.configNotes.some((n) => /modes.high must be one of/.test(n)));
    const raised = mergePlanReviewLayers(
      {
        global: L({ enabled: true, modes: { low: "skip" }, max_revisions: 2 }),
        repo: L({ modes: { low: "offer", high: "skip" }, max_revisions: 1 }),
      },
      "/tmp/x",
    );
    assert.equal(raised?.policy?.modes?.low, "offer");
    assert.equal(raised?.policy?.modes?.high, "require");
    assert.equal(raised?.maxRevisions, 1);
    assert.ok(raised?.adapter);
    assert.equal(
      mergePlanReviewLayers({ global: L(), repo: L({ modes: { low: "offer" } }) }, "/tmp/x")?.policy?.modes?.low,
      "offer",
    );
  });
});
