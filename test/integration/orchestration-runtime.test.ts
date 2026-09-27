/**
 * End-to-end test through the REAL EngineeringRuntime wiring: runtime ->
 * orchestrator -> broker -> realBackends -> fake worker + real CommandVerifier
 * over an isolated git fixture repo. Proves the extension-facing path works
 * without a live model.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MISSION_SNAPSHOT_CONTRACT_VERSION } from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

function acceptanceResults(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
    acceptanceId: match[1]!,
    status: "passed" as const,
    detail: "fake reviewer checked the criterion",
  }));
}

async function openRuntime(
  root: string,
  reviewFindings: unknown[] = [],
  onRun?: (cwd: string, role: string) => Promise<void> | void,
) {
  const worker: WorkerExecutor = {
    async run(req) {
      if (onRun) {
        await onRun(req.cwd ?? root, req.role ?? "");
      } else if (req.role === "implementer") {
        // A real implementer leaves a change behind. The orchestrator requires the
        // checkout to actually differ from the mission's base commit before an
        // integrating mission may complete, so the fake must too — otherwise the
        // 'nothing landed' invariant correctly blocks it.
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(`${req.cwd ?? root}/src`, { recursive: true });
        await writeFile(
          `${req.cwd ?? root}/src/orchestrated.ts`,
          `// produced by the orchestrated implementer\nexport const orchestrated = true;\n`,
          "utf8",
        );
      }
      return {
        result: {
          status: "completed",
          summary: `worker ${req.role} did ${req.task}`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: reviewFindings.length ? { findings: reviewFindings } : {},
        },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 100,
          turns: 1,
          model: "fake",
        },
        toolCalls: 1,
        structured:
          req.resultTool === "review_result"
            ? {
                verdict: reviewFindings.length > 0 ? "request_changes" : "approve",
                findings: reviewFindings,
                missingTests: [],
                specGaps: [],
                acceptanceResults: acceptanceResults(req.task),
                summary: reviewFindings.length > 0 ? "changes requested" : "approved",
              }
            : undefined,
      };
    },
  };
  return EngineeringRuntime.open({
    cwd: root,
    worker,
    verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
  });
}

describe("orchestration via real EngineeringRuntime (acceptance scenarios)", () => {
  const fixtures: Array<{ root: string; cleanup: () => Promise<void> }> = [];

  /**
   * A fixture whose own test suite PASSES at baseline.
   *
   * The shared fixture ships `add()` unimplemented on purpose (the vertical-slice
   * test has an agent implement it), so `npm test` in it fails. A happy-path
   * orchestration scenario asserts validation passes, so it needs a green repo:
   * on a red one the completion gate now correctly refuses to complete — earlier
   * these scenarios only "passed" because a failing validation suite was being
   * ignored (runSingleTask trusted resolution instead of exitStatus).
   */
  async function greenFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const fx = await makeFixtureRepo();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${fx.root}/src/add.js`, "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("git", ["-C", fx.root, "add", "-A"]);
    await exec("git", ["-C", fx.root, "commit", "-q", "-m", "green baseline"]);
    return fx;
  }

  it("scenario A: 'Add a health endpoint' auto-invokes engineering+validation+review and completes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    assert.ok(rt.orchestrator, "orchestrator must be wired by the runtime");
    assert.ok(rt.missionStore, "mission store must be wired by the runtime");

    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(
      result.completed,
      true,
      JSON.stringify({
        reason: result.failureReason,
        verdict: result.verdict,
        tasks: rt
          .missionStore!.listTasks(result.mission.mission_id)
          .map((task) => ({ kind: task.kind, status: task.status, failure: task.failure_reason })),
        findings: rt.missionStore!.listFindings(result.mission.mission_id).map((finding) => finding.summary),
      }),
    );
    assert.equal(result.mission.status, "COMPLETE");
    assert.ok(result.mission.required_gates.includes("validation"));
    assert.ok(result.mission.required_gates.includes("independent_review"));
    const store = rt.missionStore!;
    const tasks = store.listTasks(result.mission.mission_id);
    // implementer + validation + review tasks all SUCCEEDED
    assert.ok(tasks.some((t) => t.kind === "agent" && t.status === "SUCCEEDED"));
    assert.ok(tasks.some((t) => t.kind === "validation" && t.status === "SUCCEEDED"));
    assert.ok(tasks.some((t) => t.kind === "review" && t.status === "SUCCEEDED"));
  });

  it("binds implementer, validator, integrator, reviewer, and repository tools to an explicit repo outside the launch cwd", async () => {
    const target = await greenFixture();
    const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
    fixtures.push(target, { root: metaRoot, cleanup: () => rm(metaRoot, { recursive: true, force: true }) });
    const workerCwds: Array<{ role: string; cwd: string }> = [];
    const verifierCwds: string[] = [];
    const runtimeRef: { current?: EngineeringRuntime } = {};
    const worker: WorkerExecutor = {
      async run(req) {
        workerCwds.push({ role: req.role, cwd: req.cwd ?? "" });
        if (req.role === "implementer") {
          const activeRuntime = runtimeRef.current;
          assert.ok(activeRuntime);
          assert.ok(
            activeRuntime
              .missionStore!.listMissions()
              .some((mission) => activeRuntime.missionStore!.getWorkspaceManifest(mission.mission_id)),
            "workspace authorization must be durable before implementer dispatch",
          );
          await writeFile(join(req.cwd!, "src", "scoped.ts"), "export const scoped = true;\n", "utf8");
        }
        return {
          result: {
            status: "completed",
            summary: `${req.role} completed`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 1,
            turns: 1,
            model: "fake",
          },
          toolCalls: 0,
          structured:
            req.resultTool === "review_result"
              ? {
                  verdict: "approve",
                  findings: [],
                  missingTests: [],
                  specGaps: [],
                  acceptanceResults: acceptanceResults(req.task),
                  summary: "approved",
                }
              : undefined,
        };
      },
    };
    const { CommandVerifier } = await import("../../src/verify/Verifier.ts");
    class RecordingVerifier extends CommandVerifier {
      override async detect(cwd: string) {
        verifierCwds.push(cwd);
        return super.detect(cwd);
      }
    }
    const rt = await EngineeringRuntime.open({ cwd: metaRoot, worker, verifier: new RecordingVerifier() });
    runtimeRef.current = rt;
    const targetGit = await (await import("../../src/git/GitRepo.ts")).GitRepo.open(target.root);
    assert.ok(targetGit);

    const result = await rt.orchestrator!.orchestrate(`Add scoped support in ${target.root}`, {
      repository: metaRoot,
      baseRef: await targetGit.headCommit(),
      mutationRequested: true,
    });

    assert.equal(result.completed, true, result.failureReason ?? "");
    const manifest = rt.missionStore!.getWorkspaceManifest(result.mission.mission_id);
    assert.ok(manifest);
    assert.equal(manifest.repositories.length, 1);
    assert.equal(manifest.repositories[0]?.canonicalRoot, target.root);
    assert.ok(
      rt
        .missionStore!.listTasks(result.mission.mission_id)
        .every((task) => task.repo_id === manifest.repositories[0]?.repoId),
      "every executable task must carry the selected repository binding",
    );
    assert.ok(workerCwds.some(({ role, cwd }) => role === "implementer" && cwd !== metaRoot));
    const reviewerCwd = workerCwds.find(({ role }) => role === "reviewer")?.cwd;
    assert.ok(reviewerCwd && reviewerCwd !== target.root && reviewerCwd !== metaRoot);
    assert.ok(verifierCwds.length > 0 && verifierCwds.every((cwd) => cwd === reviewerCwd));
    const candidate = rt.missionStore!.getCandidate(result.mission.mission_id, manifest.repositories[0]!.repoId);
    assert.ok(candidate, "candidate-scoped gate evidence must be recorded");
    assert.equal(candidate.identity.candidateSha, await targetGit.headCommit());
    assert.equal(await readFile(join(target.root, "src", "scoped.ts"), "utf8"), "export const scoped = true;\n");

    const repoSearch = rt.coreTools.find((tool) => tool.name === "repo_search");
    assert.ok(repoSearch);
    const execute = repoSearch.execute as unknown as (
      id: string,
      params: { query: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: { cwd: string },
    ) => Promise<{ content: Array<{ text: string }>; details: { repoId?: string } }>;
    const search = await execute("scope-search", { query: "scoped" }, undefined, undefined, { cwd: target.root });
    assert.match(search.content[0]?.text ?? "", /src\/scoped\.ts/);
    assert.doesNotMatch(search.content[0]?.text ?? "", /runtime not initialized|not a git repository/i);
    assert.equal(search.details.repoId, manifest.repositories[0]?.repoId);
    await assert.rejects(
      execute("scope-search-unmatched", { query: "scoped" }, undefined, undefined, { cwd: metaRoot }),
      /outside every active workspace manifest/i,
    );
  });

  it("blocks a protected explicit workspace as WORKSPACE_SCOPE_MISMATCH before planning", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const result = await rt.orchestrator!.orchestrate("Modify files in /", {
      repository: fx.root,
      baseRef: await rt.git!.headCommit(),
      mutationRequested: true,
    });

    assert.equal(result.completed, false);
    assert.equal(result.mission.status, "BLOCKED");
    assert.equal(rt.missionStore!.listTasks(result.mission.mission_id).length, 0, "planning must not run");
    assert.ok(
      rt
        .missionStore!.listFailureClassifications(result.mission.mission_id)
        .some((classification) => classification.category === "WORKSPACE_SCOPE_MISMATCH"),
    );
  });

  it("confines a subdirectory-authorized worker and never integrates out-of-scope changes", async () => {
    const target = await greenFixture();
    const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
    fixtures.push(target, { root: metaRoot, cleanup: () => rm(metaRoot, { recursive: true, force: true }) });
    const worker: WorkerExecutor = {
      async run(req) {
        if (req.role === "implementer") {
          await writeFile(join(req.cwd!, "src", "allowed.ts"), "export const allowed = true;\n", "utf8");
          await writeFile(join(req.cwd!, "outside.ts"), "export const escaped = true;\n", "utf8");
        }
        return {
          result: {
            status: "completed",
            summary: "worker completed",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 1,
            turns: 1,
            model: "fake",
          },
          toolCalls: 0,
          structured:
            req.resultTool === "review_result"
              ? {
                  verdict: "approve",
                  findings: [],
                  missingTests: [],
                  specGaps: [],
                  acceptanceResults: acceptanceResults(req.task),
                  summary: "approved",
                }
              : undefined,
        };
      },
    };
    const rt = await EngineeringRuntime.open({
      cwd: metaRoot,
      worker,
      verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
    });

    const result = await rt.orchestrator!.orchestrate(`Implement only in ${join(target.root, "src")}`, {
      repository: metaRoot,
      baseRef: "",
      mutationRequested: true,
    });

    assert.equal(result.completed, false);
    const manifest = rt.missionStore!.getWorkspaceManifest(result.mission.mission_id)!;
    assert.deepEqual(manifest.repositories[0]?.writableDomains, ["src/**"]);
    assert.ok(
      rt
        .missionStore!.listTasks(result.mission.mission_id)
        .filter((task) => task.mutates_repo)
        .every((task) => task.write_domains.every((domain) => domain === "src/**")),
    );
    await assert.rejects(readFile(join(target.root, "outside.ts"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(target.root, "src", "allowed.ts"), "utf8"), /ENOENT/);
    assert.ok(
      rt
        .missionStore!.listFailureClassifications(result.mission.mission_id)
        .some((classification) => classification.category === "WORKSPACE_SCOPE_MISMATCH"),
    );
  });

  it("keeps concurrent external missions bound to their explicit repoIds", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
    fixtures.push(first, second, { root: metaRoot, cleanup: () => rm(metaRoot, { recursive: true, force: true }) });
    const worker: WorkerExecutor = {
      async run(req) {
        if (req.role === "implementer") {
          const marker = req.task.includes(first.root) ? "first" : "second";
          await writeFile(join(req.cwd!, "src", `${marker}.ts`), `export const ${marker} = true;\n`, "utf8");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return {
          result: {
            status: "completed",
            summary: "done",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 1,
            turns: 1,
            model: "fake",
          },
          toolCalls: 0,
          structured:
            req.resultTool === "review_result"
              ? {
                  verdict: "approve",
                  findings: [],
                  missingTests: [],
                  specGaps: [],
                  acceptanceResults: acceptanceResults(req.task),
                  summary: "approved",
                }
              : undefined,
        };
      },
    };
    const rt = await EngineeringRuntime.open({
      cwd: metaRoot,
      worker,
      verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
    });

    const [a, b] = await Promise.all([
      rt.orchestrator!.orchestrate(`Add first support in ${first.root}`, {
        repository: metaRoot,
        baseRef: "",
        mutationRequested: true,
      }),
      rt.orchestrator!.orchestrate(`Add second support in ${second.root}`, {
        repository: metaRoot,
        baseRef: "",
        mutationRequested: true,
      }),
    ]);

    assert.equal(a.completed, true, a.failureReason ?? "");
    assert.equal(b.completed, true, b.failureReason ?? "");
    assert.match(await readFile(join(first.root, "src", "first.ts"), "utf8"), /first/);
    assert.match(await readFile(join(second.root, "src", "second.ts"), "utf8"), /second/);
    await assert.rejects(readFile(join(first.root, "src", "second.ts"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(second.root, "src", "first.ts"), "utf8"), /ENOENT/);
  });

  it("mission tool derives the external target base instead of forwarding the launch repo SHA", async () => {
    const launch = await greenFixture();
    const target = await greenFixture();
    fixtures.push(launch, target);
    await writeFile(join(launch.root, "launch-only.txt"), "different history\n", "utf8");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["-C", launch.root, "add", "launch-only.txt"]);
    await promisify(execFile)("git", ["-C", launch.root, "commit", "-q", "-m", "launch-only history"]);
    const rt = await openRuntime(launch.root);
    const targetGit = await (await import("../../src/git/GitRepo.ts")).GitRepo.open(target.root);
    assert.ok(targetGit);
    const targetBase = await targetGit.headCommit();
    const launchBase = await rt.git!.headCommit();
    assert.notEqual(targetBase, launchBase);
    const missionTool = rt.coreTools.find((tool) => tool.name === "mission")!;
    const execute = missionTool.execute as unknown as (
      id: string,
      params: { request: string; mutate: boolean },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: { cwd: string },
    ) => Promise<{ details: { missionId: string } }>;

    const response = await execute(
      "external-base",
      { request: `Add external support in ${target.root}`, mutate: true },
      undefined,
      undefined,
      { cwd: launch.root },
    );

    const mission = rt.missionStore!.getMission(response.details.missionId)!;
    assert.equal(mission.repository, target.root);
    assert.equal(mission.base_ref, targetBase);
  });

  it("rejects a supplied base commit that does not belong to the selected external repository", async () => {
    const launch = await greenFixture();
    const target = await greenFixture();
    const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
    fixtures.push(launch, target, { root: metaRoot, cleanup: () => rm(metaRoot, { recursive: true, force: true }) });
    await writeFile(join(launch.root, "launch-only.txt"), "unique launch commit\n", "utf8");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["-C", launch.root, "add", "launch-only.txt"]);
    await promisify(execFile)("git", ["-C", launch.root, "commit", "-q", "-m", "unique launch commit"]);
    const launchGit = await (await import("../../src/git/GitRepo.ts")).GitRepo.open(launch.root);
    assert.ok(launchGit);
    const rt = await openRuntime(metaRoot);

    const result = await rt.orchestrator!.orchestrate(`Modify ${target.root}`, {
      repository: metaRoot,
      baseRef: await launchGit.headCommit(),
      mutationRequested: true,
    });

    assert.equal(result.mission.status, "BLOCKED");
    assert.match(result.failureReason ?? "", /does not belong to selected repository/i);
    assert.equal(rt.missionStore!.listTasks(result.mission.mission_id).length, 0);
  });

  it("reloads an external manifest binding when the meta-root runtime reopens", async () => {
    const target = await greenFixture();
    const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
    fixtures.push(target, { root: metaRoot, cleanup: () => rm(metaRoot, { recursive: true, force: true }) });
    const rt1 = await openRuntime(metaRoot);
    const result = await rt1.orchestrator!.orchestrate(`Add support in ${target.root}`, {
      repository: metaRoot,
      baseRef: "",
      mutationRequested: true,
    });
    await rt1.missionStore!.flush();
    const repoId = rt1.missionStore!.getWorkspaceManifest(result.mission.mission_id)!.repositories[0]!.repoId;

    const rt2 = await openRuntime(metaRoot);

    assert.equal(rt2.repositoryRegistry.get(repoId).root, target.root);
  });

  it("reopens and resumes a paused external mission on the persisted repository binding", async () => {
    const target = await greenFixture();
    const metaRoot = await mkdtemp(join(tmpdir(), "pi-eng-meta-root-"));
    fixtures.push(target, { root: metaRoot, cleanup: () => rm(metaRoot, { recursive: true, force: true }) });
    const unavailable: WorkerExecutor = {
      async run() {
        return {
          result: {
            status: "failed",
            summary: "gateway unavailable",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: "transient:server_unavailable",
          },
          usage: null,
          toolCalls: 0,
        };
      },
    };
    const rt1 = await EngineeringRuntime.open({
      cwd: metaRoot,
      worker: unavailable,
      verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
    });
    Object.assign(rt1.resilience, {
      retry_window_ms: 0,
      auto_resume_horizon_ms: 0,
      probe_interval_ms: 1,
      jitter_ms: 0,
    });
    const paused = await rt1.orchestrator!.orchestrate(`Add resumed support in ${target.root}`, {
      repository: metaRoot,
      baseRef: "",
      mutationRequested: true,
    });
    assert.equal(paused.mission.status, "PAUSED_INFRASTRUCTURE");
    await rt1.missionStore!.flush();
    const persistedEvents = (await readFile(join(rt1.workDir, "orchestration.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const replayBackend = JsonlEventStore.inMemory();
    await replayBackend.appendAll(persistedEvents);
    const replayedStore = MissionStore.open(replayBackend);
    assert.equal(replayedStore.getMission(paused.mission.mission_id)?.status, "PAUSED_INFRASTRUCTURE");
    assert.equal(
      replayedStore.getWorkspaceManifest(paused.mission.mission_id)?.repositories[0]?.canonicalRoot,
      target.root,
    );

    const resumedCwds: string[] = [];
    const recovered: WorkerExecutor = {
      async run(req) {
        resumedCwds.push(req.cwd);
        if (req.role === "implementer") {
          await writeFile(join(req.cwd, "src", "resumed.ts"), "export const resumed = true;\n", "utf8");
        }
        return {
          result: {
            status: "completed",
            summary: "recovered",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
          },
          usage: null,
          toolCalls: 0,
          structured:
            req.resultTool === "review_result"
              ? {
                  verdict: "approve",
                  findings: [],
                  missingTests: [],
                  specGaps: [],
                  acceptanceResults: acceptanceResults(req.task),
                  summary: "approved",
                }
              : undefined,
        };
      },
    };
    const rt2 = await EngineeringRuntime.open({
      cwd: metaRoot,
      worker: recovered,
      verifier: new (await import("../../src/verify/Verifier.ts")).CommandVerifier(),
    });
    assert.notEqual(rt2, rt1);
    const resumed = await rt2.orchestrator!.resume(paused.mission.mission_id, { force: true });

    assert.equal(resumed.status, "COMPLETE");
    assert.match(await readFile(join(target.root, "src", "resumed.ts"), "utf8"), /resumed/);
    await assert.rejects(readFile(join(metaRoot, "src", "resumed.ts"), "utf8"), /ENOENT/);
    assert.ok(resumedCwds.length >= 2);
    assert.ok(resumedCwds.every((cwd) => cwd.startsWith(target.root) || cwd.includes("pi-eng-")));
    const repoId = rt2.missionStore!.getWorkspaceManifest(paused.mission.mission_id)!.repositories[0]!.repoId;
    assert.ok(rt2.missionStore!.listTasks(paused.mission.mission_id).every((task) => task.repo_id === repoId));
  });

  it("scenario B: investigation escalates to engineering+review when source changes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    // Pure investigation: no mutation -> completes as investigation.
    const r0 = await rt.orchestrator!.orchestrate("Find out why login fails", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: false,
    });
    assert.equal(r0.mission.workflow_class, "investigation");
    // With a mutation request -> escalates to engineering_review.
    const r1 = await rt.orchestrator!.orchestrate("Find out why login fails", {
      repository: rt.cwd,
      baseRef,
      changedFiles: ["src/auth/service.ts"],
      mutationRequested: true,
    });
    assert.notEqual(r1.mission.workflow_class, "investigation");
    assert.ok(r1.mission.required_gates.includes("independent_review"));
  });

  it("scenario D: a blocking reviewer finding blocks completion and the orchestrator creates repair work", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    // The review backend reports a blocking finding on every pass, so the
    // orchestrator must repair, re-review, and still refuse to complete.
    const rt = await openRuntime(fx.root, [
      {
        severity: "blocking",
        summary: "auth bypass: token not verified",
        category: "security",
        file: "src/a.ts",
        line: 1,
      },
    ]);
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Fix the login bug", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    const store = rt.missionStore!;

    assert.equal(result.completed, false, "a blocking finding must prevent completion");
    assert.notEqual(store.getMission(result.mission.mission_id)!.status, "COMPLETE");
    assert.ok(
      store.listFindings(result.mission.mission_id).some((f) => f.severity === "blocking"),
      "the blocking finding stays on the record",
    );
    // The orchestrator itself created repair work (not the test).
    const repairs = store
      .listTasks(result.mission.mission_id)
      .filter((t) => t.objective.startsWith("Repair review finding"));
    assert.ok(repairs.length >= 1, "the orchestrator must create repair task(s) from the finding");
    assert.ok(
      repairs.every((t) => t.mutates_repo && t.isolation === "worktree"),
      "repairs mutate in isolation",
    );
    // And it re-reviewed after repairing (more than one review task ran).
    const reviews = store.listTasks(result.mission.mission_id).filter((t) => t.kind === "review");
    assert.ok(reviews.length >= 2, `expected a re-review after repair, saw ${reviews.length}`);
  });

  it("a read-only investigation mission never gets a mutating task and still completes", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Why is login failing?", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: false,
    });
    const tasks = rt.missionStore!.listTasks(result.mission.mission_id);
    assert.equal(result.mission.workflow_class, "investigation");
    assert.ok(tasks.length > 0);
    assert.equal(
      tasks.filter((t) => t.mutates_repo).length,
      0,
      `investigation must not mutate: ${JSON.stringify(tasks.map((t) => [t.kind, t.mutates_repo]))}`,
    );
    // A mission with no post-execution gates must still reach COMPLETE rather
    // than dead-ending on an illegal transition.
    assert.equal(result.completed, true, result.failureReason ?? "");
    assert.equal(result.mission.status, "COMPLETE");
  });

  it("mission/task/execution state survives runtime restart over the same repo", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt1 = await openRuntime(fx.root);
    const baseRef = await rt1.git!.headCommit();
    const r = await rt1.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt1.cwd,
      baseRef,
      mutationRequested: true,
    });
    await rt1.missionStore!.flush();

    // Reopen a fresh runtime over the same repo -> durable store replayed.
    const rt2 = await openRuntime(fx.root);
    const restored = rt2.missionStore!.getMission(r.mission.mission_id);
    assert.ok(restored);
    assert.equal(restored.status, "COMPLETE");
    assert.equal(
      rt2.missionStore!.listTasks(r.mission.mission_id).length,
      rt1.missionStore!.listTasks(r.mission.mission_id).length,
    );
  });

  it("a mutating mission's change actually lands in the repository (worktree -> merge)", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    // The worker edits the checkout it was given (its own worktree), like a real
    // implementer does. Without harvesting + integration the worktree is torn
    // down and the mission "completes" with an unchanged repository.
    const workerCwd: string[] = [];
    const rt = await openRuntime(fx.root, [], async (cwd, role) => {
      if (role !== "implementer") return;
      workerCwd.push(cwd);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${cwd}/src`, { recursive: true });
      await writeFile(`${cwd}/src/health.ts`, `export const health = () => ({ ok: true });\n`, "utf8");
    });
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });

    const { access } = await import("node:fs/promises");
    let landed = true;
    try {
      await access(`${fx.root}/src/health.ts`);
    } catch {
      landed = false;
    }
    if (!landed) {
      assert.fail(
        `worker change never reached the repo (mission ${result.mission.status}, completed=${result.completed}, ${result.failureReason ?? ""})`,
      );
    }
    assert.ok(landed);
    // The change must have travelled worktree -> harvest -> merge, not been
    // written straight into the main checkout (which would make this test pass
    // vacuously if worktree isolation silently fell back to cwd).
    assert.ok(workerCwd.length >= 1, "implementer should have run");
    assert.notEqual(workerCwd[0], fx.root, "implementer must run in an isolated worktree");
    // And the mission only completed because the change was integrated first.
    const integ = rt.missionStore!.listTasks(result.mission.mission_id).filter((t) => t.kind === "integration");
    assert.ok(integ.length >= 1, "an integration step must run for worktree-isolated mutation");
  });

  /** Commit a divergent edit on the same line the worker will touch. */
  async function commitInMain(root: string, content: string, msg: string): Promise<void> {
    await writeFile(`${root}/src/add.js`, content, "utf8");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("git", ["-C", root, "add", "-A"]);
    await exec("git", ["-C", root, "commit", "-q", "-m", msg]);
  }

  it("a conflicted merge blocks completion and leaves the incumbent tree intact", async () => {
    const fx = await greenFixture();
    const { GitRepo } = await import("../../src/git/GitRepo.ts");
    const probe = await GitRepo.open(fx.root);
    assert.ok(probe);
    const baseRef = await probe.headCommit();

    // Same line, different content on both sides -> a real merge conflict. The
    // incumbent line stays valid JS so the conflict, not a check failure, is
    // what blocks the mission.
    await commitInMain(fx.root, "export function add(a, b) {\n  return a + b; // main\n}\n", "main note");

    const rt = await openRuntime(fx.root, [], async (cwd, role) => {
      if (role !== "implementer") return;
      await writeFile(`${cwd}/src/add.js`, "export function add(a, b) {\n  return a + b; // worker\n}\n", "utf8");
    });

    const result = await rt.orchestrator!.orchestrate("Annotate the add helper", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });

    const integ = rt.missionStore!.listTasks(result.mission.mission_id).filter((t) => t.kind === "integration");
    assert.ok(integ.length >= 1, "integration step should have been created");
    assert.ok(
      rt
        .missionStore!.listFindings(result.mission.mission_id)
        .some((finding) => /promotion rejected.*diverged/i.test(finding.summary)),
      "incumbent divergence must reject promotion",
    );
    assert.equal(result.completed, false, "a conflicted integration must never complete the mission");
    // mergeBranch aborts a conflicted merge, so the incumbent content survives
    // and the worker's line is not applied.
    const mainSrc = await readFile(`${fx.root}/src/add.js`, "utf8");
    assert.ok(mainSrc.includes("// main"), "incumbent content must survive a conflicted merge");
    assert.ok(!mainSrc.includes("// worker"), "conflicted worker change must not be applied");
    assert.ok(!mainSrc.includes("<<<<<<<"), "no conflict markers may be left in the working tree");
    assert.ok(
      rt
        .orchestrator!.broker.preservedBranches(result.mission.mission_id)
        .some((branch) => branch.includes("candidate")),
      "the rejected candidate must remain inspectable",
    );

    // Recovery must remain possible: after a conflict the worker branch is the
    // only copy of its output, so cleanup MUST NOT have run `git branch -D` on it.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const branches = await promisify(execFile)("git", ["-C", fx.root, "branch", "--list", "pi-eng-orch-*"]);
    assert.ok(
      branches.stdout.trim().length > 0,
      "unmerged worker work must be preserved on its branch for operator recovery",
    );
    const preserved = rt.missionStore!.listFindings(result.mission.mission_id).filter((f) => f.severity === "major");
    assert.ok(
      preserved.some((f) => f.summary.includes("preserved on branch")),
      "preserved work must be reported so an operator knows it exists",
    );
  });

  it("an integrating mission whose worker produced no change does not complete", async () => {
    const fx = await greenFixture();
    const { GitRepo } = await import("../../src/git/GitRepo.ts");
    const probe = await GitRepo.open(fx.root);
    assert.ok(probe);
    const baseRef = await probe.headCommit();
    // The worker runs, reports success, and changes nothing. Harvesting yields an
    // empty branch, which merges cleanly — a green integration alone must not be
    // taken as proof the repository changed.
    const rt = await openRuntime(fx.root, [], () => {});
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "no landed change must not count as a completed mutation");
    // The reason is surfaced as a blocking finding, so operators and the PI WEB
    // panel see why the mission stopped instead of an opaque unmet-gate verdict.
    const findings = rt.missionStore!.listFindings(result.mission.mission_id);
    assert.ok(
      findings.some((f) => f.category === "integration" && f.severity === "blocking"),
      `an empty-integration finding is required, got ${findings.map((f) => `${f.severity}:${f.category}`).join(",")}`,
    );
  });

  it("integration checks that fail after a clean merge block completion", async () => {
    const fx = await greenFixture();
    const baseRef = await (async () => {
      const { GitRepo } = await import("../../src/git/GitRepo.ts");
      const g = await GitRepo.open(fx.root);
      assert.ok(g);
      return g.headCommit();
    })();

    // Merges cleanly but breaks the repo's own suite: integration must report
    // failure through exitStatus (not throw) and the mission must not complete.
    const rt = await openRuntime(fx.root, [], async (cwd, role) => {
      if (role !== "implementer") return;
      await writeFile(`${cwd}/src/add.js`, "export function add(a, b) {\n  return a - b;\n}\n", "utf8");
    });
    const result = await rt.orchestrator!.orchestrate("Change add to subtract", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    assert.equal(result.completed, false, "failing integration checks must block completion");
    const integ = rt.missionStore!.listTasks(result.mission.mission_id).filter((t) => t.kind === "integration");
    assert.ok(
      integ.some((t) => t.status === "FAILED"),
      `integration must be FAILED, got ${integ.map((t) => t.status).join(",")}`,
    );
  });

  it("publishes the versioned mission snapshot file the PI WEB plugin reads (spec 08)", async () => {
    const fx = await greenFixture();
    fixtures.push(fx);
    const rt = await openRuntime(fx.root);
    const baseRef = await rt.git!.headCommit();
    const result = await rt.orchestrator!.orchestrate("Add a health endpoint", {
      repository: rt.cwd,
      baseRef,
      mutationRequested: true,
    });
    // The orchestrator fed the observability read-model during the real run:
    // progress, health and worker activity are populated (spec 00 §observability).
    const obs = rt.missionObservability!.projection(result.mission.mission_id);
    assert.ok(obs, "observability projection present after a real orchestrated run");
    assert.equal(obs.summary.health, "complete");
    assert.equal(obs.summary.progress.approximatePercent, 100);
    assert.equal(obs.summary.progress.verifiedComplete, true);
    assert.ok(obs.progressHistory.length >= 2, "progress history accumulated during the run");
    assert.ok(obs.activity.length >= 1, "activity events accumulated during the run");

    const snap = await rt.publishMissionSnapshot();
    assert.ok(snap);
    assert.equal(snap.contractVersion, MISSION_SNAPSHOT_CONTRACT_VERSION);
    assert.equal(snap.missions.length, 1);
    assert.ok(snap.missions[0]!.observability, "snapshot carries the observability section");
    assert.equal(snap.missions[0]!.observability!.health, "complete");
    // The file exists on disk where the browser plugin reads it.
    const { readFile } = await import("node:fs/promises");
    const onDisk = JSON.parse(await readFile(`${rt.workDir}/orchestration-snapshot.json`, "utf8")) as {
      missions: Array<{ status: string }>;
    };
    assert.equal(onDisk.missions[0]!.status, "COMPLETE");
  });

  after(async () => {
    for (const f of fixtures) await f.cleanup();
  });
});
