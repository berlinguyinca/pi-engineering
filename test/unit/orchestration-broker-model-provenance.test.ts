/**
 * P4 provenance — broker settlement records the model that actually served.
 *
 * The execution record's `model` field is what /mission-status reads for both
 * task `usage.model` (missionWhy.ts) and `workersDetail` (orchestrator.ts). It
 * is seeded at creation with the *requested* model (`modelRequirements.model`,
 * often null for unrouted roles) and was previously never updated to the model
 * that actually served. The backend records the serving model on the outcome
 * (`outcome.usage.model`, via withModel from `route ?? ranOn(run) ??
 * reviewFallbackModel`); settlement must copy it onto the execution record so
 * an unrouted in-session worker's serving model is not lost.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

type BrokerBackends = import("../../src/orchestration/broker.ts").BrokerBackends;
type RunAgent = NonNullable<BrokerBackends["agent"]>["runAgent"];

function buildBroker(runAgent: RunAgent) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "model provenance",
    goal: "g",
    user_request: "u",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering_review",
  });
  const task = store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "investigator",
    objective: "inspect",
  });
  store.transitionTask(task.task_id, "READY");
  const broker = new ExecutionBroker({ store, backends: { agent: { runAgent } } });
  return { store, mission, task, broker };
}

describe("P4 broker settlement model provenance", () => {
  it("settles the execution record to the model that actually served (unrouted, no request)", async () => {
    const { store, mission, task, broker } = buildBroker(async () => ({
      executionId: "w",
      exitStatus: "succeeded",
      summary: "done",
      artifactRefs: [],
      // The backend records the serving model on the outcome (withModel).
      usage: { model: "metabolomics/qwen3.8-27b-hybrid-max" },
    }));

    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      role: "investigator",
      objective: "inspect",
      mutatesRepo: false,
      isolation: "none",
      writeDomains: [],
      // No modelRequirements -> the execution record is created with model=null.
    });
    await handle.result();

    const execution = store.getExecution(handle.executionId);
    assert.ok(execution, "execution record exists");
    // Regression: without the settlement fix this stayed null (the requested
    // model was never recorded, and the serving model on the outcome was lost).
    assert.equal(execution.model, "metabolomics/qwen3.8-27b-hybrid-max");
    assert.equal(execution.status, "SUCCEEDED");
  });

  it("prefers the serving model over the requested model when they differ (failover)", async () => {
    const { store, mission, task, broker } = buildBroker(async () => ({
      executionId: "w",
      exitStatus: "succeeded",
      summary: "done",
      artifactRefs: [],
      usage: { model: "gw/fallback-model" },
    }));

    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      role: "investigator",
      objective: "inspect",
      mutatesRepo: false,
      isolation: "none",
      writeDomains: [],
      modelRequirements: { model: "gw/primary-model" },
    });
    await handle.result();

    const execution = store.getExecution(handle.executionId);
    assert.ok(execution);
    // The model that actually served (post-failover) wins over the requested one.
    assert.equal(execution.model, "gw/fallback-model");
  });

  it("keeps the requested model when the outcome records no serving model", async () => {
    const { store, mission, task, broker } = buildBroker(async () => ({
      executionId: "w",
      exitStatus: "succeeded",
      summary: "done",
      artifactRefs: [],
      usage: {},
    }));

    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      role: "investigator",
      objective: "inspect",
      mutatesRepo: false,
      isolation: "none",
      writeDomains: [],
      modelRequirements: { model: "gw/primary-model" },
    });
    await handle.result();

    const execution = store.getExecution(handle.executionId);
    assert.ok(execution);
    // No serving model on the outcome -> the requested model recorded at
    // creation is preserved (not overwritten with null/undefined).
    assert.equal(execution.model, "gw/primary-model");
  });

  // Gate backends (review/integration/validation) settle through a DIFFERENT
  // path than the agent backend: a successful gate execution is published via
  // buildGateEvidencePublication -> publishGateEvidenceIfAuthoritative, NOT the
  // setExecutionStatus path that carries the P4 Gap-2 model copy. So the
  // serving model must also flow through the gate publication, or an unrouted
  // reviewer's serving model is lost (usage.model null in /mission-status).
  it("settles a gate execution (review) to the serving model via the gate publication path", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const baseSha = await git.headCommit();
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = store.createMission({
        title: "review model provenance",
        goal: "g",
        user_request: "u",
        repository: fx.root,
        base_ref: baseSha,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-review-prov",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
        repositories: [
          { repoId: "repo-review-prov", canonicalRoot: fx.root, baseRef: "main", baseSha, writableDomains: ["**"] },
        ],
        dependencyEdges: [],
        hash: "manifest-review-prov",
        createdAt: "2026-09-27T00:00:00.000Z",
      });
      const ownership = new MissionOwnership(store, { ownerId: "review-prov", leaseMs: 60_000 });
      const identity = await ownership.acquire(mission.mission_id, { resumptionGeneration: 0 });
      const authority = await ownership.maintain(identity, "repo-review-prov");
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "review",
        role: "reviewer",
        objective: "review the candidate",
        repo_id: "repo-review-prov",
      });
      store.transitionTask(task.task_id, "READY");
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => ({ repoId: "repo-review-prov", root: fx.root, git }),
        backends: {
          review: {
            runReview: async () => ({
              executionId: "review-w",
              exitStatus: "succeeded",
              summary: "approved",
              artifactRefs: [],
              // The real review backend records the serving model on the
              // outcome (withModel from the routed reviewer model).
              usage: { input: 26651, output: 2908, model: "metabolomics/review-model" },
              reviewEvidence: {
                reviewerSessionId: "RVS-test",
                model: "metabolomics/review-model",
                provider: "metabolomics",
                verdict: "approve",
                independenceMode: "independent",
                findings: [],
                outputValid: true,
                accessible: true,
                acceptanceResults: [],
              },
            }),
          },
        },
      });
      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: "repo-review-prov",
        kind: "review",
        role: "reviewer",
        objective: task.objective,
        authority,
      });
      await handle.result();
      const execution = store.getExecution(handle.executionId);
      assert.ok(execution, "execution record exists");
      // Regression: without the gate-path model copy this stayed null (the
      // requested model, seeded at creation) even though the review ran on a
      // model and the outcome carried it.
      assert.equal(execution.model, "metabolomics/review-model");
      assert.equal(execution.status, "SUCCEEDED");
      await authority.close();
    } finally {
      await fx.cleanup();
    }
  });
});
