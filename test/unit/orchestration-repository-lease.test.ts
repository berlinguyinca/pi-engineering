import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership, RepositoryLeasedError } from "../../src/orchestration/ownership.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import type { OrchestrationTask } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const REPO = "repo-shared";

function mission(store: MissionStore, missionId: string) {
  const created = store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "repository lease scope",
    user_request: "repository lease scope",
    repository: REPO,
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.transitionMission(missionId, "CLASSIFYING");
  store.transitionMission(missionId, "PLANNING");
  store.transitionMission(missionId, "READY");
  store.transitionMission(missionId, "EXECUTING");
  return created;
}

function task(
  store: MissionStore,
  missionId: string,
  objective: string,
  kind: "agent" | "integration",
  domains: string[],
  isolation: "none" | "worktree" = "none",
): OrchestrationTask {
  return store.createTask({
    mission_id: missionId,
    kind,
    role: kind === "agent" ? "implementer" : "integrator",
    objective,
    repo_id: REPO,
    mutates_repo: true,
    write_domains: domains,
    isolation,
    execution_budget_ms: 60_000,
    max_attempts: 1,
  });
}

async function harness() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const ownership = new MissionOwnership(store, { ownerId: "controller", leaseMs: 60_000 });
  const orchestrator = new Orchestrator({ store, backends: {}, planner: async () => [], ownership });
  for (const id of ["M-1", "M-2"]) {
    mission(store, id);
    await orchestrator.adoptMissionOwnership(id);
  }
  return { store, backend, ownership, orchestrator };
}

async function until(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}

describe("repository lease scope", () => {
  it("lets two missions hold implementer authority on one repo without a repository lease", async () => {
    const { store, orchestrator } = await harness();
    const a = task(store, "M-1", "impl a", "agent", ["a/**"]);
    const b = task(store, "M-2", "impl b", "agent", ["b/**"]);
    const [first, second] = await Promise.all([
      orchestrator.acquireTaskAuthority(a),
      orchestrator.acquireTaskAuthority(b),
    ]);
    assert.equal(first.repositoryIdentity, undefined);
    assert.equal(second.repositoryIdentity, undefined);
    assert.equal(store.getRepositoryLeaseByRepoId(REPO), undefined);
    await first.close();
    await second.close();
  });

  it("runs two missions' implementers concurrently in real worktrees under lanes only", async () => {
    const { store, orchestrator } = await harness();
    const fx = await makeFixtureRepo();
    const git = await GitRepo.open(fx.root);
    assert.ok(git);
    const windows = new Map<string, { start: number; end: number }>();
    const releases = new Map<string, () => void>();
    const broker = new ExecutionBroker({
      store,
      git,
      resolveRepository: async (repoId: string) => ({ repoId, root: fx.root, git }),
      backends: {
        agent: {
          runAgent: async ({ objective, worktree }: { objective: string; worktree?: string | null }) => {
            const window = { start: Date.now(), end: 0 };
            windows.set(objective, window);
            const id = objective.replace("impl ", "");
            await mkdir(join(worktree!, id), { recursive: true });
            await writeFile(join(worktree!, id, "out.txt"), `${objective}\n`, "utf8");
            await new Promise<void>((resolve) => releases.set(objective, resolve));
            window.end = Date.now();
            return {
              executionId: objective,
              exitStatus: "succeeded" as const,
              summary: "done",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const acquireAuthority = (t: OrchestrationTask, signal?: AbortSignal) =>
      orchestrator.acquireTaskAuthorityWaiting(t, signal);
    const missions = ["M-1", "M-2"];
    for (const id of missions) {
      task(store, id, `impl ${id}`, "agent", [`${id}/**`], "worktree");
    }
    const runs = missions.map((id) =>
      new MissionScheduler({
        store,
        broker,
        limits: { maxActive: 2, maxAgents: 2 },
        acquireAuthority,
      }).runMission(id),
    );
    await until(() => windows.size === 2);
    assert.equal(windows.get("impl M-1")?.end, 0, "M-1 still executing");
    assert.equal(windows.get("impl M-2")?.end, 0, "M-2 still executing: overlapping windows");
    assert.equal(store.getRepositoryLeaseByRepoId(REPO), undefined, "no repository lease during worker execution");
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const id of missions) releases.get(`impl ${id}`)?.();
    await Promise.all(runs);
    const one = windows.get("impl M-1")!;
    const two = windows.get("impl M-2")!;
    assert.ok(two.start < one.end && one.start < two.end, "execution windows overlap by timestamp");
    for (const t of store.listTasks("M-1").concat(store.listTasks("M-2"))) {
      assert.equal(t.status, "SUCCEEDED", t.failure_reason ?? "");
    }
  });

  it("makes integration wait, naming the holder, while another mission holds the repository", async () => {
    const { store, backend, orchestrator } = await harness();
    const first = task(store, "M-1", "integrate 1", "integration", ["**"]);
    const second = task(store, "M-2", "integrate 2", "integration", ["**"]);
    const held = await orchestrator.acquireTaskAuthority(first);
    assert.equal(held.repositoryIdentity?.missionId, "M-1");

    let settled = false;
    const waiting = orchestrator.acquireTaskAuthorityWaiting(second).then((authority) => {
      settled = true;
      return authority;
    });
    await until(() => store.getRepositoryWait(second.task_id) !== undefined);
    assert.equal(store.getRepositoryWait(second.task_id)?.holderMissionId, "M-1");
    assert.notEqual(store.getTask(second.task_id)?.status, "BLOCKED");
    // Durable: another process replaying the same event stream sees the named wait.
    await store.flush();
    const other = MissionStore.open(backend);
    assert.equal(other.listRepositoryWaits("M-2")[0]?.holderMissionId, "M-1");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, "promotion/integration stays exclusive while M-1 holds the lease");

    await held.close();
    const acquired = await waiting;
    assert.equal(acquired.repositoryIdentity?.missionId, "M-2");
    assert.equal(store.getRepositoryWait(second.task_id), undefined);
    await acquired.close();
  });

  it("keeps the wait recorded and does not block after the ceiling, using an injected clock", async () => {
    const { store, orchestrator } = await harness();
    const first = task(store, "M-1", "integrate 1", "integration", ["**"]);
    const second = task(store, "M-2", "integrate 2", "integration", ["**"]);
    const held = await orchestrator.acquireTaskAuthority(first);
    let at = 0;
    orchestrator.repositoryWait.now = () => at;
    orchestrator.repositoryWait.sleep = async (ms) => {
      at += ms;
    };
    orchestrator.repositoryWait.ceilingMs = 600_000;
    await assert.rejects(() => orchestrator.acquireTaskAuthorityWaiting(second), RepositoryLeasedError);
    assert.equal(at, 600_000, "waited exactly the ceiling");
    assert.equal(store.getRepositoryWait(second.task_id)?.holderMissionId, "M-1", "wait stays named");
    assert.notEqual(store.getTask(second.task_id)?.status, "BLOCKED");
    await held.close();
  });

  it("stops waiting when aborted and clears the wait", async () => {
    const { store, orchestrator } = await harness();
    const first = task(store, "M-1", "integrate 1", "integration", ["**"]);
    const second = task(store, "M-2", "integrate 2", "integration", ["**"]);
    const held = await orchestrator.acquireTaskAuthority(first);
    const controller = new AbortController();
    orchestrator.repositoryWait.sleep = async () => controller.abort();
    await assert.rejects(
      () => orchestrator.acquireTaskAuthorityWaiting(second, controller.signal),
      RepositoryLeasedError,
    );
    assert.equal(store.getRepositoryWait(second.task_id), undefined);
    await held.close();
  });

  it("leaves a scheduled integration task READY (not BLOCKED, no attempt) past the ceiling", async () => {
    const { store, orchestrator } = await harness();
    const first = task(store, "M-1", "integrate 1", "integration", ["**"]);
    const second = task(store, "M-2", "integrate 2", "integration", ["**"]);
    const held = await orchestrator.acquireTaskAuthority(first);
    orchestrator.repositoryWait.ceilingMs = 0;
    const broker = new ExecutionBroker({ store, backends: {} });
    const controller = new AbortController();
    const run = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 1 },
      acquireAuthority: (t, signal) => orchestrator.acquireTaskAuthorityWaiting(t, signal),
    }).runMission("M-2", controller.signal);
    await until(() => store.getRepositoryWait(second.task_id) !== undefined);
    assert.notEqual(store.getTask(second.task_id)?.status, "BLOCKED");
    assert.equal(store.getTask(second.task_id)?.attempt, 0);
    controller.abort();
    await run.catch(() => undefined);
    await held.close();
  });
});
