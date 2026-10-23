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
import { parsePlanReviewConfig } from "../../src/orchestration/planReviewConfig.ts";
import { PLANNER_CLARIFICATION_CATEGORY } from "../../src/orchestration/types.ts";
import { PlannotatorAdapter, type PlannotatorTransport } from "../../src/platform/Plannotator.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const GOAL = "change login token handling in the auth module";
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function open(extra: Record<string, unknown> = {}, yaml?: string) {
  const fx = await makeFixtureRepo();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-agent-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
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

  it("enabled from the repo YAML with a CLI that is not installed: fail closed; skip override from YAML is recorded", async () => {
    const closed = await open(
      {},
      "plan_review:\n  enabled: true\n  plannotator:\n    command: definitely-not-installed-plannotator\n",
    );
    assert.deepEqual(await closed.plan(), []);
    assert.equal(closed.store.listFindings(closed.mission.mission_id).length, 1);

    const skipped = await open(
      {},
      'plan_review:\n  enabled: true\n  override:\n    mode: skip\n    reason: "offline hotfix"\n    operator: alice\n',
    );
    assert.equal((await skipped.plan()).length, 1);
    const [policy] = skipped.store.listPlanPolicies(skipped.mission.mission_id);
    assert.equal(policy?.source, "override");
    assert.equal(policy?.overrideReason, "offline hotfix");
  });

  it("a malformed enabled block fails closed; a disabled or absent block is off", () => {
    assert.equal(parsePlanReviewConfig(undefined, "/tmp"), null);
    assert.equal(parsePlanReviewConfig({ enabled: false }, "/tmp"), null);
    const bad = parsePlanReviewConfig({ enabled: true, modes: { high: "sometimes" } }, "/tmp");
    assert.equal(bad?.adapter, null);
    assert.deepEqual(bad?.policy?.modes, { low: "require", medium: "require", high: "require", critical: "require" });
    const noReason = parsePlanReviewConfig({ enabled: true, override: { mode: "skip" } }, "/tmp");
    assert.equal(noReason?.adapter, null);
    const good = parsePlanReviewConfig({ enabled: true, max_revisions: 2, modes: { medium: "require" } }, "/tmp/x");
    assert.equal(good?.maxRevisions, 2);
    assert.equal(good?.policy?.modes?.medium, "require");
    assert.ok(good?.adapter);
  });
});
