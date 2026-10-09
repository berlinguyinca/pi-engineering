/**
 * Recovery of a wall-clock-timed-out worker's committed work (MSN-1xh24o),
 * against a real git fixture: real worktrees, real commits, real merges into
 * the integrator's handoff list.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import {
  ExecutionBroker,
  type ExecutionOutcome,
  RepositoryLifecycleInventoryUnavailableError,
} from "../../src/orchestration/broker.ts";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

type Handoff = { worktree: { path: string; branch: string }; summary: string; ref?: string; recovered?: boolean };

/** What a scripted worker does inside its worktree before it settles. */
interface Step {
  task: string;
  /** Files written and committed by the WORKER itself. */
  commit?: string[];
  /** Files written but left uncommitted (the broker's harvest commits these). */
  edit?: string[];
  outcome: Pick<ExecutionOutcome, "exitStatus" | "summary" | "error">;
}

const TIMEOUT = { exitStatus: "failed", summary: "Worker timed out.", error: "timeout" } as const;
const SUCCESS = { exitStatus: "succeeded", summary: "done" } as const;

/**
 * How the integration runner behaves. "record" (default) only records the
 * handoffs; "merge" really merges each handoff (its exact ref when given) into
 * the fixture checkout, skipping the listed branches, like realBackends does
 * for a conflicting recovered handoff.
 */
interface IntegrationMode {
  merge?: boolean;
  skip?: (branch: string) => boolean;
  exitStatus?: string;
}

async function scenario(steps: Step[], mode: IntegrationMode = {}) {
  const fx = await makeFixtureRepo();
  const git = (await GitRepo.open(fx.root))!;
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const base = await git.headCommit();
  const m = store.createMission({
    title: "x",
    goal: "x",
    user_request: "x",
    repository: ".",
    base_ref: base,
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  const handoffs: Handoff[] = [];
  /** task -> the worker's own last commit. */
  const workerCommits = new Map<string, string>();
  const byObjective = new Map<string, Step[]>();
  for (const s of steps) byObjective.set(s.task, [...(byObjective.get(s.task) ?? []), s]);
  const broker = new ExecutionBroker({
    store,
    git,
    baseRef: base,
    backends: {
      agent: {
        runAgent: async ({ worktree, objective }) => {
          const step = byObjective.get(objective)!.shift()!;
          const write = async (f: string) => {
            await mkdir(join(worktree!, "src"), { recursive: true });
            await writeFile(join(worktree!, "src", f), `${objective} ${f}\n`);
          };
          for (const f of step.commit ?? []) await write(f);
          if (step.commit?.length) {
            await git.commitAll(worktree!, `worker commit for ${objective}`);
            workerCommits.set(objective, await git.headCommitIn(worktree!));
          }
          for (const f of step.edit ?? []) await write(f);
          return { executionId: "e", artifactRefs: [], usage: {}, ...step.outcome };
        },
      },
      integration: {
        runIntegration: async (input) => {
          handoffs.push(...(input.handoffs as Handoff[]));
          if (mode.merge) {
            for (const h of input.handoffs) {
              if (mode.skip?.(h.worktree.branch)) continue;
              await git.mergeBranch(h.ref ?? h.worktree.branch);
            }
          }
          return {
            executionId: "i",
            exitStatus: mode.exitStatus ?? "succeeded",
            summary: "merged",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    },
  });
  const taskIds = new Map<string, string>();
  for (const s of steps) {
    let id = taskIds.get(s.task);
    if (!id) {
      id = store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: s.task,
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      }).task_id;
      taskIds.set(s.task, id);
    }
    await (
      await broker.execute({
        taskId: id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: s.task,
        mutatesRepo: true,
        isolation: "worktree",
      })
    ).result();
  }
  const it = store.createTask({
    mission_id: m.mission_id,
    kind: "integration",
    role: "integrator",
    objective: "merge",
  });
  await (
    await broker.execute({
      taskId: it.task_id,
      missionId: m.mission_id,
      kind: "integration",
      role: "integrator",
      objective: "merge",
    })
  ).result();
  const branchOf = (task: string) => `pi-eng-orch-${taskIds.get(task)}`;
  const taskOf = (task: string) => taskIds.get(task)!;
  const integration = store.listExecutions(m.mission_id).find((e) => e.backend === "integration")!;
  return { fx, store, m, handoffs, workerCommits, branchOf, taskOf, integration };
}

describe("ExecutionBroker: recovering a timed-out worker's committed work", () => {
  it("rejects late integration findings and cleanup while retaining uncertain branches", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const backend = JsonlEventStore.inMemory();
      const store = MissionStore.open(backend);
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "late integration",
        goal: "late integration",
        user_request: "late integration",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const workerTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "worker",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      let releaseIntegration!: () => void;
      const integrationBlocked = new Promise<void>((resolve) => {
        releaseIntegration = resolve;
      });
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: base,
        defaultTimeoutMs: 5_000,
        cancellationAckTimeoutMs: 15,
        backends: {
          agent: {
            runAgent: async ({ worktree }) => {
              await writeFile(join(worktree!, "src", "late-integration.ts"), "export const late = true;\n");
              return { executionId: "worker", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
            },
          },
          integration: {
            runIntegration: async () => {
              await integrationBlocked;
              return {
                executionId: "integration",
                exitStatus: "succeeded",
                summary: "late merge",
                artifactRefs: ["artifact://integration/late"],
                usage: {},
                findings: [{ severity: "blocking", summary: "late finding" }],
              };
            },
          },
        },
      });
      await (
        await broker.execute({
          taskId: workerTask.task_id,
          missionId: mission.mission_id,
          kind: "agent",
          objective: workerTask.objective,
          mutatesRepo: true,
          isolation: "worktree",
          writeDomains: workerTask.write_domains,
        })
      ).result();
      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "merge",
      });
      const integration = await broker.execute({
        taskId: integrationTask.task_id,
        missionId: mission.mission_id,
        kind: "integration",
        objective: integrationTask.objective,
        executionBudgetMs: 20,
      });

      assert.equal((await integration.result()).error, "timeout");
      const findings = store.listFindings(mission.mission_id);
      releaseIntegration();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.deepEqual(store.listFindings(mission.mission_id), findings);
      assert.equal(broker.pendingIntegrations(mission.mission_id), 1);
      assert.ok(broker.preservedBranches(mission.mission_id).some((branch) => branch.includes(workerTask.task_id)));
      const evidence = backend
        .all()
        .filter((event) => event.type === "execution.late_result_rejected")
        .map((event) => event.payload.evidence as Record<string, unknown>)
        .find((candidate) => (candidate.findings as unknown[] | undefined)?.length);
      assert.deepEqual(evidence?.findings, [{ severity: "blocking", summary: "late finding" }]);
      assert.equal((evidence?.handoffs as unknown[] | undefined)?.length, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("defers destructive integration cleanup so a takeover cannot delete the recoverable branch", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "deferred integration cleanup",
        goal: "deferred integration cleanup",
        user_request: "deferred integration cleanup",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const workerTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "worker",
        mutates_repo: true,
        isolation: "worktree",
      });
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: base,
        backends: {
          agent: {
            runAgent: async ({ worktree }) => {
              await writeFile(join(worktree!, "src", "deferred-cleanup.ts"), "export const deferred = true;\n");
              return { executionId: "worker", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
            },
          },
          integration: {
            runIntegration: async () => ({
              executionId: "integration",
              exitStatus: "succeeded",
              summary: "merged",
              artifactRefs: [],
              usage: {},
            }),
          },
        },
      });
      await (
        await broker.execute({
          taskId: workerTask.task_id,
          missionId: mission.mission_id,
          kind: "agent",
          objective: workerTask.objective,
          mutatesRepo: true,
          isolation: "worktree",
        })
      ).result();
      const branch = `pi-eng-orch-${workerTask.task_id}`;
      let removalStarted!: () => void;
      const removing = new Promise<void>((resolve) => {
        removalStarted = resolve;
      });
      let releaseRemoval!: () => void;
      const removalBlocked = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      const originalRemove = git.removeWorktree.bind(git);
      git.removeWorktree = async (info, options) => {
        removalStarted();
        await removalBlocked;
        return originalRemove(info, options);
      };
      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "merge",
      });
      const integration = await broker.execute({
        taskId: integrationTask.task_id,
        missionId: mission.mission_id,
        kind: "integration",
        objective: integrationTask.objective,
      });
      const result = integration.result();
      const first = await Promise.race([
        result.then(() => "settled" as const),
        removing.then(() => "removing" as const),
      ]);
      if (first === "removing") {
        store.assignTaskAuthority(integrationTask.task_id, {
          missionId: mission.mission_id,
          generation: 1,
          ownerId: "takeover",
          acquiredAt: "2026-09-27T12:00:00.000Z",
          renewBy: "2026-09-27T12:01:00.000Z",
          fencingToken: 1,
        });
        releaseRemoval();
        await result.catch(() => undefined);
      } else {
        store.assignTaskAuthority(integrationTask.task_id, {
          missionId: mission.mission_id,
          generation: 1,
          ownerId: "takeover",
          acquiredAt: "2026-09-27T12:00:00.000Z",
          renewBy: "2026-09-27T12:01:00.000Z",
          fencingToken: 1,
        });
      }

      assert.equal(first, "settled", "integration must not begin destructive cleanup under execution authority");
      execFileSync("git", ["-C", fx.root, "show-ref", "--verify", `refs/heads/${branch}`]);
      assert.ok(broker.preservedBranches(mission.mission_id).includes(branch));
    } finally {
      await fx.cleanup();
    }
  });

  it("preserves a pre-timeout checkpoint but keeps the uncooperative branch ineligible for integration", async () => {
    const fx = await makeFixtureRepo();
    const artifactRoot = await mkdtemp(join(tmpdir(), "checkpoint-artifacts-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const artifacts = await ArtifactStore.create(artifactRoot);
      const validArtifact = await artifacts.put("checkpoint", "implementation", "verified artifact body", "proof");
      const secondValidArtifact = await artifacts.put("checkpoint", "tests", "verified artifact body", "proof");
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "preserve timeout checkpoint",
        goal: "preserve timeout checkpoint",
        user_request: "preserve timeout checkpoint",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-timeout-preserve",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
        repositories: [
          {
            repoId: "repo-timeout-preserve",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: base,
            writableDomains: ["src/**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-timeout-preserve",
        createdAt: "2026-09-27T10:00:00.000Z",
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        repo_id: "repo-timeout-preserve",
        kind: "agent",
        role: "implementer",
        objective: "commit then ignore timeout",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
        deliverables: ["implementation"],
        // Generous budget: the valid checkpoint claim is fired only after the
        // agent polls for the two earlier reject findings to appear. Under
        // full-suite load those polls can outrun a 1s budget, so the deadline
        // checkpoint would be taken before the valid claim is buffered and
        // completedDeliverables would come back empty. Give the claim time to
        // land before the timeout.
        execution_budget_ms: 5_000,
        checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 200 },
      });
      const handoffs: Handoff[] = [];
      const broker = new ExecutionBroker({
        store,
        git,
        checkpoints: new CheckpointManager({ store }),
        artifacts,
        cancellationAckTimeoutMs: 20,
        resolveRepository: async (repoId) => ({ repoId, root: fx.root, git }),
        backends: {
          agent: {
            runAgent: async ({ worktree, onActivity }) => {
              await mkdir(join(worktree!, "src"), { recursive: true });
              await writeFile(join(worktree!, "src", "preserved.ts"), "export const preserved = true;\n");
              await git.commitAll(worktree!, "worker checkpoint commit");
              const candidateSha = await git.headCommitIn(worktree!);
              onActivity?.({
                kind: "state",
                summary: "spoofed legacy checkpoint",
                meaningfulProgress: true,
                completedDeliverables: ["implementation"],
              } as never);
              onActivity?.({
                kind: "checkpoint",
                summary: "missing artifact",
                meaningfulProgress: true,
                claims: [
                  {
                    deliverable: "implementation",
                    candidateSha,
                    evidencePaths: ["src/preserved.ts"],
                    artifactRefs: ["artifact://checkpoint/missing"],
                  },
                ],
              });
              for (let attempt = 0; attempt < 100; attempt++) {
                if (
                  store.listFindings(mission.mission_id).some((finding) => finding.category === "checkpoint_progress")
                )
                  break;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              onActivity?.({
                kind: "checkpoint",
                summary: "spoofed artifact",
                meaningfulProgress: true,
                claims: [
                  {
                    deliverable: "implementation",
                    candidateSha,
                    evidencePaths: ["src/preserved.ts"],
                    artifactRefs: ["artifact://other/implementation"],
                  },
                ],
              });
              for (let attempt = 0; attempt < 100; attempt++) {
                if (
                  store.listFindings(mission.mission_id).filter((finding) => finding.category === "checkpoint_progress")
                    .length >= 2
                )
                  break;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              onActivity?.({
                kind: "checkpoint",
                summary: "Checkpoint progress recorded",
                meaningfulProgress: true,
                claims: [
                  {
                    deliverable: "implementation",
                    candidateSha,
                    evidencePaths: ["src/preserved.ts"],
                    artifactRefs: [validArtifact.uri, secondValidArtifact.uri],
                  },
                ],
              });
              await blocked;
              return {
                executionId: "late-worker",
                exitStatus: "succeeded",
                summary: "late",
                artifactRefs: ["artifact://handoff/late"],
                usage: {},
              };
            },
          },
          integration: {
            runIntegration: async (input) => {
              handoffs.push(...(input.handoffs as Handoff[]));
              return {
                executionId: "integration",
                exitStatus: "succeeded",
                summary: "done",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: task.repo_id,
        kind: "agent",
        role: task.role,
        objective: task.objective,
        mutatesRepo: true,
        isolation: "worktree",
        writeDomains: task.write_domains,
        deliverables: task.deliverables,
        executionBudgetMs: task.execution_budget_ms,
        checkpointPolicy: task.checkpoint_policy,
      });
      const result = handle.result();
      const outcome = await Promise.race([
        result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result did not hard-timeout")), 10_000)),
      ]).catch(async (error) => {
        release();
        await result.catch(() => undefined);
        throw error;
      });
      assert.equal(outcome.error, "timeout");
      const checkpoint = store.getTaskCheckpoint(store.getExecution(handle.executionId)!.checkpoint_id!);
      assert.ok(checkpoint?.candidateSha, "the last stable checkpoint remains recoverable evidence");
      assert.deepEqual(
        checkpoint.completedDeliverables,
        ["implementation"],
        JSON.stringify({
          findings: store.listFindings(mission.mission_id),
          artifact: await artifacts.readContentByUri(validArtifact.uri),
        }),
      );
      assert.deepEqual(checkpoint.remainingDeliverables, []);
      assert.equal(checkpoint.artifactRefs.length, 2);
      assert.equal(
        new Set(checkpoint.artifactRefs).size,
        2,
        "equal content from distinct claims keeps one URI per claim",
      );
      assert.ok(
        checkpoint.artifactRefs.every((ref) => ref.startsWith("artifact://checkpoint/")),
        JSON.stringify(checkpoint.artifactRefs),
      );
      assert.ok(
        checkpoint.artifactRefs.every((ref) => ref !== validArtifact.uri && ref !== secondValidArtifact.uri),
        "checkpoint evidence must not retain mutable worker-owned URIs",
      );
      assert.deepEqual(await Promise.all(checkpoint.artifactRefs.map((ref) => artifacts.readContentByUri(ref))), [
        "verified artifact body",
        "verified artifact body",
      ]);
      await artifacts.put("checkpoint", "implementation", "worker-owned artifact changed", "changed");
      await artifacts.delete(secondValidArtifact.uri);
      assert.deepEqual(
        await Promise.all(checkpoint.artifactRefs.map((ref) => artifacts.readContentByUri(ref))),
        ["verified artifact body", "verified artifact body"],
        "worker-owned artifact mutation/deletion cannot alter checkpoint-owned evidence",
      );
      assert.deepEqual(checkpoint.artifactHashes, [
        `sha256:${createHash("sha256").update("verified artifact body").digest("hex")}`,
        `sha256:${createHash("sha256").update("verified artifact body").digest("hex")}`,
      ]);
      const rejectedClaims = store
        .listFindings(mission.mission_id)
        .filter(
          (finding) =>
            finding.category === "checkpoint_progress" && finding.summary.includes("Rejected unauthenticated"),
        );
      assert.equal(rejectedClaims.length, 2, JSON.stringify(rejectedClaims));
      assert.ok(rejectedClaims.some((finding) => finding.evidence?.includes("artifact://checkpoint/missing")));
      assert.ok(rejectedClaims.some((finding) => finding.evidence?.includes("artifact://other/implementation")));
      execFileSync("git", ["-C", fx.root, "cat-file", "-e", `${checkpoint.candidateSha}:src/preserved.ts`]);

      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        repo_id: task.repo_id,
        kind: "integration",
        role: "integrator",
        objective: "do not integrate unreconciled timeout work",
      });
      await (
        await broker.execute({
          taskId: integrationTask.task_id,
          missionId: mission.mission_id,
          repoId: task.repo_id,
          kind: "integration",
          role: integrationTask.role,
          objective: integrationTask.objective,
        })
      ).result();
      assert.deepEqual(handoffs, [], "checkpointed timeout work requires reconciliation before integration");

      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      release();
      await rm(artifactRoot, { recursive: true, force: true });
      await fx.cleanup();
    }
  });

  it("recovers exactly the commits the worker made, not the harvest's auto-commit of its half-done edits", async () => {
    const s = await scenario([{ task: "committed", commit: ["done.txt"], edit: ["half.txt"], outcome: TIMEOUT }]);
    try {
      assert.equal(s.handoffs.length, 1, JSON.stringify(s.handoffs));
      const h = s.handoffs[0]!;
      assert.equal(h.recovered, true);
      assert.equal(h.ref, s.workerCommits.get("committed"), "merge the worker's own tip, not the harvest commit");
      assert.equal(h.worktree.branch, s.branchOf("committed"));
      // The half-done edit is still harvested onto the branch (preserved for an
      // operator), just never merged: the tip is a harvest commit past the ref.
      const tip = execFileSync("git", ["-C", s.fx.root, "rev-parse", h.worktree.branch], { encoding: "utf8" }).trim();
      assert.notEqual(tip, h.ref);
      execFileSync("git", ["-C", s.fx.root, "cat-file", "-e", `${h.worktree.branch}:src/half.txt`]);
      // Surfaced, not silent.
      assert.ok(
        s.store.listFindings(s.m.mission_id).some((f) => /recover/i.test(f.summary)),
        "a finding must name the recovered execution",
      );
    } finally {
      await s.fx.cleanup();
    }
  });

  it("a SUCCEEDED worker that committed some steps and left the last one uncommitted keeps all of it", async () => {
    // Commit discipline makes this the common shape: steps committed as they
    // go, the final step still in the tree when the worker reports success.
    const s = await scenario([{ task: "disciplined", commit: ["step1.txt"], edit: ["step4.txt"], outcome: SUCCESS }], {
      merge: true,
    });
    try {
      assert.equal(s.handoffs.length, 1);
      assert.ok(existsSync(`${s.fx.root}/src/step1.txt`), "the committed step is integrated");
      assert.ok(existsSync(`${s.fx.root}/src/step4.txt`), "the uncommitted last step is harvested and integrated");
    } finally {
      await s.fx.cleanup();
    }
  });

  it("does not recover a timed-out worker that only edited files (nothing it committed itself)", async () => {
    const s = await scenario([{ task: "edited", edit: ["half.txt"], outcome: TIMEOUT }]);
    try {
      assert.deepEqual(s.handoffs, [], "half-done edits stay preserve-only");
    } finally {
      await s.fx.cleanup();
    }
  });

  it("keeps committed work from a gateway/transport timeout preserve-only (only the wall-clock marker recovers)", async () => {
    for (const error of ["gateway:queue_timeout", "transient:timeout"]) {
      const s = await scenario([
        {
          task: "infra",
          commit: ["partial.txt"],
          outcome: { exitStatus: "failed", summary: "Worker failed after 5 attempt(s): request timed out", error },
        },
      ]);
      try {
        assert.deepEqual(s.handoffs, [], `${error}: partial work must stay preserve-only`);
      } finally {
        await s.fx.cleanup();
      }
    }
  });

  it("integrates recovered work LAST, after every clean branch", async () => {
    const s = await scenario([
      { task: "recovered", commit: ["r.txt"], outcome: TIMEOUT },
      { task: "clean", commit: ["c.txt"], outcome: SUCCESS },
    ]);
    try {
      assert.deepEqual(
        s.handoffs.map((h) => [h.worktree.branch, h.recovered === true]),
        [
          [s.branchOf("clean"), false],
          [s.branchOf("recovered"), true],
        ],
      );
    } finally {
      await s.fx.cleanup();
    }
  });

  it("a retry of the same task that succeeds is integrated (the last settled outcome wins), once", async () => {
    const s = await scenario([
      { task: "retried", edit: ["a.txt"], outcome: { exitStatus: "failed", summary: "guard abort", error: "guard" } },
      { task: "retried", commit: ["b.txt"], outcome: SUCCESS },
    ]);
    try {
      assert.deepEqual(
        s.handoffs.map((h) => [h.worktree.branch, h.recovered === true]),
        [[s.branchOf("retried"), false]],
      );
    } finally {
      await s.fx.cleanup();
    }
  });
});

describe("ExecutionBroker: recording what recovery actually merged (completion-gate evidence)", () => {
  it("records the recovered task, branch and exact ref on the integration execution once merged", async () => {
    const s = await scenario(
      [
        { task: "recovered", commit: ["r.txt"], edit: ["half.txt"], outcome: TIMEOUT },
        { task: "clean", commit: ["c.txt"], outcome: SUCCESS },
      ],
      { merge: true },
    );
    try {
      assert.deepEqual(s.integration.recovered_merged, [
        { task_id: s.taskOf("recovered"), branch: s.branchOf("recovered"), ref: s.workerCommits.get("recovered") },
      ]);
    } finally {
      await s.fx.cleanup();
    }
  });

  it("records nothing for recovered work the integrator did not merge (skipped / conflict)", async () => {
    const s = await scenario([{ task: "recovered", commit: ["r.txt"], outcome: TIMEOUT }], {
      merge: true,
      skip: () => true,
    });
    try {
      assert.equal(s.handoffs.length, 1, "it was handed off");
      assert.equal(s.integration.recovered_merged, undefined);
    } finally {
      await s.fx.cleanup();
    }
  });

  it("records nothing when the integration itself did not succeed", async () => {
    const s = await scenario([{ task: "recovered", commit: ["r.txt"], outcome: TIMEOUT }], {
      merge: true,
      exitStatus: "failed",
    });
    try {
      assert.equal(s.integration.recovered_merged, undefined);
    } finally {
      await s.fx.cleanup();
    }
  });
});

describe("GitRepo.revListCount", () => {
  it("reports an unknown count as null, not as 'no commits'", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      assert.equal(await git.revListCount("HEAD..HEAD"), 0);
      assert.equal(await git.revListCount("HEAD..no-such-branch"), null);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("ExecutionBroker durable lifecycle inventory", () => {
  it("fails closed with a typed diagnostic when a Git provider omits required inventories", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "inventory",
      goal: "inventory",
      user_request: "inventory",
      repository: "/tmp/not-evidence",
      base_ref: "base",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-inventory",
      kind: "agent",
      role: "implementer",
      objective: "work",
    });
    const broker = new ExecutionBroker({
      store,
      resolveRepository: async () => ({ repoId: "repo-inventory", root: "/tmp/not-evidence", git: {} as GitRepo }),
      backends: {},
    });
    await assert.rejects(
      () => broker.durableRepositoryStateRefs(mission.mission_id),
      (error: unknown) =>
        error instanceof RepositoryLifecycleInventoryUnavailableError &&
        error.code === "PERSISTENCE_UNAVAILABLE" &&
        error.repoId === "repo-inventory",
    );
  });

  it("fails closed for both diagnostics and preserved refs when repository-bound work has no Git provider", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "missing git",
      goal: "missing git",
      user_request: "missing git",
      repository: "/tmp/not-evidence",
      base_ref: "base",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-no-git",
      kind: "agent",
      role: "implementer",
      objective: "work",
    });
    const broker = new ExecutionBroker({ store, git: null, backends: {} });
    for (const read of [
      () => broker.durableRepositoryDiagnostics(mission.mission_id),
      () => broker.durableRepositoryStateRefs(mission.mission_id),
    ]) {
      await assert.rejects(
        read,
        (error: unknown) =>
          error instanceof RepositoryLifecycleInventoryUnavailableError &&
          error.code === "PERSISTENCE_UNAVAILABLE" &&
          error.repoId === "repo-no-git",
      );
    }
  });
});
